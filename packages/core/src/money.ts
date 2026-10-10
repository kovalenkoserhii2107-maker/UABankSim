/**
 * Гроші в симуляторі — цілі мінімальні одиниці (копійки/центи).
 *
 * Жодних `number` з дробовою частиною: банківський баланс має сходитись до
 * копійки, а double накопичує похибку вже на десятках тисяч проводок. Усі суми
 * зберігаються як ціле число копійок; множення на ставки виконується через
 * `scale`, яке округлює за принципом "half away from zero" — так само, як це
 * роблять банківські системи при нарахуванні відсотків.
 */

/** Валюти, з якими працює банк. */
export const CURRENCIES = ['UAH', 'USD', 'EUR'] as const;

export type Currency = (typeof CURRENCIES)[number];

/** Сума в мінімальних одиницях валюти (копійки, центи). */
export interface Money {
  /** Ціле число копійок. Може бути від'ємним. */
  readonly minor: number;
  readonly currency: Currency;
}

/** Кількість мінімальних одиниць в одиниці валюти. Для всіх наших валют — 100. */
export const MINOR_UNITS = 100;

const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {}

function assertInteger(minor: number, context: string): void {
  if (!Number.isFinite(minor) || !Number.isInteger(minor)) {
    throw new MoneyError(`${context}: сума має бути цілим числом копійок, отримано ${minor}`);
  }
  if (Math.abs(minor) > MAX_SAFE_MINOR) {
    throw new MoneyError(`${context}: перевищено безпечний діапазон цілих чисел (${minor})`);
  }
}

/** Створює суму з цілого числа копійок. */
export function fromMinor(minor: number, currency: Currency): Money {
  assertInteger(minor, 'fromMinor');
  return { minor, currency };
}

/**
 * Створює суму з "людського" числа (гривень). Дробова частина округлюється до
 * копійки. Використовується у конфігах та тестах, не в гарячому шляху рушія.
 */
export function money(units: number, currency: Currency = 'UAH'): Money {
  if (!Number.isFinite(units)) {
    throw new MoneyError(`money: очікувалось скінченне число, отримано ${units}`);
  }
  return fromMinor(roundHalfAwayFromZero(units * MINOR_UNITS), currency);
}

/** Нуль у заданій валюті. */
export function zero(currency: Currency = 'UAH'): Money {
  return { minor: 0, currency };
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0;
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`${op}: не можна змішувати ${a.currency} та ${b.currency} без конвертації`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  return fromMinor(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'subtract');
  return fromMinor(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return fromMinor(-a.minor, a.currency);
}

export function abs(a: Money): Money {
  return fromMinor(Math.abs(a.minor), a.currency);
}

/** Сума списку. Порожній список повертає нуль у валюті `currency`. */
export function sum(items: readonly Money[], currency: Currency = 'UAH'): Money {
  let total = 0;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new MoneyError(`sum: очікувалась валюта ${currency}, отримано ${item.currency}`);
    }
    total += item.minor;
  }
  return fromMinor(total, currency);
}

/**
 * Множення суми на безрозмірний коефіцієнт (ставка, частка, множник попиту).
 * Округлення — half away from zero, тобто 0.5 копійки завжди "від нуля".
 */
export function scale(a: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new MoneyError(`scale: очікувався скінченний коефіцієнт, отримано ${factor}`);
  }
  return fromMinor(roundHalfAwayFromZero(a.minor * factor), a.currency);
}

/**
 * Ділення суми на ціле число частин без втрати копійок: залишок розподіляється
 * по одній копійці на перші частини. `allocate(fromMinor(100,'UAH'), 3)` дає
 * 34 + 33 + 33 копійки, а не три по 33 із загубленою копійкою.
 */
export function allocate(a: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`allocate: кількість частин має бути додатним цілим, отримано ${parts}`);
  }
  const sign = a.minor < 0 ? -1 : 1;
  const total = Math.abs(a.minor);
  const base = Math.floor(total / parts);
  let remainder = total - base * parts;
  const result: Money[] = [];
  for (let i = 0; i < parts; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    result.push(fromMinor(sign * (base + extra), a.currency));
  }
  return result;
}

/**
 * Розподіл суми за вагами (наприклад, комісії між платіжною системою, банком-
 * емітентом та еквайром). Залишок від округлення додається до найбільшої частки,
 * тому сума часток завжди дорівнює вихідній сумі.
 */
export function allocateByWeights(a: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError('allocateByWeights: потрібна хоча б одна вага');
  }
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  if (!(totalWeight > 0)) {
    throw new MoneyError('allocateByWeights: сума ваг має бути додатною');
  }
  const shares = weights.map((w) => roundHalfAwayFromZero((a.minor * w) / totalWeight));
  const distributed = shares.reduce((acc, s) => acc + s, 0);
  let drift = a.minor - distributed;
  // Залишок кладемо на найбільшу частку — так відносна похибка мінімальна.
  let largest = 0;
  for (let i = 1; i < shares.length; i += 1) {
    if (Math.abs(shares[i] ?? 0) > Math.abs(shares[largest] ?? 0)) largest = i;
  }
  shares[largest] = (shares[largest] ?? 0) + drift;
  drift = 0;
  return shares.map((s) => fromMinor(s, a.currency));
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b, 'compare');
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/** Відношення двох сум однієї валюти. Ділення на нуль дає `fallback`. */
export function ratio(a: Money, b: Money, fallback = 0): number {
  assertSameCurrency(a, b, 'ratio');
  if (b.minor === 0) return fallback;
  return a.minor / b.minor;
}

/** Значення в одиницях валюти — тільки для звітів та логів, не для розрахунків. */
export function toUnits(a: Money): number {
  return a.minor / MINOR_UNITS;
}

/** Форматування для звітів: `1 234 567.89 UAH`. */
export function formatMoney(a: Money, options: { readonly withCurrency?: boolean } = {}): string {
  const withCurrency = options.withCurrency ?? true;
  const sign = a.minor < 0 ? '-' : '';
  const total = Math.abs(a.minor);
  const units = Math.floor(total / MINOR_UNITS).toString();
  const cents = (total % MINOR_UNITS).toString().padStart(2, '0');
  const grouped = units.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${grouped}.${cents}${withCurrency ? ` ${a.currency}` : ''}`;
}

/**
 * Округлення "half away from zero". `Math.round` округлює -0.5 до -0, що для
 * від'ємних проводок дає асиметрію між дебетом і кредитом.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Переведення річної номінальної ставки у множник за один тижневий такт.
 * Використовуємо просту (не складну) пропорцію на 365/7 днів — саме так
 * нараховуються відсотки за українськими кредитами й депозитами.
 */
export function weeklyInterest(principal: Money, annualRate: number, days = 7): Money {
  return scale(principal, (annualRate * days) / 365);
}

/** Конвертація за курсом (одиниць `to` за одиницю `from`). */
export function convert(a: Money, to: Currency, rate: number): Money {
  if (a.currency === to) return a;
  if (!(rate > 0)) {
    throw new MoneyError(`convert: курс має бути додатним, отримано ${rate}`);
  }
  return fromMinor(roundHalfAwayFromZero(a.minor * rate), to);
}
