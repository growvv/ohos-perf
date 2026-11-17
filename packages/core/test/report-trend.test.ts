import { describe, it, expect } from 'vitest';
import {
  buildTrend,
  renderTrendHtml,
  renderTrendJson,
  trendRunFromReport,
  type TrendRun,
} from '../src/report/trend';
import type { Metric } from '../src/report/metric';
import { buildReport } from '../src/report/model';

/*
 * HapRay's multi-version page takes several report HTML files, pulls the
 * embedded JSON out of each, and draws the total load and the per-category
 * load across versions. It lets the user drop in any files at all: two
 * different apps, two different scenes, the same file twice — and draws a
 * trend anyway, because the page has no model to refuse with.
 *
 * A trend is a claim that the runs are comparable. So `buildTrend` refuses
 * the inputs that make the claim false, and records what it could not
 * measure rather than plotting a zero: a metric a run never emitted is a
 * gap in the series, not a value of 0.
 */

const metric = (id: string, value: number, fidelity: 'exact' | 'approximate' | 'proxy' = 'exact'): Metric => ({
  id,
  value,
  unit: 'count',
  fidelity,
  provenance: { collector: 'hitrace', table: 'frame_slice', device: 'emu' },
});

function run(
  label: string,
  metrics: Metric[],
  overrides: Partial<TrendRun> = {},
): TrendRun {
  return {
    label,
    app: 'com.demo',
    device: 'emu',
    startedAtNs: 1000,
    metrics,
    ...overrides,
  };
}

describe('buildTrend', () => {
  it('puts one point per run in a series, in run order', () => {
    const trend = buildTrend([
      run('r1', [metric('frame.count', 10)]),
      run('r2', [metric('frame.count', 20)]),
      run('r3', [metric('frame.count', 30)]),
    ]);

    expect(trend.series).toHaveLength(1);
    expect(trend.series[0].id).toBe('frame.count');
    expect(trend.series[0].points.map((point) => point.value)).toEqual([10, 20, 30]);
    expect(trend.series[0].measured).toBe(3);
  });

  it('reports a metric a run never emitted as a gap, not a zero', () => {
    const trend = buildTrend([
      run('r1', [metric('frame.count', 10)]),
      run('r2', []),
      run('r3', [metric('frame.count', 30)]),
    ]);

    expect(trend.series[0].points.map((point) => point.value)).toEqual([10, null, 30]);
    expect(trend.series[0].measured).toBe(2);
  });

  it('takes the delta from the first and last measured point', () => {
    // The middle run did not measure it: the change is 10 -> 30 across the
    // runs that did, not a change to and from nothing.
    const trend = buildTrend([
      run('r1', [metric('frame.count', 10)]),
      run('r2', []),
      run('r3', [metric('frame.count', 30)]),
    ]);

    expect(trend.series[0].delta).toBe(20);
    expect(trend.series[0].deltaPct).toBe(200);
    // More frames is the better direction.
    expect(trend.series[0].status).toBe('improved');
  });

  it('orders the runs by capture time when every run recorded one', () => {
    const trend = buildTrend([
      run('late', [metric('frame.count', 30)], { startedAtNs: 3000 }),
      run('early', [metric('frame.count', 10)], { startedAtNs: 1000 }),
      run('middle', [metric('frame.count', 20)], { startedAtNs: 2000 }),
    ]);

    expect(trend.orderedBy).toBe('startedAtNs');
    expect(trend.runs.map((entry) => entry.label)).toEqual(['early', 'middle', 'late']);
    expect(trend.series[0].points.map((point) => point.value)).toEqual([10, 20, 30]);
  });

  it('keeps the argument order and says so when a run has no timestamp', () => {
    const trend = buildTrend([
      run('b', [metric('frame.count', 20)], { startedAtNs: undefined }),
      run('a', [metric('frame.count', 10)], { startedAtNs: undefined }),
    ]);

    expect(trend.orderedBy).toBe('argument');
    expect(trend.runs.map((entry) => entry.label)).toEqual(['b', 'a']);
  });

  it('refuses fewer than two runs: a trend of one is not a trend', () => {
    expect(() => buildTrend([run('only', [metric('frame.count', 1)])])).toThrow(/at least two/i);
  });

  it('refuses two runs under the same label', () => {
    expect(() =>
      buildTrend([
        run('same', [metric('frame.count', 1)]),
        run('same', [metric('frame.count', 2)]),
      ]),
    ).toThrow(/duplicate/i);
  });

  it('refuses a trend across two different apps', () => {
    // The runs are only comparable when they measure the same app; mixing
    // them produces a line whose movement is the app changing, not the app
    // changing behaviour.
    expect(() =>
      buildTrend([
        run('r1', [metric('frame.count', 1)], { app: 'com.demo' }),
        run('r2', [metric('frame.count', 2)], { app: 'com.other' }),
      ]),
    ).toThrow(/com\.demo.*com\.other/);
  });

  it('sorts series by id so two renders of the same input are identical', () => {
    const trend = buildTrend([
      run('r1', [metric('frame.count', 1), metric('binder.latency.avg', 2)]),
      run('r2', [metric('binder.latency.avg', 3), metric('frame.count', 4)]),
    ]);

    expect(trend.series.map((series) => series.id)).toEqual([
      'binder.latency.avg',
      'frame.count',
    ]);
  });

  it('keeps a non-numeric metric as a label series with no delta', () => {
    const trend = buildTrend([
      run('r1', [{ ...metric('components.top.name', 0), value: 'Button', unit: 'none' }]),
      run('r2', [{ ...metric('components.top.name', 0), value: 'Text', unit: 'none' }]),
    ]);

    expect(trend.series[0].points.map((point) => point.value)).toEqual(['Button', 'Text']);
    expect(trend.series[0].delta).toBeUndefined();
    expect(trend.series[0].status).toBeUndefined();
  });

  it('leaves the status off a metric whose direction is unknown', () => {
    const trend = buildTrend([
      run('r1', [metric('fault.total.count', 1)]),
      run('r2', [metric('fault.total.count', 2)]),
    ]);

    expect(trend.series[0].delta).toBe(1);
    expect(trend.series[0].status).toBeUndefined();
  });

  it('treats a degraded metric as a gap, not a measurement', () => {
    // A skipped analyzer's zero is a stand-in for "not measured", with
    // `proxy` fidelity and a `degraded` block saying so. Plotting it would
    // draw a flat line at zero across every run — the strongest possible
    // claim about a metric nobody measured.
    const degraded = {
      ...metric('binder.latency.avg', 0, 'proxy'),
      degraded: { reason: 'missing trace.binder', fallback: 'analyzer skipped' },
    };
    const trend = buildTrend([
      run('r1', [degraded, metric('frame.count', 10)]),
      run('r2', [degraded, metric('frame.count', 20)]),
    ]);

    const latency = trend.series.find((series) => series.id === 'binder.latency.avg');
    expect(latency?.points.map((point) => point.value)).toEqual([null, null]);
    expect(latency?.measured).toBe(0);
    expect(latency?.delta).toBeUndefined();
    expect(latency?.status).toBeUndefined();
  });

  it('gives a series with one measured point no delta at all', () => {
    // One point has no change. Reporting `delta: 0` would read as "unchanged",
    // which is a measurement this trend did not make.
    const trend = buildTrend([
      run('r1', [metric('frame.count', 10)]),
      run('r2', []),
    ]);

    expect(trend.series[0].measured).toBe(1);
    expect(trend.series[0].delta).toBeUndefined();
    expect(trend.series[0].deltaPct).toBeUndefined();
    expect(trend.series[0].status).toBeUndefined();
  });
});

describe('trendRunFromReport', () => {
  const report = (label: string, packageName: string, startedAtNs?: number) =>
    buildReport({
      generator: { name: '@ohos-perf/core', version: '0.0.0' },
      app: { packageName, pids: [], processNames: [packageName] },
      device: 'emu',
      window: { startNs: 0, endNs: 100 },
      ...(startedAtNs === undefined ? {} : { startedAtNs }),
      sections: [
        {
          analyzerId: 'frames',
          status: 'measured',
          result: {
            metrics: [metric('frame.count', 10), metric('frame.fps', 60)],
            evidence: [],
          },
        },
      ],
    });

  it('flattens a saved report into one run: label, app, device, start and metrics', () => {
    const run = trendRunFromReport('v1', report('v1', 'com.demo', 500));
    expect(run.label).toBe('v1');
    expect(run.app).toBe('com.demo');
    expect(run.device).toBe('emu');
    expect(run.startedAtNs).toBe(500);
    expect(run.metrics.map((entry) => entry.id).sort()).toEqual(['frame.count', 'frame.fps']);
  });

  it('omits the start when the report did not record one', () => {
    const run = trendRunFromReport('v1', report('v1', 'com.demo'));
    expect(run.startedAtNs).toBeUndefined();
  });

  it('produces runs a trend accepts', () => {
    const trend = buildTrend([
      trendRunFromReport('v1', report('v1', 'com.demo', 500)),
      trendRunFromReport('v2', report('v2', 'com.demo', 900)),
    ]);
    expect(trend.orderedBy).toBe('startedAtNs');
    expect(trend.series.find((series) => series.id === 'frame.count')?.delta).toBe(0);
  });
});

describe('renderTrendJson and renderTrendHtml', () => {
  const trend = buildTrend([
    run('v1', [metric('frame.count', 10)], { startedAtNs: 1000 }),
    run('v2', [metric('frame.count', 20)], { startedAtNs: 2000 }),
  ]);

  it('renders JSON that parses back to the model', () => {
    expect(JSON.parse(renderTrendJson(trend))).toEqual(JSON.parse(JSON.stringify(trend)));
  });

  it('renders one row per series with the run labels as columns', () => {
    const html = renderTrendHtml(trend);
    expect(html).toContain('frame.count');
    expect(html).toContain('v1');
    expect(html).toContain('v2');
    expect(html).toContain('improved');
  });

  it('draws no line for a series with fewer than two measured points', () => {
    // A polyline through one point is a dot pretending to be a trend.
    const sparse = buildTrend([
      run('v1', [metric('frame.count', 10)]),
      run('v2', []),
    ]);
    const html = renderTrendHtml(sparse);
    expect(html).not.toContain('<polyline');
    expect(html).toContain('not measured');
  });

  it('carries no scripts and no external URLs', () => {
    const html = renderTrendHtml(trend);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('is byte-identical for the same runs in the same order', () => {
    const again = buildTrend([
      run('v1', [metric('frame.count', 10)], { startedAtNs: 1000 }),
      run('v2', [metric('frame.count', 20)], { startedAtNs: 2000 }),
    ]);
    expect(renderTrendHtml(again)).toBe(renderTrendHtml(trend));
    expect(renderTrendJson(again)).toBe(renderTrendJson(trend));
  });
});
