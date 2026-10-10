/**
 * Каталог подій ядра.
 *
 * Тут описані лише ті події, які породжує сам рушій (фази такту, закриття
 * періодів, дії регулятора). Продуктові модулі оголошують власні події у своїх
 * пакетах і публікують їх у ту саму шину — ядро про них не знає і знати не має.
 */

import type { Money } from '../money.ts';
import type { GameDate } from '../time/calendar.ts';
import type { SimEvent } from './bus.ts';

/** Імена подій ядра. Використовуйте константи, а не рядкові літерали. */
export const CoreEvents = {
  weekBegin: 'core:week-begin',
  weekMain: 'core:week-main',
  weekAccrual: 'core:week-accrual',
  weekTreasury: 'core:week-treasury',
  weekEnd: 'core:week-end',
  monthEnd: 'core:month-end',
  quarterEnd: 'core:quarter-end',
  yearEnd: 'core:year-end',
  macroUpdated: 'core:macro-updated',
  ratiosCalculated: 'core:ratios-calculated',
  ratioBreached: 'core:ratio-breached',
  liquidityShortfall: 'core:liquidity-shortfall',
  gameOver: 'core:game-over',
} as const;

export interface WeekEvent extends SimEvent {
  readonly type:
    | typeof CoreEvents.weekBegin
    | typeof CoreEvents.weekMain
    | typeof CoreEvents.weekAccrual
    | typeof CoreEvents.weekTreasury
    | typeof CoreEvents.weekEnd;
  readonly date: GameDate;
}

export interface PeriodEvent extends SimEvent {
  readonly type: typeof CoreEvents.monthEnd | typeof CoreEvents.quarterEnd | typeof CoreEvents.yearEnd;
  readonly date: GameDate;
}

/** Макроекономічні параметри тижня — стан ринку, у якому працює банк. */
export interface MacroState {
  /** Облікова ставка НБУ, десятковий дріб (0.25 = 25%). */
  readonly keyRate: number;
  /** Річна інфляція. */
  readonly inflation: number;
  /** Офіційний курс, гривень за одиницю валюти. */
  readonly fx: Readonly<Record<'USD' | 'EUR', number>>;
  /** Середньоринкова ставка за строковими депозитами фізосіб. */
  readonly marketDepositRate: number;
  /** Середньоринкова ставка за кредитами готівкою. */
  readonly marketLoanRate: number;
  /** Норматив обов'язкового резервування за коштами до запитання. */
  readonly reserveRequirement: number;
  /** Ставка за депозитними сертифікатами НБУ. */
  readonly certificateRate: number;
  /** Дохідність ОВДП. */
  readonly bondYield: number;
  /** Ставка податку на прибуток банків, чинна в цьому періоді. */
  readonly profitTaxRate: number;
  /**
   * Індекс стресу 0..1: 0 — спокійний ринок, 1 — гострий етап кризи.
   * Впливає на схильність вкладників забирати кошти і на дефолтність позичальників.
   */
  readonly stress: number;
}

export interface MacroUpdatedEvent extends SimEvent {
  readonly type: typeof CoreEvents.macroUpdated;
  readonly date: GameDate;
  readonly macro: MacroState;
  readonly previous: MacroState | null;
}

export interface LiquidityShortfallEvent extends SimEvent {
  readonly type: typeof CoreEvents.liquidityShortfall;
  readonly date: GameDate;
  /** Скільки гривень бракує на кореспондентському рахунку. */
  readonly shortfall: Money;
}

export interface GameOverEvent extends SimEvent {
  readonly type: typeof CoreEvents.gameOver;
  readonly date: GameDate;
  readonly reason: 'capital' | 'liquidity' | 'shareholders' | 'licence';
  readonly message: string;
}
