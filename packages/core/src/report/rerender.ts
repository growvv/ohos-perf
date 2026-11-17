import type { ReportModel } from './model';
import {
  renderReportJson,
  renderSummaryJson,
  summarizeReport,
} from './model';
import { renderReportHtml } from './html';
import { renderEvidenceCsv, renderMetricsCsv } from './csv';
import { renderReportXlsx } from './xlsx';

/**
 * Re-rendering a saved report bundle (HapRay parity row 33, the last clause).
 *
 * HapRay's `update` re-runs the whole report from the scene directory when the
 * code changes: it re-analyzes, then rewrites the page. That makes an old
 * report a function of *today's* code, not of what was measured — two people
 * opening the same saved run on different versions see different numbers.
 *
 * This package's `report.json` is a typed model, not an analyzer payload dump:
 * every metric keeps its value, unit, window, provenance and fidelity, and
 * every evidence item keeps its subject and signals. So a bundle can be
 * re-rendered from `report.json` alone — no scene, no device, no analyzer —
 * and the page a reader saved is the page they get back.
 *
 * ## What a re-render cannot reproduce
 *
 * The flamegraph is drawn from folded stacks, which are not in the model: they
 * are a query over `perf_sample`, and copying them into `report.json` would
 * double the document's size for a drawing. A re-render therefore writes no
 * flamegraph rather than an empty canvas, which would be a picture of a
 * capture in which nothing ran. The screenshot is the same story from the
 * other side: `assets/screenshot.png` is a copied file, not a value, so the
 * caller supplies it or the page renders without it.
 */

/**
 * The artifacts a re-render produces, in the order `report` writes them.
 *
 * `assets/screenshot.png` is absent: it is a copied file, so it is the
 * caller's to place beside the page.
 */
export const BUNDLE_RENDERED_FILES: readonly [
  'report.html',
  'report.json',
  'summary.json',
  'metrics.csv',
  'evidence.csv',
  'report.xlsx',
] = [
  'report.html',
  'report.json',
  'summary.json',
  'metrics.csv',
  'evidence.csv',
  'report.xlsx',
];

export interface BundleRerenderInput {
  /** The document `report.json` holds. */
  readonly model: ReportModel;
}

/**
 * Render the bundle from its model.
 *
 * The result is `[name, content]` pairs in {@link BUNDLE_RENDERED_FILES}
 * order, ready to write. It is a pure function of the model — the same
 * document always produces the same bytes, which is what makes a re-render
 * checkable against the bundle it came from.
 */
export function renderBundle(
  input: BundleRerenderInput,
): Array<[string, string | Uint8Array]> {
  const { model } = input;
  return [
    ['report.html', renderReportHtml(model)],
    ['report.json', renderReportJson(model)],
    ['summary.json', renderSummaryJson(summarizeReport(model))],
    ['metrics.csv', renderMetricsCsv(model)],
    ['evidence.csv', renderEvidenceCsv(model)],
    ['report.xlsx', renderReportXlsx(model)],
  ];
}
