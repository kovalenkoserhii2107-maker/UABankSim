/**
 * Звітність, що будується виключно з Головної книги: баланс, звіт про
 * фінансові результати та пруденційні нормативи НБУ.
 *
 * Жодна цифра тут не зберігається окремо — усе рахується із сальдо рахунків.
 * Якщо механіка не сформувала проводку, вона не потрапить і у звіт: це
 * навмисна властивість, яка не дає грі "малювати" показники.
 */

import {
  add,
  fromMinor,
  ratio,
  subtract,
  sum,
  zero,
  type Currency,
  type Money,
} from '../money.ts';
import { ACC, CHART_OF_ACCOUNTS, accountDefinition, isBalanceSheet } from './accounts.ts';
import type { Journal } from './journal.ts';

/** Курси до гривні: скільки гривень за одиницю валюти. */
export type FxRates = ReadonlyMap<Currency, number>;

export const UAH_ONLY: FxRates = new Map<Currency, number>([['UAH', 1]]);

function lineTotals(journal: Journal, rates: FxRates, kinds: readonly string[]): Map<string, Money> {
  const totals = new Map<string, Money>();
  for (const def of CHART_OF_ACCOUNTS) {
    if (!kinds.includes(def.kind)) continue;
    const balance = journal.balanceIn(def.code, 'UAH', rates);
    if (balance.minor === 0) continue;
    const signed = def.contra ? fromMinor(-balance.minor, 'UAH') : balance;
    totals.set(def.reportLine, add(totals.get(def.reportLine) ?? zero('UAH'), signed));
  }
  return totals;
}

export interface BalanceSheet {
  readonly week: number;
  readonly assetLines: ReadonlyMap<string, Money>;
  readonly liabilityLines: ReadonlyMap<string, Money>;
  readonly equityLines: ReadonlyMap<string, Money>;
  readonly totalAssets: Money;
  readonly totalLiabilities: Money;
  /** Балансовий капітал, включно з нерозподіленим результатом поточного періоду. */
  readonly totalEquity: Money;
}

export function buildBalanceSheet(journal: Journal, week: number, rates: FxRates = UAH_ONLY): BalanceSheet {
  const assetLines = lineTotals(journal, rates, ['asset']);
  const liabilityLines = lineTotals(journal, rates, ['liability']);
  const equityLines = new Map(lineTotals(journal, rates, ['equity']));

  const totalAssets = sum([...assetLines.values()], 'UAH');
  const totalLiabilities = sum([...liabilityLines.values()], 'UAH');
  // Прибуток поточного періоду ще "сидить" на рахунках 6/7 класу — до річного
  // закриття він є частиною капіталу, інакше баланс не зійдеться.
  const runningResult = subtract(totalAssets, add(totalLiabilities, sum([...equityLines.values()], 'UAH')));
  if (runningResult.minor !== 0) {
    equityLines.set('resultOfPeriod', add(equityLines.get('resultOfPeriod') ?? zero('UAH'), runningResult));
  }
  const totalEquity = sum([...equityLines.values()], 'UAH');

  return { week, assetLines, liabilityLines, equityLines, totalAssets, totalLiabilities, totalEquity };
}

export interface IncomeStatement {
  readonly fromWeek: number;
  readonly toWeek: number;
  readonly interestIncome: Money;
  readonly interestExpense: Money;
  readonly netInterestIncome: Money;
  readonly feeIncome: Money;
  readonly tradingResult: Money;
  readonly operatingIncome: Money;
  readonly staffCost: Money;
  readonly administrativeCost: Money;
  readonly totalOperatingCost: Money;
  readonly provisionCharge: Money;
  readonly penalties: Money;
  readonly profitBeforeTax: Money;
  readonly tax: Money;
  readonly netProfit: Money;
  /** Cost-to-Income Ratio — ключовий KPI акціонерів. */
  readonly costIncomeRatio: number;
}

const ADMIN_LINES = [
  'occupancyCost',
  'depreciation',
  'cashLogisticsCost',
  'marketingCost',
  'itCost',
] as const;

/**
 * Базова ставка податку на прибуток банків. В Україні вона змінювалась:
 * 18% до 2023 року, 50% за наслідками 2023-2024, 25% з 2025-го. Сценарій
 * підставляє історичне значення, ця константа — лише запасний варіант.
 */
export const BANK_PROFIT_TAX_RATE = 0.18;

export function buildIncomeStatement(
  journal: Journal,
  fromWeek: number,
  toWeek: number,
  rates: FxRates = UAH_ONLY,
  taxRate = BANK_PROFIT_TAX_RATE,
): IncomeStatement {
  const income = lineTotals(journal, rates, ['income']);
  const expense = lineTotals(journal, rates, ['expense']);
  const get = (map: Map<string, Money>, line: string): Money => map.get(line) ?? zero('UAH');

  const interestIncome = get(income, 'interestIncome');
  const interestExpense = get(expense, 'interestExpense');
  const netInterestIncome = subtract(interestIncome, interestExpense);
  const feeIncome = get(income, 'feeIncome');
  const tradingResult = get(income, 'tradingResult');
  const operatingIncome = add(add(netInterestIncome, feeIncome), tradingResult);

  const staffCost = get(expense, 'staffCost');
  const administrativeCost = sum(
    ADMIN_LINES.map((line) => get(expense, line)),
    'UAH',
  );
  const totalOperatingCost = add(staffCost, administrativeCost);
  const provisionCharge = subtract(get(expense, 'provisionCharge'), get(income, 'provisionRelease'));
  const penalties = get(expense, 'penalties');

  const profitBeforeTax = subtract(
    operatingIncome,
    add(add(totalOperatingCost, provisionCharge), penalties),
  );
  const tax = profitBeforeTax.minor > 0 ? fromMinor(Math.round(profitBeforeTax.minor * taxRate), 'UAH') : zero('UAH');
  const netProfit = subtract(profitBeforeTax, tax);

  return {
    fromWeek,
    toWeek,
    interestIncome,
    interestExpense,
    netInterestIncome,
    feeIncome,
    tradingResult,
    operatingIncome,
    staffCost,
    administrativeCost,
    totalOperatingCost,
    provisionCharge,
    penalties,
    profitBeforeTax,
    tax,
    netProfit,
    costIncomeRatio: ratio(totalOperatingCost, operatingIncome, Number.POSITIVE_INFINITY),
  };
}

/** Нормативи НБУ, які гра відстежує щотижня. */
export interface PrudentialRatios {
  /** Н1 — мінімальний розмір регулятивного капіталу (абсолютна величина). */
  readonly regulatoryCapital: Money;
  /** Н2 — адекватність регулятивного капіталу, мін. 10%. */
  readonly h2CapitalAdequacy: number;
  /** Н3 — співвідношення регулятивного капіталу до сукупних активів, мін. 7%. */
  readonly h3CapitalToAssets: number;
  /** Н6 — короткострокова ліквідність, мін. 60%. */
  readonly h6ShortTermLiquidity: number;
  /** Активи, зважені на ризик. */
  readonly riskWeightedAssets: Money;
  /** Частка непрацюючих кредитів у портфелі. */
  readonly nplRatio: number;
  /** Покриття кредитного портфеля резервами. */
  readonly provisionCoverage: number;
  readonly breaches: readonly RatioBreach[];
}

export interface RatioBreach {
  readonly code: 'H1' | 'H2' | 'H3' | 'H6';
  readonly actual: number;
  readonly required: number;
  readonly message: string;
}

/** Мінімальні значення нормативів (спрощені, у дусі інструкції НБУ № 368). */
export const RATIO_LIMITS = {
  /** Мінімальний регулятивний капітал банку, млн грн → копійки. */
  h1MinCapital: 200_000_000 * 100,
  h2Min: 0.1,
  h3Min: 0.07,
  h6Min: 0.6,
} as const;

/**
 * Ваги ризику за спрощеною логікою НБУ: готівка та коррахунок в НБУ — 0%,
 * ОВДП і депсертифікати — 0%, міжбанк — 20%, іпотека/МСБ — 50%,
 * незабезпечена роздріб — 100%, основні засоби — 100%.
 */
export const RISK_WEIGHTS: Readonly<Record<string, number>> = {
  [ACC.cashVault]: 0,
  [ACC.cashAtm]: 0,
  [ACC.cashInTransit]: 0.2,
  [ACC.nostroNbu]: 0,
  [ACC.mandatoryReserves]: 0,
  [ACC.nbuCertificates]: 0,
  [ACC.governmentBonds]: 0,
  [ACC.nostroBanks]: 0.2,
  [ACC.interbankPlaced]: 0.2,
  [ACC.loansCorporate]: 1,
  [ACC.loansRetailCash]: 1,
  [ACC.loansRetailCards]: 1,
  [ACC.fixedAssets]: 1,
};

export interface RatioInputs {
  /** Портфель кредитів, визнаних непрацюючими (NPL, прострочення 90+). */
  readonly nonPerformingLoans: Money;
  /** Зобов'язання з погашенням до 1 року — знаменник Н6. */
  readonly shortTermLiabilities: Money;
  /** Ліквідні активи з погашенням до 1 року — чисельник Н6. */
  readonly shortTermAssets?: Money;
}

export function buildPrudentialRatios(
  journal: Journal,
  inputs: RatioInputs,
  rates: FxRates = UAH_ONLY,
): PrudentialRatios {
  const balanceSheet = buildBalanceSheet(journal, 0, rates);
  const at = (code: string): Money => journal.balanceIn(code, 'UAH', rates);

  // Регулятивний капітал: балансовий капітал мінус нематеріальні/непокриті
  // ризики. У спрощеній моделі — балансовий капітал за вирахуванням
  // недосформованих резервів (їх у грі бути не може) і основних засобів понад
  // 25% капіталу ми не віднімаємо, щоб не ускладнювати перший зріз.
  const regulatoryCapital = balanceSheet.totalEquity;

  let rwa = 0;
  for (const def of CHART_OF_ACCOUNTS) {
    if (def.kind !== 'asset' || def.contra) continue;
    const weight = RISK_WEIGHTS[def.code];
    if (weight === undefined || weight === 0) continue;
    rwa += Math.round(at(def.code).minor * weight);
  }
  // Резерви зменшують ризикову базу: зважуємо чисту балансову вартість.
  const allowance = at(ACC.loanLossAllowance);
  rwa = Math.max(0, rwa - allowance.minor);
  const riskWeightedAssets = fromMinor(rwa, 'UAH');

  const grossLoans = sum(
    [at(ACC.loansRetailCash), at(ACC.loansRetailCards), at(ACC.loansCorporate)],
    'UAH',
  );
  const liquidAssets =
    inputs.shortTermAssets ??
    sum(
      [
        at(ACC.cashVault),
        at(ACC.cashAtm),
        at(ACC.nostroNbu),
        at(ACC.nostroBanks),
        at(ACC.nbuCertificates),
        at(ACC.governmentBonds),
        at(ACC.interbankPlaced),
      ],
      'UAH',
    );

  const h2 = ratio(regulatoryCapital, riskWeightedAssets, Number.POSITIVE_INFINITY);
  const h3 = ratio(regulatoryCapital, balanceSheet.totalAssets, Number.POSITIVE_INFINITY);
  const h6 = ratio(liquidAssets, inputs.shortTermLiabilities, Number.POSITIVE_INFINITY);

  const breaches: RatioBreach[] = [];
  if (regulatoryCapital.minor < RATIO_LIMITS.h1MinCapital) {
    breaches.push({
      code: 'H1',
      actual: regulatoryCapital.minor / 100,
      required: RATIO_LIMITS.h1MinCapital / 100,
      message: 'Регулятивний капітал нижчий за мінімально допустимий (Н1)',
    });
  }
  if (h2 < RATIO_LIMITS.h2Min) {
    breaches.push({ code: 'H2', actual: h2, required: RATIO_LIMITS.h2Min, message: 'Порушено норматив достатності капіталу Н2' });
  }
  if (h3 < RATIO_LIMITS.h3Min) {
    breaches.push({ code: 'H3', actual: h3, required: RATIO_LIMITS.h3Min, message: 'Порушено норматив Н3 (капітал до активів)' });
  }
  if (h6 < RATIO_LIMITS.h6Min) {
    breaches.push({ code: 'H6', actual: h6, required: RATIO_LIMITS.h6Min, message: 'Порушено норматив короткострокової ліквідності Н6' });
  }

  return {
    regulatoryCapital,
    h2CapitalAdequacy: h2,
    h3CapitalToAssets: h3,
    h6ShortTermLiquidity: h6,
    riskWeightedAssets,
    nplRatio: ratio(inputs.nonPerformingLoans, grossLoans),
    provisionCoverage: ratio(allowance, inputs.nonPerformingLoans),
    breaches,
  };
}

/**
 * Людські назви статей звітності. Живуть поруч із визначенням самих статей, щоб
 * консоль і веб-інтерфейс не розходились у формулюваннях.
 */
export const REPORT_LINE_TITLES: Readonly<Record<string, string>> = {
  cash: 'Готівка в касах і банкоматах',
  nostroNbu: 'Кореспондентський рахунок в НБУ',
  mandatoryReserves: 'Обов’язкові резерви',
  securities: 'Депсертифікати НБУ та ОВДП',
  nostroBanks: 'Кореспондентські рахунки в банках',
  interbankPlaced: 'Міжбанк розміщений',
  loansRetail: 'Кредити фізичним особам',
  loansCorporate: 'Кредити юридичним особам',
  loanLossAllowance: 'Резерв під знецінення',
  accruedIncome: 'Нараховані доходи',
  fixedAssets: 'Основні засоби',
  otherAssets: 'Інші активи',
  currentAccountsRetail: 'Поточні рахунки фізосіб',
  termDepositsRetail: 'Строкові вклади фізосіб',
  currentAccountsCorporate: 'Поточні рахунки юросіб',
  termDepositsCorporate: 'Строкові кошти юросіб',
  interbankTaken: 'Міжбанк залучений',
  nbuRefinancing: 'Рефінансування НБУ',
  accruedExpense: 'Нараховані витрати',
  payroll: 'Заборгованість із зарплати',
  otherLiabilities: 'Інші зобов’язання',
  shareCapital: 'Статутний капітал',
  retainedEarnings: 'Нерозподілений прибуток',
  currentYearResult: 'Фінансовий результат минулих періодів',
  resultOfPeriod: 'Результат поточного періоду',
};

/** Назва статті для показу; невідомий ключ повертається як є. */
export function reportLineTitle(line: string): string {
  return REPORT_LINE_TITLES[line] ?? line;
}

/** Перевірка, що рахунок належить до звітної статті — використовується в тестах. */
export function reportLineOf(code: string): string {
  return accountDefinition(code).reportLine;
}

export function isBalanceSheetAccount(code: string): boolean {
  return isBalanceSheet(accountDefinition(code));
}
