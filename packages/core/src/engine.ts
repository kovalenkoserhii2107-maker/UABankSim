/**
 * Рушій симуляції.
 *
 * Такт (один ігровий тиждень) виконується строго фазами, і порядок фаз — це
 * і є "фізика" банку:
 *
 *   1. `week-begin`   — оновлення макро, дії регулятора, ринкові умови;
 *   2. `week-main`    — бізнес: продажі, видачі, зняття, платежі;
 *   3. `week-accrual` — нарахування відсотків, резервів, амортизації;
 *   4. `week-treasury`— казначейство закриває розрив ліквідності за наслідками
 *                       усього, що сталося вище;
 *   5. `week-end`     — звітність, нормативи, перевірка умов програшу.
 *
 * Казначейство свідомо йде після нарахувань: у справжньому банку рішення про
 * овернайт приймають, знаючи підсумок дня, а не до нього.
 */

import { EventBus, PRIORITY, type SimEvent } from './events/bus.ts';
import {
  CoreEvents,
  type GameOverEvent,
  type MacroState,
  type MacroUpdatedEvent,
  type PeriodEvent,
  type WeekEvent,
} from './events/types.ts';
import { Journal, type JournalEntry, type Posting } from './ledger/journal.ts';
import {
  buildBalanceSheet,
  buildIncomeStatement,
  buildPrudentialRatios,
  type BalanceSheet,
  type FxRates,
  type IncomeStatement,
  type PrudentialRatios,
  type RatioInputs,
} from './ledger/reports.ts';
import { ACC } from './ledger/accounts.ts';
import { formatMoney, sum, zero, type Currency, type Money } from './money.ts';
import type { LogRecord, LogSeverity, RatioContribution, SimContext, SimModule } from './module.ts';
import { SimulationState, type SimulationStateInit } from './state.ts';
import { GameCalendar } from './time/calendar.ts';
import { Rng } from './util/rng.ts';

/** Джерело макроекономічних даних (історичні ряди НБУ або синтетичний ряд). */
export interface MacroProvider {
  at(week: number, calendar: GameCalendar): MacroState;
}

/** Функція, якою модуль повідомляє свій внесок у нормативи. */
export type RatioContributor = () => RatioContribution;

export interface SimulationOptions {
  readonly seed: number;
  readonly startYear: number;
  readonly startMonth?: number;
  readonly macro: MacroProvider;
  readonly state: SimulationStateInit;
  readonly modules: readonly SimModule[];
  /** Скільки записів стрічки подій тримати в пам'яті. */
  readonly logLimit?: number;
  readonly journal?: Journal;
}

export interface WeekReport {
  readonly week: number;
  readonly label: string;
  readonly macro: MacroState;
  readonly balanceSheet: BalanceSheet;
  readonly ratios: PrudentialRatios;
  readonly logs: readonly LogRecord[];
}

export interface PeriodReport {
  readonly week: number;
  readonly label: string;
  readonly balanceSheet: BalanceSheet;
  readonly incomeStatement: IncomeStatement;
  readonly ratios: PrudentialRatios;
}

export class Simulation {
  readonly bus = new EventBus();
  readonly journal: Journal;
  readonly calendar: GameCalendar;
  readonly state: SimulationState;
  readonly #macroProvider: MacroProvider;
  readonly #modules: SimModule[];
  readonly #seed: number;
  readonly #logLimit: number;
  readonly #logs: LogRecord[] = [];
  readonly #ratioContributors: RatioContributor[] = [];
  #macro: MacroState;
  #week = -1;
  #started = false;
  /** Тиждень, з якого рахується поточний звіт про фінрезультати. */
  #incomeStatementFrom = 0;
  readonly #annualStatements: IncomeStatement[] = [];

  constructor(options: SimulationOptions) {
    this.calendar = new GameCalendar(options.startYear, options.startMonth ?? 1);
    this.journal = options.journal ?? new Journal();
    this.state = new SimulationState(options.state);
    this.#macroProvider = options.macro;
    this.#modules = [...options.modules];
    this.#seed = options.seed;
    this.#logLimit = options.logLimit ?? 500;
    this.#macro = options.macro.at(0, this.calendar);
    this.#assertDependencies();
  }

  get week(): number {
    return Math.max(0, this.#week);
  }

  get macro(): MacroState {
    return this.#macro;
  }

  get modules(): readonly SimModule[] {
    return this.#modules;
  }

  /** Курси валют поточного тижня у форматі, який очікує звітність. */
  get fxRates(): FxRates {
    return new Map<Currency, number>([
      ['UAH', 1],
      ['USD', this.#macro.fx.USD],
      ['EUR', this.#macro.fx.EUR],
    ]);
  }

  #assertDependencies(): void {
    const ids = new Set(this.#modules.map((m) => m.id));
    if (ids.size !== this.#modules.length) {
      throw new Error('Simulation: у сценарії є модулі з однаковим id');
    }
    for (const module of this.#modules) {
      for (const dependency of module.dependsOn ?? []) {
        if (!ids.has(dependency)) {
          throw new Error(
            `Модуль "${module.id}" потребує "${dependency}", але його немає у сценарії`,
          );
        }
      }
    }
  }

  /**
   * Модуль повідомляє рушію свій внесок у нормативи (NPL, короткострокові
   * зобов'язання). Викликається під час `setup`.
   */
  contributeToRatios(contributor: RatioContributor): void {
    this.#ratioContributors.push(contributor);
  }

  /** Ініціалізація: `setup` усіх модулів у порядку оголошення. */
  start(): void {
    if (this.#started) throw new Error('Simulation.start() вже викликано');
    this.#started = true;
    this.#week = 0;
    for (const module of this.#modules) {
      module.setup(this.#contextFor(module));
    }
    this.#week = -1;
  }

  /** Виконує один тижневий такт і повертає звіт тижня. */
  tick(): WeekReport {
    if (!this.#started) this.start();
    if (!this.state.isAlive) {
      throw new Error(`Симуляцію завершено: ${this.state.gameOverReason ?? 'невідома причина'}`);
    }
    this.#week += 1;
    const week = this.#week;
    const date = this.calendar.dateAt(week);
    const logsBefore = this.#logs.length;

    // 1. Макроекономіка тижня.
    const previous = this.#macro;
    this.#macro = this.#macroProvider.at(week, this.calendar);
    const macroEvent: MacroUpdatedEvent = {
      type: CoreEvents.macroUpdated,
      date,
      macro: this.#macro,
      previous,
    };
    this.bus.emit(macroEvent);

    // 2-5. Фази такту.
    for (const phase of [
      CoreEvents.weekBegin,
      CoreEvents.weekMain,
      CoreEvents.weekAccrual,
      CoreEvents.weekTreasury,
      CoreEvents.weekEnd,
    ] as const) {
      const event: WeekEvent = { type: phase, date };
      this.bus.emit(event);
    }

    // Закриття періодів.
    if (this.calendar.isMonthEnd(week)) {
      this.#emitPeriod(CoreEvents.monthEnd, week);
      if (this.calendar.isQuarterEnd(week)) this.#emitPeriod(CoreEvents.quarterEnd, week);
      if (this.calendar.isYearEnd(week)) {
        this.#emitPeriod(CoreEvents.yearEnd, week);
        this.#closeFinancialYear(week);
      }
    }

    const ratios = this.ratios();
    for (const breach of ratios.breaches) {
      this.bus.emit({ type: CoreEvents.ratioBreached, date, breach } as SimEvent & {
        date: typeof date;
        breach: (typeof ratios.breaches)[number];
      });
      this.#pushLog({
        week,
        date,
        source: 'nbu',
        severity: 'critical',
        message: `${breach.message}: фактично ${(breach.actual * 100).toFixed(2)}%, вимога ${(breach.required * 100).toFixed(2)}%`,
      });
    }

    this.#checkSolvency(week, ratios);

    return {
      week,
      label: this.calendar.format(week),
      macro: this.#macro,
      balanceSheet: this.balanceSheet(),
      ratios,
      logs: this.#logs.slice(logsBefore),
    };
  }

  /** Прокручує `count` тижнів, зупиняючись достроково при game over. */
  run(count: number): WeekReport[] {
    const reports: WeekReport[] = [];
    for (let i = 0; i < count; i += 1) {
      if (!this.state.isAlive) break;
      reports.push(this.tick());
    }
    return reports;
  }

  #emitPeriod(type: PeriodEvent['type'], week: number): void {
    const event: PeriodEvent = { type, date: this.calendar.dateAt(week) };
    this.bus.emit(event);
  }

  /**
   * Річне закриття: доходи та витрати згортаються на рахунок 5040, наступний
   * звіт про фінрезультати починається з чистого аркуша.
   */
  #closeFinancialYear(week: number): void {
    // Звіт за рік, що закривається, зберігаємо окремо: після згортання рахунків
    // 6 і 7 класу відтворити його з Головної книги вже неможливо.
    this.#annualStatements.push(this.incomeStatement());
    const entry = this.journal.closeIncomeAndExpense(week);
    if (entry) this.journal.post(entry);
    this.#incomeStatementFrom = week + 1;
  }

  /** Звіти про фінрезультати за закриті роки, у хронологічному порядку. */
  get annualStatements(): readonly IncomeStatement[] {
    return this.#annualStatements;
  }

  /**
   * Звіт за поточний незакритий період, а якщо він порожній (щойно відбулося
   * річне закриття) — за останній закритий рік.
   */
  latestIncomeStatement(): IncomeStatement {
    const current = this.incomeStatement();
    if (current.operatingIncome.minor !== 0 || current.totalOperatingCost.minor !== 0) return current;
    return this.#annualStatements[this.#annualStatements.length - 1] ?? current;
  }

  #collectRatioInputs(): RatioInputs {
    const npl: Money[] = [];
    const shortTermLiabilities: Money[] = [];
    const shortTermAssets: Money[] = [];
    for (const contributor of this.#ratioContributors) {
      const contribution = contributor();
      if (contribution.nonPerformingLoans) npl.push(contribution.nonPerformingLoans);
      if (contribution.shortTermLiabilities) shortTermLiabilities.push(contribution.shortTermLiabilities);
      if (contribution.shortTermAssets) shortTermAssets.push(contribution.shortTermAssets);
    }
    const rates = this.fxRates;
    // Якщо жоден модуль не веде строкові пасиви, за знаменник Н6 беремо кошти
    // клієнтів до запитання — вони можуть піти будь-якої секунди.
    const fallbackShortTerm = sum(
      [
        this.journal.balanceIn(ACC.currentAccountsRetail, 'UAH', rates),
        this.journal.balanceIn(ACC.currentAccountsCorporate, 'UAH', rates),
        this.journal.balanceIn(ACC.termDepositsRetail, 'UAH', rates),
        this.journal.balanceIn(ACC.termDepositsCorporate, 'UAH', rates),
      ],
      'UAH',
    );
    const inputs: RatioInputs = {
      nonPerformingLoans: sum(npl, 'UAH'),
      shortTermLiabilities:
        shortTermLiabilities.length > 0 ? sum(shortTermLiabilities, 'UAH') : fallbackShortTerm,
      ...(shortTermAssets.length > 0 ? { shortTermAssets: sum(shortTermAssets, 'UAH') } : {}),
    };
    return inputs;
  }

  ratios(): PrudentialRatios {
    return buildPrudentialRatios(this.journal, this.#collectRatioInputs(), this.fxRates);
  }

  balanceSheet(): BalanceSheet {
    return buildBalanceSheet(this.journal, this.week, this.fxRates);
  }

  incomeStatement(): IncomeStatement {
    return buildIncomeStatement(
      this.journal,
      this.#incomeStatementFrom,
      this.week,
      this.fxRates,
      this.#macro.profitTaxRate,
    );
  }

  periodReport(): PeriodReport {
    return {
      week: this.week,
      label: this.calendar.format(this.week),
      balanceSheet: this.balanceSheet(),
      incomeStatement: this.incomeStatement(),
      ratios: this.ratios(),
    };
  }

  /**
   * Умови програшу, які перевіряє саме ядро: від'ємний капітал та вичерпана
   * ліквідність. Невиконання KPI акціонерів — зона відповідальності
   * відповідного модуля, він публікує `core:game-over` сам.
   */
  #checkSolvency(week: number, ratios: PrudentialRatios): void {
    const date = this.calendar.dateAt(week);
    if (ratios.regulatoryCapital.minor < 0) {
      this.#gameOver(week, 'capital', `Капітал банку від'ємний (${formatMoney(ratios.regulatoryCapital)}) — НБУ визнає банк неплатоспроможним`);
      return;
    }
    const rates = this.fxRates;
    const nostro = this.journal.balanceIn(ACC.nostroNbu, 'UAH', rates);
    if (nostro.minor < 0) {
      const shortfall = zero('UAH');
      this.bus.emit({
        type: CoreEvents.liquidityShortfall,
        date,
        shortfall: { ...shortfall, minor: -nostro.minor },
      } as SimEvent);
      this.#gameOver(
        week,
        'liquidity',
        `Кореспондентський рахунок в НБУ пішов у мінус на ${formatMoney({ minor: -nostro.minor, currency: 'UAH' })} — банк не виконує платежі клієнтів`,
      );
    }
  }

  #gameOver(week: number, reason: GameOverEvent['reason'], message: string): void {
    if (!this.state.isAlive) return;
    this.state.endGame(message);
    const event: GameOverEvent = { type: CoreEvents.gameOver, date: this.calendar.dateAt(week), reason, message };
    this.#pushLog({ week, date: event.date, source: 'core', severity: 'critical', message });
    this.bus.emit(event);
  }

  #pushLog(record: LogRecord): void {
    this.#logs.push(record);
    if (this.#logs.length > this.#logLimit) {
      this.#logs.splice(0, this.#logs.length - this.#logLimit);
    }
  }

  get logs(): readonly LogRecord[] {
    return this.#logs;
  }

  #contextFor(module: SimModule): SimContext {
    const simulation = this;
    const rng = Rng.forStream(this.#seed, module.id);
    return {
      bus: this.bus,
      journal: this.journal,
      calendar: this.calendar,
      state: this.state,
      rng,
      get week(): number {
        return simulation.week;
      },
      get date() {
        return simulation.calendar.dateAt(simulation.week);
      },
      get macro(): MacroState {
        return simulation.#macro;
      },
      post({ narrative, postings }: { narrative: string; postings: readonly Posting[] }): JournalEntry {
        return simulation.journal.post({
          week: simulation.week,
          narrative,
          source: module.id,
          postings,
        });
      },
      emit<E extends SimEvent>(event: E): void {
        simulation.bus.emit(event);
      },
      contributeToRatios(contribution: () => RatioContribution): void {
        simulation.#ratioContributors.push(contribution);
      },
      log(message: string, severity: LogSeverity = 'info'): void {
        simulation.#pushLog({
          week: simulation.week,
          date: simulation.calendar.dateAt(simulation.week),
          source: module.id,
          severity,
          message,
        });
      },
    };
  }

  /** Контекст для коду поза модулями (сценарій, тести, консольні команди). */
  contextFor(moduleId: string): SimContext {
    const module = this.#modules.find((m) => m.id === moduleId);
    if (!module) throw new Error(`Модуль "${moduleId}" не зареєстровано у сценарії`);
    return this.#contextFor(module);
  }
}

export { PRIORITY };
