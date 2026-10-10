/**
 * Контракт продуктового модуля.
 *
 * Ядро не знає, що таке депозит, картка чи броньований автомобіль. Воно вміє
 * рахувати час, вести Головну книгу і розносити події. Усе інше — модулі, які
 * реєструються у сценарії й спілкуються через шину.
 *
 * Правила, яких дотримується кожен модуль:
 *   1. Стан модуля живе у власному зрізі `SimulationState`, а не в ядрі.
 *   2. Гроші рухаються лише через `ctx.post(...)` — прямої зміни сальдо немає.
 *   3. Випадковість береться з `ctx.rng`, а не з `Math.random`, інакше зникає
 *      відтворюваність симуляції.
 */

import type { EventBus, SimEvent } from './events/bus.ts';
import type { MacroState } from './events/types.ts';
import type { Journal, JournalEntry } from './ledger/journal.ts';
import type { Money } from './money.ts';
import type { SimulationState } from './state.ts';
import type { GameCalendar, GameDate } from './time/calendar.ts';
import type { Rng } from './util/rng.ts';

export interface PostOptions {
  /** Опис проводки для журналу операцій. */
  readonly narrative: string;
  readonly postings: readonly import('./ledger/journal.ts').Posting[];
}

/** Усе, що модуль отримує від рушія. */
export interface SimContext {
  readonly bus: EventBus;
  readonly journal: Journal;
  readonly calendar: GameCalendar;
  readonly state: SimulationState;
  /** Потік випадковості, виділений саме цьому модулю. */
  readonly rng: Rng;
  /** Поточний абсолютний тиждень. */
  readonly week: number;
  readonly date: GameDate;
  /** Макроекономіка поточного тижня. */
  readonly macro: MacroState;
  /** Записати проводку від імені модуля. */
  post(options: PostOptions): JournalEntry;
  /** Опублікувати подію. */
  emit<E extends SimEvent>(event: E): void;
  /** Повідомлення в стрічку подій для гравця. */
  log(message: string, severity?: LogSeverity): void;
  /**
   * Повідомити рушію, як цей модуль впливає на нормативи. Ядро не знає, що таке
   * NPL чи строковий пасив, тому запитує це в того, хто веде відповідний портфель.
   * Викликається один раз у `setup`.
   */
  contributeToRatios(contribution: () => RatioContribution): void;
}

/** Внесок модуля у розрахунок пруденційних нормативів. */
export interface RatioContribution {
  /** Непрацюючі кредити (прострочення 90+). */
  readonly nonPerformingLoans?: Money;
  /** Зобов'язання з погашенням до року — знаменник Н6. */
  readonly shortTermLiabilities?: Money;
  /** Ліквідні активи з погашенням до року — чисельник Н6. */
  readonly shortTermAssets?: Money;
}

export type LogSeverity = 'info' | 'warning' | 'critical' | 'success';

export interface LogRecord {
  readonly week: number;
  readonly date: GameDate;
  readonly source: string;
  readonly severity: LogSeverity;
  readonly message: string;
}

export interface SimModule {
  /** Унікальний ідентифікатор, він же джерело проводок і потік ГПСЧ. */
  readonly id: string;
  /** Людська назва для UI. */
  readonly title: string;
  /**
   * Модулі, без яких цей не працює. Рушій перевіряє їх наявність під час
   * складання сценарію і кидає помилку одразу, а не на 40-му тижні.
   */
  readonly dependsOn?: readonly string[];
  /**
   * Реєстрація підписок і початкового стану. Викликається один раз до першого
   * такту. Проводки тут дозволені — саме так модуль формує стартовий баланс.
   */
  setup(ctx: SimContext): void;
  /** Необов'язкове прибирання — для модулів, які можна вимкнути під час гри. */
  teardown?(ctx: SimContext): void;
}

/** Базовий клас із зручностями; наслідування не обов'язкове. */
export abstract class BaseModule implements SimModule {
  abstract readonly id: string;
  abstract readonly title: string;
  abstract setup(ctx: SimContext): void;

  /** Сума, обмежена нулем знизу — типова перевірка перед проводкою. */
  protected static positive(amount: Money): boolean {
    return amount.minor > 0;
  }
}
