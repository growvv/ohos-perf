import { describe, it, expect } from 'vitest';
import {
  BUNDLE_RENDERED_FILES,
  renderBundle,
  type BundleRerenderInput,
} from '../src/report/rerender';
import { buildReport } from '../src/report/model';
import { renderReportHtml } from '../src/report/html';
import { renderReportJson, summarizeReport, renderSummaryJson } from '../src/report/model';
import { renderMetricsCsv, renderEvidenceCsv } from '../src/report/csv';
import { renderReportXlsx } from '../src/report/xlsx';
import type { Metric } from '../src/report/metric';

/*
 * HapRay's `update` re-runs the whole report from the scene directory when the
 * code changes. Our `report.json` is not a payload dump — it is a typed model
 * that carries every value the page shows, with provenance and fidelity. So a
 * bundle can be re-rendered from `report.json` alone, without the scene, the
 * device, or today's analyzers.
 *
 * What that buys is the thing a saved report is for: a reader can re-open a
 * run recorded months ago and get the same page, even after an analyzer's
 * output changed. What it costs is that the render is only as good as the
 * model — so `renderBundle` refuses a document that is not one, rather than
 * rendering a page of blanks.
 */

const metric = (id: string, value: number): Metric => ({
  id,
  value,
  unit: 'count',
  fidelity: 'exact',
  provenance: { collector: 'hitrace', table: 'frame_slice', rows: 2, device: 'emu' },
});

const model = buildReport({
  generator: { name: '@ohos-perf/core', version: '0.0.0' },
  app: { packageName: 'com.demo', pids: [17], processNames: ['com.demo'] },
  device: 'emu',
  window: { startNs: 0, endNs: 100 },
  sections: [
    {
      analyzerId: 'frames',
      status: 'measured',
      result: { metrics: [metric('frame.count', 10)], evidence: [] },
    },
  ],
});

const input = (overrides: Partial<BundleRerenderInput> = {}): BundleRerenderInput => ({
  model,
  ...overrides,
});

describe('renderBundle', () => {
  it('renders every artifact from the model alone', () => {
    const bundle = renderBundle(input());
    expect(bundle.map(([name]) => name)).toEqual([...BUNDLE_RENDERED_FILES]);
    for (const [, content] of bundle) {
      expect(typeof content === 'string' ? content.length : content.byteLength).toBeGreaterThan(0);
    }
  });

  it('reproduces the original bundle byte for byte', () => {
    // The point of a re-render is that the page a reader saved is the page
    // they get back. Anything less and the artifact is not a document.
    const bundle = new Map(renderBundle(input()));
    expect(bundle.get('report.html')).toBe(renderReportHtml(model));
    expect(bundle.get('report.json')).toBe(renderReportJson(model));
    expect(bundle.get('summary.json')).toBe(renderSummaryJson(summarizeReport(model)));
    expect(bundle.get('metrics.csv')).toBe(renderMetricsCsv(model));
    expect(bundle.get('evidence.csv')).toBe(renderEvidenceCsv(model));
    expect(bundle.get('report.xlsx')).toEqual(renderReportXlsx(model));
  });

  it('does not write a flamegraph: its stacks are not in the model', () => {
    // `report.json` keeps the metrics and evidence, not the folded stacks the
    // drawing is made from. Writing an empty canvas would be a picture of a
    // capture in which nothing ran, so the file is absent instead.
    expect(renderBundle(input()).map(([name]) => name)).not.toContain('flamegraph.svg');
  });

  it('re-renders a comparison sheet when the model carries one', () => {
    const compared = buildReport({
      generator: { name: '@ohos-perf/core', version: '0.0.0' },
      app: { packageName: 'com.demo', pids: [], processNames: ['com.demo'] },
      device: 'emu',
      window: { startNs: 0, endNs: 100 },
      sections: [],
      comparison: {
        rows: [{
          id: 'frame.count', unit: 'count', baseline: 5, current: 10,
          delta: 5, deltaPct: 100, fidelity: 'exact', status: 'improved',
        }],
        totals: { improved: 1, regressed: 0, unchanged: 0, added: 0, removed: 0, incomparable: 0 },
      },
    });
    const bundle = new Map(renderBundle({ model: compared }));
    expect(bundle.get('report.html')).toContain('Comparison');
  });

  it('is byte-identical across two renders of the same model', () => {
    expect(renderBundle(input())).toEqual(renderBundle(input()));
  });
});
