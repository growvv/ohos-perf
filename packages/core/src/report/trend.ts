import type { Metric } from './metric';
import type { ReportModel } from './model';
import { METRIC_DIRECTIONS, type MetricDirection } from './compare';
import { escapeHtml } from './escape';
import { maxOf, minOf } from '../extremes';

/**
 * Multi-run trend aggregation (HapRay parity row 35, the aggregation half).
 *
 * HapRay's `PerfMulti.vue` accepts any set of report HTML files, extracts the
 * embedded JSON from each, and draws the total load and the per-category load
 * across them. It asks the user to filter by app, ROM version, app version and
 * scene — because the page has no model that could tell comparable runs from
 * incomparable ones, so the filtering is left to a human reading four
 * dropdowns.
 *
 * A trend line is a claim that the runs are comparable: that the same app was
 * measured the same way, and that a movement along the x axis is a change in
 * the app rather than a change in what was measured. So this module refuses
 * the inputs that make the claim false — different apps, a duplicated label —
 * and makes the rest of the claim visible: the ordering is stated, a metric a
 * run never emitted is a gap rather than a zero, and a delta is taken between
 * the first and last run that actually measured the metric.
 *
 * ## What a gap means
 *
 * Plotting 0 for "this run did not emit `frame.count`" would draw a collapse
 * to zero and a recovery, which is a much stronger claim than "the analyzer
 * did not run". The point is `null`, the series counts its `measured` points,
 * and the HTML prints the count beside the name. A *degraded* metric counts as
 * a gap too: its zero is the engine's stand-in for "nothing to read", so a
 * series of them is a series of gaps — kept, so the metric that was not
 * measured is named, but drawn as nothing.
 */

/** One run's metrics, named and identified well enough to be compared. */
export interface TrendRun {
  /** Unique across the trend; the x-axis label. */
  readonly label: string;
  readonly app: string;
  readonly device: string;
  /** Capture start, when the run recorded one. Absent disables time ordering. */
  readonly startedAtNs?: number;
  readonly metrics: readonly Metric[];
}

/** One run's value for one metric; `null` when the run did not emit it. */
export interface TrendPoint {
  readonly label: string;
  readonly value: number | string | null;
  /** The metric's fidelity in this run, when it emitted the metric. */
  readonly fidelity?: Metric['fidelity'];
}

export interface TrendSeries {
  readonly id: string;
  readonly unit: Metric['unit'];
  /** One point per run, in `TrendOrder` order. */
  readonly points: readonly TrendPoint[];
  /** How many runs emitted the metric. */
  readonly measured: number;
  /** Difference between the first and last measured numeric points. */
  readonly delta?: number;
  /** Percent change over the same two points; absent when the first is 0. */
  readonly deltaPct?: number;
  /**
   * `improved` / `regressed` / `unchanged` when the metric has a known
   * direction and both ends are numeric; absent otherwise. Unlike a two-way
   * comparison there is no `added`/`removed`/`incomparable` here: a series
   * exists because at least one run emitted it, and a metric with no known
   * direction simply carries no verdict.
   */
  readonly status?: 'improved' | 'regressed' | 'unchanged';
  /** Every run's fidelity, deduplicated and sorted; more than one means mixed. */
  readonly fidelities: readonly Metric['fidelity'][];
}

/** How the runs were ordered. Stated so a reader knows what the x axis means. */
export type TrendOrder = 'startedAtNs' | 'argument';

export interface Trend {
  readonly runs: readonly TrendRun[];
  readonly orderedBy: TrendOrder;
  /** Sorted by id, so two renders of the same input are byte-identical. */
  readonly series: readonly TrendSeries[];
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Aggregate two or more runs into one trend.
 *
 * Throws — rather than filtering silently — when the inputs cannot support the
 * claim: fewer than two runs, a duplicate label (the x axis would have two
 * points in one column), or runs from different apps. `device` is deliberately
 * not a refusal: a trend across two devices is a legitimate question, and the
 * runs table names the device of every point so the reader can see it.
 */
export function buildTrend(runs: readonly TrendRun[]): Trend {
  if (runs.length < 2) {
    throw new Error('buildTrend: a trend needs at least two runs');
  }

  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.label)) {
      throw new Error(`buildTrend: duplicate run label "${run.label}"`);
    }
    seen.add(run.label);
  }

  const apps = [...new Set(runs.map((run) => run.app))].sort();
  if (apps.length > 1) {
    throw new Error(
      `buildTrend: the runs measure different apps (${apps.join(', ')}); ` +
        'a trend is only comparable within one app',
    );
  }

  // Time order only when every run recorded a start; a partial order would
  // silently place an undated run first and make the x axis a lie.
  const timed = runs.every((run) => run.startedAtNs !== undefined);
  const orderedBy: TrendOrder = timed ? 'startedAtNs' : 'argument';
  const ordered = timed
    ? [...runs].sort((a, b) => a.startedAtNs! - b.startedAtNs!)
    : [...runs];

  const ids = [...new Set(runs.flatMap((run) => run.metrics.map((metric) => metric.id)))].sort();

  const series: TrendSeries[] = ids.map((id) => {
    const points: TrendPoint[] = [];
    const fidelities = new Set<Metric['fidelity']>();
    let unit: Metric['unit'] | undefined;

    for (const run of ordered) {
      const metric = run.metrics.find((candidate) => candidate.id === id);
      // A degraded metric is the skipped analyzer's stand-in, not a
      // measurement: its zero is what the engine writes when there was
      // nothing to read. Plotting it would draw a flat line at zero across
      // every run, which is the strongest claim a trend can make about a
      // metric nobody measured.
      if (metric === undefined || metric.degraded !== undefined) {
        points.push({ label: run.label, value: null });
        continue;
      }
      unit ??= metric.unit;
      fidelities.add(metric.fidelity);
      points.push({ label: run.label, value: metric.value, fidelity: metric.fidelity });
    }

    const measuredPoints = points.filter(
      (point) => point.value !== null && typeof point.value === 'number',
    );
    const first = measuredPoints[0];
    const last = measuredPoints[measuredPoints.length - 1];
    const numeric =
      first === undefined || last === undefined || measuredPoints.length < 2
        ? undefined
        : { first: first.value as number, last: last.value as number };

    const delta = numeric === undefined ? undefined : numeric.last - numeric.first;
    const deltaPct =
      numeric === undefined || numeric.first === 0
        ? undefined
        : round3(((numeric.last - numeric.first) / Math.abs(numeric.first)) * 100);

    const direction: MetricDirection | undefined = METRIC_DIRECTIONS[id];
    let status: TrendSeries['status'];
    if (delta !== undefined && direction !== undefined) {
      status =
        delta === 0
          ? 'unchanged'
          : direction === 'lower'
            ? delta < 0 ? 'improved' : 'regressed'
            : delta > 0 ? 'improved' : 'regressed';
    }

    return {
      id,
      unit: unit ?? 'none',
      points,
      measured: measuredPoints.length,
      ...(delta === undefined ? {} : { delta }),
      ...(deltaPct === undefined ? {} : { deltaPct }),
      ...(status === undefined ? {} : { status }),
      fidelities: [...fidelities].sort(byString),
    };
  });

  return { runs: ordered, orderedBy, series };
}

/** The canonical JSON serialization for `trend.json`. */
export function renderTrendJson(trend: Trend): string {
  return `${JSON.stringify(trend, null, 2)}\n`;
}

/**
 * Flatten one saved report into a run.
 *
 * The report model is the input because it is what `report` writes to disk:
 * the metrics are already sorted by id per section, so the flattened list is
 * deterministic without a second sort. A section with no metrics contributes
 * nothing; the run's `metrics.length` is the sum the runs table reports.
 */
export function trendRunFromReport(label: string, model: ReportModel): TrendRun {
  return {
    label,
    app: model.scenario.app.packageName,
    device: model.scenario.device,
    ...(model.scenario.startedAtNs === undefined
      ? {}
      : { startedAtNs: model.scenario.startedAtNs }),
    metrics: model.sections.flatMap((section) => section.metrics),
  };
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1f24; background: #f6f7f9; }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; letter-spacing: -.02em; }
h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
p { margin: .35rem 0; }
code { font: 13px/1.4 ui-monospace, "Cascadia Code", Consolas, monospace; }
.subtitle { color: #47505c; }
.meta { color: #6b7480; font-size: .85rem; }
.card { background: #fff; border: 1px solid #e2e5e9; border-radius: 8px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f2; vertical-align: top; }
th { color: #5b6470; font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.dim { color: #6b7480; }
.chip { display: inline-block; font-size: .72rem; font-weight: 600; padding: .08rem .45rem; border-radius: 999px; background: #eef1f4; text-transform: lowercase; }
.chip.improved { background: #ecfdf3; color: #166534; }
.chip.regressed { background: #fef2f2; color: #b91c1c; }
.chip.unchanged { background: #eef1f4; color: #374151; }
.chip.mixed { background: #fff7ed; color: #9a3412; }
svg.spark { display: block; width: 100%; height: 90px; overflow: visible; }
svg.spark polyline { fill: none; stroke: #2563eb; stroke-width: 1.5; }
svg.spark circle { fill: #2563eb; }
svg.spark .gap { fill: none; stroke: #9ca3af; stroke-dasharray: 2 3; stroke-width: 1; }
footer { margin-top: 2rem; color: #6b7480; font-size: .8rem; }
`.trim();

/** A run's value as a table cell: an em dash for a gap, never a zero. */
function cellText(point: TrendPoint): string {
  return point.value === null ? '—' : String(point.value);
}

/**
 * Draw one series as an inline SVG polyline.
 *
 * Points are evenly spaced by run index — the x axis is the run sequence, not
 * elapsed time, because two runs can be days apart and the interesting
 * movement is the version change, not the calendar. A `null` point breaks the
 * line into segments: the gap is drawn as nothing, which is what "not
 * measured" looks like. A series with fewer than two measured points gets no
 * polyline at all — a line through one point is a dot pretending to be a
 * trend, and the table already states the number.
 */
function sparkline(series: TrendSeries): string {
  const width = 100;
  const height = 100;
  const pad = 4;
  const count = series.points.length;
  const numeric = series.points
    .map((point) => (typeof point.value === 'number' ? point.value : null));
  const values = numeric.filter((value): value is number => value !== null);
  if (values.length < 2) return '';

  let min = minOf(values);
  let max = maxOf(values);
  if (min === max) {
    // A flat line has no range to scale; draw it through the middle rather
    // than dividing by zero.
    min -= 1;
    max += 1;
  }
  const x = (index: number): number =>
    count === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (count - 1);
  const y = (value: number): number =>
    height - pad - ((value - min) / (max - min)) * (height - pad * 2);

  const segments: string[] = [];
  let current: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = numeric[index];
    if (value === null) {
      if (current.length > 0) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`);
  }
  if (current.length > 0) segments.push(current.join(' '));

  const lines = segments.map(
    (segment) => `<polyline points="${segment}"/>`,
  );
  const dots = series.points
    .map((point, index) =>
      typeof point.value === 'number'
        ? `<circle cx="${x(index).toFixed(2)}" cy="${y(point.value).toFixed(2)}" r="1.6"/>`
        : '',
    )
    .filter((dot) => dot !== '');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" ` +
    `preserveAspectRatio="none" role="img" ` +
    `aria-label="${escapeHtml(series.id)} across ${count} runs">` +
    `${lines.join('')}${dots.join('')}</svg>`;
}

/**
 * Render the trend as one self-contained HTML document.
 *
 * Same rules as the report page: no scripts, no external resources, every
 * interpolation escaped. The runs table names each run's label, app, device
 * and start so the reader can judge comparability themselves; the series
 * table carries the numbers a polyline cannot show.
 */
export function renderTrendHtml(trend: Trend): string {
  const orderNote =
    trend.orderedBy === 'startedAtNs'
      ? 'ordered by capture start time'
      : 'in argument order (a run has no capture start time, so time order was not assumed)';

  const runRows = trend.runs.map((run) =>
    [
      '<tr>',
      `<td><code>${escapeHtml(run.label)}</code></td>`,
      `<td>${escapeHtml(run.app)}</td>`,
      `<td>${escapeHtml(run.device)}</td>`,
      `<td class="num">${run.startedAtNs === undefined ? '—' : escapeHtml(String(run.startedAtNs))}</td>`,
      `<td class="num">${run.metrics.length}</td>`,
      '</tr>',
    ].join('\n'),
  );

  const seriesRows = trend.series.map((series) => {
    const mixed = series.fidelities.length > 1;
    const status = series.status === undefined
      ? '<span class="dim">—</span>'
      : `<span class="chip ${series.status}">${escapeHtml(series.status)}</span>`;
    const delta = series.delta === undefined
      ? '<span class="dim">—</span>'
      : escapeHtml(String(series.delta));
    const pct = series.deltaPct === undefined
      ? '<span class="dim">—</span>'
      : escapeHtml(`${series.deltaPct}%`);
    // A polyline through one point is a dot pretending to be a trend.
    const spark = sparkline(series);
    return [
      '<tr>',
      `<td><code>${escapeHtml(series.id)}</code>` +
        `<div class="dim">${series.measured} of ${series.points.length} runs measured</div></td>`,
      `<td>${spark === '' ? '<span class="dim">not measured</span>' : spark}</td>`,
      ...series.points.map((point) => `<td class="num">${escapeHtml(cellText(point))}</td>`),
      `<td>${escapeHtml(series.unit)}</td>`,
      `<td class="num">${delta}</td>`,
      `<td class="num">${pct}</td>`,
      `<td>${status}</td>`,
      `<td class="${mixed ? 'chip mixed' : 'dim'}">${escapeHtml(series.fidelities.join(', ') || '—')}</td>`,
      '</tr>',
    ].join('\n');
  });

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>ohos-perf trend — ${escapeHtml(trend.runs[0]?.app ?? '')}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    '<h1>ohos-perf trend</h1>',
    `<p class="subtitle">${escapeHtml(trend.runs[0]?.app ?? '')} · ` +
      `${trend.runs.length} runs · ${trend.series.length} metrics</p>`,
    `<p class="meta">${escapeHtml(orderNote)}</p>`,
    '</header>',
    '<section class="card">',
    '<h2>Runs</h2>',
    '<table>',
    '<thead><tr><th>Run</th><th>App</th><th>Device</th><th>Started at (ns)</th>' +
      '<th>Metrics</th></tr></thead>',
    '<tbody>',
    ...runRows,
    '</tbody>',
    '</table>',
    '</section>',
    '<section class="card">',
    '<h2>Metrics</h2>',
    '<table>',
    '<thead><tr><th>Metric</th><th>Trend</th>' +
      trend.runs.map((run) => `<th>${escapeHtml(run.label)}</th>`).join('') +
      '<th>Unit</th><th>Delta</th><th>%</th><th>Status</th><th>Fidelity</th></tr></thead>',
    '<tbody>',
    ...seriesRows,
    '</tbody>',
    '</table>',
    '</section>',
    '<footer>Generated from measured run data. A dash is a run that did not ' +
      'emit the metric, never a zero. No scripts, no external resources.</footer>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
