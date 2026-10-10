/**
 * Автопілот — референсна політика керування банком.
 *
 * Це не ШІ-суперник і не частина ігрового процесу: це "виконувач обов'язків",
 * який щотижня приймає ті самі рішення, що й гравець, за простими правилами.
 * Він потрібен для трьох речей:
 *
 *   1. показати поверхню рішень: усе, що вміє автопілот, гравець робить тими
 *      самими викликами (`setTermRate`, `setScoringCutoff`, `setMarketingBudget`);
 *   2. балансування: щоб оцінити сценарій, потрібен базовий рівень гри, а не
 *      порівняння з повністю пасивним банком, який гарантовано гине;
 *   3. регресійні тести: політика детермінована, тож будь-яка зміна економіки
 *      одразу видно за підсумковим балансом.
 *
 * Правила навмисно прості й пояснювані — це базовий рівень, який гравець має
 * перемагати, а не оптимум.
 */

import {
  ACC,
  BaseModule,
  CoreEvents,
  PRIORITY,
  add,
  ratio,
  scale,
  sum,
  type Money,
  type SimContext,
  type WeekEvent,
} from '@uabanksim/core';
import { OverheadsModule, type OverheadsState, OVERHEADS_SLICE } from './overheads.ts';
import {
  RetailDepositsModule,
  RETAIL_DEPOSITS_SLICE,
  termDepositPortfolio,
  type RetailDepositsState,
} from './retail-deposits.ts';
import {
  RetailLendingModule,
  RETAIL_LENDING_SLICE,
  grossLoanPortfolio,
  nonPerformingLoans,
  type RetailLendingState,
} from './retail-lending.ts';

export interface AutopilotConfig {
  /** Цільове покриття короткострокових зобов'язань ліквідними активами. */
  readonly targetLiquidity?: number;
  /** Частка NPL, вище за яку політика підтискає скоринг. */
  readonly targetNpl?: number;
  /** Межі ставки за вкладами як множники до ринкової. */
  readonly rateBounds?: readonly [number, number];
  /** Наскільки різко реагувати на відхилення (0..1). */
  readonly aggressiveness?: number;
}

export const AUTOPILOT_SLICE = 'autopilot';

export interface AutopilotState {
  /** Останнє рішення щодо ставки — для пояснення гравцю, що робив автопілот. */
  lastRateFactor: number;
  lastCutoff: number;
  decisions: number;
}

const DEFAULTS = {
  targetLiquidity: 0.9,
  targetNpl: 0.12,
  rateBounds: [0.7, 1.45] as const,
  aggressiveness: 0.35,
};

export class AutopilotModule extends BaseModule {
  readonly id = AUTOPILOT_SLICE;
  readonly title = 'Автопілот (референсна політика)';
  readonly dependsOn = [RETAIL_DEPOSITS_SLICE, RETAIL_LENDING_SLICE] as const;
  readonly #config: Required<AutopilotConfig>;

  constructor(config: AutopilotConfig = {}) {
    super();
    this.#config = { ...DEFAULTS, ...config };
  }

  setup(ctx: SimContext): void {
    const state = ctx.state.registerSlice<AutopilotState>(AUTOPILOT_SLICE, {
      lastRateFactor: 1,
      lastCutoff: 0.5,
      decisions: 0,
    });

    // Рішення приймаються на початку тижня, до того як відпрацюють продукти:
    // ставка, оголошена в понеділок, діє на весь тиждень.
    ctx.bus.on<WeekEvent>(CoreEvents.weekBegin, () => this.#decide(ctx, state), {
      priority: PRIORITY.market,
      owner: this.id,
    });
  }

  #decide(ctx: SimContext, state: AutopilotState): void {
    this.#setDepositRate(ctx, state);
    this.#setScoring(ctx, state);
    this.#setMarketing(ctx);
    state.decisions += 1;
  }

  /**
   * Ставка за вкладами. Логіка та сама, що в живого казначея: дивимось на
   * покриття короткострокових зобов'язань ліквідними активами. Не вистачає
   * ліквідності — платимо ринку більше; надлишок — здешевлюємо пасив.
   */
  #setDepositRate(ctx: SimContext, state: AutopilotState): void {
    const deposits = ctx.state.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    const liquidAssets = sum(
      [
        ctx.journal.balance(ACC.cashVault, 'UAH'),
        ctx.journal.balance(ACC.nostroNbu, 'UAH'),
        ctx.journal.balance(ACC.nbuCertificates, 'UAH'),
        ctx.journal.balance(ACC.governmentBonds, 'UAH'),
      ],
      'UAH',
    );
    const shortTerm = add(
      ctx.journal.balance(ACC.currentAccountsRetail, 'UAH'),
      termDepositPortfolio(deposits),
    );
    const coverage = ratio(liquidAssets, shortTerm, 2);
    const gap = this.#config.targetLiquidity - coverage;

    const [minFactor, maxFactor] = this.#config.rateBounds;
    // Паніка вкладників — окремий доданок: у такий момент ставка має бути
    // помітно вищою за ринок, інакше пасив не втримати жодною рекламою.
    const panicPremium = deposits.panic * 0.5;
    const factor = Math.min(
      maxFactor,
      Math.max(minFactor, 1 + gap * this.#config.aggressiveness * 2 + panicPremium),
    );
    state.lastRateFactor = factor;
    RetailDepositsModule.setTermRate(ctx, ctx.macro.marketDepositRate * factor);
    // За поточними рахунками платимо символічно: їхня цінність у тому, що вони
    // майже безкоштовні, і платити за них ринкову ставку немає сенсу.
    RetailDepositsModule.setCurrentAccountRate(ctx, Math.min(0.02, ctx.macro.keyRate * 0.1));
  }

  /**
   * Поріг скорингу. Реагуємо на фактичний NPL і на макрострес: у кризу видавати
   * кеш-кредити за довоєнними правилами — найшвидший спосіб втратити капітал.
   */
  #setScoring(ctx: SimContext, state: AutopilotState): void {
    const lending = ctx.state.slice<RetailLendingState>(RETAIL_LENDING_SLICE);
    const npl = ratio(nonPerformingLoans(lending), grossLoanPortfolio(lending));
    const nplPressure = (npl - this.#config.targetNpl) * 2.5;
    const target = Math.min(
      0.9,
      Math.max(0.25, 0.45 + nplPressure + ctx.macro.stress * 0.35),
    );
    // Рухаємось до цілі поступово: різка зміна порогу вбиває воронку продажів,
    // а результат попереднього рішення видно лише через кілька місяців.
    const cutoff = lending.scoringCutoff + (target - lending.scoringCutoff) * this.#config.aggressiveness;
    state.lastCutoff = cutoff;
    RetailLendingModule.setScoringCutoff(ctx, cutoff);
    RetailLendingModule.setRates(ctx, {
      cashLoan: ctx.macro.marketLoanRate * (1 + ctx.macro.stress * 0.15),
      card: ctx.macro.marketLoanRate * (1 + ctx.macro.stress * 0.15) + 0.12,
    });
  }

  /**
   * Маркетинг. Реклама — перше, що ріжуть у збиток, і саме тому банки з неї
   * так важко виходять: впізнаваність згасає швидше, ніж повертається прибуток.
   */
  #setMarketing(ctx: SimContext): void {
    if (!ctx.state.hasSlice(OVERHEADS_SLICE)) return;
    const overheads = ctx.state.slice<OverheadsState>(OVERHEADS_SLICE);
    const capital = ctx.journal.balance(ACC.shareCapital, 'UAH');
    const equityGap = ratio(ctx.journal.balance(ACC.currentYearResult, 'UAH'), capital, 0);
    // У кризу і при збитках — мінімум; у прибуткові часи — повний бюджет.
    // Базовий бюджет запам'ятовуємо з першого тижня, до будь-яких урізань:
    // інакше кожне скорочення рахувалось би від уже урізаної суми.
    this.#baseMarketing ??= overheads.marketingBudget;
    const factor = ctx.macro.stress > 0.7 || equityGap < -0.1 ? 0.35 : 1;
    OverheadsModule.setMarketingBudget(ctx, scale(this.#baseMarketing, factor));
  }

  #baseMarketing: Money | undefined;

  /** Короткий опис поточної позиції автопілота — для стрічки подій та дебагу. */
  static describe(ctx: SimContext): string {
    const state = ctx.state.slice<AutopilotState>(AUTOPILOT_SLICE);
    const deposits = ctx.state.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    return (
      `ставка за вкладами ${(deposits.termRate * 100).toFixed(1)}% ` +
      `(${state.lastRateFactor.toFixed(2)}× ринку), поріг скорингу ${state.lastCutoff.toFixed(2)}`
    );
  }
}

export function createAutopilot(config: AutopilotConfig = {}): AutopilotModule {
  return new AutopilotModule(config);
}
