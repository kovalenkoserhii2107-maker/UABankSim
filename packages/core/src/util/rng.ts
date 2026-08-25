/**
 * Детермінований генератор псевдовипадкових чисел.
 *
 * Симуляція має бути відтворюваною: той самий сценарій із тим самим seed і тими
 * самими рішеннями гравця зобов'язаний дати ту саму історію банку. Це критично
 * і для тестів, і для чесності гри — гравець не може "перекотити" невдалий
 * тиждень перезавантаженням.
 *
 * Реалізація — mulberry32: 32 біти стану, добра рівномірність, швидкість і,
 * головне, повна незалежність від реалізації `Math.random` у рушії JS.
 */

export class Rng {
  #state: number;

  constructor(seed: number) {
    // Приводимо seed до 32-бітного цілого; 0 замінюємо, щоб не застрягти.
    this.#state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Створює незалежний потік із того самого джерела — по потоку на модуль. */
  static forStream(seed: number, stream: string): Rng {
    let h = seed | 0;
    for (let i = 0; i < stream.length; i += 1) {
      h = Math.imul(h ^ stream.charCodeAt(i), 0x01000193);
    }
    return new Rng(h);
  }

  /** Рівномірно розподілене число в [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Рівномірне число в [min, max). */
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Ціле число в [min, max] включно. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max (${max}) менший за min (${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Подія з імовірністю `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Нормальний розподіл (Box-Muller). Використовується там, де шум має бути
   * симетричним: попит на кредити, відхилення курсу, поведінка вкладників.
   */
  normal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Логнормальний множник із медіаною 1 — зручний для мультиплікативного шуму
   * (попит цього тижня = базовий попит × шум), бо ніколи не дає від'ємних значень.
   */
  lognormalFactor(sigma: number): number {
    return Math.exp(this.normal(0, sigma));
  }

  /** Пуассонівська кількість подій (алгоритм Кнута) — для потоку клієнтів. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 500) {
      // При великій інтенсивності нормальне наближення точніше і швидше.
      return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    }
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  /** Випадковий елемент масиву. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: порожній масив');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Стан генератора — щоб зберегти/відновити гру без розсинхрону. */
  get state(): number {
    return this.#state;
  }

  set state(value: number) {
    this.#state = value | 0;
  }
}
