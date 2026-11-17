import type { Metric } from './metric';
import type { ReportModel, ReportSection } from './model';
import { escapeHtml } from './escape';
import { windowText } from './window';

/** Fixed key order so a render is byte-identical across runs. */
function signalText(signals: Record<string, number | string | readonly string[]>): string {
  return Object.keys(signals)
    .sort()
    .map((key) => `${key}=${String(signals[key])}`)
    .join(', ');
}

function subjectText(subject: {
  process: string;
  thread?: string;
  frameNo?: number;
  pid?: number;
}): string {
  const parts = [subject.process];
  if (subject.thread !== undefined) parts.push(`thread ${subject.thread}`);
  if (subject.frameNo !== undefined) parts.push(`frame ${subject.frameNo}`);
  if (subject.pid !== undefined) parts.push(`pid ${subject.pid}`);
  return parts.join(' · ');
}

function provenanceText(metric: Metric): string {
  const parts = [metric.provenance.collector];
  if (metric.provenance.table !== undefined) parts.push(metric.provenance.table);
  if (metric.provenance.rows !== undefined) parts.push(`${metric.provenance.rows} rows`);
  parts.push(metric.provenance.device);
  return parts.join(' · ');
}

function metricNote(metric: Metric): string {
  if (metric.degraded !== undefined) {
    return `degraded: ${metric.degraded.reason} (${metric.degraded.fallback})`;
  }
  if (metric.window !== undefined) {
    return `window ${windowText(metric.window)}`;
  }
  return '';
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1f24; background: #f6f7f9; }
main { max-width: 1100px; margin: 0 auto; }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; letter-spacing: -.02em; }
h2 { margin: 0; font-size: 1.15rem; }
p { margin: .35rem 0; }
code { font: 13px/1.4 ui-monospace, "Cascadia Code", Consolas, monospace; }
header { margin-bottom: 1.25rem; }
.subtitle { color: #47505c; }
.meta { color: #6b7480; font-size: .85rem; }
.banner.degraded { border-left: 4px solid #b45309; background: #fff7ed; padding: .75rem 1rem; border-radius: 6px; margin: 1rem 0; }
.banner h2 { font-size: 1rem; color: #92400e; }
.banner ul { margin: .4rem 0 0; padding-left: 1.2rem; }
.card { background: #fff; border: 1px solid #e2e5e9; border-radius: 8px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
.section-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .6rem; }
.badge { margin-left: auto; font-size: .75rem; font-weight: 600; padding: .15rem .5rem; border-radius: 999px; background: #ecfdf3; color: #166534; }
.badge.degraded { background: #fff7ed; color: #9a3412; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f2; vertical-align: top; }
th { color: #5b6470; font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.note { color: #8a531a; }
.dim { color: #6b7480; }
.chip { display: inline-block; font-size: .72rem; font-weight: 600; padding: .08rem .45rem; border-radius: 999px; background: #eef1f4; text-transform: lowercase; }
.chip.info { background: #eff6ff; color: #1d4ed8; }
.chip.warn { background: #fff7ed; color: #9a3412; }
.chip.critical { background: #fef2f2; color: #b91c1c; }
.chip.improved { background: #ecfdf3; color: #166534; }
.chip.regressed { background: #fef2f2; color: #b91c1c; }
.chip.unchanged { background: #eef1f4; color: #374151; }
.chip.added, .chip.removed, .chip.incomparable { background: #f3f4f6; color: #4b5563; }
details { margin-top: .5rem; }
figure.screenshot { margin: 0 0 .75rem; }
figure.screenshot img { max-width: 100%; height: auto; border: 1px solid #d7dbe0; border-radius: 6px; }
figcaption { color: #6b7480; font-size: .8rem; }
summary { cursor: pointer; color: #374151; font-size: .88rem; }
ol.evidence { margin: .5rem 0 0; padding-left: 1.2rem; }
ol.evidence li { margin-bottom: .6rem; }
footer { margin-top: 2rem; color: #6b7480; font-size: .8rem; }
@media print { body { background: #fff; padding: 0; } .card { break-inside: avoid; border-color: #ccc; } }
`.trim();

function renderMetricRow(metric: Metric): string {
  const note = metricNote(metric);
  return [
    '<tr>',
    `<td><code>${escapeHtml(metric.id)}</code></td>`,
    `<td class="num">${escapeHtml(String(metric.value))}</td>`,
    `<td>${escapeHtml(metric.unit)}</td>`,
    `<td>${escapeHtml(metric.fidelity)}</td>`,
    `<td class="dim">${escapeHtml(provenanceText(metric))}</td>`,
    `<td class="${note.startsWith('degraded') ? 'note' : 'dim'}">${escapeHtml(note)}</td>`,
    '</tr>',
  ].join('\n');
}

function renderEvidenceItem(
  item: ReportSection['evidence'][number],
): string {
  const signals = signalText(item.signals);
  return [
    `<li class="evidence ${item.severity}">`,
    `<p><span class="chip ${item.severity}">${escapeHtml(item.severity)}</span> ` +
      `<code>${escapeHtml(item.kind)}</code> · ${escapeHtml(subjectText(item.subject))}</p>`,
    `<p>${escapeHtml(item.explain)}</p>`,
    ...(signals === '' ? [] : [`<p class="dim">${escapeHtml(signals)}</p>`]),
    '</li>',
  ].join('\n');
}

function renderSection(section: ReportSection, model: ReportModel): string {
  const metrics = section.metrics.length === 0
    ? '<p class="dim">no metrics</p>'
    : [
        '<table>',
        '<thead><tr><th>Metric</th><th>Value</th><th>Unit</th><th>Fidelity</th>' +
          '<th>Provenance</th><th>Note</th></tr></thead>',
        '<tbody>',
        ...section.metrics.map(renderMetricRow),
        '</tbody>',
        '</table>',
      ].join('\n');
  const evidence = section.evidence.length === 0
    ? ''
    : [
        `<details><summary>Evidence (${section.evidence.length})</summary>`,
        '<ol class="evidence">',
        ...section.evidence.map(renderEvidenceItem),
        '</ol>',
        '</details>',
      ].join('\n');

  // The screenshot belongs to the ui section: it is the artifact that section
  // describes, and a reader comparing the tree metrics to the picture should
  // not have to scroll. A scene without one renders no <img> at all — a broken
  // image icon would say less than the degraded metric notes already do.
  const screenshot = section.id !== 'ui' || model.scenario.screenshot === undefined
    ? ''
    : [
        '<figure class="screenshot">',
        '<img src="assets/screenshot.png" alt="the captured screen">',
        `<figcaption>screenshot.png · ${model.scenario.screenshot.width}×` +
          `${model.scenario.screenshot.height}</figcaption>`,
        '</figure>',
      ].join('\n');

  return [
    `<section id="${escapeHtml(section.id)}" class="card">`,
    '<div class="section-head">',
    `<h2>${escapeHtml(section.title)}</h2>`,
    `<span class="badge${section.status === 'degraded' ? ' degraded' : ''}">` +
      `${escapeHtml(section.status)}</span>`,
    '</div>',
    ...(section.degradedReason === undefined
      ? []
      : [`<p class="note">${escapeHtml(section.degradedReason)}</p>`]),
    screenshot,
    metrics,
    evidence,
    '</section>',
  ].join('\n');
}

function renderBanner(model: ReportModel): string[] {
  const degraded = model.sections.filter((section) => section.status === 'degraded');
  if (degraded.length === 0) return [];
  return [
    '<section class="banner degraded" aria-label="degraded banner">',
    '<h2>Degraded sections</h2>',
    '<ul>',
    ...degraded.map(
      (section) =>
        `<li><code>${escapeHtml(section.id)}</code> — ${escapeHtml(
          section.degradedReason ?? 'no reason recorded',
        )}</li>`,
    ),
    '</ul>',
    '</section>',
  ];
}

function renderComparison(model: ReportModel): string[] {
  if (model.comparison === undefined) return [];
  const rows = model.comparison.rows.map((row) =>
    [
      '<tr>',
      `<td><code>${escapeHtml(row.id)}</code></td>`,
      `<td class="num">${escapeHtml(row.baseline === null ? '—' : String(row.baseline))}</td>`,
      `<td class="num">${escapeHtml(row.current === null ? '—' : String(row.current))}</td>`,
      `<td class="num">${escapeHtml(row.unit)}</td>`,
      `<td class="num">${escapeHtml(row.delta === undefined ? '' : String(row.delta))}</td>`,
      `<td class="num">${escapeHtml(row.deltaPct === undefined ? '' : `${row.deltaPct}%`)}</td>`,
      `<td>${escapeHtml(row.fidelity)}</td>`,
      `<td><span class="chip ${row.status}">${escapeHtml(row.status)}</span></td>`,
      '</tr>',
    ].join('\n'),
  );
  return [
    '<section id="comparison" class="card">',
    '<div class="section-head"><h2>Comparison</h2>' +
      `<span class="badge">${model.comparison.rows.length} metrics</span></div>`,
    '<table>',
    '<thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Unit</th>' +
      '<th>Delta</th><th>%</th><th>Fidelity</th><th>Status</th></tr></thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
    '</section>',
  ];
}

/**
 * Render the whole report as one self-contained HTML document.
 *
 * No scripts, no stylesheets, no images and no URLs: the page is a pure
 * function of the model, so it opens offline and renders identically anywhere.
 * Every interpolation goes through {@link escapeHtml}.
 */
export function renderReportHtml(model: ReportModel): string {
  const { scenario, totals, generator } = model;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>ohos-perf report — ${escapeHtml(scenario.app.packageName)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    '<h1>ohos-perf report</h1>',
    `<p class="subtitle">${escapeHtml(scenario.app.packageName)} · ` +
      `${escapeHtml(scenario.device)} · window ${windowText(scenario.window)}</p>`,
    `<p class="meta">schema ${model.schemaVersion} · ${escapeHtml(generator.name)} ` +
      `${escapeHtml(generator.version)} · ${model.sections.length} sections · ` +
      `${totals.metrics} metrics · ${totals.evidence} evidence</p>`,
    '</header>',
    ...renderBanner(model),
    ...renderComparison(model),
    ...model.sections.map((section) => renderSection(section, model)),
    '<footer>Generated by ' +
      `${escapeHtml(generator.name)} ${escapeHtml(generator.version)} from measured scene data. ` +
      'No scripts, no external resources; every value keeps its provenance and fidelity.</footer>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
