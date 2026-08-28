/** Форматування звітності для консолі. */

import {
  formatMoney,
  reportLineTitle,
  type BalanceSheet,
  type IncomeStatement,
  type Money,
  type PrudentialRatios,
} from '@uabanksim/core';


const COLUMN = 42;

function row(label: string, amount: Money): string {
  const title = reportLineTitle(label);
  return `  ${title.padEnd(COLUMN)}${formatMoney(amount, { withCurrency: false }).padStart(20)}`;
}

function percent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function renderBalanceSheet(sheet: BalanceSheet): string {
  const out: string[] = ['БАЛАНС', '', ' АКТИВИ'];
  for (const [line, amount] of sheet.assetLines) out.push(row(line, amount));
  out.push(row('РАЗОМ АКТИВИ', sheet.totalAssets), '', ' ЗОБОВ’ЯЗАННЯ');
  for (const [line, amount] of sheet.liabilityLines) out.push(row(line, amount));
  out.push(row('Разом зобов’язання', sheet.totalLiabilities), '', ' КАПІТАЛ');
  for (const [line, amount] of sheet.equityLines) out.push(row(line, amount));
  out.push(row('Разом капітал', sheet.totalEquity));
  return out.join('\n');
}

export function renderIncomeStatement(pnl: IncomeStatement): string {
  return [
    `ЗВІТ ПРО ФІНАНСОВІ РЕЗУЛЬТАТИ (тижні ${pnl.fromWeek}-${pnl.toWeek})`,
    '',
    row('Процентні доходи', pnl.interestIncome),
    row('Процентні витрати', pnl.interestExpense),
    row('Чистий процентний дохід', pnl.netInterestIncome),
    row('Комісійні доходи', pnl.feeIncome),
    row('Операційний дохід', pnl.operatingIncome),
    '',
    row('Витрати на персонал', pnl.staffCost),
    row('Адміністративні витрати', pnl.administrativeCost),
    row('Відрахування в резерви', pnl.provisionCharge),
    row('Штрафи регулятора', pnl.penalties),
    '',
    row('Прибуток до оподаткування', pnl.profitBeforeTax),
    row('Податок на прибуток', pnl.tax),
    row('ЧИСТИЙ ПРИБУТОК', pnl.netProfit),
    '',
    `  ${'Cost-Income Ratio (CIR)'.padEnd(COLUMN)}${percent(pnl.costIncomeRatio, 0).padStart(20)}`,
  ].join('\n');
}

export function renderRatios(ratios: PrudentialRatios): string {
  const line = (title: string, value: string, limit?: string): string =>
    `  ${title.padEnd(COLUMN)}${value.padStart(12)}${limit ? `   (мін. ${limit})` : ''}`;
  const out = [
    'НОРМАТИВИ НБУ',
    '',
    line('Регулятивний капітал (Н1)', formatMoney(ratios.regulatoryCapital, { withCurrency: false })),
    line('Достатність капіталу (Н2)', percent(ratios.h2CapitalAdequacy), '10%'),
    line('Капітал до активів (Н3)', percent(ratios.h3CapitalToAssets), '7%'),
    line('Короткострокова ліквідність (Н6)', percent(ratios.h6ShortTermLiquidity), '60%'),
    line('Активи, зважені на ризик', formatMoney(ratios.riskWeightedAssets, { withCurrency: false })),
    line('Частка NPL у портфелі', percent(ratios.nplRatio)),
    line('Покриття NPL резервами', percent(ratios.provisionCoverage, 0)),
  ];
  if (ratios.breaches.length > 0) {
    out.push('', '  ПОРУШЕННЯ:');
    for (const breach of ratios.breaches) out.push(`   ! ${breach.message}`);
  }
  return out.join('\n');
}

export { percent };
