/**
 * Пасиви населення: поточні рахунки та строкові депозити.
 *
 * Головний конфлікт модуля описаний у ТЗ: гроші на поточних рахунках майже
 * безкоштовні для банку, але можуть піти будь-якої секунди; строкові депозити
 * дорогі, зате дають стабільність. Гравець керує двома ставками і живе з
 * наслідками.
 *
 * Модель попиту: клієнти порівнюють вашу ставку з ринковою і реагують
 * еластично. Але ставка — не єдиний аргумент: у кризу спрацьовує репутація, і
 * банк із поганою репутацією не збере пасив навіть за подвійну ціну.
 */

import {
  ACC,
  BaseModule,
  CoreEvents,
  PRIORITY,
  add,
  allocate,
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
  type BankRunEvent,
  type DepositsOpenedEvent,
  type DepositsWithdrawnEvent,
  type PortfolioInheritedEvent,
} from './events.ts';

/** Одна когорта строкових депозитів — усе, що залучено за один тиждень. */
export interface DepositCohort {
  /** Тиждень залучення. */
  readonly openedWeek: number;
  /** Ставка, зафіксована в договорі. Зміна ринкової ставки її не чіпає. */
  readonly rate: number;
  readonly termWeeks: number;
  /** Тіло вкладу, що залишилось. */
  principal: Money;
  /** Нараховані, але не виплачені відсотки. */
  accrued: Money;
  /** Скільки тижнів минуло від залучення. */
  age: number;
}

export interface RetailDepositsConfig {
  /** Скільки гривень на тиждень готовий принести ринок за ринковою ставкою. */
  readonly baseWeeklyInflow: Money;
  /** Еластичність попиту за ставкою: 2 означає, що +10% до ставки дає ~+21% припливу. */
  readonly rateElasticity?: number;
  /** Строк депозиту в тижнях (12 тижнів ≈ 3 місяці). */
  readonly termWeeks?: number;
  /** Частка вкладу, яку клієнт приносить готівкою в касу. */
  readonly cashShare?: number;
  /** Базова частка когорти, що продовжує депозит на новий строк. */
  readonly baseRolloverRate?: number;
  /** Тижневий природний відтік коштів з поточних рахунків. */
  readonly currentAccountChurn?: number;
  /** Тижневий приплив на поточні рахунки як частка від наявного залишку. */
  readonly currentAccountGrowth?: number;
  /** Стартова ставка за строковими вкладами (частка від ринкової). */
  readonly initialTermRateFactor?: number;
  /** Ставка за поточними рахунками. */
  readonly initialCurrentRate?: number;
}

export interface RetailDepositsState {
  cohorts: DepositCohort[];
  /** Ставка, яку банк пропонує зараз за строковими вкладами. */
  termRate: number;
  /** Ставка за поточними рахунками. */
  currentAccountRate: number;
  /** Сукупний приплив за весь час — для аналітики. */
  totalRaised: Money;
  /** Сукупний відтік. */
  totalWithdrawn: Money;
  /** Інтенсивність паніки 0..1: наскільки активно вкладники забирають кошти. */
  panic: number;
}

export const RETAIL_DEPOSITS_SLICE = 'retail-deposits';

const DEFAULTS = {
  rateElasticity: 2.2,
  termWeeks: 12,
  cashShare: 0.45,
  baseRolloverRate: 0.55,
  currentAccountChurn: 0.06,
  currentAccountGrowth: 0.045,
  initialTermRateFactor: 1,
  initialCurrentRate: 0.01,
} as const;

export class RetailDepositsModule extends BaseModule {
  readonly id = RETAIL_DEPOSITS_SLICE;
  readonly title = 'Депозити фізичних осіб';
  readonly #config: Required<RetailDepositsConfig>;

  constructor(config: RetailDepositsConfig) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  setup(ctx: SimContext): void {
    const state = ctx.state.registerSlice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE, {
      cohorts: [],
      termRate: ctx.macro.marketDepositRate * this.#config.initialTermRateFactor,
      currentAccountRate: this.#config.initialCurrentRate,
      totalRaised: zero('UAH'),
      totalWithdrawn: zero('UAH'),
      panic: 0,
    });

    ctx.bus.on<WeekEvent>(CoreEvents.weekMain, () => this.#weekMain(ctx, state), {
      priority: PRIORITY.product,
      owner: this.id,
    });
    ctx.bus.on<WeekEvent>(CoreEvents.weekAccrual, () => this.#accrue(ctx, state), {
      priority: PRIORITY.accrual,
      owner: this.id,
    });
    ctx.bus.on<PeriodEvent>(CoreEvents.monthEnd, () => this.#reportMonth(ctx, state), {
      priority: PRIORITY.reporting,
      owner: this.id,
    });

    ctx.bus.on<PortfolioInheritedEvent>(
      BankEvents.portfolioInherited,
      (event: PortfolioInheritedEvent) => this.#adoptInherited(ctx, state, event),
      { priority: PRIORITY.macro + 1, owner: this.id },
    );

    ctx.contributeToRatios(() => ({
      shortTermLiabilities: shortTermDepositLiabilities(ctx, state),
    }));
  }

  /**
   * Взяття під управління успадкованого портфеля вкладів. Проводок не робимо —
   * гроші вже на рахунку 2630. Розбиваємо портфель на когорти з різними строками
   * погашення, інакше весь пасив банку доведеться повертати в один тиждень.
   */
  #adoptInherited(ctx: SimContext, state: RetailDepositsState, event: PortfolioInheritedEvent): void {
    if (!isPositive(event.termDeposits)) return;
    const buckets = Math.max(1, event.maxRemainingWeeks);
    const slices = allocate(event.termDeposits, buckets);
    slices.forEach((principal, index) => {
      if (!isPositive(principal)) return;
      state.cohorts.push({
        openedWeek: ctx.week,
        rate: event.termDepositRate,
        // Строк когорти задаємо рівним драбині погашення, а вік — так, щоб
        // когорта з індексом i дозріла через i+1 тижнів. Успадкований портфель
        // має погашатись поступово, як реальна депозитна база, а не одним днем.
        termWeeks: buckets,
        principal,
        accrued: zero('UAH'),
        age: buckets - (index + 1),
      });
    });
    ctx.log(
      `Прийнято під управління портфель вкладів на ${formatMoney(event.termDeposits)} ` +
        `під ${(event.termDepositRate * 100).toFixed(1)}% річних`,
    );
  }

  // --- Керування з боку гравця -------------------------------------------

  /** Встановити ставку за строковими вкладами. */
  static setTermRate(ctx: SimContext, rate: number): void {
    const state = ctx.state.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    state.termRate = Math.max(0, rate);
  }

  static setCurrentAccountRate(ctx: SimContext, rate: number): void {
    const state = ctx.state.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    state.currentAccountRate = Math.max(0, rate);
  }

  // --- Тижневий такт -------------------------------------------------------

  #weekMain(ctx: SimContext, state: RetailDepositsState): void {
    this.#updatePanic(ctx, state);
    this.#matureCohorts(ctx, state);
    this.#currentAccountFlows(ctx, state);
    this.#raiseNewDeposits(ctx, state);
    for (const cohort of state.cohorts) cohort.age += 1;
  }

  /**
   * Паніка вкладників. Зростає від макростресу і низької репутації, згасає, доки
   * банк справно платить. Це те, що в ТЗ описано як bank run: інформаційна атака
   * плюс порожні банкомати подвоюють ефект.
   */
  #updatePanic(ctx: SimContext, state: RetailDepositsState): void {
    const pressure = ctx.macro.stress * (1.3 - ctx.state.reputation);
    const target = Math.min(1, Math.max(0, pressure - 0.25));
    // Паніка наростає швидше, ніж вщухає: довіру втрачають за тиждень, а
    // повертають місяцями.
    state.panic = target > state.panic ? state.panic + (target - state.panic) * 0.6 : state.panic * 0.85;
    if (state.panic > 0.35) {
      const outflow = scale(this.#termPortfolio(state), state.panic * 0.08);
      if (isPositive(outflow)) {
        this.#withdrawEarly(ctx, state, outflow);
        const event: BankRunEvent = {
          type: BankEvents.depositRun,
          week: ctx.week,
          intensity: state.panic,
          outflow,
        };
        ctx.emit(event);
        ctx.log(
          `Паніка вкладників (${(state.panic * 100).toFixed(0)}%): достроково забрано ${formatMoney(outflow)}`,
          'warning',
        );
      }
    }
  }

  /** Дострокове розірвання: клієнт втрачає нараховані відсотки. */
  #withdrawEarly(ctx: SimContext, state: RetailDepositsState, requested: Money): void {
    let remaining = requested;
    for (const cohort of state.cohorts) {
      if (!isPositive(remaining)) break;
      const take = min(cohort.principal, remaining);
      if (!isPositive(take)) continue;
      const share = take.minor / cohort.principal.minor;
      // Достроково розірваний вклад втрачає нараховані відсотки: сторнуємо їх,
      // інакше нарахування зависне на рахунку 2638 назавжди.
      const forfeited = scale(cohort.accrued, share);
      if (isPositive(forfeited)) {
        ctx.post({
          narrative: 'Сторнування відсотків за достроково розірваними вкладами',
          postings: [
            debit(ACC.accruedDepositExpense, forfeited),
            credit(ACC.interestExpenseTermRetail, forfeited),
          ],
        });
        cohort.accrued = subtract(cohort.accrued, forfeited);
      }
      cohort.principal = subtract(cohort.principal, take);
      remaining = subtract(remaining, take);
      this.#payOut(ctx, state, take, ACC.termDepositsRetail, 'panic');
    }
    state.cohorts = state.cohorts.filter((c) => isPositive(c.principal));
  }

  /** Погашення когорт, у яких закінчився строк, з урахуванням пролонгації. */
  #matureCohorts(ctx: SimContext, state: RetailDepositsState): void {
    const matured = state.cohorts.filter((c) => c.age >= c.termWeeks);
    if (matured.length === 0) return;
    state.cohorts = state.cohorts.filter((c) => c.age < c.termWeeks);

    for (const cohort of matured) {
      // Клієнт продовжує вклад тим охочіше, чим краща ставка і репутація банку.
      const attractiveness = cohort.rate / Math.max(0.001, ctx.macro.marketDepositRate);
      const rollover = Math.min(
        0.92,
        Math.max(
          0,
          this.#config.baseRolloverRate * attractiveness * ctx.state.reputation * (1 - state.panic) * 1.6,
        ),
      );
      const rolled = scale(cohort.principal, rollover);
      const repaid = subtract(cohort.principal, rolled);

      // Відсотки виплачуються завжди — і за продовженим вкладом теж.
      if (isPositive(cohort.accrued)) {
        ctx.post({
          narrative: 'Виплата нарахованих відсотків за строковими вкладами',
          postings: [
            debit(ACC.accruedDepositExpense, cohort.accrued),
            credit(ACC.currentAccountsRetail, cohort.accrued),
          ],
        });
      }
      if (isPositive(repaid)) {
        // Непролонгований вклад іде з банку: клієнт забирає гроші готівкою або
        // переказує їх туди, де ставка краща. Залишати їх на поточному рахунку
        // означало б подарувати банку безкоштовне фондування, якого немає.
        this.#payOut(ctx, state, repaid, ACC.termDepositsRetail, 'maturity');
      }
      if (isPositive(rolled)) {
        state.cohorts.push({
          openedWeek: ctx.week,
          rate: state.termRate,
          termWeeks: this.#config.termWeeks,
          principal: rolled,
          accrued: zero('UAH'),
          age: 0,
        });
      }
    }
  }

  /**
   * Рух коштів на поточних рахунках. Приплив пропорційний впізнаваності бренду,
   * відтік зростає в паніку. Виплати з поточних рахунків забирають готівку з
   * каси — саме тут виникає потреба в інкасації.
   */
  #currentAccountFlows(ctx: SimContext, state: RetailDepositsState): void {
    const balance = ctx.journal.balance(ACC.currentAccountsRetail, 'UAH');
    const inflow = scale(
      add(balance, scale(this.#config.baseWeeklyInflow, 0.3)),
      this.#config.currentAccountGrowth * (0.4 + ctx.state.brandAwareness) * ctx.rng.lognormalFactor(0.15),
    );
    if (isPositive(inflow)) {
      const cashPortion = scale(inflow, this.#config.cashShare);
      const wire = subtract(inflow, cashPortion);
      ctx.post({
        narrative: 'Надходження коштів на поточні рахунки фізичних осіб',
        postings: [
          ...(isPositive(cashPortion) ? [debit(ACC.cashVault, cashPortion)] : []),
          ...(isPositive(wire) ? [debit(ACC.nostroNbu, wire)] : []),
          credit(ACC.currentAccountsRetail, inflow),
        ],
      });
    }

    const churn = this.#config.currentAccountChurn * (1 + state.panic * 3);
    const outflow = min(scale(balance, churn * ctx.rng.lognormalFactor(0.2)), balance);
    if (isPositive(outflow)) {
      this.#payOut(ctx, state, outflow, ACC.currentAccountsRetail, state.panic > 0.35 ? 'panic' : 'attrition');
    }
  }

  /**
   * Виплата клієнту: спершу готівкою з каси (скільки її є), решта — переказом
   * з кореспондентського рахунку. Якщо каса порожня, банк платить безготівково,
   * але клієнт цього не пробачає — репутація просідає.
   */
  #payOut(
    ctx: SimContext,
    state: RetailDepositsState,
    amount: Money,
    sourceAccount: string,
    reason: DepositsWithdrawnEvent['reason'],
  ): void {
    const wantCash = scale(amount, this.#config.cashShare);
    const vault = ctx.journal.balance(ACC.cashVault, 'UAH');
    const cash = min(wantCash, vault);
    const wire = subtract(amount, cash);

    ctx.post({
      narrative:
        reason === 'panic'
          ? 'Дострокове зняття коштів фізичними особами'
          : 'Зняття коштів з поточних рахунків фізичних осіб',
      postings: [
        debit(sourceAccount, amount),
        ...(isPositive(cash) ? [credit(ACC.cashVault, cash)] : []),
        ...(isPositive(wire) ? [credit(ACC.nostroNbu, wire)] : []),
      ],
    });

    state.totalWithdrawn = add(state.totalWithdrawn, amount);
    const unmet = wantCash.minor === 0 ? 0 : 1 - cash.minor / wantCash.minor;
    // Дрібна нестача готівки — це черга, а не скандал. Репутація страждає лише
    // тоді, коли каса не може видати помітну частину того, по що прийшли люди.
    if (unmet > 0.2) {
      ctx.state.adjustReputation(-0.004 * (unmet - 0.2));
    }
    const event: DepositsWithdrawnEvent = {
      type: BankEvents.depositsWithdrawn,
      amount,
      requestedCash: wantCash,
      cashPortion: cash,
      reason,
    };
    ctx.emit(event);
  }

  /** Залучення нових строкових вкладів за поточною ставкою банку. */
  #raiseNewDeposits(ctx: SimContext, state: RetailDepositsState): void {
    const marketRate = Math.max(0.001, ctx.macro.marketDepositRate);
    const competitiveness = Math.pow(state.termRate / marketRate, this.#config.rateElasticity);
    // Репутація і впізнаваність — не бонус, а множник: невідомий банк із
    // найкращою ставкою збирає менше, ніж відомий із середньою.
    const trust = ctx.state.reputation * (0.35 + 0.65 * ctx.state.brandAwareness);
    const demandFactor =
      competitiveness * trust * (1 - state.panic) * ctx.rng.lognormalFactor(0.25);
    const inflow = scale(this.#config.baseWeeklyInflow, Math.max(0, demandFactor));
    if (!isPositive(inflow)) return;

    const cashPortion = scale(inflow, this.#config.cashShare);
    const wire = subtract(inflow, cashPortion);
    ctx.post({
      narrative: `Залучення строкових вкладів фізичних осіб під ${(state.termRate * 100).toFixed(1)}%`,
      postings: [
        ...(isPositive(cashPortion) ? [debit(ACC.cashVault, cashPortion)] : []),
        ...(isPositive(wire) ? [debit(ACC.nostroNbu, wire)] : []),
        credit(ACC.termDepositsRetail, inflow),
      ],
    });

    state.cohorts.push({
      openedWeek: ctx.week,
      rate: state.termRate,
      termWeeks: this.#config.termWeeks,
      principal: inflow,
      accrued: zero('UAH'),
      age: 0,
    });
    state.totalRaised = add(state.totalRaised, inflow);

    const event: DepositsOpenedEvent = {
      type: BankEvents.depositsOpened,
      amount: inflow,
      cashPortion,
      rate: state.termRate,
      termWeeks: this.#config.termWeeks,
    };
    ctx.emit(event);
  }

  /**
   * Нарахування відсотків. Строкові вклади нараховуються за ставкою договору,
   * поточні рахунки — за поточною ставкою банку.
   */
  #accrue(ctx: SimContext, state: RetailDepositsState): void {
    const termInterest = sum(
      state.cohorts.map((cohort) => {
        const interest = weeklyInterest(cohort.principal, cohort.rate);
        cohort.accrued = add(cohort.accrued, interest);
        return interest;
      }),
      'UAH',
    );
    if (isPositive(termInterest)) {
      ctx.post({
        narrative: 'Нарахування процентних витрат за строковими вкладами',
        postings: [
          debit(ACC.interestExpenseTermRetail, termInterest),
          credit(ACC.accruedDepositExpense, termInterest),
        ],
      });
    }

    const currentBalance = ctx.journal.balance(ACC.currentAccountsRetail, 'UAH');
    const currentInterest = weeklyInterest(currentBalance, state.currentAccountRate);
    if (isPositive(currentInterest)) {
      ctx.post({
        narrative: 'Нарахування процентних витрат за поточними рахунками',
        postings: [
          debit(ACC.interestExpenseCurrent, currentInterest),
          credit(ACC.currentAccountsRetail, currentInterest),
        ],
      });
    }
  }

  #termPortfolio(state: RetailDepositsState): Money {
    return sum(
      state.cohorts.map((c) => c.principal),
      'UAH',
    );
  }

  #reportMonth(ctx: SimContext, state: RetailDepositsState): void {
    const term = this.#termPortfolio(state);
    const current = ctx.journal.balance(ACC.currentAccountsRetail, 'UAH');
    ctx.log(
      `Пасиви населення: строкові ${formatMoney(term)}, до запитання ${formatMoney(current)}, ` +
        `ставка ${(state.termRate * 100).toFixed(1)}% проти ринкових ${(ctx.macro.marketDepositRate * 100).toFixed(1)}%`,
    );
  }
}

/** Сукупний портфель строкових вкладів — використовується звітністю і нормативами. */
export function termDepositPortfolio(state: RetailDepositsState): Money {
  return sum(
    state.cohorts.map((c) => c.principal),
    'UAH',
  );
}

/** Частка пасивів, що погашається протягом наступних 12 тижнів (для Н6). */
export function shortTermDepositLiabilities(ctx: SimContext, state: RetailDepositsState): Money {
  const maturingSoon = sum(
    state.cohorts.filter((c) => c.termWeeks - c.age <= 12).map((c) => c.principal),
    'UAH',
  );
  // Кошти до запитання вважаються короткостроковими повністю.
  return add(maturingSoon, ctx.journal.balance(ACC.currentAccountsRetail, 'UAH'));
}

export function createRetailDeposits(config: RetailDepositsConfig): RetailDepositsModule {
  return new RetailDepositsModule(config);
}
