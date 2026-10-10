/**
 * Типізована шина подій — єдиний спосіб, у який модулі спілкуються між собою.
 *
 * Модуль ніколи не імпортує інший модуль. Він публікує подію ("видано кредит",
 * "клієнт зняв готівку в банкоматі") і підписується на ті, що його стосуються.
 * Завдяки цьому карткові продукти, інкасація чи казначейство додаються без
 * жодної правки в решті коду — саме та властивість, заради якої в PRD обрано
 * event-driven архітектуру.
 *
 * Обробники одного тижня виконуються в порядку пріоритету: спочатку макро- та
 * ринкові події, потім бізнес-логіка модулів, наприкінці — казначейство, яке
 * закриває розрив ліквідності за наслідками всіх інших рішень.
 */

/** Базова форма події: дискримінований union по полю `type`. */
export interface SimEvent {
  readonly type: string;
}

export type EventHandler<E extends SimEvent> = (event: E) => void;

/** Пріоритети виконання обробників у межах одного типу події. */
export const PRIORITY = {
  /** Макроекономіка, курси, дії регулятора — формують контекст тижня. */
  macro: 100,
  /** Ринок і конкуренти. */
  market: 200,
  /** Продуктові модулі: депозити, кредити, картки, мережа. */
  product: 300,
  /** Нарахування відсотків, резервів, амортизації. */
  accrual: 400,
  /** Казначейство: закриття позиції ліквідності після всіх інших операцій. */
  treasury: 500,
  /** Звітність, нормативи, KPI акціонерів. */
  reporting: 600,
} as const;

interface Subscription<E extends SimEvent> {
  readonly handler: EventHandler<E>;
  readonly priority: number;
  readonly owner: string;
  readonly seq: number;
}

export class EventBus {
  readonly #subscriptions = new Map<string, Subscription<never>[]>();
  #seq = 0;
  #depth = 0;
  #maxDepth = 32;
  readonly #trace: string[] = [];
  #tracing = false;

  /**
   * Підписка на подію. Повертає функцію відписки — модуль, який знімається з
   * гри (закрите відділення, проданий бізнес), прибирає за собою сам.
   */
  on<E extends SimEvent>(
    type: E['type'],
    handler: EventHandler<E>,
    options: { readonly priority?: number; readonly owner?: string } = {},
  ): () => void {
    const list = (this.#subscriptions.get(type) ?? []) as Subscription<E>[];
    const subscription: Subscription<E> = {
      handler,
      priority: options.priority ?? PRIORITY.product,
      owner: options.owner ?? 'anonymous',
      seq: this.#seq++,
    };
    list.push(subscription);
    // Стабільне сортування: рівні пріоритети зберігають порядок реєстрації.
    list.sort((a, b) => (a.priority === b.priority ? a.seq - b.seq : a.priority - b.priority));
    this.#subscriptions.set(type, list as Subscription<never>[]);
    return () => {
      const current = this.#subscriptions.get(type);
      if (!current) return;
      const index = current.indexOf(subscription as Subscription<never>);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /** Одноразова підписка. */
  once<E extends SimEvent>(
    type: E['type'],
    handler: EventHandler<E>,
    options: { readonly priority?: number; readonly owner?: string } = {},
  ): () => void {
    const off = this.on<E>(
      type,
      (event) => {
        off();
        handler(event);
      },
      options,
    );
    return off;
  }

  /**
   * Публікація події. Синхронна: обробник може одразу опублікувати наслідок
   * (видача кредиту → рух готівки → потреба в підкріпленні каси), і весь
   * ланцюжок завершиться до повернення керування.
   */
  emit<E extends SimEvent>(event: E): void {
    if (this.#depth >= this.#maxDepth) {
      throw new Error(
        `EventBus: перевищено глибину вкладеності ${this.#maxDepth} на події "${event.type}" — ` +
          'імовірно, модулі утворили нескінченний цикл',
      );
    }
    if (this.#tracing) this.#trace.push(event.type);
    const list = this.#subscriptions.get(event.type) as Subscription<E>[] | undefined;
    if (!list || list.length === 0) return;
    this.#depth += 1;
    try {
      // Копія списку: обробник має право відписатись під час обробки.
      for (const subscription of [...list]) {
        subscription.handler(event);
      }
    } finally {
      this.#depth -= 1;
    }
  }

  /** Кількість підписників — діагностика складання сценарію. */
  listenerCount(type: string): number {
    return this.#subscriptions.get(type)?.length ?? 0;
  }

  /** Хто підписаний на тип події — для дебагу порядку виконання. */
  subscribersOf(type: string): readonly { owner: string; priority: number }[] {
    return (this.#subscriptions.get(type) ?? []).map((s) => ({ owner: s.owner, priority: s.priority }));
  }

  /** Вмикає запис послідовності подій — використовується в тестах рушія. */
  startTrace(): void {
    this.#tracing = true;
    this.#trace.length = 0;
  }

  stopTrace(): readonly string[] {
    this.#tracing = false;
    return [...this.#trace];
  }

  set maxDepth(value: number) {
    this.#maxDepth = value;
  }
}
