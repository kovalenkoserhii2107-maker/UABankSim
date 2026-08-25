/**
 * Постачальники макроекономіки для рушія.
 *
 * `HistoricalMacroProvider` бере опорні точки ряду НБУ та інтерполює їх на
 * тижневий такт. Ставки, яких немає в ряді (депозити, кредити, депсертифікати,
 * ОВДП), виводяться з облікової ставки за стійкими емпіричними
 * співвідношеннями українського ринку.
 *
 * `SyntheticMacroProvider` тримає макро незмінним — потрібен для тестів і для
 * "пісочниці", де гравець вчиться механіці без історичних шоків.
 */

import {
  MONTHS_IN_YEAR,
  type GameCalendar,
  type MacroProvider,
  type MacroState,
} from '@uabanksim/core';
import { NBU_SERIES, type MacroAnchor } from './nbu-series.ts';

/**
 * Виведення ринкових ставок з облікової.
 *
 * Емпіричні співвідношення українського ринку:
 *   - строковий депозит фізособи йде помітно нижче облікової ставки, бо банки
 *     конкурують за пасив неохоче, доки є депсертифікати НБУ;
 *   - кредит готівкою коштує в рази дорожче за фондування: у ціні сидить
 *     очікуваний рівень дефолтів, а не лише вартість грошей;
 *   - депсертифікат НБУ прив'язаний до облікової ставки майже один в один;
 *   - ОВДП дає невелику премію до облікової ставки за строковість.
 */
export function deriveRates(keyRate: number, stress: number): {
  marketDepositRate: number;
  marketLoanRate: number;
  certificateRate: number;
  bondYield: number;
} {
  const depositPremium = 0.02 + stress * 0.05; // у кризу банки б'ються за пасив
  return {
    marketDepositRate: Math.max(0.01, keyRate * 0.75 + depositPremium - 0.02),
    marketLoanRate: Math.max(0.05, keyRate + 0.22 + stress * 0.1),
    certificateRate: Math.max(0, keyRate - 0.01),
    bondYield: Math.max(0.01, keyRate + 0.01 + stress * 0.02),
  };
}

function absoluteMonth(anchor: Pick<MacroAnchor, 'year' | 'month'>): number {
  return anchor.year * MONTHS_IN_YEAR + (anchor.month - 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface HistoricalMacroOptions {
  /** Ряд опорних точок. За замовчуванням — вбудований ряд НБУ. */
  readonly series?: readonly MacroAnchor[];
  /**
   * Множник стресу сценарію. Сценарій "кризовий менеджер" може підняти його,
   * щоб та сама історія відчувалась гостріше.
   */
  readonly stressMultiplier?: number;
}

export class HistoricalMacroProvider implements MacroProvider {
  readonly #series: readonly MacroAnchor[];
  readonly #stressMultiplier: number;
  readonly #cache = new Map<number, MacroState>();

  constructor(options: HistoricalMacroOptions = {}) {
    const series = [...(options.series ?? NBU_SERIES)].sort((a, b) => absoluteMonth(a) - absoluteMonth(b));
    if (series.length === 0) throw new Error('HistoricalMacroProvider: порожній ряд макроданих');
    this.#series = series;
    this.#stressMultiplier = options.stressMultiplier ?? 1;
  }

  /**
   * Інтерпольований стан на заданий (рік, місяць, частка місяця).
   * За межами ряду повертає крайню опорну точку — гра не ламається, якщо
   * сценарій виходить за межі відомої історії.
   */
  interpolate(year: number, month: number, fractionOfMonth = 0): MacroAnchor {
    const target = year * MONTHS_IN_YEAR + (month - 1) + fractionOfMonth;
    const first = this.#series[0] as MacroAnchor;
    const last = this.#series[this.#series.length - 1] as MacroAnchor;
    if (target <= absoluteMonth(first)) return first;
    if (target >= absoluteMonth(last)) return last;

    let lowIndex = 0;
    for (let i = 1; i < this.#series.length; i += 1) {
      if (absoluteMonth(this.#series[i] as MacroAnchor) <= target) lowIndex = i;
      else break;
    }
    const low = this.#series[lowIndex] as MacroAnchor;
    const high = this.#series[lowIndex + 1] as MacroAnchor;
    const span = absoluteMonth(high) - absoluteMonth(low);
    const t = span === 0 ? 0 : (target - absoluteMonth(low)) / span;

    return {
      year,
      month,
      keyRate: lerp(low.keyRate, high.keyRate, t),
      inflation: lerp(low.inflation, high.inflation, t),
      usd: lerp(low.usd, high.usd, t),
      eur: lerp(low.eur, high.eur, t),
      stress: lerp(low.stress, high.stress, t),
      reserveRequirement: lerp(low.reserveRequirement, high.reserveRequirement, t),
      // Ставка податку — дискретна норма закону, її не інтерполюють.
      profitTaxRate: low.profitTaxRate,
    };
  }

  at(week: number, calendar: GameCalendar): MacroState {
    const cached = this.#cache.get(week);
    if (cached) return cached;
    const date = calendar.dateAt(week);
    const anchor = this.interpolate(date.year, date.month, (date.weekOfMonth - 1) / 4);
    const stress = Math.min(1, anchor.stress * this.#stressMultiplier);
    const rates = deriveRates(anchor.keyRate, stress);
    const macro: MacroState = {
      keyRate: anchor.keyRate,
      inflation: anchor.inflation,
      fx: { USD: anchor.usd, EUR: anchor.eur },
      reserveRequirement: anchor.reserveRequirement,
      profitTaxRate: anchor.profitTaxRate,
      stress,
      ...rates,
    };
    this.#cache.set(week, macro);
    return macro;
  }
}

/** Незмінне макро — для тестів і навчальної пісочниці. */
export class SyntheticMacroProvider implements MacroProvider {
  readonly #macro: MacroState;

  constructor(overrides: Partial<MacroState> = {}) {
    const keyRate = overrides.keyRate ?? 0.15;
    const stress = overrides.stress ?? 0.1;
    const derived = deriveRates(keyRate, stress);
    this.#macro = {
      keyRate,
      inflation: 0.08,
      fx: { USD: 41, EUR: 45 },
      reserveRequirement: 0.05,
      profitTaxRate: 0.25,
      stress,
      ...derived,
      ...overrides,
    };
  }

  at(): MacroState {
    return this.#macro;
  }
}
