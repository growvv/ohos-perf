import { describe, it, expect } from 'vitest';
import type { AnalyzerSection } from '../src/analyze/engine';
import { compareResults, type BaselineComparison } from '../src/report/compare';
import { evidence } from '../src/report/evidence';
import { renderReportHtml } from '../src/report/html';
import { metric } from '../src/report/metric';
import { buildReport, type ReportModel } from '../src/report/model';

const app = { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] };

function build(sections: AnalyzerSection[], comparison?: BaselineComparison): ReportModel {
  return buildReport({
    generator: { name: '@ohos-perf/core', version: '0.4.0' },
    app,
    device: 'emu',
    window: { startNs: 1000, endNs: 2000 },
    sections,
    ...(comparison === undefined ? {} : { comparison }),
  });
}

const metricOf = (id: string, value: number) =>
  metric({
    id,
    value,
    unit: 'count',
    fidelity: 'exact',
    provenance: { collector: 'test', device: 'emu' },
  });

const jank = evidence({
  kind: 'jank',
  severity: 'warn',
  subject: { process: 'com.demo', thread: 'ui' },
  window: { startNs: 1000, endNs: 1010 },
  signals: { excess: 4 },
  explain: 'frame over budget',
  drillDown: [],
});

describe('renderReportHtml', () => {
  it('renders one anchored section per analyzer with its metrics and evidence', () => {
    const html = renderReportHtml(
      build([
        { analyzerId: 'frames', status: 'measured', result: { metrics: [metricOf('frame.fps', 60)], evidence: [jank] } },
        { analyzerId: 'gc', status: 'measured', result: { metrics: [metricOf('gc.rate', 2)], evidence: [] } },
      ]),
    );

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<section id="frames"');
    expect(html).toContain('<section id="gc"');
    expect(html).toContain('frame.fps');
    expect(html).toContain('gc.rate');
    expect(html).toContain('frame over budget');
    expect(html).toContain('com.demo');
  });

  it('shows a degraded section and names it in the banner', () => {
    const html = renderReportHtml(
      build([
        {
          analyzerId: 'threads',
          status: 'degraded',
          result: {
            metrics: [metricOf('threads.degraded', 0)],
            evidence: [
              evidence({
                kind: 'degraded_capability',
                severity: 'warn',
                subject: { process: 'com.demo' },
                window: { startNs: 1000, endNs: 2000 },
                signals: { missing: 'perf.pmu' },
                explain: 'threads skipped: missing perf.pmu: no PMU',
                drillDown: [],
              }),
            ],
          },
        },
      ]),
    );

    expect(html).toContain('degraded');
    expect(html).toContain('threads skipped: missing perf.pmu: no PMU');
    expect(html).toMatch(/degraded banner/i);
  });

  it('says a metric covers the whole capture when the scene records no span', () => {
    // `analyze` over a scene with no `trace_range` windows the analyzers over
    // `0 … MAX_SAFE_INTEGER`. Printed as numbers that is a 285-year window in
    // every row of the table.
    const model = buildReport({
      generator: { name: '@ohos-perf/core', version: '0.4.0' },
      app,
      device: 'emu',
      window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
      sections: [
        {
          analyzerId: 'frames',
          status: 'measured',
          result: {
            metrics: [metric({
              id: 'frame.fps',
              value: 60,
              unit: 'count',
              fidelity: 'exact',
              provenance: { collector: 'test', device: 'emu' },
              window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
            })],
            evidence: [],
          },
        },
      ],
    });
    const html = renderReportHtml(model);
    expect(html).toContain('whole capture');
    expect(html).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it('escapes every interpolated value', () => {
    const html = renderReportHtml(
      build([
        {
          analyzerId: 'frames',
          status: 'measured',
          result: {
            metrics: [metricOf('<script>alert(1)</script>', 1)],
            evidence: [
              evidence({
                kind: 'jank',
                severity: 'info',
                subject: { process: '<img src=x onerror=alert(2)>' },
                window: { startNs: 1000, endNs: 1010 },
                signals: {},
                explain: 'a & b "quoted"',
                drillDown: [],
              }),
            ],
          },
        },
      ]),
    );

    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('a &amp; b &quot;quoted&quot;');
  });

  it('is offline: no scripts, links, imports or URLs', () => {
    const html = renderReportHtml(
      build([{ analyzerId: 'frames', status: 'measured', result: { metrics: [metricOf('a', 1)], evidence: [] } }]),
    );
    for (const forbidden of ['<script', '<link', 'http://', 'https://', 'url(', '@import']) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('renders comparison rows with their fidelity and status class, and omits the section without one', () => {
    const proxy = metric({
      id: 'gc.rate',
      value: 2,
      unit: 'count',
      fidelity: 'proxy',
      provenance: { collector: 'test', device: 'emu' },
    });
    const comparison = compareResults(
      { metrics: [metricOf('frame.jank.rate', 40), { ...proxy, value: 3 }], evidence: [] },
      { metrics: [metricOf('frame.jank.rate', 30), proxy], evidence: [] },
    );
    const withCompare = renderReportHtml(
      build(
        [
          {
            analyzerId: 'frames',
            status: 'measured',
            result: { metrics: [metricOf('frame.jank.rate', 30), proxy], evidence: [] },
          },
        ],
        comparison,
      ),
    );
    expect(withCompare).toContain('id="comparison"');
    expect(withCompare).toContain('class="chip improved"');
    expect(withCompare).toContain('40');
    expect(withCompare).toContain('30');

    const start = withCompare.indexOf('<section id="comparison"');
    const comparisonHtml = withCompare.slice(start, withCompare.indexOf('</section>', start));
    expect(comparisonHtml).toContain('<th>Fidelity</th>');
    expect(comparisonHtml).toContain('<td>proxy</td>');

    const without = renderReportHtml(
      build([{ analyzerId: 'frames', status: 'measured', result: { metrics: [metricOf('frame.jank.rate', 30)], evidence: [] } }]),
    );
    expect(without).not.toContain('id="comparison"');
  });

  it('embeds the scene screenshot inside the ui section', () => {
    const model = buildReport({
      generator: { name: '@ohos-perf/core', version: '0.9.0' },
      app,
      device: 'emu',
      window: { startNs: 1000, endNs: 2000 },
      sections: [{
        analyzerId: 'ui',
        status: 'measured',
        result: { metrics: [metricOf('ui.screenshot.width', 1080)], evidence: [] },
      }],
      screenshot: { width: 1080, height: 2340 },
    });
    const html = renderReportHtml(model);

    expect(html).toContain('<section id="ui"');
    expect(html).toContain('<img src="assets/screenshot.png"');
    expect(html).toContain('1080×2340');
    // No screenshot: the metrics carry the degraded reason, and no <img> is
    // emitted, so the page never shows a broken image.
    const without = renderReportHtml(buildReport({
      generator: { name: '@ohos-perf/core', version: '0.9.0' },
      app,
      device: 'emu',
      window: { startNs: 1000, endNs: 2000 },
      sections: [{
        analyzerId: 'ui',
        status: 'measured',
        result: { metrics: [metricOf('ui.screenshot.width', 0)], evidence: [] },
      }],
    }));
    expect(without).not.toContain('<img');
  });

  it('is deterministic', () => {
    const model = build([{ analyzerId: 'frames', status: 'measured', result: { metrics: [metricOf('a', 1)], evidence: [jank] } }]);
    expect(renderReportHtml(model)).toBe(renderReportHtml(model));
  });
});
