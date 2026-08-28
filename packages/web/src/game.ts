/**
 * Ігрова сесія: обгортка над рушієм для інтерфейсу.
 *
 * Рушій нічого не знає про UI — він рахує тижні й веде Головну книгу. Цей модуль
 * додає рівно те, чого бракує інтерфейсу: історію показників по тижнях (для
 * графіків) і зручні виклики рішень гравця, які під капотом ідуть у ті самі
 * статичні методи модулів, що використовує автопілот.
 */

import {
  ACC,
  formatMoney,
  ratio,
  subtract,
  toUnits,
  type LogRecord,
  type Money,
  type Simulation,
} from '@uabanksim/core';
import { SCENARIOS, createSimulation, type ScenarioId } from '@uabanksim/data';
import {
  OverheadsModule,
  OVERHEADS_SLICE,
  RetailDepositsModule,
  RETAIL_DEPOSITS_SLICE,
  RetailLendingModule,
  RETAIL_LENDING_SLICE,
  grossLoanPortfolio,
  nonPerformingLoans,
  termDepositPortfolio,
  type OverheadsState,
  type RetailDepositsState,
  type RetailLendingState,
} from '@uabanksim/modules';

/** Зріз показників за один тиждень — рядок для всіх графіків дашборда. */
export interface WeekPoint {
  readonly week: number;
  readonly label: string;
  readonly assets: number;
  readonly equity: number;
  readonly liabilities: number;
  readonly loans: number;
  readonly deposits: number;
  readonly liquidAssets: number;
  readonly h2: number;
  readonly h6: number;
  readonly nplRatio: number;
  readonly reputation: number;
  readonly awareness: number;
  readonly keyRate: number;
  readonly depositRate: number;
  readonly stress: number;
  /** Прибуток наростаючим підсумком у межах фінансового року, у млн грн. */
  readonly profitToDate: number;
  /** З якого тижня рахується поточний фінансовий рік. */
  readonly profitFrom: number;
  readonly isMonthEnd: boolean;
}

/** Місячний фінрезультат — окремий ряд, бо P&L має сенс лише за період. */
export interface MonthPoint {
  readonly week: number;
  readonly label: string;
  readonly profit: number;
}

export interface Decisions {
  /** Ставка за строковими вкладами, десятковий дріб. */
  termRate: number;
  /** Поріг скорингу 0..1. */
  scoringCutoff: number;
  /** Місячний маркетинговий бюджет у млн грн. */
  marketingBudget: number;
}

const MILLION = 1_000_000;

/** Переводить суму в мільйони гривень — усі графіки живуть у цих одиницях. */
export function toMillions(amount: Money): number {
  return toUnits(amount) / MILLION;
}

export class Game {
  readonly simulation: Simulation;
  readonly scenarioId: ScenarioId;
  readonly autopilot: boolean;
  readonly history: WeekPoint[] = [];
  readonly months: MonthPoint[] = [];
  #lastMonthProfit: { toDate: number; from: number } | null = null;

  constructor(scenarioId: ScenarioId, options: { seed: number; autopilot: boolean }) {
    this.scenarioId = scenarioId;
    this.autopilot = options.autopilot;
    this.simulation = createSimulation(scenarioId, {
      seed: options.seed,
      autopilot: options.autopilot,
    });
    this.simulation.start();
    this.#record();
  }

  get scenario() {
    return SCENARIOS[this.scenarioId];
  }

  get isAlive(): boolean {
    return this.simulation.state.isAlive;
  }

  get week(): number {
    return this.simulation.week;
  }

  get label(): string {
    return this.simulation.calendar.format(this.simulation.week);
  }

  /** Прокручує один тиждень. Повертає `false`, якщо гру вже завершено. */
  advanceWeek(): boolean {
    if (!this.isAlive) return false;
    this.simulation.tick();
    this.#record();
    return true;
  }

  /** Прокручує тижні до кінця поточного фінансового місяця включно. */
  advanceMonth(): void {
    do {
      if (!this.advanceWeek()) return;
    } while (!this.simulation.calendar.isMonthEnd(this.simulation.week));
  }

  advanceQuarter(): void {
    do {
      if (!this.advanceWeek()) return;
    } while (!this.simulation.calendar.isQuarterEnd(this.simulation.week));
  }

  // --- Рішення гравця -----------------------------------------------------

  /**
   * Рішення застосовуються через ті самі виклики, що доступні автопілоту, —
   * жодного "чорного ходу" в стан для інтерфейсу немає.
   */
  applyDecisions(decisions: Decisions): void {
    RetailDepositsModule.setTermRate(
      this.simulation.contextFor(RETAIL_DEPOSITS_SLICE),
      decisions.termRate,
    );
    RetailLendingModule.setScoringCutoff(
      this.simulation.contextFor(RETAIL_LENDING_SLICE),
      decisions.scoringCutoff,
    );
    OverheadsModule.setMarketingBudget(this.simulation.contextFor(OVERHEADS_SLICE), {
      minor: Math.round(decisions.marketingBudget * MILLION * 100),
      currency: 'UAH',
    });
  }

  /** Поточні значення важелів — щоб інтерфейс стартував із реального стану. */
  currentDecisions(): Decisions {
    const deposits = this.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    const lending = this.slice<RetailLendingState>(RETAIL_LENDING_SLICE);
    const overheads = this.slice<OverheadsState>(OVERHEADS_SLICE);
    return {
      termRate: deposits.termRate,
      scoringCutoff: lending.scoringCutoff,
      marketingBudget: toMillions(overheads.marketingBudget),
    };
  }

  slice<T>(key: string): T {
    return this.simulation.state.slice<T>(key);
  }

  get logs(): readonly LogRecord[] {
    return this.simulation.logs;
  }

  // --- Історія показників -------------------------------------------------

  #record(): void {
    const sim = this.simulation;
    const sheet = sim.balanceSheet();
    const ratios = sim.ratios();
    const pnl = sim.incomeStatement();
    const deposits = this.slice<RetailDepositsState>(RETAIL_DEPOSITS_SLICE);
    const lending = this.slice<RetailLendingState>(RETAIL_LENDING_SLICE);
    const rates = sim.fxRates;
    const at = (code: string): Money => sim.journal.balanceIn(code, 'UAH', rates);

    const liquid =
      toMillions(at(ACC.cashVault)) +
      toMillions(at(ACC.cashAtm)) +
      toMillions(at(ACC.nostroNbu)) +
      toMillions(at(ACC.nbuCertificates)) +
      toMillions(at(ACC.governmentBonds));

    const point: WeekPoint = {
      week: sim.week,
      label: sim.calendar.format(sim.week),
      assets: toMillions(sheet.totalAssets),
      equity: toMillions(sheet.totalEquity),
      liabilities: toMillions(sheet.totalLiabilities),
      loans: toMillions(grossLoanPortfolio(lending)),
      deposits: toMillions(termDepositPortfolio(deposits)),
      liquidAssets: liquid,
      h2: ratios.h2CapitalAdequacy,
      h6: ratios.h6ShortTermLiquidity,
      nplRatio: ratio(nonPerformingLoans(lending), grossLoanPortfolio(lending)),
      reputation: sim.state.reputation,
      awareness: sim.state.brandAwareness,
      keyRate: sim.macro.keyRate,
      depositRate: deposits.termRate,
      stress: sim.macro.stress,
      profitToDate: toMillions(pnl.netProfit),
      profitFrom: pnl.fromWeek,
      isMonthEnd: sim.calendar.isMonthEnd(sim.week),
    };
    this.history.push(point);

    if (!point.isMonthEnd) return;
    // Прибуток за місяць — приріст накопиченого результату. На межі фінансового
    // року накопичення обнуляється, тому порівнюємо лише в межах одного року.
    const previous = this.#lastMonthProfit;
    const profit =
      previous && previous.from === point.profitFrom
        ? point.profitToDate - previous.toDate
        : point.profitToDate;
    this.months.push({ week: point.week, label: point.label, profit });
    this.#lastMonthProfit = { toDate: point.profitToDate, from: point.profitFrom };
  }

  /** Останній зріз — те, що показують плитки KPI. */
  get latest(): WeekPoint {
    return this.history[this.history.length - 1] as WeekPoint;
  }

  /** Зміна показника за останні `weeks` тижнів — для стрілок на плитках. */
  delta(field: keyof WeekPoint, weeks = 4): number | null {
    const current = this.latest;
    const past = this.history[Math.max(0, this.history.length - 1 - weeks)];
    if (!past || past === current) return null;
    const a = current[field];
    const b = past[field];
    if (typeof a !== 'number' || typeof b !== 'number') return null;
    return a - b;
  }
}

export { formatMoney, subtract, SCENARIOS };
export type { ScenarioId, Money, LogRecord };
