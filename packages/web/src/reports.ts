/**
 * Панелі звітності: Баланс, Звіт про фінансові результати, Нормативи, Журнал.
 *
 * Усі цифри беруться з тих самих функцій, що й у консольному прогоні, — жодного
 * окремого «розрахунку для UI». Якщо число з'явилось тут, воно є в Головній книзі.
 */

import {
  RATIO_LIMITS,
  formatMoney,
  reportLineTitle,
  type BalanceSheet,
  type IncomeStatement,
  type JournalEntry,
  type Money,
  type PrudentialRatios,
} from '@uabanksim/core';

function el(html: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

const amount = (value: Money): string => formatMoney(value, { withCurrency: false });

function row(label: string, value: Money, cls = ''): string {
  const negative = value.minor < 0 ? ' negative' : '';
  return `<tr class="${cls}${negative}"><td>${escapeHtml(label)}</td><td>${amount(value)}</td></tr>`;
}

function group(title: string): string {
  return `<tr class="group"><td colspan="2">${escapeHtml(title)}</td></tr>`;
}

export function balanceSheetTable(sheet: BalanceSheet): HTMLElement {
  const lines = (map: ReadonlyMap<string, Money>): string =>
    [...map].map(([line, value]) => row(reportLineTitle(line), value)).join('');
  return el(
    `<table class="report">` +
      group('Активи') +
      lines(sheet.assetLines) +
      row('Разом активи', sheet.totalAssets, 'total') +
      group('Зобов’язання') +
      lines(sheet.liabilityLines) +
      row('Разом зобов’язання', sheet.totalLiabilities, 'total') +
      group('Капітал') +
      lines(sheet.equityLines) +
      row('Разом капітал', sheet.totalEquity, 'total') +
      `</table>`,
  );
}

export function incomeStatementTable(pnl: IncomeStatement): HTMLElement {
  const cir = Number.isFinite(pnl.costIncomeRatio)
    ? `${(pnl.costIncomeRatio * 100).toFixed(0)}%`
    : '—';
  return el(
    `<table class="report">` +
      group(`Доходи і витрати, тижні ${pnl.fromWeek}–${pnl.toWeek}`) +
      row('Процентні доходи', pnl.interestIncome) +
      row('Процентні витрати', pnl.interestExpense) +
      row('Чистий процентний дохід', pnl.netInterestIncome, 'total') +
      row('Комісійні доходи', pnl.feeIncome) +
      row('Результат від торгівлі валютою', pnl.tradingResult) +
      row('Операційний дохід', pnl.operatingIncome, 'total') +
      group('Витрати') +
      row('Витрати на персонал', pnl.staffCost) +
      row('Адміністративні витрати', pnl.administrativeCost) +
      row('Відрахування в резерви', pnl.provisionCharge) +
      row('Штрафи регулятора', pnl.penalties) +
      group('Результат') +
      row('Прибуток до оподаткування', pnl.profitBeforeTax) +
      row('Податок на прибуток', pnl.tax) +
      row('Чистий прибуток', pnl.netProfit, 'total') +
      `<tr><td>Cost-Income Ratio</td><td>${cir}</td></tr>` +
      `</table>`,
  );
}

interface RatioLine {
  readonly name: string;
  readonly value: number;
  readonly limit: number;
  /** `min` — норматив «не менше», `max` — «не більше». */
  readonly direction: 'min' | 'max';
}

export function ratiosPanel(ratios: PrudentialRatios): HTMLElement {
  const lines: RatioLine[] = [
    { name: 'Н2 — достатність регулятивного капіталу', value: ratios.h2CapitalAdequacy, limit: RATIO_LIMITS.h2Min, direction: 'min' },
    { name: 'Н3 — капітал до сукупних активів', value: ratios.h3CapitalToAssets, limit: RATIO_LIMITS.h3Min, direction: 'min' },
    { name: 'Н6 — короткострокова ліквідність', value: ratios.h6ShortTermLiquidity, limit: RATIO_LIMITS.h6Min, direction: 'min' },
  ];

  const rows = lines
    .map((line) => {
      const ok = line.direction === 'min' ? line.value >= line.limit : line.value <= line.limit;
      // Запас менший за чверть нормативу — привід попередити, а не рапортувати «все добре».
      const tight = ok && Math.abs(line.value - line.limit) < line.limit * 0.25;
      const tone = ok ? (tight ? 'warn' : 'good') : 'bad';
      const mark = ok ? (tight ? '△' : '✓') : '✕';
      const shown = Number.isFinite(line.value) ? `${(line.value * 100).toFixed(1)}%` : '—';
      return (
        `<div class="ratio-row"><span class="ratio-row__name">${escapeHtml(line.name)}</span>` +
        `<span class="ratio-row__value">${shown}</span>` +
        `<span class="ratio-row__limit">${line.direction === 'min' ? 'мін.' : 'макс.'} ${(line.limit * 100).toFixed(0)}%</span>` +
        `<span class="badge" data-tone="${tone}">${mark}</span></div>`
      );
    })
    .join('');

  const capitalOk = ratios.regulatoryCapital.minor >= RATIO_LIMITS.h1MinCapital;
  const extra =
    `<div class="ratio-row"><span class="ratio-row__name">Н1 — регулятивний капітал</span>` +
    `<span class="ratio-row__value">${amount(ratios.regulatoryCapital)}</span>` +
    `<span class="ratio-row__limit">мін. ${(RATIO_LIMITS.h1MinCapital / 100 / 1_000_000).toFixed(0)} млн</span>` +
    `<span class="badge" data-tone="${capitalOk ? 'good' : 'bad'}">${capitalOk ? '✓' : '✕'}</span></div>` +
    `<div class="ratio-row"><span class="ratio-row__name">Активи, зважені на ризик</span>` +
    `<span class="ratio-row__value">${amount(ratios.riskWeightedAssets)}</span><span class="ratio-row__limit"></span><span></span></div>` +
    `<div class="ratio-row"><span class="ratio-row__name">Частка NPL у кредитному портфелі</span>` +
    `<span class="ratio-row__value">${(ratios.nplRatio * 100).toFixed(1)}%</span><span class="ratio-row__limit"></span><span></span></div>` +
    `<div class="ratio-row"><span class="ratio-row__name">Покриття NPL резервами</span>` +
    `<span class="ratio-row__value">${Number.isFinite(ratios.provisionCoverage) ? `${(ratios.provisionCoverage * 100).toFixed(0)}%` : '—'}</span>` +
    `<span class="ratio-row__limit"></span><span></span></div>`;

  return el(`<div>${extra}${rows}</div>`);
}

/** Останні проводки — доказ того, що кожна цифра дашборда має бухгалтерську основу. */
export function journalTable(entries: readonly JournalEntry[]): HTMLElement {
  if (entries.length === 0) return el('<p class="feed__empty">Проводок ще немає.</p>');
  const rows = [...entries]
    .reverse()
    .slice(0, 60)
    .map((entry) => {
      const total = entry.postings
        .filter((p) => p.side === 'debit')
        .reduce((acc, p) => acc + p.amount.minor, 0);
      const accounts = entry.postings
        .map((p) => `${p.side === 'debit' ? 'Дт' : 'Кт'} ${p.account}`)
        .join(' · ');
      return (
        `<tr><td>${escapeHtml(entry.narrative)}<br>` +
        `<span class="feed__when">тиждень ${entry.week} · ${escapeHtml(accounts)}</span></td>` +
        `<td>${formatMoney({ minor: total, currency: 'UAH' }, { withCurrency: false })}</td></tr>`
      );
    })
    .join('');
  return el(`<table class="report">${rows}</table>`);
}
