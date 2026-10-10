/**
 * Роздрібне кредитування: кредити готівкою та кредитні картки.
 *
 * Бізнес закону великих чисел: жоден окремий позичальник не важливий, важлива
 * налаштована гравцем "воронка". Гравець рухає один повзунок — поріг скорингу —
 * і отримує класичний банківський компроміс: суворий поріг дає чистий портфель
 * і мало обсягу, м'який — вибухове зростання і NPL, який прилетить за півроку.
 *
 * Портфель ведеться когортами (вінтажами): усе, видане за один тиждень, живе як
 * єдина одиниця і мігрує по стадіях знецінення. Це і швидко, і відповідає тому,
 * як ризиковики реально дивляться на роздріб — по вінтажах, а не по клієнтах.
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
  ratio,
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
import { BankEvents, type LoanIssuedEvent, type LoanWrittenOffEvent } from './events.ts';

export type LoanProduct = 'cash-loan' | 'credit-card';

/**
 * Стадії знецінення за логікою МСФЗ 9, спрощені до трьох:
 *   stage1 — обслуговується вчасно;
 *   stage2 — прострочення 30-89 днів, ризик зріс, але кредит ще живий;
 *   stage3 — NPL, прострочення 90+ днів.
 */
export interface LoanCohort {
  readonly product: LoanProduct;
  readonly originatedWeek: number;
  readonly rate: number;
  readonly termWeeks: number;
  /** Очікувана річна дефолтність, зафіксована порогом скорингу на видачі. */
  readonly annualPd: number;
  stage1: Money;
  stage2: Money;
  stage3: Money;
  /** Нараховані, але не отримані відсотки. */
  accrued: Money;
  age: number;
  /** Скільки тижнів когорта має кредити в стадії 3 — для списання. */
  weeksInDefault: number;
}

export interface RetailLendingConfig {
  /** Скільки гривень на тиждень просить ринок за ринковою ставкою. */
  readonly baseWeeklyDemand: Money;
  /** Строк кредиту готівкою в тижнях. */
  readonly cashLoanTermWeeks?: number;
  /** Частка попиту, що припадає на кредитні картки (револьверний борг). */
  readonly cardShare?: number;
  /** Стартовий поріг скорингу 0..1: 0 — беремо всіх, 1 — майже нікого. */
  readonly initialScoringCutoff?: number;
  /** Націнка банку до ринкової ставки за кредитами. */
  readonly initialRateSpread?: number;
  /** Скільки тижнів кредит лежить у стадії 3 до списання. */
  readonly writeOffAfterWeeks?: number;
  /** Чи є інтеграція з бюро кредитних історій — знижує дефолтність. */
  readonly creditBureau?: boolean;
  /**
   * Яку частку виданого кредиту позичальник витрачає одразу — знімає готівкою
   * або платить нею в чужих магазинах. Ці гроші йдуть з банку, і саме тому
   * кредитування споживає ліквідність, а не створює її.
   */
  readonly spendShare?: number;
  /** Яка частина розрахунків із позичальниками проходить готівкою через касу. */
  readonly cashShare?: number;
}

export interface RetailLendingState {
  cohorts: LoanCohort[];
  /** Поріг скорингу 0..1. Головний важіль ризик-апетиту. */
  scoringCutoff: number;
  /** Ставка за кредитами готівкою. */
  cashLoanRate: number;
  /** Ставка за кредитними картками. */
  cardRate: number;
  creditBureau: boolean;
  totalIssued: Money;
  totalWrittenOff: Money;
  /** Сформований резерв — дзеркало рахунку 2400, потрібне для дельти. */
  provisionTarget: Money;
}

export const RETAIL_LENDING_SLICE = 'retail-lending';

const DEFAULTS = {
  cashLoanTermWeeks: 48,
  cardShare: 0.35,
  initialScoringCutoff: 0.5,
  initialRateSpread: 0.06,
  writeOffAfterWeeks: 52,
  creditBureau: false,
  spendShare: 0.9,
  cashShare: 0.4,
} as const;

/**
 * Коефіцієнти покриття резервами за стадіями. Значення відповідають типовому
 * рівню покриття незабезпеченої роздрібки в українських банках.
 */
export const PROVISION_COVERAGE: Readonly<Record<'stage1' | 'stage2' | 'stage3', number>> = {
  stage1: 0.02,
  stage2: 0.2,
  stage3: 0.85,
};

/**
 * Річна дефольтність як функція порогу скорингу.
 *
 * При cutoff = 0 банк видає всім підряд і отримує ~35% дефолтів на рік — рівень,
 * на якому в Україні згорали агресивні кеш-кредитні програми. При cutoff = 1
 * лишається ~2%: зарплатні клієнти з підтвердженим доходом.
 */
export function pdForCutoff(cutoff: number, creditBureau: boolean): number {
  const clamped = Math.min(1, Math.max(0, cutoff));
  const base = 0.02 + 0.33 * Math.pow(1 - clamped, 1.8);
  // Бюро кредитних історій відсіює тих, хто вже не платить іншим банкам.
  return creditBureau ? base * 0.75 : base;
}

/** Частка заявок, які проходять скоринг при заданому порозі. */
export function approvalRateForCutoff(cutoff: number): number {
  const clamped = Math.min(1, Math.max(0, cutoff));
  return Math.max(0.03, 0.95 * Math.pow(1 - clamped, 0.9));
}

export class RetailLendingModule extends BaseModule {
  readonly id = RETAIL_LENDING_SLICE;
  readonly title = 'Роздрібне кредитування';
  readonly #config: Required<RetailLendingConfig>;

  constructor(config: RetailLendingConfig) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  setup(ctx: SimContext): void {
    const state = ctx.state.registerSlice<RetailLendingState>(RETAIL_LENDING_SLICE, {
      cohorts: [],
      scoringCutoff: this.#config.initialScoringCutoff,
      cashLoanRate: ctx.macro.marketLoanRate + this.#config.initialRateSpread,
      cardRate: ctx.macro.marketLoanRate + this.#config.initialRateSpread + 0.12,
      creditBureau: this.#config.creditBureau,
      totalIssued: zero('UAH'),
      totalWrittenOff: zero('UAH'),
      provisionTarget: zero('UAH'),
    });

    ctx.bus.on<WeekEvent>(CoreEvents.weekMain, () => this.#weekMain(ctx, state), {
      priority: PRIORITY.product,
      owner: this.id,
    });
    ctx.bus.on<WeekEvent>(CoreEvents.weekAccrual, () => this.#accrue(ctx, state), {
      priority: PRIORITY.accrual,
      owner: this.id,
    });
    ctx.bus.on<PeriodEvent>(CoreEvents.monthEnd, () => this.#monthEnd(ctx, state), {
      priority: PRIORITY.accrual,
      owner: this.id,
    });

    ctx.contributeToRatios(() => ({ nonPerformingLoans: nonPerformingLoans(state) }));
  }

  // --- Керування з боку гравця -------------------------------------------

  /** Пересунути поріг скорингу. Ефект на портфель — з лагом у кілька місяців. */
  static setScoringCutoff(ctx: SimContext, cutoff: number): void {
    const state = ctx.state.slice<RetailLendingState>(RETAIL_LENDING_SLICE);
    state.scoringCutoff = Math.min(1, Math.max(0, cutoff));
  }

  static setRates(ctx: SimContext, rates: { cashLoan?: number; card?: number }): void {
    const state = ctx.state.slice<RetailLendingState>(RETAIL_LENDING_SLICE);
    if (rates.cashLoan !== undefined) state.cashLoanRate = Math.max(0, rates.cashLoan);
    if (rates.card !== undefined) state.cardRate = Math.max(0, rates.card);
  }

  /** Підключити бюро кредитних історій. */
  static enableCreditBureau(ctx: SimContext): void {
    ctx.state.slice<RetailLendingState>(RETAIL_LENDING_SLICE).creditBureau = true;
  }

  // --- Тижневий такт -------------------------------------------------------

  #weekMain(ctx: SimContext, state: RetailLendingState): void {
    this.#collectRepayments(ctx, state);
    this.#migrateDelinquency(ctx, state);
    this.#writeOffBadDebt(ctx, state);
    this.#originate(ctx, state);
    for (const cohort of state.cohorts) cohort.age += 1;
    state.cohorts = state.cohorts.filter(
      (c) => isPositive(c.stage1) || isPositive(c.stage2) || isPositive(c.stage3),
    );
  }

  /** Видача нових кредитів за поточними ставками і порогом скорингу. */
  #originate(ctx: SimContext, state: RetailLendingState): void {
    const marketRate = Math.max(0.01, ctx.macro.marketLoanRate);
    // Попит падає, коли ставка вища за ринок, і зростає, коли нижча.
    const priceFactor = Math.pow(marketRate / Math.max(0.01, state.cashLoanRate), 1.6);
    const reach = 0.3 + 0.7 * ctx.state.brandAwareness;
    // У кризу люди беруть менше кредитів, а банки й самі підтискають видачі.
    const cycle = 1 - ctx.macro.stress * 0.55;
    const approval = approvalRateForCutoff(state.scoringCutoff);
    const volume = scale(
      this.#config.baseWeeklyDemand,
      Math.max(0, priceFactor * reach * cycle * approval * ctx.rng.lognormalFactor(0.3)),
    );
    if (!isPositive(volume)) return;

    const pd = pdForCutoff(state.scoringCutoff, state.creditBureau);
    const cardVolume = scale(volume, this.#config.cardShare);
    const cashVolume = subtract(volume, cardVolume);

    for (const [product, amount, rate, term] of [
      ['cash-loan', cashVolume, state.cashLoanRate, this.#config.cashLoanTermWeeks],
      // Картковий борг револьверний: моделюємо як довгий кредит із вищою ставкою.
      ['credit-card', cardVolume, state.cardRate, this.#config.cashLoanTermWeeks * 2],
    ] as const) {
      if (!isPositive(amount)) continue;
      const loanAccount = product === 'cash-loan' ? ACC.loansRetailCash : ACC.loansRetailCards;
      ctx.post({
        narrative:
          product === 'cash-loan'
            ? `Видача кредитів готівкою під ${(rate * 100).toFixed(1)}%`
            : `Встановлення лімітів за кредитними картками під ${(rate * 100).toFixed(1)}%`,
        postings: [
          debit(loanAccount, amount),
          // Кредит зараховується на поточний рахунок клієнта — гроші лишаються
          // в банку як пасив, доки клієнт їх не витратить.
          credit(ACC.currentAccountsRetail, amount),
        ],
      });
      state.cohorts.push({
        product,
        originatedWeek: ctx.week,
        rate,
        termWeeks: term,
        annualPd: product === 'credit-card' ? pd * 1.25 : pd,
        stage1: amount,
        stage2: zero('UAH'),
        stage3: zero('UAH'),
        accrued: zero('UAH'),
        age: 0,
        weeksInDefault: 0,
      });
      this.#spendProceeds(ctx, amount);
      state.totalIssued = add(state.totalIssued, amount);
      const event: LoanIssuedEvent = {
        type: BankEvents.loanIssued,
        product,
        amount,
        rate,
        expectedLoss: pd * PROVISION_COVERAGE.stage3,
      };
      ctx.emit(event);
    }
  }

  /**
   * Планове погашення тіла. Кредит гаситься рівномірно за строком (спрощений
   * ануїтет) і лише тією частиною портфеля, що обслуговується: стадія 2 платить
   * нерегулярно, стадія 3 не платить взагалі.
   */
  #collectRepayments(ctx: SimContext, state: RetailLendingState): void {
    let principalRepaid = zero('UAH');
    for (const cohort of state.cohorts) {
      const remainingWeeks = Math.max(1, cohort.termWeeks - cohort.age);
      const payment = min(scale(cohort.stage1, 1 / remainingWeeks), cohort.stage1);
      if (!isPositive(payment)) continue;
      cohort.stage1 = subtract(cohort.stage1, payment);
      principalRepaid = add(principalRepaid, payment);
    }
    if (!isPositive(principalRepaid)) return;
    ctx.post({
      narrative: 'Планове погашення тіла кредитів фізичними особами',
      postings: [
        // Позичальник приносить гроші ззовні — частину готівкою в касу,
        // частину переказом із зарплатного рахунку в іншому банку.
        ...this.#receiveFunds(principalRepaid),
        ...this.#splitByProduct(state, principalRepaid).map(([account, amount]) => credit(account, amount)),
      ],
    });
  }

  /**
   * Витрачання кредитних коштів. Гроші, зараховані на рахунок позичальника, не
   * лишаються в банку: він знімає їх у банкоматі або розраховується в чужому
   * магазині. Без цієї проводки видані кредити перетворювались би на безкоштовне
   * фондування — помилка, яка робить будь-яку банківську модель занадто щедрою.
   */
  #spendProceeds(ctx: SimContext, amount: Money): void {
    const spent = scale(amount, this.#config.spendShare);
    if (!isPositive(spent)) return;
    const wantCash = scale(spent, this.#config.cashShare);
    const vault = ctx.journal.balance(ACC.cashVault, 'UAH');
    const cash = min(wantCash, vault);
    const wire = subtract(spent, cash);
    ctx.post({
      narrative: 'Використання кредитних коштів позичальниками',
      postings: [
        debit(ACC.currentAccountsRetail, spent),
        ...(isPositive(cash) ? [credit(ACC.cashVault, cash)] : []),
        ...(isPositive(wire) ? [credit(ACC.nostroNbu, wire)] : []),
      ],
    });
  }

  /** Надходження коштів від позичальників: частина готівкою, частина переказом. */
  #receiveFunds(amount: Money): ReturnType<typeof debit>[] {
    const cash = scale(amount, this.#config.cashShare);
    const wire = subtract(amount, cash);
    return [
      ...(isPositive(cash) ? [debit(ACC.cashVault, cash)] : []),
      ...(isPositive(wire) ? [debit(ACC.nostroNbu, wire)] : []),
    ];
  }

  /**
   * Сплата відсотків — раз на фінансовий місяць. Платить та частина портфеля,
   * що обслуговується; нараховане на проблемну заборгованість лишається на
   * рахунку 2208 і сторнується під час списання.
   */
  #collectInterest(ctx: SimContext, state: RetailLendingState): void {
    let received = zero('UAH');
    for (const cohort of state.cohorts) {
      if (!isPositive(cohort.accrued)) continue;
      const outstanding = add(add(cohort.stage1, cohort.stage2), cohort.stage3);
      const performingShare = isPositive(outstanding)
        ? ratio(add(cohort.stage1, scale(cohort.stage2, 0.4)), outstanding)
        : 1;
      const collected = scale(cohort.accrued, Math.min(1, performingShare));
      if (!isPositive(collected)) continue;
      cohort.accrued = subtract(cohort.accrued, collected);
      received = add(received, collected);
    }
    if (!isPositive(received)) return;
    ctx.post({
      narrative: 'Сплата відсотків за кредитами фізичних осіб',
      postings: [...this.#receiveFunds(received), credit(ACC.accruedRetailInterest, received)],
    });
  }

  /**
   * Розподіл суми між рахунками 2202 і 2207 пропорційно до частки продуктів у
   * портфелі: одна проводка не має "змішувати" кеш-кредити з картками.
   */
  #splitByProduct(state: RetailLendingState, amount: Money): [string, Money][] {
    if (!isPositive(amount)) return [];
    const cardPortfolio = sum(
      state.cohorts.filter((c) => c.product === 'credit-card').map((c) => c.stage1),
      'UAH',
    );
    const cashPortfolio = sum(
      state.cohorts.filter((c) => c.product === 'cash-loan').map((c) => c.stage1),
      'UAH',
    );
    const total = add(cardPortfolio, cashPortfolio);
    if (!isPositive(total)) return [[ACC.loansRetailCash, amount]];
    const cardPart = scale(amount, ratio(cardPortfolio, total));
    const cashPart = subtract(amount, cardPart);
    const result: [string, Money][] = [];
    if (isPositive(cashPart)) result.push([ACC.loansRetailCash, cashPart]);
    if (isPositive(cardPart)) result.push([ACC.loansRetailCards, cardPart]);
    return result;
  }

  /**
   * Міграція прострочення. Тижнева ймовірність виходу в прострочення виводиться
   * з річної PD, помноженої на макрострес: у кризу платити перестають ті, хто в
   * спокійний рік платив би справно.
   */
  #migrateDelinquency(ctx: SimContext, state: RetailLendingState): void {
    const stressMultiplier = 1 + ctx.macro.stress * 1.8;
    for (const cohort of state.cohorts) {
      // Крива дефолтності роздрібу: пік припадає на 3-9 місяць життя кредиту.
      const seasoning = Math.min(1.6, 0.25 + cohort.age / 20);
      const weeklyPd = (cohort.annualPd / 52) * stressMultiplier * seasoning;
      const toStage2 = scale(cohort.stage1, Math.min(0.25, weeklyPd * ctx.rng.lognormalFactor(0.2)));
      if (isPositive(toStage2)) {
        cohort.stage1 = subtract(cohort.stage1, toStage2);
        cohort.stage2 = add(cohort.stage2, toStage2);
      }
      // Зі стадії 2 частина повертається до нормального обслуговування (cure),
      // решта йде в NPL. Хороший колекшн — це саме про cure rate.
      const cureRate = 0.22 * (1 - ctx.macro.stress * 0.5);
      const cured = scale(cohort.stage2, cureRate);
      const defaulted = scale(subtract(cohort.stage2, cured), 0.33);
      if (isPositive(cured)) {
        cohort.stage2 = subtract(cohort.stage2, cured);
        cohort.stage1 = add(cohort.stage1, cured);
      }
      if (isPositive(defaulted)) {
        cohort.stage2 = subtract(cohort.stage2, defaulted);
        cohort.stage3 = add(cohort.stage3, defaulted);
      }
      cohort.weeksInDefault = isPositive(cohort.stage3) ? cohort.weeksInDefault + 1 : 0;
    }
  }

  /**
   * Списання безнадійної заборгованості за рахунок резерву. Баланс очищається,
   * фінрезультат не страждає — збиток був визнаний раніше, коли формувався резерв.
   */
  #writeOffBadDebt(ctx: SimContext, state: RetailLendingState): void {
    let written = zero('UAH');
    let reversedInterest = zero('UAH');
    const perAccount = new Map<string, Money>();
    for (const cohort of state.cohorts) {
      if (cohort.weeksInDefault < this.#config.writeOffAfterWeeks || !isPositive(cohort.stage3)) continue;
      const amount = cohort.stage3;
      const account = cohort.product === 'cash-loan' ? ACC.loansRetailCash : ACC.loansRetailCards;
      perAccount.set(account, add(perAccount.get(account) ?? zero('UAH'), amount));
      written = add(written, amount);
      cohort.stage3 = zero('UAH');
      cohort.weeksInDefault = 0;
      // Нараховані, але вже безнадійні відсотки визнаються витратами: тримати їх
      // активом на рахунку 2208 після списання тіла було б малюванням балансу.
      if (isPositive(cohort.accrued)) {
        reversedInterest = add(reversedInterest, cohort.accrued);
        cohort.accrued = zero('UAH');
      }
    }
    if (isPositive(reversedInterest)) {
      ctx.post({
        narrative: 'Сторнування нарахованих відсотків за списаними кредитами',
        postings: [
          debit(ACC.provisionCharge, reversedInterest),
          credit(ACC.accruedRetailInterest, reversedInterest),
        ],
      });
    }
    if (!isPositive(written)) return;

    const allowance = ctx.journal.balance(ACC.loanLossAllowance, 'UAH');
    const covered = min(written, allowance);
    const uncovered = subtract(written, covered);
    ctx.post({
      narrative: 'Списання безнадійної заборгованості за рахунок резерву',
      postings: [
        ...(isPositive(covered) ? [debit(ACC.loanLossAllowance, covered)] : []),
        // Якщо резерву не вистачило, різниця йде прямо у витрати періоду.
        ...(isPositive(uncovered) ? [debit(ACC.provisionCharge, uncovered)] : []),
        ...[...perAccount].map(([account, amount]) => credit(account, amount)),
      ],
    });
    state.totalWrittenOff = add(state.totalWrittenOff, written);
    const event: LoanWrittenOffEvent = { type: BankEvents.loanWrittenOff, amount: written };
    ctx.emit(event);
    ctx.log(`Списано безнадійних кредитів на ${formatMoney(written)}`, 'warning');
  }

  /** Нарахування процентних доходів. Стадія 3 доходу не генерує. */
  #accrue(ctx: SimContext, state: RetailLendingState): void {
    let total = zero('UAH');
    for (const cohort of state.cohorts) {
      const earning = add(cohort.stage1, scale(cohort.stage2, 0.5));
      const interest = weeklyInterest(earning, cohort.rate);
      if (!isPositive(interest)) continue;
      cohort.accrued = add(cohort.accrued, interest);
      total = add(total, interest);
    }
    if (!isPositive(total)) return;
    ctx.post({
      narrative: 'Нарахування процентних доходів за кредитами фізичних осіб',
      postings: [debit(ACC.accruedRetailInterest, total), credit(ACC.interestIncomeRetail, total)],
    });
  }

  /**
   * Місячне формування резервів. Рахуємо цільовий резерв за стадіями і проводимо
   * лише дельту: саме так виглядає "доформування резервів" після інспекції НБУ.
   */
  #monthEnd(ctx: SimContext, state: RetailLendingState): void {
    this.#collectInterest(ctx, state);
    const target = this.provisionTarget(state);
    const current = ctx.journal.balance(ACC.loanLossAllowance, 'UAH');
    const delta = subtract(target, current);
    state.provisionTarget = target;
    if (delta.minor === 0) return;
    if (delta.minor > 0) {
      ctx.post({
        narrative: 'Формування резервів під знецінення кредитного портфеля',
        postings: [debit(ACC.provisionCharge, delta), credit(ACC.loanLossAllowance, delta)],
      });
    } else {
      const release = scale(delta, -1);
      ctx.post({
        narrative: 'Розформування резервів під знецінення кредитного портфеля',
        postings: [debit(ACC.loanLossAllowance, release), credit(ACC.provisionRelease, release)],
      });
    }
    const npl = this.nonPerformingLoans(state);
    const gross = this.grossPortfolio(state);
    ctx.log(
      `Кредитний портфель ${formatMoney(gross)}, NPL ${(ratio(npl, gross) * 100).toFixed(1)}%, ` +
        `резерв ${formatMoney(target)}`,
      ratio(npl, gross) > 0.2 ? 'warning' : 'info',
    );
  }

  /** Цільовий резерв за стадіями знецінення. */
  provisionTarget(state: RetailLendingState): Money {
    return sum(
      state.cohorts.map((c) =>
        sum(
          [
            scale(c.stage1, PROVISION_COVERAGE.stage1),
            scale(c.stage2, PROVISION_COVERAGE.stage2),
            scale(c.stage3, PROVISION_COVERAGE.stage3),
          ],
          'UAH',
        ),
      ),
      'UAH',
    );
  }

  nonPerformingLoans(state: RetailLendingState): Money {
    return sum(
      state.cohorts.map((c) => c.stage3),
      'UAH',
    );
  }

  grossPortfolio(state: RetailLendingState): Money {
    return sum(
      state.cohorts.map((c) => add(add(c.stage1, c.stage2), c.stage3)),
      'UAH',
    );
  }
}

export function createRetailLending(config: RetailLendingConfig): RetailLendingModule {
  return new RetailLendingModule(config);
}

/** Непрацюючі кредити зі стану модуля — для нормативів рушія. */
export function nonPerformingLoans(state: RetailLendingState): Money {
  return sum(
    state.cohorts.map((c) => c.stage3),
    'UAH',
  );
}

export function grossLoanPortfolio(state: RetailLendingState): Money {
  return sum(
    state.cohorts.map((c) => add(add(c.stage1, c.stage2), c.stage3)),
    'UAH',
  );
}
