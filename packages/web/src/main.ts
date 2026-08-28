/**
 * Точка входу веб-інтерфейсу.
 *
 * Інтерфейс тримає рівно два екрани: вибір сценарію і дашборд голови правління.
 * Уся логіка живе в рушії — тут лише читання стану та виклик тих самих рішень,
 * що доступні автопілоту. Перемальовка повна після кожного такту: симуляція
 * рахує тижні, а не кадри, тож економити на рендері немає сенсу.
 */

import './styles.css';
import type { LogRecord } from '@uabanksim/core';
import { SCENARIOS, listScenarios, type ScenarioId } from '@uabanksim/data';
import { Game, toMillions, type Decisions } from './game.ts';
import { barChart, lineChart } from './charts.ts';
import { balanceSheetTable, incomeStatementTable, journalTable, ratiosPanel } from './reports.ts';

const app = document.getElementById('app') as HTMLElement;

type ReportTab = 'balance' | 'income' | 'ratios' | 'journal';

interface AppState {
  game: Game | null;
  scenario: ScenarioId;
  autopilot: boolean;
  tab: ReportTab;
}

const state: AppState = { game: null, scenario: 'sandbox', autopilot: false, tab: 'balance' };

const percent = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';

/** Мільйони гривень у компактному вигляді: 1 240 млн → 1.24 млрд. */
const millions = (value: number): string =>
  Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(2)} млрд` : `${value.toFixed(0)} млн`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

// --- Екран вибору сценарію ------------------------------------------------

function renderIntro(): void {
  app.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'intro';
  intro.innerHTML =
    `<div class="intro__brand">UABankSim</div>` +
    `<h1>Ви — голова правління банку</h1>` +
    `<p class="intro__lede">Ваш продукт — гроші, а головний інструмент — управління ризиком. ` +
    `Кожна дія проходить через справжню бухгалтерію: видача кредиту, підкріплення каси, ` +
    `зарплата касира — усе це проводки, які змінюють баланс і нормативи НБУ. ` +
    `Один хід — один тиждень.</p>` +
    `<div class="scenarios"></div>` +
    `<div class="intro__start">` +
    `<button class="primary" id="start">Почати гру</button>` +
    `<label class="toggle"><input type="checkbox" id="autopilot"> Автопілот — рішення приймає референсна політика</label>` +
    `</div>`;
  app.append(intro);

  const list = intro.querySelector('.scenarios') as HTMLElement;
  for (const scenario of listScenarios()) {
    const card = document.createElement('button');
    card.className = 'scenario';
    card.type = 'button';
    card.setAttribute('aria-pressed', String(scenario.id === state.scenario));
    card.innerHTML =
      `<span class="scenario__year">${scenario.startYear}-${String(scenario.startMonth).padStart(2, '0')} · ` +
      `${scenario.branches} ${scenario.branches === 1 ? 'відділення' : 'відділень'}</span>` +
      `<span class="scenario__title">${escapeHtml(scenario.title)}</span>` +
      `<span class="scenario__summary">${escapeHtml(scenario.summary)}</span>` +
      `<ul class="scenario__brief">${scenario.briefing.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
    card.addEventListener('click', () => {
      state.scenario = scenario.id;
      renderIntro();
    });
    list.append(card);
  }

  const autopilot = intro.querySelector('#autopilot') as HTMLInputElement;
  autopilot.checked = state.autopilot;
  autopilot.addEventListener('change', () => {
    state.autopilot = autopilot.checked;
  });

  (intro.querySelector('#start') as HTMLButtonElement).addEventListener('click', () => {
    state.game = new Game(state.scenario, { seed: 20220224, autopilot: state.autopilot });
    state.tab = 'balance';
    renderDashboard();
  });
}

// --- Дашборд ---------------------------------------------------------------

function renderDashboard(): void {
  const game = state.game;
  if (!game) return renderIntro();
  const sim = game.simulation;
  const point = game.latest;

  app.innerHTML = '';
  app.append(topBar(game), layout(game));

  function topBar(g: Game): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML =
      `<span class="topbar__bank">${escapeHtml(sim.state.bankName)}</span>` +
      `<span class="topbar__date">${escapeHtml(g.label)} · тиждень ${g.week}</span>` +
      `<div class="topbar__macro">` +
      `<span class="macro">Облікова ставка <b>${percent(point.keyRate)}</b></span>` +
      `<span class="macro">Долар <b>${sim.macro.fx.USD.toFixed(2)}</b></span>` +
      `<span class="macro">Інфляція <b>${percent(sim.macro.inflation)}</b></span>` +
      `<span class="macro">Стрес ринку <b>${percent(point.stress, 0)}</b></span>` +
      `</div>` +
      `<div class="topbar__actions">` +
      `<button class="ghost" data-step="week">+ тиждень</button>` +
      `<button class="ghost" data-step="month">+ місяць</button>` +
      `<button class="primary" data-step="quarter">+ квартал</button>` +
      `<button class="ghost" data-step="restart">Заново</button>` +
      `</div>`;

    for (const button of bar.querySelectorAll<HTMLButtonElement>('[data-step]')) {
      const step = button.dataset['step'];
      if (step !== 'restart') button.disabled = !g.isAlive;
      button.addEventListener('click', () => {
        if (step === 'restart') {
          state.game = null;
          return renderIntro();
        }
        if (step === 'week') g.advanceWeek();
        if (step === 'month') g.advanceMonth();
        if (step === 'quarter') g.advanceQuarter();
        renderDashboard();
      });
    }
    return bar;
  }

  function layout(g: Game): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'layout';
    const main = document.createElement('div');
    const side = document.createElement('div');

    if (!g.isAlive) {
      const over = document.createElement('div');
      over.className = 'gameover';
      over.innerHTML =
        `<h2>Гру завершено</h2><p>${escapeHtml(sim.state.gameOverReason ?? '')}</p>`;
      main.append(over);
    }

    main.append(tiles(g), chartsPanel(g), reportsPanel(g));
    side.append(leversPanel(g), feedPanel(g.logs));
    wrap.append(main, side);
    return wrap;
  }
}

// --- Плитки показників ------------------------------------------------------

function tile(label: string, value: string, unit: string, note?: { text: string; tone?: 'good' | 'bad' }): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tile';
  box.innerHTML =
    `<div class="tile__label">${escapeHtml(label)}</div>` +
    `<div class="tile__value">${escapeHtml(value)}<span class="tile__unit">${escapeHtml(unit)}</span></div>` +
    (note ? `<div class="tile__note"${note.tone ? ` data-tone="${note.tone}"` : ''}>${escapeHtml(note.text)}</div>` : '');
  return box;
}

function tiles(game: Game): HTMLElement {
  const point = game.latest;
  const sim = game.simulation;
  const pnl = sim.latestIncomeStatement();
  const assetsDelta = game.delta('assets', 12);
  const container = document.createElement('div');
  container.className = 'tiles';

  container.append(
    tile('Активи', millions(point.assets), '', assetsDelta === null ? undefined : {
      text: `${assetsDelta >= 0 ? '+' : '−'}${millions(Math.abs(assetsDelta))} за квартал`,
      tone: assetsDelta >= 0 ? 'good' : 'bad',
    }),
    tile('Капітал', millions(point.equity), ''),
    tile('Результат періоду', millions(toMillions(pnl.netProfit)), '', {
      text: `${pnl.netProfit.minor >= 0 ? 'прибуток' : 'збиток'} з тижня ${pnl.fromWeek}`,
      tone: pnl.netProfit.minor >= 0 ? 'good' : 'bad',
    }),
    tile('Норматив Н2', percent(point.h2), '', {
      text: point.h2 >= 0.1 ? 'вимога — не менше 10%' : 'порушено вимогу НБУ',
      tone: point.h2 >= 0.1 ? 'good' : 'bad',
    }),
    tile('Частка NPL', percent(point.nplRatio), ''),
    tile('Репутація', percent(point.reputation, 0), '', {
      text: `впізнаваність ${percent(point.awareness, 0)}`,
    }),
  );
  return container;
}

// --- Графіки ----------------------------------------------------------------

/**
 * Для графіків беремо не кожен тиждень, а рівномірну вибірку: на горизонті в
 * кілька років щотижнева крапка не додає інформації, лише шум і зайві вузли.
 */
function sample<T>(items: readonly T[], limit = 60): T[] {
  if (items.length <= limit) return [...items];
  const step = (items.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => items[Math.round(i * step)] as T);
}

function chartsPanel(game: Game): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = '<p class="panel__title">Динаміка</p>';
  const grid = document.createElement('div');
  grid.className = 'charts';

  const points = sample(game.history);
  const labels = points.map((p) => p.label);

  grid.append(
    lineChart({
      title: 'Баланс банку, млн грн',
      labels,
      series: [
        { name: 'Активи', values: points.map((p) => p.assets), color: 'series-1' },
        { name: 'Зобов’язання', values: points.map((p) => p.liabilities), color: 'series-2' },
        { name: 'Капітал', values: points.map((p) => p.equity), color: 'series-3' },
      ],
      format: (v) => millions(v),
      minY: 0,
    }),
    lineChart({
      title: 'Достатність капіталу Н2',
      labels,
      series: [
        {
          name: 'Н2',
          // Норматив може йти в нескінченність, доки немає ризикових активів:
          // обрізаємо, щоб один стартовий тиждень не з'їв усю шкалу.
          values: points.map((p) => Math.min(p.h2, 2)),
          color: 'series-7',
        },
      ],
      format: (v) => `${(v * 100).toFixed(0)}%`,
      reference: { value: 0.1, label: 'мінімум 10%' },
      minY: 0,
    }),
    lineChart({
      title: 'Портфелі, млн грн',
      labels,
      series: [
        { name: 'Кредити', values: points.map((p) => p.loans), color: 'series-2' },
        { name: 'Строкові вклади', values: points.map((p) => p.deposits), color: 'series-1' },
        { name: 'Ліквідні активи', values: points.map((p) => p.liquidAssets), color: 'series-3' },
      ],
      format: (v) => millions(v),
      minY: 0,
    }),
  );

  const months = sample(game.months, 36);
  if (months.length > 0) {
    grid.append(
      barChart({
        title: 'Фінансовий результат за місяць, млн грн',
        labels: months.map((m) => m.label),
        values: months.map((m) => m.profit),
        format: (v) => `${v.toFixed(0)}`,
        polarity: { positive: 'Прибуток', negative: 'Збиток' },
        wide: true,
      }),
    );
  }

  panel.append(grid);
  return panel;
}

// --- Важелі керування -------------------------------------------------------

function leversPanel(game: Game): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  const decisions = game.currentDecisions();
  const market = game.simulation.macro.marketDepositRate;

  panel.innerHTML =
    `<p class="panel__title">Рішення тижня</p>` +
    (game.autopilot
      ? `<p class="lever__hint">Увімкнено автопілот: він перевизначає ці важелі на початку кожного тижня.</p>`
      : '');

  const add = (
    name: string,
    hint: string,
    value: number,
    min: number,
    max: number,
    step: number,
    display: (v: number) => string,
    apply: (v: number) => void,
  ): void => {
    const lever = document.createElement('div');
    lever.className = 'lever';
    lever.innerHTML =
      `<div class="lever__head"><span class="lever__name">${escapeHtml(name)}</span>` +
      `<span class="lever__value">${escapeHtml(display(value))}</span></div>` +
      `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}">` +
      `<div class="lever__hint">${escapeHtml(hint)}</div>`;
    const input = lever.querySelector('input') as HTMLInputElement;
    const readout = lever.querySelector('.lever__value') as HTMLElement;
    input.addEventListener('input', () => {
      readout.textContent = display(Number(input.value));
    });
    input.addEventListener('change', () => {
      apply(Number(input.value));
      // Перемальовуємо лише підказки — повний рендер зкинув би фокус із повзунка.
      updateHints(game);
    });
    panel.append(lever);
  };

  const next: Decisions = { ...decisions };

  add(
    'Ставка за строковими вкладами',
    `Ринок пропонує ${percent(market)}. Вища ставка приносить пасив, але з’їдає маржу.`,
    Number((decisions.termRate * 100).toFixed(1)),
    1,
    35,
    0.5,
    (v) => `${v.toFixed(1)}%`,
    (v) => {
      next.termRate = v / 100;
      game.applyDecisions(next);
    },
  );

  add(
    'Поріг скорингу',
    'Ліворуч — беремо всіх і швидко ростемо разом із NPL. Праворуч — чистий портфель і мало обсягу.',
    Number(decisions.scoringCutoff.toFixed(2)),
    0,
    1,
    0.05,
    (v) => v.toFixed(2),
    (v) => {
      next.scoringCutoff = v;
      game.applyDecisions(next);
    },
  );

  add(
    'Маркетинг на місяць',
    'Впізнаваність згасає без реклами, а в кризу реклама майже не працює.',
    Number(decisions.marketingBudget.toFixed(1)),
    0,
    Math.max(10, Math.ceil(decisions.marketingBudget * 3)),
    0.5,
    (v) => `${v.toFixed(1)} млн`,
    (v) => {
      next.marketingBudget = v;
      game.applyDecisions(next);
    },
  );

  const hints = document.createElement('div');
  hints.className = 'lever__hint';
  hints.id = 'lever-summary';
  panel.append(hints);
  updateHints(game, hints);
  return panel;
}

function updateHints(game: Game, target?: HTMLElement): void {
  const node = target ?? document.getElementById('lever-summary');
  if (!node) return;
  const decisions = game.currentDecisions();
  const market = game.simulation.macro.marketDepositRate;
  const spread = decisions.termRate - market;
  node.textContent =
    spread > 0.01
      ? `Ви платите на ${(spread * 100).toFixed(1)} п.п. більше за ринок — пасив прийде, але дорогий.`
      : spread < -0.01
        ? `Ви платите на ${(Math.abs(spread) * 100).toFixed(1)} п.п. менше за ринок — вклади підуть до конкурентів.`
        : 'Ваша ставка на рівні ринку.';
}

// --- Звітність --------------------------------------------------------------

const TAB_TITLES: Record<ReportTab, string> = {
  balance: 'Баланс',
  income: 'Фінрезультат',
  ratios: 'Нормативи',
  journal: 'Журнал проводок',
};

function reportsPanel(game: Game): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = '<p class="panel__title">Звітність</p>';

  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'tablist');
  const body = document.createElement('div');

  const paint = (): void => {
    body.innerHTML = '';
    const sim = game.simulation;
    if (state.tab === 'balance') body.append(balanceSheetTable(sim.balanceSheet()));
    if (state.tab === 'income') body.append(incomeStatementTable(sim.latestIncomeStatement()));
    if (state.tab === 'ratios') body.append(ratiosPanel(sim.ratios()));
    if (state.tab === 'journal') body.append(journalTable(sim.journal.recentEntries(60)));
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('.tab')) {
      button.setAttribute('aria-selected', String(button.dataset['tab'] === state.tab));
    }
  };

  for (const [id, title] of Object.entries(TAB_TITLES) as [ReportTab, string][]) {
    const button = document.createElement('button');
    button.className = 'tab';
    button.type = 'button';
    button.dataset['tab'] = id;
    button.textContent = title;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => {
      state.tab = id;
      paint();
    });
    tabs.append(button);
  }

  panel.append(tabs, body);
  paint();
  return panel;
}

// --- Стрічка подій ----------------------------------------------------------

function feedPanel(logs: readonly LogRecord[]): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = '<p class="panel__title">Стрічка подій</p>';
  if (logs.length === 0) {
    panel.insertAdjacentHTML('beforeend', '<p class="feed__empty">Поки що тихо. Проженіть кілька тижнів.</p>');
    return panel;
  }
  const list = document.createElement('ul');
  list.className = 'feed';
  for (const record of [...logs].reverse().slice(0, 60)) {
    const item = document.createElement('li');
    item.dataset['severity'] = record.severity;
    item.innerHTML =
      `<span class="feed__when">${record.date.year}-${String(record.date.month).padStart(2, '0')}</span>` +
      `<span class="feed__text">${escapeHtml(record.message)}</span>`;
    list.append(item);
  }
  panel.append(list);
  return panel;
}

renderIntro();
