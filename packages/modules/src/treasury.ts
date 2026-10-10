/**
 * Казначейство: пульт керування ліквідністю банку.
 *
 * Модуль працює у фазі `week-treasury`, тобто після того, як відпрацювали всі
 * бізнес-модулі. Це навмисно: рішення про овернайт приймають, знаючи підсумок
 * дня, а не до нього.
 *
 * Порядок дій за тиждень:
 *   1. привести обов'язкові резерви до нормативу НБУ;
 *   2. підкріпити касу готівкою або здати надлишок (з витратами на інкасацію);
 *   3. закрити розрив ліквідності — міжбанк, а якщо не дають, рефінансування НБУ;
 *   4. надлишок гривні припаркувати в депозитні сертифікати НБУ.
 *
 * Гроші, які лежать без діла, знецінюються інфляцією — тому "нічого не робити"
 * тут теж є рішенням, і воно програшне.
 */

import {
  ACC,
  BaseModule,
  CoreEvents,
  PRIORITY,
  add,
  credit,
  debit,
  formatMoney,
  isPositive,
  min,
  scale,
  subtract,
  sum,
  weeklyInterest,
  zero,
  type Money,
  type PeriodEvent,
  type SimContext,
  type WeekEvent,
} from '@uabanksim/core';
import {
  BankEvents,
  type DepositsWithdrawnEvent,
  type LiquidityBorrowedEvent,
} from './events.ts';

export interface TreasuryConfig {
  /** Мінімальний запас готівки в касі як частка від тижневого обороту зняття. */
  readonly cashBufferWeeks?: number;
  /** Скільки коштує доставка готівки, як частка від суми (інкасація). */
  readonly cashDeliveryFee?: number;
  /** Премія до облікової ставки, під яку банку дають на міжбанку. */
  readonly interbankSpread?: number;
  /** Премія до облікової ставки за кредитами рефінансування НБУ. */
  readonly refinancingSpread?: number;
  /** Цільовий залишок на коррахунку понад обов'язкові резерви. */
  readonly operationalBuffer: Money;
  /** Чи паркувати надлишок у депозитні сертифікати НБУ. */
  readonly parkSurplus?: boolean;
}

export interface TreasuryState {
  /** Залучений міжбанк, який треба повернути наступного тижня. */
  interbankDebt: Money;
  interbankRate: number;
  /** Рефінансування НБУ — довші гроші під заставу. */
  refinancing: Money;
  /** Скільки тижнів поспіль банк не може закрити розрив. */
  weeksInShortfall: number;
  totalCashDelivered: Money;
  totalLogisticsCost: Money;
}

export const TREASURY_SLICE = 'treasury';

const DEFAULTS = {
  cashBufferWeeks: 2,
  cashDeliveryFee: 0.0025,
  interbankSpread: 0.02,
  refinancingSpread: 0.04,
  parkSurplus: true,
} as const;

export class TreasuryModule extends BaseModule {
  readonly id = TREASURY_SLICE;
  readonly title = 'Казначейство та міжбанк';
  readonly #config: Required<TreasuryConfig>;
  /** Ковзна оцінка тижневого попиту на готівку — база для розміру буфера каси. */
  #cashOutflowEstimate = zero('UAH');
  /** Попит на готівку, накопичений за поточний тиждень. */
  #cashDemandThisWeek = zero('UAH');

  constructor(config: TreasuryConfig) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  setup(ctx: SimContext): void {
    const state = ctx.state.registerSlice<TreasuryState>(TREASURY_SLICE, {
      interbankDebt: zero('UAH'),
      interbankRate: 0,
      refinancing: zero('UAH'),
      weeksInShortfall: 0,
      totalCashDelivered: zero('UAH'),
      totalLogisticsCost: zero('UAH'),
    });

    // Слухаємо зняття готівки, щоб знати, скільки її возити наступного тижня.
    ctx.bus.on<DepositsWithdrawnEvent>(
      BankEvents.depositsWithdrawn,
      (event: DepositsWithdrawnEvent) => {
        // Рахуємо саме те, скільки готівки просили, а не скільки видали:
        // інакше порожня каса сама себе виправдовує і ніколи не поповнюється.
        this.#cashDemandThisWeek = add(this.#cashDemandThisWeek, event.requestedCash);
      },
      { owner: this.id, priority: PRIORITY.treasury },
    );

    ctx.bus.on<WeekEvent>(CoreEvents.weekTreasury, () => this.#manageLiquidity(ctx, state), {
      priority: PRIORITY.treasury,
      owner: this.id,
    });
    ctx.bus.on<WeekEvent>(CoreEvents.weekAccrual, () => this.#accrue(ctx, state), {
      priority: PRIORITY.accrual,
      owner: this.id,
    });
    ctx.bus.on<PeriodEvent>(CoreEvents.monthEnd, () => this.#settleAccruals(ctx), {
      priority: PRIORITY.treasury,
      owner: this.id,
    });
  }

  /**
   * Розрахунок за нарахованими доходами й витратами казначейства. Без нього
   * рахунки нарахувань росли б нескінченно, а коррахунок не бачив би реальних
   * грошей від НБУ.
   */
  #settleAccruals(ctx: SimContext): void {
    const receivable = ctx.journal.balance(ACC.accruedSecuritiesIncome, 'UAH');
    if (isPositive(receivable)) {
      ctx.post({
        narrative: 'Отримання доходу за депозитними сертифікатами та ОВДП',
        postings: [debit(ACC.nostroNbu, receivable), credit(ACC.accruedSecuritiesIncome, receivable)],
      });
    }
    const payable = ctx.journal.balance(ACC.accruedInterbankExpense, 'UAH');
    const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
    const paid = min(payable, available);
    if (isPositive(paid)) {
      ctx.post({
        narrative: 'Сплата відсотків за залученими коштами банків та НБУ',
        postings: [debit(ACC.accruedInterbankExpense, paid), credit(ACC.nostroNbu, paid)],
      });
    }
  }

  #manageLiquidity(ctx: SimContext, state: TreasuryState): void {
    // Згортаємо тижневий попит на готівку в ковзну оцінку і починаємо новий тиждень.
    this.#cashOutflowEstimate = add(
      scale(this.#cashOutflowEstimate, 0.5),
      scale(this.#cashDemandThisWeek, 0.5),
    );
    this.#cashDemandThisWeek = zero('UAH');
    this.#repayInterbank(ctx, state);
    this.#alignMandatoryReserves(ctx);
    this.#manageVaultCash(ctx, state);
    this.#coverShortfall(ctx, state);
    if (this.#config.parkSurplus) this.#parkSurplus(ctx);
  }

  /** Овернайт повертається першим ділом наступного тижня — це його суть. */
  #repayInterbank(ctx: SimContext, state: TreasuryState): void {
    if (!isPositive(state.interbankDebt)) return;
    const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
    const repay = min(state.interbankDebt, available);
    if (!isPositive(repay)) return;
    ctx.post({
      narrative: 'Повернення міжбанківського кредиту овернайт',
      postings: [debit(ACC.interbankTaken, repay), credit(ACC.nostroNbu, repay)],
    });
    state.interbankDebt = subtract(state.interbankDebt, repay);
  }

  /**
   * Обов'язкове резервування: НБУ вимагає тримати частину коштів клієнтів на
   * окремому рахунку. Ці гроші не працюють — вони просто зменшують те, що можна
   * дати в кредит.
   */
  #alignMandatoryReserves(ctx: SimContext): void {
    const base = sum(
      [
        ctx.journal.balance(ACC.currentAccountsRetail, 'UAH'),
        ctx.journal.balance(ACC.currentAccountsCorporate, 'UAH'),
        ctx.journal.balance(ACC.termDepositsRetail, 'UAH'),
        ctx.journal.balance(ACC.termDepositsCorporate, 'UAH'),
      ],
      'UAH',
    );
    const required = scale(base, ctx.macro.reserveRequirement);
    const held = ctx.journal.balance(ACC.mandatoryReserves, 'UAH');
    const delta = subtract(required, held);
    if (delta.minor === 0) return;

    if (delta.minor > 0) {
      const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
      const transfer = min(delta, available);
      if (!isPositive(transfer)) return;
      ctx.post({
        narrative: 'Формування обов’язкових резервів на рахунку в НБУ',
        postings: [debit(ACC.mandatoryReserves, transfer), credit(ACC.nostroNbu, transfer)],
      });
    } else {
      const release = scale(delta, -1);
      ctx.post({
        narrative: 'Вивільнення надлишку обов’язкових резервів',
        postings: [debit(ACC.nostroNbu, release), credit(ACC.mandatoryReserves, release)],
      });
    }
  }

  /**
   * Підкріплення каси. Готівка їде з НБУ через рахунок "кошти в дорозі" — і
   * кожен рейс коштує грошей. Саме тут у наступних ітераціях з'явиться вибір
   * між власною службою інкасації та аутсорсом.
   */
  #manageVaultCash(ctx: SimContext, state: TreasuryState): void {
    const target = scale(this.#cashOutflowEstimate, this.#config.cashBufferWeeks);
    const vault = ctx.journal.balance(ACC.cashVault, 'UAH');
    const gap = subtract(target, vault);

    if (gap.minor > 0) {
      const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
      // Комісія за рейс списується з того самого коррахунку, тому беремо суму,
      // яка разом із комісією ще вміщається в наявний залишок.
      const affordable = scale(available, 1 / (1 + this.#config.cashDeliveryFee));
      const delivered = min(gap, affordable);
      if (!isPositive(delivered)) return;
      const fee = scale(delivered, this.#config.cashDeliveryFee);
      ctx.post({
        narrative: 'Підкріплення каси готівкою з НБУ',
        postings: [debit(ACC.cashVault, delivered), credit(ACC.nostroNbu, delivered)],
      });
      if (isPositive(fee)) {
        ctx.post({
          narrative: 'Витрати на інкасацію та перевезення цінностей',
          postings: [debit(ACC.cashLogisticsCost, fee), credit(ACC.nostroNbu, fee)],
        });
        state.totalLogisticsCost = add(state.totalLogisticsCost, fee);
      }
      state.totalCashDelivered = add(state.totalCashDelivered, delivered);
      return;
    }

    // Надлишок готівки — це заморожений капітал: здаємо в НБУ.
    const surplus = scale(subtract(vault, target), 0.5);
    if (surplus.minor > 0 && surplus.minor > target.minor * 0.1) {
      const fee = scale(surplus, this.#config.cashDeliveryFee);
      ctx.post({
        narrative: 'Здавання надлишку готівки до НБУ',
        postings: [debit(ACC.nostroNbu, surplus), credit(ACC.cashVault, surplus)],
      });
      if (isPositive(fee)) {
        ctx.post({
          narrative: 'Витрати на інкасацію та перевезення цінностей',
          postings: [debit(ACC.cashLogisticsCost, fee), credit(ACC.nostroNbu, fee)],
        });
        state.totalLogisticsCost = add(state.totalLogisticsCost, fee);
      }
    }
  }

  /**
   * Закриття розриву ліквідності.
   *
   * Спершу продаємо депозитні сертифікати НБУ — це найдешевші гроші. Далі йдемо
   * на міжбанк, але конкуренти дають лише тим, кому довіряють: за низької
   * репутації ліміт на банк урізається. Останній рубіж — рефінансування НБУ, і
   * воно доступне лише банку з нормальними нормативами.
   */
  #coverShortfall(ctx: SimContext, state: TreasuryState): void {
    const nostro = ctx.journal.balance(ACC.nostroNbu, 'UAH');
    const need = subtract(this.#config.operationalBuffer, nostro);
    if (need.minor <= 0) {
      state.weeksInShortfall = 0;
      return;
    }

    let remaining = need;

    // 1. Депозитні сертифікати НБУ — миттєва ліквідність без питань.
    const certificates = ctx.journal.balance(ACC.nbuCertificates, 'UAH');
    const sold = min(remaining, certificates);
    if (isPositive(sold)) {
      ctx.post({
        narrative: 'Продаж депозитних сертифікатів НБУ для покриття розриву',
        postings: [debit(ACC.nostroNbu, sold), credit(ACC.nbuCertificates, sold)],
      });
      remaining = subtract(remaining, sold);
    }
    if (!isPositive(remaining)) {
      state.weeksInShortfall = 0;
      return;
    }

    // 2. Міжбанк. Ліміт залежить від довіри ринку до банку.
    const trust = ctx.state.reputation * (1 - ctx.macro.stress * 0.6);
    const capital = ctx.journal.balance(ACC.shareCapital, 'UAH');
    const interbankLimit = scale(capital, Math.max(0, trust));
    const borrow = min(remaining, interbankLimit);
    if (isPositive(borrow)) {
      const rate = ctx.macro.keyRate + this.#config.interbankSpread + (1 - trust) * 0.06;
      ctx.post({
        narrative: `Залучення міжбанківського кредиту овернайт під ${(rate * 100).toFixed(1)}%`,
        postings: [debit(ACC.nostroNbu, borrow), credit(ACC.interbankTaken, borrow)],
      });
      state.interbankDebt = add(state.interbankDebt, borrow);
      state.interbankRate = rate;
      remaining = subtract(remaining, borrow);
      const event: LiquidityBorrowedEvent = {
        type: BankEvents.liquidityBorrowed,
        amount: borrow,
        rate,
        source: 'interbank',
      };
      ctx.emit(event);
    }
    if (!isPositive(remaining)) {
      state.weeksInShortfall = 0;
      return;
    }

    // 3. Рефінансування НБУ — кредит останньої надії під заставу кредитного портфеля.
    const eligibleCollateral = scale(
      sum(
        [
          ctx.journal.balance(ACC.loansRetailCash, 'UAH'),
          ctx.journal.balance(ACC.loansCorporate, 'UAH'),
          ctx.journal.balance(ACC.governmentBonds, 'UAH'),
        ],
        'UAH',
      ),
      0.6,
    );
    const alreadyPledged = ctx.journal.balance(ACC.nbuRefinancing, 'UAH');
    const refiCapacity = subtract(eligibleCollateral, alreadyPledged);
    const refi = min(remaining, refiCapacity);
    if (isPositive(refi)) {
      const rate = ctx.macro.keyRate + this.#config.refinancingSpread;
      ctx.post({
        narrative: `Отримання кредиту рефінансування НБУ під ${(rate * 100).toFixed(1)}%`,
        postings: [debit(ACC.nostroNbu, refi), credit(ACC.nbuRefinancing, refi)],
      });
      state.refinancing = add(state.refinancing, refi);
      remaining = subtract(remaining, refi);
      ctx.log(`Залучено рефінансування НБУ на ${formatMoney(refi)}`, 'warning');
      const event: LiquidityBorrowedEvent = {
        type: BankEvents.liquidityBorrowed,
        amount: refi,
        rate,
        source: 'nbu-refinancing',
      };
      ctx.emit(event);
    }

    if (isPositive(remaining)) {
      state.weeksInShortfall += 1;
      ctx.log(
        `Розрив ліквідності ${formatMoney(remaining)} не закрито ` +
          `(${state.weeksInShortfall}-й тиждень поспіль)`,
        state.weeksInShortfall > 2 ? 'critical' : 'warning',
      );
      // Клієнти бачать затримки платежів раніше, ніж про це напише преса.
      ctx.state.adjustReputation(-0.02 * state.weeksInShortfall);
    } else {
      state.weeksInShortfall = 0;
    }
  }

  /** Надлишок гривні паркується в депозитні сертифікати НБУ. */
  #parkSurplus(ctx: SimContext): void {
    const nostro = ctx.journal.balance(ACC.nostroNbu, 'UAH');
    const surplus = subtract(nostro, this.#config.operationalBuffer);
    if (surplus.minor <= 0) return;
    ctx.post({
      narrative: 'Розміщення вільної гривні в депозитні сертифікати НБУ',
      postings: [debit(ACC.nbuCertificates, surplus), credit(ACC.nostroNbu, surplus)],
    });
  }

  /** Нарахування доходів за сертифікатами й ОВДП та витрат за залученими коштами. */
  #accrue(ctx: SimContext, state: TreasuryState): void {
    const certificates = ctx.journal.balance(ACC.nbuCertificates, 'UAH');
    const bonds = ctx.journal.balance(ACC.governmentBonds, 'UAH');
    const income = add(
      weeklyInterest(certificates, ctx.macro.certificateRate),
      weeklyInterest(bonds, ctx.macro.bondYield),
    );
    if (isPositive(income)) {
      ctx.post({
        narrative: 'Нарахування процентних доходів за цінними паперами',
        postings: [debit(ACC.accruedSecuritiesIncome, income), credit(ACC.interestIncomeSecurities, income)],
      });
    }

    const interbankCost = weeklyInterest(state.interbankDebt, state.interbankRate);
    if (isPositive(interbankCost)) {
      ctx.post({
        narrative: 'Нарахування процентних витрат за міжбанківськими кредитами',
        postings: [
          debit(ACC.interestExpenseInterbank, interbankCost),
          credit(ACC.accruedInterbankExpense, interbankCost),
        ],
      });
    }

    const refiCost = weeklyInterest(
      ctx.journal.balance(ACC.nbuRefinancing, 'UAH'),
      ctx.macro.keyRate + this.#config.refinancingSpread,
    );
    if (isPositive(refiCost)) {
      ctx.post({
        narrative: 'Нарахування процентних витрат за рефінансуванням НБУ',
        postings: [
          debit(ACC.interestExpenseNbu, refiCost),
          credit(ACC.accruedInterbankExpense, refiCost),
        ],
      });
    }
  }
}

export function createTreasury(config: TreasuryConfig): TreasuryModule {
  return new TreasuryModule(config);
}
