/**
 * Графіки дашборда — інлайновий SVG без бібліотек.
 *
 * Кожен графік будується з одного опису серій і повертає готовий елемент разом
 * із шаром наведення: перехрестя та підказка на лінійних, підсвітка стовпця на
 * стовпчикових. Кольори беруться з CSS-змінних (`--series-*`), тому світла й
 * темна теми перемикаються в одному місці, а не в коді графіка.
 */

export interface Series {
  readonly name: string;
  readonly values: readonly number[];
  /** Роль кольору: номер слота категорійної палітри або статус. */
  readonly color: string;
}

export interface LineChartOptions {
  readonly title: string;
  readonly labels: readonly string[];
  readonly series: readonly Series[];
  /** Форматування значення в підказці та на осі. */
  readonly format: (value: number) => string;
  /** Опорна лінія — наприклад, мінімально допустиме значення нормативу. */
  readonly reference?: { readonly value: number; readonly label: string };
  /** Нижня межа осі; за замовчуванням підбирається за даними. */
  readonly minY?: number;
  readonly height?: number;
}

const PAD = { top: 16, right: 14, bottom: 26, left: 56 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 0.001; t += step) {
    ticks.push(Number(t.toFixed(10)));
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Каркас графіка: заголовок, легенда, полотно та контейнер підказки. */
function shell(title: string, series: readonly Series[], body: string, showLegend: boolean): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'chart';
  const legend =
    showLegend && series.length > 1
      ? `<div class="chart__legend">${series
          .map(
            (s) =>
              `<span class="chart__legend-item"><i style="background:var(--${s.color})"></i>${escapeHtml(s.name)}</span>`,
          )
          .join('')}</div>`
      : '';
  figure.innerHTML =
    `<figcaption class="chart__head"><span class="chart__title">${escapeHtml(title)}</span>${legend}</figcaption>` +
    `<div class="chart__canvas">${body}<div class="chart__tip" hidden></div></div>`;
  return figure;
}

/**
 * Лінійний графік зі спільною віссю. Двох шкал не буває навмисно: показники
 * різного масштабу — це два графіки, а не один із двома осями.
 */
export function lineChart(options: LineChartOptions): HTMLElement {
  const { labels, series, format } = options;
  const height = options.height ?? 190;
  const width = 520;
  const points = labels.length;
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  if (options.reference) all.push(options.reference.value);
  const rawMin = options.minY ?? Math.min(...all);
  const rawMax = Math.max(...all);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;
  const min = options.minY ?? rawMin - span * 0.08;
  const max = rawMax + span * 0.08;

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (points <= 1 ? plotW / 2 : (i / (points - 1)) * plotW);
  const y = (v: number): number => PAD.top + plotH - ((v - min) / (max - min || 1)) * plotH;

  const ticks = niceTicks(min, max);
  const grid = ticks
    .map(
      (t) =>
        `<line class="chart__grid" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="chart__tick" x="${PAD.left - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${format(t)}</text>`,
    )
    .join('');

  const reference = options.reference
    ? `<line class="chart__reference" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(options.reference.value).toFixed(1)}" y2="${y(options.reference.value).toFixed(1)}"/>` +
      `<text class="chart__reference-label" x="${width - PAD.right}" y="${(y(options.reference.value) - 5).toFixed(1)}" text-anchor="end">${escapeHtml(options.reference.label)}</text>`
    : '';

  const paths = series
    .map((s) => {
      const d = s.values
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
        .join(' ');
      const last = s.values.length - 1;
      // Крапка на останньому значенні — точка, за якою читають "де ми зараз".
      const marker =
        last >= 0
          ? `<circle class="chart__end" cx="${x(last).toFixed(1)}" cy="${y(s.values[last] as number).toFixed(1)}" r="4" style="fill:var(--${s.color})"/>`
          : '';
      return `<path class="chart__line" d="${d}" style="stroke:var(--${s.color})"/>${marker}`;
    })
    .join('');

  const firstLabel = labels[0] ?? '';
  const lastLabel = labels[labels.length - 1] ?? '';
  const axis =
    `<text class="chart__tick" x="${PAD.left}" y="${height - 8}" text-anchor="start">${escapeHtml(firstLabel)}</text>` +
    (points > 1
      ? `<text class="chart__tick" x="${width - PAD.right}" y="${height - 8}" text-anchor="end">${escapeHtml(lastLabel)}</text>`
      : '');

  const svg =
    `<svg class="chart__svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">` +
    `${grid}${reference}${paths}${axis}` +
    `<line class="chart__crosshair" y1="${PAD.top}" y2="${PAD.top + plotH}" hidden/>` +
    `</svg>`;

  const figure = shell(options.title, series, svg, true);
  attachLineHover(figure, { labels, series, format, x, width });
  return figure;
}

interface HoverContext {
  readonly labels: readonly string[];
  readonly series: readonly Series[];
  readonly format: (value: number) => string;
  readonly x: (index: number) => number;
  readonly width: number;
}

/**
 * Шар наведення. Графік у вебі інтерактивний за замовчуванням: без підказки
 * лінія показує форму, але не дає жодного числа.
 */
function attachLineHover(figure: HTMLElement, ctx: HoverContext): void {
  const canvas = figure.querySelector('.chart__canvas') as HTMLElement;
  const svg = figure.querySelector('.chart__svg') as SVGSVGElement;
  const crosshair = figure.querySelector('.chart__crosshair') as SVGLineElement;
  const tip = figure.querySelector('.chart__tip') as HTMLElement;
  if (ctx.labels.length === 0) return;

  const move = (event: PointerEvent): void => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.min(
      ctx.labels.length - 1,
      Math.max(0, Math.round(ratio * (ctx.labels.length - 1))),
    );
    const svgX = ctx.x(index);
    crosshair.setAttribute('x1', String(svgX));
    crosshair.setAttribute('x2', String(svgX));
    crosshair.removeAttribute('hidden');
    tip.hidden = false;
    tip.innerHTML =
      `<b>${escapeHtml(ctx.labels[index] as string)}</b>` +
      ctx.series
        .map(
          (s) =>
            `<span><i style="background:var(--${s.color})"></i>${escapeHtml(s.name)}` +
            `<em>${ctx.format(s.values[index] as number)}</em></span>`,
        )
        .join('');
    const left = (svgX / ctx.width) * rect.width;
    tip.style.left = `${Math.min(Math.max(left, 8), rect.width - 8)}px`;
  };

  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', () => {
    crosshair.setAttribute('hidden', '');
    tip.hidden = true;
  });
}

export interface BarChartOptions {
  readonly title: string;
  /** Розтягнути на всю ширину сітки графіків. */
  readonly wide?: boolean;
  readonly labels: readonly string[];
  readonly values: readonly number[];
  readonly format: (value: number) => string;
  /** Підпис для додатних і від'ємних значень — полярність не має бути лише кольором. */
  readonly polarity: { readonly positive: string; readonly negative: string };
  readonly height?: number;
}

/**
 * Стовпчиковий графік для величини зі знаком (прибуток / збиток). Полярність
 * кодується розхідною парою "синій ↔ червоний" із нульовою віссю посередині —
 * і дублюється підписом у підказці, щоб колір не був єдиним каналом.
 */
export function barChart(options: BarChartOptions): HTMLElement {
  const height = options.height ?? 190;
  const width = 520;
  const values = options.values;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const y = (v: number): number => PAD.top + plotH - ((v - min) / span) * plotH;
  const zero = y(0);
  const count = Math.max(1, values.length);
  // 2px проміжок між сусідніми стовпцями — інакше вони зливаються в суцільну масу.
  const slot = plotW / count;
  const barW = Math.max(2, Math.min(28, slot - 2));

  const ticks = niceTicks(min, max);
  const grid = ticks
    .map(
      (t) =>
        `<line class="chart__grid" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="chart__tick" x="${PAD.left - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${options.format(t)}</text>`,
    )
    .join('');

  const bars = values
    .map((v, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const top = v >= 0 ? y(v) : zero;
      const h = Math.max(1, Math.abs(y(v) - zero));
      const color = v >= 0 ? 'series-1' : 'status-critical';
      return (
        `<rect class="chart__bar" data-index="${i}" x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" ` +
        `width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:var(--${color})"/>`
      );
    })
    .join('');

  const svg =
    `<svg class="chart__svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">` +
    `${grid}${bars}` +
    `<line class="chart__zero" x1="${PAD.left}" x2="${width - PAD.right}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}"/>` +
    `</svg>`;

  const figure = shell(options.title, [], svg, false);
  if (options.wide) figure.classList.add('chart--wide');
  const tip = figure.querySelector('.chart__tip') as HTMLElement;
  const canvas = figure.querySelector('.chart__canvas') as HTMLElement;
  canvas.addEventListener('pointermove', (event) => {
    const target = (event.target as Element).closest('.chart__bar');
    if (!target) {
      tip.hidden = true;
      return;
    }
    const index = Number(target.getAttribute('data-index'));
    const value = values[index] as number;
    const sign = value >= 0 ? options.polarity.positive : options.polarity.negative;
    tip.hidden = false;
    tip.innerHTML =
      `<b>${escapeHtml(options.labels[index] ?? '')}</b>` +
      `<span><i style="background:var(--${value >= 0 ? 'series-1' : 'status-critical'})"></i>${escapeHtml(sign)}` +
      `<em>${options.format(Math.abs(value))}</em></span>`;
    const rect = canvas.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(event.clientX - rect.left, 8), rect.width - 8)}px`;
  });
  canvas.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
  return figure;
}
