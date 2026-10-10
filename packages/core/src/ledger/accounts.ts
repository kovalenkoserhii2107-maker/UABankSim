/**
 * План рахунків — спрощена, але структурно достовірна модель плану рахунків
 * бухгалтерського обліку банків України (постанова Правління НБУ № 89).
 *
 * Класи рахунків:
 *   1 — казначейські та міжбанківські операції (готівка, коррахунок в НБУ, ЦП, міжбанк)
 *   2 — операції з клієнтами (кредити, депозити, поточні рахунки)
 *   3 — операції з ЦП та інші активи і зобов'язання (розрахунки, зарплата)
 *   4 — фінансові та капітальні інвестиції (основні засоби)
 *   5 — капітал банку
 *   6 — доходи
 *   7 — витрати
 *
 * Ми свідомо беремо підмножину рахунків: гра має бути читабельною, тому один
 * ігровий рахунок може відповідати групі реальних балансових рахунків.
 */

import type { Currency } from '../money.ts';

/** Нормальне сальдо рахунку. Визначає, як дебет/кредит змінюють залишок. */
export type NormalBalance = 'debit' | 'credit';

export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountDefinition {
  /** Номер рахунку за планом рахунків, напр. `2620`. */
  readonly code: string;
  readonly name: string;
  readonly kind: AccountKind;
  /**
   * Контрарний рахунок (напр. резерви під кредити або знос основних засобів):
   * має нормальне сальдо, протилежне своєму класу, і зменшує статтю звітності,
   * до якої належить.
   */
  readonly contra?: boolean;
  /** Стаття балансу / звіту про фінрезультати, у яку рахунок агрегується. */
  readonly reportLine: string;
}

/** Нормальне сальдо за типом рахунку з урахуванням контрарності. */
export function normalBalanceOf(def: AccountDefinition): NormalBalance {
  const base: NormalBalance =
    def.kind === 'asset' || def.kind === 'expense' ? 'debit' : 'credit';
  if (!def.contra) return base;
  return base === 'debit' ? 'credit' : 'debit';
}

/** Чи є рахунок балансовим (проти рахунків доходів/витрат). */
export function isBalanceSheet(def: AccountDefinition): boolean {
  return def.kind === 'asset' || def.kind === 'liability' || def.kind === 'equity';
}

const define = (
  code: string,
  name: string,
  kind: AccountKind,
  reportLine: string,
  contra = false,
): AccountDefinition => (contra ? { code, name, kind, reportLine, contra } : { code, name, kind, reportLine });

/**
 * Ігровий план рахунків. Кожен запис — точка, у якій ігрова механіка
 * доторкається до бухгалтерії: якщо механіка не має рахунку, вона не має і
 * впливу на баланс.
 */
export const CHART_OF_ACCOUNTS: readonly AccountDefinition[] = [
  // --- Клас 1: казначейство та міжбанк -------------------------------------
  define('1001', 'Банкноти та монети в касі банку', 'asset', 'cash'),
  define('1004', 'Банкноти та монети в банкоматах і ПТКС', 'asset', 'cash'),
  define('1005', 'Банкноти та монети в дорозі (інкасація)', 'asset', 'cash'),
  define('1200', 'Кореспондентський рахунок банку в НБУ', 'asset', 'nostroNbu'),
  define('1203', 'Обов’язкові резерви банку в НБУ', 'asset', 'mandatoryReserves'),
  define('1400', 'Депозитні сертифікати НБУ', 'asset', 'securities'),
  define('1410', 'ОВДП у портфелі банку', 'asset', 'securities'),
  define('1418', 'Нараховані доходи за цінними паперами', 'asset', 'accruedIncome'),
  define('1500', 'Кореспондентські рахунки в інших банках', 'asset', 'nostroBanks'),
  define('1523', 'Кредити, надані іншим банкам (міжбанк розміщений)', 'asset', 'interbankPlaced'),
  define('1600', 'Кореспондентські рахунки інших банків', 'liability', 'interbankTaken'),
  define('1623', 'Кредити, отримані від інших банків (міжбанк залучений)', 'liability', 'interbankTaken'),
  define('1626', 'Нараховані витрати за міжбанківськими кредитами', 'liability', 'accruedExpense'),
  define('1630', 'Кредити рефінансування, отримані від НБУ', 'liability', 'nbuRefinancing'),

  // --- Клас 2: операції з клієнтами ----------------------------------------
  define('2062', 'Кредити в поточну діяльність, надані суб’єктам господарювання', 'asset', 'loansCorporate'),
  define('2068', 'Нараховані доходи за кредитами суб’єктам господарювання', 'asset', 'accruedIncome'),
  define('2202', 'Кредити на поточні потреби, надані фізичним особам', 'asset', 'loansRetail'),
  define('2207', 'Кредити за картковими рахунками фізичних осіб', 'asset', 'loansRetail'),
  define('2208', 'Нараховані доходи за кредитами фізичним особам', 'asset', 'accruedIncome'),
  define('2400', 'Резерви під знецінення кредитів клієнтів', 'asset', 'loanLossAllowance', true),
  define('2600', 'Поточні рахунки суб’єктів господарювання', 'liability', 'currentAccountsCorporate'),
  define('2610', 'Строкові кошти суб’єктів господарювання', 'liability', 'termDepositsCorporate'),
  define('2620', 'Поточні рахунки фізичних осіб', 'liability', 'currentAccountsRetail'),
  define('2630', 'Строкові кошти фізичних осіб', 'liability', 'termDepositsRetail'),
  define('2638', 'Нараховані витрати за коштами клієнтів', 'liability', 'accruedExpense'),
  define('2909', 'Інша кредиторська заборгованість за операціями з клієнтами', 'liability', 'otherLiabilities'),

  // --- Клас 3: інші активи та зобов'язання ---------------------------------
  define('3510', 'Дебіторська заборгованість з придбання активів', 'asset', 'otherAssets'),
  define('3552', 'Нестачі та інші нарахування на працівників банку', 'asset', 'otherAssets'),
  define('3620', 'Кредиторська заборгованість за податками та зборами', 'liability', 'otherLiabilities'),
  define('3652', 'Нарахування працівникам банку за заробітною платою', 'liability', 'payroll'),

  // --- Клас 4: основні засоби ----------------------------------------------
  define('4400', 'Основні засоби (приміщення, обладнання, банкомати, броньовані авто)', 'asset', 'fixedAssets'),
  define('4409', 'Знос основних засобів', 'asset', 'fixedAssets', true),

  // --- Клас 5: капітал -----------------------------------------------------
  define('5000', 'Зареєстрований статутний капітал банку', 'equity', 'shareCapital'),
  define('5030', 'Нерозподілені прибутки минулих років', 'equity', 'retainedEarnings'),
  define('5040', 'Прибуток/збиток поточного року', 'equity', 'currentYearResult'),

  // --- Клас 6: доходи ------------------------------------------------------
  define('6042', 'Процентні доходи за кредитами фізичним особам', 'income', 'interestIncome'),
  define('6046', 'Процентні доходи за кредитами суб’єктам господарювання', 'income', 'interestIncome'),
  define('6050', 'Процентні доходи за цінними паперами', 'income', 'interestIncome'),
  define('6110', 'Комісійні доходи за розрахунково-касовим обслуговуванням', 'income', 'feeIncome'),
  define('6111', 'Комісійні доходи за операціями з платіжними картками', 'income', 'feeIncome'),
  define('6204', 'Результат від торгівлі іноземною валютою', 'income', 'tradingResult'),
  define('6395', 'Дохід від зменшення резервів під знецінення кредитів', 'income', 'provisionRelease'),

  // --- Клас 7: витрати -----------------------------------------------------
  define('7040', 'Процентні витрати за строковими коштами фізичних осіб', 'expense', 'interestExpense'),
  define('7041', 'Процентні витрати за поточними рахунками клієнтів', 'expense', 'interestExpense'),
  define('7100', 'Процентні витрати за міжбанківськими кредитами', 'expense', 'interestExpense'),
  define('7101', 'Процентні витрати за кредитами рефінансування НБУ', 'expense', 'interestExpense'),
  define('7400', 'Витрати на утримання персоналу', 'expense', 'staffCost'),
  define('7420', 'Витрати на утримання приміщень та обладнання', 'expense', 'occupancyCost'),
  define('7430', 'Амортизація основних засобів', 'expense', 'depreciation'),
  define('7452', 'Витрати на інкасацію та перевезення цінностей', 'expense', 'cashLogisticsCost'),
  define('7454', 'Витрати на маркетинг та рекламу', 'expense', 'marketingCost'),
  define('7455', 'Витрати на процесинг та телекомунікації', 'expense', 'itCost'),
  define('7470', 'Штрафи та пені, сплачені за рішенням регулятора', 'expense', 'penalties'),
  define('7702', 'Відрахування в резерви під знецінення кредитів', 'expense', 'provisionCharge'),
];

const BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export class UnknownAccountError extends Error {
  constructor(code: string) {
    super(`Рахунок ${code} відсутній у плані рахунків`);
    this.name = 'UnknownAccountError';
  }
}

export function accountDefinition(code: string): AccountDefinition {
  const def = BY_CODE.get(code);
  if (!def) throw new UnknownAccountError(code);
  return def;
}

export function hasAccount(code: string): boolean {
  return BY_CODE.has(code);
}

/**
 * Ключ аналітичного рахунку: один балансовий рахунок ведеться окремо за кожною
 * валютою (саме так виникає валютна позиція банку).
 */
export type AccountKey = `${string}/${Currency}`;

export function accountKey(code: string, currency: Currency): AccountKey {
  return `${code}/${currency}`;
}

export function parseAccountKey(key: AccountKey): { code: string; currency: Currency } {
  const [code, currency] = key.split('/') as [string, Currency];
  return { code, currency };
}

/** Іменовані рахунки, щоб модулі не працювали з "магічними" рядками. */
export const ACC = {
  cashVault: '1001',
  cashAtm: '1004',
  cashInTransit: '1005',
  nostroNbu: '1200',
  mandatoryReserves: '1203',
  nbuCertificates: '1400',
  governmentBonds: '1410',
  accruedSecuritiesIncome: '1418',
  nostroBanks: '1500',
  interbankPlaced: '1523',
  loroBanks: '1600',
  interbankTaken: '1623',
  accruedInterbankExpense: '1626',
  nbuRefinancing: '1630',
  loansCorporate: '2062',
  accruedCorporateInterest: '2068',
  loansRetailCash: '2202',
  loansRetailCards: '2207',
  accruedRetailInterest: '2208',
  loanLossAllowance: '2400',
  currentAccountsCorporate: '2600',
  termDepositsCorporate: '2610',
  currentAccountsRetail: '2620',
  termDepositsRetail: '2630',
  accruedDepositExpense: '2638',
  otherPayables: '2909',
  taxPayable: '3620',
  payrollPayable: '3652',
  fixedAssets: '4400',
  accumulatedDepreciation: '4409',
  shareCapital: '5000',
  retainedEarnings: '5030',
  currentYearResult: '5040',
  interestIncomeRetail: '6042',
  interestIncomeCorporate: '6046',
  interestIncomeSecurities: '6050',
  feeIncomeRko: '6110',
  feeIncomeCards: '6111',
  fxTradingResult: '6204',
  provisionRelease: '6395',
  interestExpenseTermRetail: '7040',
  interestExpenseCurrent: '7041',
  interestExpenseInterbank: '7100',
  interestExpenseNbu: '7101',
  staffCost: '7400',
  occupancyCost: '7420',
  depreciation: '7430',
  cashLogisticsCost: '7452',
  marketingCost: '7454',
  itCost: '7455',
  penalties: '7470',
  provisionCharge: '7702',
} as const satisfies Record<string, string>;
