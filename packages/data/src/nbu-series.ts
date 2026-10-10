/**
 * Історичні макроекономічні ряди по Україні.
 *
 * Ряд заданий опорними точками — місяцями, у яких показник фактично змінився
 * (рішення Правління НБУ щодо облікової ставки, стрибки курсу, зміни режиму
 * курсоутворення). Значення для проміжних місяців рушій отримує лінійною
 * інтерполяцією: для щотижневого такту цього достатньо, а ряд лишається
 * компактним і перевірюваним.
 *
 * Джерело значень — публічна статистика НБУ (облікова ставка, офіційний курс,
 * ІСЦ). Дані округлені й місцями згладжені: це ігровий баланс, а не
 * економетрична модель. Ставки за депозитами й кредитами наведені як
 * середньоринкові для роздрібного сегмента.
 *
 * Усі ставки — десяткові дроби: 0.25 означає 25% річних.
 */

export interface MacroAnchor {
  readonly year: number;
  /** Місяць 1..12, з якого діє значення. */
  readonly month: number;
  /** Облікова ставка НБУ. */
  readonly keyRate: number;
  /** Річна інфляція (ІСЦ, до відповідного місяця попереднього року). */
  readonly inflation: number;
  /** Офіційний курс гривні за долар США. */
  readonly usd: number;
  /** Офіційний курс гривні за євро. */
  readonly eur: number;
  /**
   * Індекс стресу 0..1: інтенсивність кризи, у якій працює банк.
   * 0 — спокійний ринок; 1 — гострий етап (лютий 2022, лютий 2015).
   */
  readonly stress: number;
  /** Норматив обов'язкового резервування за коштами до запитання. */
  readonly reserveRequirement: number;
  /** Ставка податку на прибуток банків, чинна в цьому періоді. */
  readonly profitTaxRate: number;
  /** Пояснення для довідника гравця — чому саме тут перелом. */
  readonly note?: string;
}

/**
 * Опорні точки з 2013 по 2025 рік. Проміжні місяці інтерполюються.
 */
export const NBU_SERIES: readonly MacroAnchor[] = [
  { year: 2013, month: 1, keyRate: 0.075, inflation: -0.002, usd: 7.99, eur: 10.6, stress: 0.05, reserveRequirement: 0.05, profitTaxRate: 0.19, note: 'Фіксований курс, дефляція, дешеві гроші' },
  { year: 2013, month: 8, keyRate: 0.065, inflation: -0.004, usd: 7.99, eur: 10.6, stress: 0.05, reserveRequirement: 0.05, profitTaxRate: 0.19 },
  { year: 2013, month: 12, keyRate: 0.065, inflation: 0.005, usd: 7.99, eur: 11.04, stress: 0.15, reserveRequirement: 0.05, profitTaxRate: 0.19, note: 'Початок політичної кризи' },

  { year: 2014, month: 2, keyRate: 0.065, inflation: 0.019, usd: 9.9, eur: 13.5, stress: 0.7, reserveRequirement: 0.05, profitTaxRate: 0.18, note: 'Відпущено курс, початок відпливу депозитів' },
  { year: 2014, month: 4, keyRate: 0.095, inflation: 0.061, usd: 11.8, eur: 16.3, stress: 0.85, reserveRequirement: 0.05, profitTaxRate: 0.18 },
  { year: 2014, month: 7, keyRate: 0.125, inflation: 0.124, usd: 11.75, eur: 15.9, stress: 0.8, reserveRequirement: 0.05, profitTaxRate: 0.18 },
  { year: 2014, month: 11, keyRate: 0.14, inflation: 0.213, usd: 15.0, eur: 18.7, stress: 0.85, reserveRequirement: 0.05, profitTaxRate: 0.18 },
  { year: 2014, month: 12, keyRate: 0.14, inflation: 0.249, usd: 15.77, eur: 19.23, stress: 0.9, reserveRequirement: 0.05, profitTaxRate: 0.18, note: 'Масовий вихід банків з ринку' },

  { year: 2015, month: 2, keyRate: 0.195, inflation: 0.345, usd: 27.0, eur: 30.6, stress: 1.0, reserveRequirement: 0.065, profitTaxRate: 0.18, note: 'Пік девальвації: курс сягав 30 грн/дол.' },
  { year: 2015, month: 3, keyRate: 0.3, inflation: 0.408, usd: 23.4, eur: 25.3, stress: 0.95, reserveRequirement: 0.065, profitTaxRate: 0.18, note: 'Облікова ставка 30% — рекорд' },
  { year: 2015, month: 8, keyRate: 0.27, inflation: 0.522, usd: 21.3, eur: 23.9, stress: 0.75, reserveRequirement: 0.06, profitTaxRate: 0.18 },
  { year: 2015, month: 9, keyRate: 0.22, inflation: 0.516, usd: 21.2, eur: 23.8, stress: 0.7, reserveRequirement: 0.06, profitTaxRate: 0.18 },
  { year: 2015, month: 12, keyRate: 0.22, inflation: 0.433, usd: 24.0, eur: 26.2, stress: 0.6, reserveRequirement: 0.06, profitTaxRate: 0.18 },

  { year: 2016, month: 4, keyRate: 0.19, inflation: 0.098, usd: 25.2, eur: 28.7, stress: 0.45, reserveRequirement: 0.05, profitTaxRate: 0.18 },
  { year: 2016, month: 7, keyRate: 0.155, inflation: 0.077, usd: 24.9, eur: 27.6, stress: 0.4, reserveRequirement: 0.05, profitTaxRate: 0.18 },
  { year: 2016, month: 10, keyRate: 0.14, inflation: 0.121, usd: 25.7, eur: 28.1, stress: 0.4, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2016, month: 12, keyRate: 0.14, inflation: 0.124, usd: 27.19, eur: 28.42, stress: 0.5, reserveRequirement: 0.03, profitTaxRate: 0.18, note: 'Націоналізація найбільшого приватного банку' },

  { year: 2017, month: 4, keyRate: 0.13, inflation: 0.124, usd: 26.6, eur: 28.9, stress: 0.3, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2017, month: 10, keyRate: 0.135, inflation: 0.148, usd: 26.6, eur: 31.2, stress: 0.3, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2017, month: 12, keyRate: 0.145, inflation: 0.137, usd: 28.07, eur: 33.5, stress: 0.3, reserveRequirement: 0.03, profitTaxRate: 0.18 },

  { year: 2018, month: 3, keyRate: 0.17, inflation: 0.139, usd: 26.3, eur: 32.4, stress: 0.25, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2018, month: 9, keyRate: 0.18, inflation: 0.088, usd: 28.3, eur: 32.8, stress: 0.25, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2018, month: 12, keyRate: 0.18, inflation: 0.098, usd: 27.69, eur: 31.71, stress: 0.25, reserveRequirement: 0.03, profitTaxRate: 0.18 },

  { year: 2019, month: 4, keyRate: 0.175, inflation: 0.088, usd: 26.9, eur: 30.2, stress: 0.2, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2019, month: 9, keyRate: 0.165, inflation: 0.072, usd: 24.1, eur: 26.6, stress: 0.15, reserveRequirement: 0.03, profitTaxRate: 0.18 },
  { year: 2019, month: 12, keyRate: 0.135, inflation: 0.041, usd: 23.69, eur: 26.42, stress: 0.15, reserveRequirement: 0.03, profitTaxRate: 0.18 },

  { year: 2020, month: 3, keyRate: 0.1, inflation: 0.023, usd: 27.5, eur: 30.2, stress: 0.55, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Пандемічний локдаун, різкий стрибок курсу' },
  { year: 2020, month: 6, keyRate: 0.06, inflation: 0.024, usd: 26.7, eur: 30.0, stress: 0.35, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Історичний мінімум облікової ставки — 6%' },
  { year: 2020, month: 12, keyRate: 0.06, inflation: 0.05, usd: 28.27, eur: 34.74, stress: 0.3, reserveRequirement: 0.0, profitTaxRate: 0.18 },

  { year: 2021, month: 4, keyRate: 0.075, inflation: 0.084, usd: 27.9, eur: 33.4, stress: 0.25, reserveRequirement: 0.0, profitTaxRate: 0.18 },
  { year: 2021, month: 9, keyRate: 0.085, inflation: 0.11, usd: 26.6, eur: 31.2, stress: 0.25, reserveRequirement: 0.0, profitTaxRate: 0.18 },
  { year: 2021, month: 12, keyRate: 0.09, inflation: 0.1, usd: 27.28, eur: 30.92, stress: 0.35, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Нарощування напруги на кордоні' },

  { year: 2022, month: 1, keyRate: 0.1, inflation: 0.103, usd: 28.6, eur: 32.3, stress: 0.5, reserveRequirement: 0.0, profitTaxRate: 0.18 },
  { year: 2022, month: 2, keyRate: 0.1, inflation: 0.107, usd: 29.25, eur: 33.0, stress: 1.0, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Повномасштабне вторгнення: курс зафіксовано, знята частина нормативів' },
  { year: 2022, month: 6, keyRate: 0.25, inflation: 0.216, usd: 29.25, eur: 30.7, stress: 0.9, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Облікова ставка одномоментно з 10% до 25%' },
  { year: 2022, month: 7, keyRate: 0.25, inflation: 0.226, usd: 36.57, eur: 37.4, stress: 0.85, reserveRequirement: 0.0, profitTaxRate: 0.18, note: 'Девальвація офіційного курсу на 25%' },
  { year: 2022, month: 12, keyRate: 0.25, inflation: 0.266, usd: 36.57, eur: 38.95, stress: 0.8, reserveRequirement: 0.1, profitTaxRate: 0.18, note: 'Блекаути: відділення працюють від генераторів' },

  { year: 2023, month: 7, keyRate: 0.22, inflation: 0.116, usd: 36.57, eur: 40.2, stress: 0.6, reserveRequirement: 0.2, profitTaxRate: 0.5, note: 'Ставку податку на прибуток банків підвищено до 50%' },
  { year: 2023, month: 10, keyRate: 0.16, inflation: 0.053, usd: 36.4, eur: 38.6, stress: 0.55, reserveRequirement: 0.2, profitTaxRate: 0.5, note: 'Перехід до керованої гнучкості курсу' },
  { year: 2023, month: 12, keyRate: 0.15, inflation: 0.051, usd: 37.98, eur: 41.9, stress: 0.5, reserveRequirement: 0.2, profitTaxRate: 0.5 },

  { year: 2024, month: 4, keyRate: 0.135, inflation: 0.032, usd: 39.3, eur: 42.1, stress: 0.5, reserveRequirement: 0.2, profitTaxRate: 0.5 },
  { year: 2024, month: 9, keyRate: 0.13, inflation: 0.087, usd: 41.2, eur: 45.6, stress: 0.5, reserveRequirement: 0.2, profitTaxRate: 0.5 },
  { year: 2024, month: 12, keyRate: 0.135, inflation: 0.12, usd: 42.03, eur: 43.8, stress: 0.5, reserveRequirement: 0.2, profitTaxRate: 0.5 },

  { year: 2025, month: 3, keyRate: 0.155, inflation: 0.147, usd: 41.5, eur: 44.9, stress: 0.5, reserveRequirement: 0.2, profitTaxRate: 0.25, note: 'Ставку податку на прибуток банків знижено до 25%' },
  { year: 2025, month: 12, keyRate: 0.155, inflation: 0.09, usd: 42.2, eur: 48.5, stress: 0.45, reserveRequirement: 0.2, profitTaxRate: 0.25 },
];

export const SERIES_FIRST_YEAR = NBU_SERIES[0]?.year ?? 2013;
export const SERIES_LAST_YEAR = NBU_SERIES[NBU_SERIES.length - 1]?.year ?? 2025;
