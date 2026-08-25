/**
 * Акціонери та рада директорів.
 *
 * Модуль, який робить із симулятора банку симулятор CEO: гравець може мати
 * ідеальні нормативи і все одно програти, бо не виконав план по ROE. На початку
 * кожного року борд ставить цілі, щокварталу дивиться на факт, і два-три
 * провалені квартали поспіль означають звільнення.
 */

import {
  ACC,
  BaseModule,
  CoreEvents,
  PRIORITY,
  add,
  formatMoney,
  ratio,
  scale,
  subtract,
  zero,
  type Money,
  type PeriodEvent,
  type SimContext,
} from '@uabanksim/core';

export interface ShareholderTargets {
  /** Цільова рентабельність капіталу (річна). */
  readonly returnOnEquity: number;
  /** Гранично допустиме відношення витрат до доходів. */
  readonly costIncomeRatio: number;
  /** Мінімальний приріст активів за рік. */
  readonly assetGrowth: number;
}

export interface QuarterReview {
  readonly year: number;
  readonly quarter: number;
  readonly roe: number;
  readonly cir: number;
  readonly passed: boolean;
  readonly comment: string;
}

export interface ShareholdersConfig {
  readonly targets: ShareholderTargets;
  /** Скільки провалених кварталів поспіль допускає борд. */
  readonly patienceQuarters?: number;
  /**
   * Скільки перших кварталів борд не рахує за провал. Банк, що тільки будує
   * баланс, фізично не може дати цільовий ROE: мережа й головний офіс коштують
   * повну ціну з першого місяця, а портфель ще порожній.
   */
  readonly gracePeriodQuarters?: number;
  /** Наскільки борд піднімає планку після успішного року. */
  readonly ambitionGrowth?: number;
}

export interface ShareholdersState {
  targets: ShareholderTargets;
  consecutiveMisses: number;
  reviews: QuarterReview[];
  /** Активи на початок року — база для оцінки приросту. */
  assetsAtYearStart: Money;
  /** Капітал на початок кварталу — знаменник ROE. */
  equityAtQuarterStart: Money;
  /** Фінрезультат, накопичений з початку кварталу. */
  quarterStartProfit: Money;
}

export const SHAREHOLDERS_SLICE = 'shareholders';

export class ShareholdersModule extends BaseModule {
  readonly id = SHAREHOLDERS_SLICE;
  readonly title = 'Акціонери та рада директорів';
  readonly #config: Required<ShareholdersConfig>;

  constructor(config: ShareholdersConfig) {
    super();
    this.#config = { patienceQuarters: 3, gracePeriodQuarters: 2, ambitionGrowth: 0.15, ...config };
  }

  setup(ctx: SimContext): void {
    const equity = ctx.journal.balance(ACC.shareCapital, 'UAH');
    const state = ctx.state.registerSlice<ShareholdersState>(SHAREHOLDERS_SLICE, {
      targets: this.#config.targets,
      consecutiveMisses: 0,
      reviews: [],
      assetsAtYearStart: zero('UAH'),
      equityAtQuarterStart: equity,
      quarterStartProfit: zero('UAH'),
    });

    ctx.bus.on<PeriodEvent>(CoreEvents.quarterEnd, () => this.#review(ctx, state), {
      priority: PRIORITY.reporting,
      owner: this.id,
    });
    ctx.bus.on<PeriodEvent>(CoreEvents.yearEnd, () => this.#setNewTargets(ctx, state), {
      priority: PRIORITY.reporting + 1,
      owner: this.id,
    });
  }

  /**
   * Квартальний розбір польотів. ROE рахується від капіталу на початок кварталу
   * і приводиться до річного виміру — саме так на нього дивиться борд.
   */
  #review(ctx: SimContext, state: ShareholdersState): void {
    const date = ctx.calendar.dateAt(ctx.week);
    const equity = this.#equity(ctx);
    const profit = subtract(this.#accumulatedProfit(ctx), state.quarterStartProfit);
    const roe = ratio(scale(profit, 4), state.equityAtQuarterStart, 0);
    const cir = this.#costIncomeRatio(ctx);

    const passedRoe = roe >= state.targets.returnOnEquity;
    const passedCir = cir <= state.targets.costIncomeRatio;
    const passed = passedRoe && passedCir;

    const comment = passed
      ? 'Борд задоволений результатами кварталу'
      : [
          !passedRoe ? `ROE ${(roe * 100).toFixed(1)}% проти плану ${(state.targets.returnOnEquity * 100).toFixed(1)}%` : null,
          !passedCir ? `CIR ${(cir * 100).toFixed(0)}% проти ліміту ${(state.targets.costIncomeRatio * 100).toFixed(0)}%` : null,
        ]
          .filter(Boolean)
          .join('; ');

    const inGracePeriod = state.reviews.length < this.#config.gracePeriodQuarters;
    state.reviews.push({ year: date.year, quarter: date.quarter, roe, cir, passed, comment });
    state.consecutiveMisses = passed || inGracePeriod ? 0 : state.consecutiveMisses + 1;
    state.equityAtQuarterStart = equity;
    state.quarterStartProfit = this.#accumulatedProfit(ctx);

    ctx.log(
      `Рада директорів, ${date.year} Q${date.quarter}: прибуток ${formatMoney(profit)}, ${comment}` +
        (inGracePeriod && !passed ? ' (борд дає час на розбудову бізнесу)' : ''),
      passed ? 'success' : 'warning',
    );

    if (state.consecutiveMisses >= this.#config.patienceQuarters) {
      const message =
        `Рада директорів звільняє голову правління: ${state.consecutiveMisses} квартали поспіль ` +
        'без виконання KPI';
      ctx.log(message, 'critical');
      ctx.state.endGame(message);
      ctx.emit({
        type: CoreEvents.gameOver,
        date,
        reason: 'shareholders' as const,
        message,
      });
    }
  }

  /** Наприкінці року борд піднімає планку — успіх ніколи не буває остаточним. */
  #setNewTargets(ctx: SimContext, state: ShareholdersState): void {
    const assets = ctx.journal.balance(ACC.shareCapital, 'UAH');
    const grew = ratio(subtract(assets, state.assetsAtYearStart), state.assetsAtYearStart, 1);
    state.assetsAtYearStart = assets;
    if (state.consecutiveMisses > 0) return;
    state.targets = {
      returnOnEquity: state.targets.returnOnEquity * (1 + this.#config.ambitionGrowth),
      costIncomeRatio: Math.max(0.35, state.targets.costIncomeRatio - 0.02),
      assetGrowth: state.targets.assetGrowth,
    };
    ctx.log(
      `Акціонери підвищують план на наступний рік: ROE ${(state.targets.returnOnEquity * 100).toFixed(1)}%, ` +
        `CIR не вище ${(state.targets.costIncomeRatio * 100).toFixed(0)}% (активи за рік ${(grew * 100).toFixed(0)}%)`,
    );
  }

  #equity(ctx: SimContext): Money {
    return add(
      add(
        ctx.journal.balance(ACC.shareCapital, 'UAH'),
        ctx.journal.balance(ACC.retainedEarnings, 'UAH'),
      ),
      ctx.journal.balance(ACC.currentYearResult, 'UAH'),
    );
  }

  /** Накопичений фінрезультат — різниця доходів і витрат на рахунках 6 і 7 класу. */
  #accumulatedProfit(ctx: SimContext): Money {
    const income = ctx.journal.totalOf(
      [
        ACC.interestIncomeRetail,
        ACC.interestIncomeCorporate,
        ACC.interestIncomeSecurities,
        ACC.feeIncomeRko,
        ACC.feeIncomeCards,
        ACC.fxTradingResult,
        ACC.provisionRelease,
      ],
      'UAH',
    );
    const expense = ctx.journal.totalOf(
      [
        ACC.interestExpenseTermRetail,
        ACC.interestExpenseCurrent,
        ACC.interestExpenseInterbank,
        ACC.interestExpenseNbu,
        ACC.staffCost,
        ACC.occupancyCost,
        ACC.depreciation,
        ACC.cashLogisticsCost,
        ACC.marketingCost,
        ACC.itCost,
        ACC.penalties,
        ACC.provisionCharge,
      ],
      'UAH',
    );
    return subtract(income, expense);
  }

  #costIncomeRatio(ctx: SimContext): number {
    const operatingIncome = subtract(
      ctx.journal.totalOf(
        [
          ACC.interestIncomeRetail,
          ACC.interestIncomeCorporate,
          ACC.interestIncomeSecurities,
          ACC.feeIncomeRko,
          ACC.feeIncomeCards,
          ACC.fxTradingResult,
        ],
        'UAH',
      ),
      ctx.journal.totalOf(
        [
          ACC.interestExpenseTermRetail,
          ACC.interestExpenseCurrent,
          ACC.interestExpenseInterbank,
          ACC.interestExpenseNbu,
        ],
        'UAH',
      ),
    );
    const operatingCost = ctx.journal.totalOf(
      [ACC.staffCost, ACC.occupancyCost, ACC.depreciation, ACC.cashLogisticsCost, ACC.marketingCost, ACC.itCost],
      'UAH',
    );
    return ratio(operatingCost, operatingIncome, Number.POSITIVE_INFINITY);
  }
}

export function createShareholders(config: ShareholdersConfig): ShareholdersModule {
  return new ShareholdersModule(config);
}
