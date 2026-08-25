/**
 * Постійні витрати банку: персонал, приміщення, IT, маркетинг.
 *
 * Це спрощений попередник модуля мережі відділень: замість чотирьох типів
 * відділень із ТЗ тут одна цифра — кількість точок продажу. Але економіка вже
 * справжня: кожне відділення коштує грошей щомісяця, а маркетинг конвертується
 * у впізнаваність бренду, яка живить попит у депозитах і кредитах.
 *
 * Коли з'явиться повноцінний модуль мережі, він замінить цей, не зачепивши ні
 * депозитів, ні кредитів — обидва спілкуються з ним лише через стан бренду.
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
  sum,
  zero,
  type Money,
  type PeriodEvent,
  type SimContext,
} from '@uabanksim/core';

export interface OverheadsConfig {
  /** Кількість відділень. Кожне — центр витрат. */
  readonly branches: number;
  /** Місячний фонд оплати праці на одне відділення. */
  readonly payrollPerBranch: Money;
  /**
   * Місячний фонд оплати праці головного офісу: ризики, комплаєнс, казначейство,
   * бухгалтерія, IT. Ця сума не залежить від кількості відділень — саме тому
   * банк із двома відділеннями має непропорційно високий CIR і мусить рости.
   */
  readonly headOfficePayroll?: Money;
  /** Місячні витрати на утримання одного відділення (оренда, охорона, зв'язок). */
  readonly occupancyPerBranch: Money;
  /** Місячні витрати на IT і процесинг. */
  readonly itCostPerMonth: Money;
  /** Місячний маркетинговий бюджет. */
  readonly marketingPerMonth: Money;
  /** Вартість основних засобів на балансі (для амортизації). */
  readonly depreciationPerMonth?: Money;
  /**
   * Скільки впізнаваності бренду дає повний маркетинговий бюджет за місяць.
   * Впізнаваність згасає сама по собі, тому реклама — це не інвестиція, а рента.
   */
  readonly awarenessPerMarketingMonth?: number;
}

export interface OverheadsState {
  branches: number;
  marketingBudget: Money;
  totalStaffCost: Money;
  totalMarketingCost: Money;
}

export const OVERHEADS_SLICE = 'overheads';

/** Тижневе згасання впізнаваності бренду без підтримки рекламою. */
export const AWARENESS_DECAY = 0.015;

export class OverheadsModule extends BaseModule {
  readonly id = OVERHEADS_SLICE;
  readonly title = 'Мережа, персонал і маркетинг';
  readonly #config: OverheadsConfig;

  constructor(config: OverheadsConfig) {
    super();
    this.#config = config;
  }

  setup(ctx: SimContext): void {
    const state = ctx.state.registerSlice<OverheadsState>(OVERHEADS_SLICE, {
      branches: this.#config.branches,
      marketingBudget: this.#config.marketingPerMonth,
      totalStaffCost: zero('UAH'),
      totalMarketingCost: zero('UAH'),
    });

    ctx.bus.on(
      CoreEvents.weekEnd,
      () => {
        ctx.state.adjustBrandAwareness(-AWARENESS_DECAY * ctx.state.brandAwareness);
      },
      { priority: PRIORITY.reporting, owner: this.id },
    );

    ctx.bus.on<PeriodEvent>(CoreEvents.monthEnd, () => this.#closeMonth(ctx, state), {
      priority: PRIORITY.accrual,
      owner: this.id,
    });
  }

  /** Змінити маркетинговий бюджет. Ефект видно з лагом у місяць. */
  static setMarketingBudget(ctx: SimContext, budget: Money): void {
    ctx.state.slice<OverheadsState>(OVERHEADS_SLICE).marketingBudget = budget;
  }

  static setBranches(ctx: SimContext, branches: number): void {
    ctx.state.slice<OverheadsState>(OVERHEADS_SLICE).branches = Math.max(0, Math.floor(branches));
  }

  /**
   * Закриття місяця: нарахування та виплата зарплати, оплата оренди, IT і
   * реклами. Зарплата спершу нараховується на рахунок 3652 і лише потім
   * виплачується — так само, як у реальному обліку.
   */
  #closeMonth(ctx: SimContext, state: OverheadsState): void {
    const payroll = add(
      scale(this.#config.payrollPerBranch, state.branches),
      this.#config.headOfficePayroll ?? zero('UAH'),
    );
    const occupancy = scale(this.#config.occupancyPerBranch, state.branches);
    const it = this.#config.itCostPerMonth;
    const marketing = state.marketingBudget;
    const depreciation = this.#config.depreciationPerMonth ?? zero('UAH');

    if (isPositive(payroll)) {
      ctx.post({
        narrative: 'Нарахування заробітної плати працівникам банку',
        postings: [debit(ACC.staffCost, payroll), credit(ACC.payrollPayable, payroll)],
      });
      const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
      const paid = min(payroll, available);
      if (isPositive(paid)) {
        ctx.post({
          narrative: 'Виплата заробітної плати',
          postings: [debit(ACC.payrollPayable, paid), credit(ACC.nostroNbu, paid)],
        });
      }
      if (paid.minor < payroll.minor) {
        // Затримка зарплати — це не лише борг, це втеча персоналу наступного місяця.
        ctx.log('Банку не вистачило коштів на виплату зарплати', 'critical');
        ctx.state.adjustReputation(-0.03);
      }
      state.totalStaffCost = add(state.totalStaffCost, payroll);
    }

    const cashCosts: [string, Money][] = [
      [ACC.occupancyCost, occupancy],
      [ACC.itCost, it],
      [ACC.marketingCost, marketing],
    ];
    const totalCash = sum(
      cashCosts.map(([, amount]) => amount),
      'UAH',
    );
    if (isPositive(totalCash)) {
      const available = ctx.journal.balance(ACC.nostroNbu, 'UAH');
      const affordable = min(totalCash, available);
      const factor = totalCash.minor === 0 ? 0 : affordable.minor / totalCash.minor;
      const scaled = cashCosts.map(([account, amount]) => [account, scale(amount, factor)] as const);
      const scaledTotal = sum(
        scaled.map(([, amount]) => amount),
        'UAH',
      );
      if (isPositive(scaledTotal)) {
        ctx.post({
          narrative: 'Оплата операційних витрат за місяць',
          postings: [
            ...scaled.filter(([, amount]) => isPositive(amount)).map(([account, amount]) => debit(account, amount)),
            credit(ACC.nostroNbu, scaledTotal),
          ],
        });
      }
      const spentMarketing = scale(marketing, factor);
      state.totalMarketingCost = add(state.totalMarketingCost, spentMarketing);
      this.#applyMarketing(ctx, spentMarketing);
    }

    if (isPositive(depreciation)) {
      ctx.post({
        narrative: 'Амортизація основних засобів',
        postings: [debit(ACC.depreciation, depreciation), credit(ACC.accumulatedDepreciation, depreciation)],
      });
    }

    ctx.log(
      `Операційні витрати місяця: персонал ${formatMoney(payroll)}, ` +
        `мережа ${formatMoney(occupancy)}, маркетинг ${formatMoney(marketing)}`,
    );
  }

  /**
   * Конверсія маркетингу у впізнаваність. Віддача спадна: подвоєння бюджету не
   * подвоює ефект, а в кризу реклама майже не працює — саме те, що в ТЗ описано
   * як "репутаційна криза робить маркетинг марним".
   */
  #applyMarketing(ctx: SimContext, spent: Money): void {
    if (!isPositive(spent)) return;
    const reference = this.#config.marketingPerMonth;
    const intensity = reference.minor === 0 ? 0 : spent.minor / reference.minor;
    const perMonth = this.#config.awarenessPerMarketingMonth ?? 0.035;
    const trustFactor = Math.max(0.1, ctx.state.reputation);
    ctx.state.adjustBrandAwareness(perMonth * Math.sqrt(intensity) * trustFactor);
  }

  /** Місячні постійні витрати — потрібні сценарію для оцінки точки беззбитковості. */
  monthlyFixedCost(state: OverheadsState): Money {
    return sum(
      [
        scale(this.#config.payrollPerBranch, state.branches),
        this.#config.headOfficePayroll ?? zero('UAH'),
        scale(this.#config.occupancyPerBranch, state.branches),
        this.#config.itCostPerMonth,
        state.marketingBudget,
      ],
      'UAH',
    );
  }
}

export function createOverheads(config: OverheadsConfig): OverheadsModule {
  return new OverheadsModule(config);
}
