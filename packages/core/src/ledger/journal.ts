/**
 * Головна книга: журнал проводок з подвійним записом.
 *
 * Правило, на якому тримається весь симулятор: жодна ігрова дія не змінює
 * баланс напряму. Дія формує проводку (`JournalEntry`), проводка проходить
 * перевірку "дебет = кредит у розрізі кожної валюти" і лише тоді потрапляє в
 * книгу. Тому баланс не може "поїхати" через баг у механіці — він або
 * зійдеться, або проводка буде відхилена.
 */

import {
  add,
  fromMinor,
  isZero,
  sum,
  zero,
  type Currency,
  type Money,
} from '../money.ts';
import {
  ACC,
  accountDefinition,
  accountKey,
  isBalanceSheet,
  normalBalanceOf,
  type AccountDefinition,
  type AccountKey,
} from './accounts.ts';

/** Одна сторона проводки. */
export interface Posting {
  readonly account: string;
  readonly currency: Currency;
  /** Додатне число копійок. Напрямок задає `side`. */
  readonly amount: Money;
  readonly side: 'debit' | 'credit';
}

export interface JournalEntry {
  readonly id: number;
  /** Абсолютний номер ігрового тижня, у якому проведено операцію. */
  readonly week: number;
  /** Людський опис для журналу операцій та звіту гравцю. */
  readonly narrative: string;
  /** Модуль-ініціатор (`retail-deposits`, `treasury`, ...). */
  readonly source: string;
  readonly postings: readonly Posting[];
}

export type DraftEntry = Omit<JournalEntry, 'id'>;

export class UnbalancedEntryError extends Error {
  constructor(
    readonly entry: DraftEntry,
    readonly currency: Currency,
    readonly difference: Money,
  ) {
    super(
      `Проводка "${entry.narrative}" не збалансована у ${currency}: ` +
        `різниця ${difference.minor} коп. (джерело: ${entry.source})`,
    );
    this.name = 'UnbalancedEntryError';
  }
}

export class InvalidPostingError extends Error {}

export function debit(account: string, amount: Money): Posting {
  return { account, currency: amount.currency, amount, side: 'debit' };
}

export function credit(account: string, amount: Money): Posting {
  return { account, currency: amount.currency, amount, side: 'credit' };
}

/**
 * Перевіряє, що для кожної валюти сума дебетів дорівнює сумі кредитів.
 * Мультивалютна проводка (напр. купівля валюти) балансується окремо по кожній
 * валюті — різниця курсів визнається як результат від торгівлі (рах. 6204).
 */
export function assertBalanced(entry: DraftEntry): void {
  if (entry.postings.length === 0) {
    throw new InvalidPostingError(`Проводка "${entry.narrative}" не містить жодного запису`);
  }
  const byCurrency = new Map<Currency, number>();
  for (const p of entry.postings) {
    if (p.amount.minor < 0) {
      throw new InvalidPostingError(
        `Проводка "${entry.narrative}": сума ${p.amount.minor} від'ємна; ` +
          'напрямок задається полем side, а не знаком суми',
      );
    }
    if (p.amount.currency !== p.currency) {
      throw new InvalidPostingError(
        `Проводка "${entry.narrative}": валюта запису ${p.currency} не збігається із ` +
          `валютою суми ${p.amount.currency}`,
      );
    }
    accountDefinition(p.account); // кине UnknownAccountError, якщо рахунку немає
    const delta = p.side === 'debit' ? p.amount.minor : -p.amount.minor;
    byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + delta);
  }
  for (const [currency, difference] of byCurrency) {
    if (difference !== 0) {
      throw new UnbalancedEntryError(entry, currency, fromMinor(difference, currency));
    }
  }
}

export interface LedgerSnapshot {
  /** Сальдо за аналітичними рахунками, у копійках, у знаку нормального сальдо. */
  readonly balances: ReadonlyMap<AccountKey, Money>;
  readonly entryCount: number;
}

export interface JournalOptions {
  /**
   * Скільки останніх проводок тримати в пам'яті для журналу операцій.
   * Симуляція на 10 років генерує сотні тисяч проводок; сальдо ведеться
   * інкрементально, тому повна історія потрібна лише для UI та дебагу.
   */
  readonly historyLimit?: number;
}

/**
 * Головна книга банку. Тримає інкрементальні сальдо (щоб звітність будувалась
 * за O(рахунків), а не за O(проводок)) та обмежене вікно історії.
 */
export class Journal {
  #nextId = 1;
  #entryCount = 0;
  readonly #balances = new Map<AccountKey, number>();
  readonly #history: JournalEntry[] = [];
  readonly #historyLimit: number;
  readonly #listeners = new Set<(entry: JournalEntry) => void>();

  constructor(options: JournalOptions = {}) {
    this.#historyLimit = options.historyLimit ?? 2000;
  }

  /** Проводить операцію. Повертає збережений запис із присвоєним id. */
  post(entry: DraftEntry): JournalEntry {
    assertBalanced(entry);
    const stored: JournalEntry = { ...entry, id: this.#nextId };
    this.#nextId += 1;
    this.#entryCount += 1;
    for (const p of entry.postings) {
      const def = accountDefinition(p.account);
      const key = accountKey(p.account, p.currency);
      const signed = p.side === normalBalanceOf(def) ? p.amount.minor : -p.amount.minor;
      this.#balances.set(key, (this.#balances.get(key) ?? 0) + signed);
    }
    this.#history.push(stored);
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    for (const listener of this.#listeners) listener(stored);
    return stored;
  }

  /** Проводить кілька операцій; будь-яка незбалансована зупиняє всю пачку. */
  postAll(entries: readonly DraftEntry[]): JournalEntry[] {
    for (const entry of entries) assertBalanced(entry);
    return entries.map((entry) => this.post(entry));
  }

  /** Підписка на проводки — використовується аудитом і журналом операцій UI. */
  onPost(listener: (entry: JournalEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Сальдо рахунку у знаку його нормального сальдо: для активу додатне сальдо
   * означає актив, для пасиву — зобов'язання. Контрарні рахунки повертають
   * додатне значення тієї суми, на яку вони зменшують основну статтю.
   */
  balance(code: string, currency: Currency = 'UAH'): Money {
    accountDefinition(code);
    return fromMinor(this.#balances.get(accountKey(code, currency)) ?? 0, currency);
  }

  /** Сальдо рахунку по всіх валютах, перерахованих за наданими курсами. */
  balanceIn(code: string, target: Currency, rates: ReadonlyMap<Currency, number>): Money {
    accountDefinition(code);
    let total = 0;
    for (const [key, value] of this.#balances) {
      if (!key.startsWith(`${code}/`)) continue;
      const currency = key.slice(code.length + 1) as Currency;
      if (currency === target) {
        total += value;
        continue;
      }
      const rate = rates.get(currency);
      if (rate === undefined) {
        throw new Error(`balanceIn: немає курсу ${currency}→${target} для рахунку ${code}`);
      }
      total += Math.round(value * rate);
    }
    return fromMinor(total, target);
  }

  /** Сума сальдо кількох рахунків в одній валюті. */
  totalOf(codes: readonly string[], currency: Currency = 'UAH'): Money {
    return sum(
      codes.map((code) => this.balance(code, currency)),
      currency,
    );
  }

  /** Валюти, у яких на рахунку є ненульове сальдо. */
  currenciesOf(code: string): Currency[] {
    const result: Currency[] = [];
    for (const [key, value] of this.#balances) {
      if (value === 0 || !key.startsWith(`${code}/`)) continue;
      result.push(key.slice(code.length + 1) as Currency);
    }
    return result;
  }

  get entryCount(): number {
    return this.#entryCount;
  }

  /** Останні проводки, найновіші в кінці. */
  recentEntries(limit = 50): readonly JournalEntry[] {
    return this.#history.slice(Math.max(0, this.#history.length - limit));
  }

  snapshot(): LedgerSnapshot {
    const balances = new Map<AccountKey, Money>();
    for (const [key, value] of this.#balances) {
      if (value === 0) continue;
      const currency = key.slice(key.indexOf('/') + 1) as Currency;
      balances.set(key, fromMinor(value, currency));
    }
    return { balances, entryCount: this.#entryCount };
  }

  /**
   * Контрольна рівність: активи = зобов'язання + капітал + (доходи − витрати).
   * Рахунки доходів і витрат закриваються лише в кінці року, тому проміжний
   * фінрезультат входить у перевірку окремим доданком.
   */
  trialBalanceDifference(currency: Currency = 'UAH'): Money {
    let assets = 0;
    let claims = 0;
    for (const [key, value] of this.#balances) {
      const slash = key.indexOf('/');
      if ((key.slice(slash + 1) as Currency) !== currency) continue;
      const def = accountDefinition(key.slice(0, slash));
      const signed = def.contra ? -value : value;
      switch (def.kind) {
        case 'asset':
          assets += signed;
          break;
        case 'liability':
        case 'equity':
          claims += signed;
          break;
        case 'income':
          claims += signed;
          break;
        case 'expense':
          claims -= signed;
          break;
      }
    }
    return fromMinor(assets - claims, currency);
  }

  /** `true`, якщо книга сходиться по всіх валютах з ненульовими залишками. */
  isBalanced(): boolean {
    const currencies = new Set<Currency>();
    for (const key of this.#balances.keys()) {
      currencies.add(key.slice(key.indexOf('/') + 1) as Currency);
    }
    for (const currency of currencies) {
      if (!isZero(this.trialBalanceDifference(currency))) return false;
    }
    return true;
  }

  /**
   * Закриття року: рахунки доходів і витрат обнуляються, згорнутий результат
   * переноситься на рахунок 5040 "Прибуток/збиток поточного року".
   */
  closeIncomeAndExpense(week: number, currency: Currency = 'UAH'): DraftEntry | null {
    const postings: Posting[] = [];
    let result = zero(currency);
    for (const [key, value] of this.#balances) {
      if (value === 0) continue;
      const slash = key.indexOf('/');
      if ((key.slice(slash + 1) as Currency) !== currency) continue;
      const code = key.slice(0, slash);
      const def: AccountDefinition = accountDefinition(code);
      if (isBalanceSheet(def)) continue;
      const amount = fromMinor(Math.abs(value), currency);
      if (def.kind === 'income') {
        postings.push({ account: code, currency, amount, side: value > 0 ? 'debit' : 'credit' });
        result = add(result, fromMinor(value, currency));
      } else {
        postings.push({ account: code, currency, amount, side: value > 0 ? 'credit' : 'debit' });
        result = add(result, fromMinor(-value, currency));
      }
    }
    if (postings.length === 0) return null;
    postings.push({
      account: ACC.currentYearResult,
      currency,
      amount: fromMinor(Math.abs(result.minor), currency),
      side: result.minor >= 0 ? 'credit' : 'debit',
    });
    return {
      week,
      narrative: 'Закриття рахунків доходів і витрат на фінансовий результат',
      source: 'ledger',
      postings,
    };
  }
}
