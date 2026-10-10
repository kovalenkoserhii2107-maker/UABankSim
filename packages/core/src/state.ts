/**
 * Стан банку поза Головною книгою.
 *
 * У книзі лежать гроші; тут — усе, що грошима не є, але керує їх рухом:
 * репутація, впізнаваність бренду, прихована шкала уваги регулятора, жорсткість
 * фінмоніторингу. Модулі зберігають власний стан у реєстрі `slice`, тому ядро не
 * має знати ні про картки, ні про інкасацію.
 */

/** Позиція банку щодо фінансового моніторингу — "повзунок жорсткості" з ТЗ. */
export type ComplianceStance = 'white' | 'balanced' | 'grey';

/** Множники до потоку корпоративних клієнтів і до ризику санкцій НБУ. */
export const COMPLIANCE_PROFILE: Readonly<
  Record<ComplianceStance, { readonly corporateInflow: number; readonly attentionPerWeek: number; readonly feeUplift: number }>
> = {
  // Жорсткий: вимагаємо купу довідок, блокуємо сумнівне. Відтік корпоративу,
  // падіння доходів від РКО, нульовий ризик штрафу.
  white: { corporateInflow: 0.7, attentionPerWeek: -0.5, feeUplift: 0.9 },
  balanced: { corporateInflow: 1, attentionPerWeek: 0.2, feeUplift: 1 },
  // М'який: пропускаємо "схемні" транзакції. Вибухове зростання комісій і
  // портфеля — і шкала уваги регулятора, що рано чи пізно вистрілить.
  grey: { corporateInflow: 1.6, attentionPerWeek: 2.5, feeUplift: 1.45 },
};

export interface SimulationStateInit {
  readonly bankName: string;
  readonly reputation?: number;
  readonly brandAwareness?: number;
  readonly regulatorAttention?: number;
  readonly complianceStance?: ComplianceStance;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class SimulationState {
  readonly bankName: string;
  /** Довіра клієнтів, 0..1. Падає від затримок платежів і скандалів. */
  #reputation: number;
  /** Впізнаваність бренду, 0..1. Зростає від маркетингу, згасає без нього. */
  #brandAwareness: number;
  /** Прихована шкала уваги НБУ, 0..100. За 100 — позапланова інспекція. */
  #regulatorAttention: number;
  complianceStance: ComplianceStance;
  /** Чи триває гра. Ставиться в `false` разом із подією `core:game-over`. */
  #alive = true;
  #gameOverReason: string | null = null;

  readonly #slices = new Map<string, unknown>();

  constructor(init: SimulationStateInit) {
    this.bankName = init.bankName;
    this.#reputation = clamp01(init.reputation ?? 0.5);
    this.#brandAwareness = clamp01(init.brandAwareness ?? 0.2);
    this.#regulatorAttention = Math.max(0, init.regulatorAttention ?? 0);
    this.complianceStance = init.complianceStance ?? 'balanced';
  }

  get reputation(): number {
    return this.#reputation;
  }

  get brandAwareness(): number {
    return this.#brandAwareness;
  }

  get regulatorAttention(): number {
    return this.#regulatorAttention;
  }

  get isAlive(): boolean {
    return this.#alive;
  }

  get gameOverReason(): string | null {
    return this.#gameOverReason;
  }

  adjustReputation(delta: number): number {
    this.#reputation = clamp01(this.#reputation + delta);
    return this.#reputation;
  }

  adjustBrandAwareness(delta: number): number {
    this.#brandAwareness = clamp01(this.#brandAwareness + delta);
    return this.#brandAwareness;
  }

  /** Накопичення уваги регулятора. Не може стати від'ємною. */
  adjustRegulatorAttention(delta: number): number {
    this.#regulatorAttention = Math.min(100, Math.max(0, this.#regulatorAttention + delta));
    return this.#regulatorAttention;
  }

  endGame(reason: string): void {
    this.#alive = false;
    this.#gameOverReason = reason;
  }

  /**
   * Реєстр стану модулів. Модуль оголошує свій зріз один раз у `setup` і далі
   * працює з ним як зі звичайним об'єктом.
   */
  registerSlice<T>(key: string, initial: T): T {
    if (this.#slices.has(key)) {
      throw new Error(`Зріз стану "${key}" вже зареєстрований`);
    }
    this.#slices.set(key, initial);
    return initial;
  }

  slice<T>(key: string): T {
    if (!this.#slices.has(key)) {
      throw new Error(`Зріз стану "${key}" не зареєстрований — модуль не підключено до сценарію`);
    }
    return this.#slices.get(key) as T;
  }

  hasSlice(key: string): boolean {
    return this.#slices.has(key);
  }
}
