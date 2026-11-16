import { describe, it, expect } from 'vitest';
import { compareResults, METRIC_DIRECTIONS } from '../src/report/compare';
import type { Fidelity } from '../src/device/capability';
import type { Metric } from '../src/report/metric';

const metricOf = (id: string, value: number | string, fidelity: Fidelity = 'exact'): Metric =>
  ({ id, value, unit: 'count', fidelity, provenance: { collector: 'test', device: 'd' } });

const result = (...metrics: Metric[]) => ({ metrics, evidence: [] });

describe('compareResults', () => {
  it('marks a lower-is-better metric that fell as improved', () => {
    const c = compareResults(
      result(metricOf('frame.jank.rate', 40)),
      result(metricOf('frame.jank.rate', 30)),
    );
    expect(c.rows).toEqual([{
      id: 'frame.jank.rate', unit: 'count', baseline: 40, current: 30,
      delta: -10, deltaPct: -25, fidelity: 'exact', status: 'improved',
    }]);
    expect(c.totals.improved).toBe(1);
  });

  it('marks a higher-is-better metric that rose as improved', () => {
    const c = compareResults(
      result(metricOf('frame.fps', 30)),
      result(metricOf('frame.fps', 45)),
    );
    expect(c.rows[0].status).toBe('improved');
    expect(c.rows[0].deltaPct).toBe(50);
  });

  it('marks a higher-is-better metric that fell as regressed', () => {
    const c = compareResults(
      result(metricOf('frame.fps', 60)),
      result(metricOf('frame.fps', 30)),
    );
    expect(c.rows[0]).toMatchObject({ status: 'regressed', delta: -30, deltaPct: -50 });
  });

  it('marks a lower-is-better metric that rose as regressed', () => {
    const c = compareResults(
      result(metricOf('mem.rss.peak', 100)),
      result(metricOf('mem.rss.peak', 150)),
    );
    expect(c.rows[0]).toMatchObject({ status: 'regressed', delta: 50, deltaPct: 50 });
  });

  it('compares the exact memory-measure metrics as lower-is-better', () => {
    const c = compareResults(
      result(
        metricOf('mem.measure.rss.avg', 600 * 1024 * 1024),
        metricOf('mem.measure.rss.peak', 600 * 1024 * 1024),
      ),
      result(
        metricOf('mem.measure.rss.avg', 500 * 1024 * 1024),
        metricOf('mem.measure.rss.peak', 700 * 1024 * 1024),
      ),
    );
    expect(c.rows.map((row) => [row.id, row.status])).toEqual([
      ['mem.measure.rss.avg', 'improved'],
      ['mem.measure.rss.peak', 'regressed'],
    ]);
  });

  it('marks an equal value as unchanged', () => {
    const c = compareResults(
      result(metricOf('frame.count', 5)),
      result(metricOf('frame.count', 5)),
    );
    expect(c.rows[0]).toMatchObject({ status: 'unchanged', delta: 0, deltaPct: 0 });
  });

  it('omits deltaPct when the baseline is zero', () => {
    const c = compareResults(
      result(metricOf('frame.count', 0)),
      result(metricOf('frame.count', 5)),
    );
    expect(c.rows[0].delta).toBe(5);
    expect(c.rows[0].deltaPct).toBeUndefined();
  });

  it('rounds deltaPct to three decimals', () => {
    const c = compareResults(
      result(metricOf('frame.count', 3)),
      result(metricOf('frame.count', 4)),
    );
    // 1/3 = 33.333...%
    expect(c.rows[0].deltaPct).toBe(33.333);
  });

  it('reports added and removed metrics without a delta', () => {
    const c = compareResults(
      result(metricOf('frame.count', 5)),
      result(metricOf('mem.rss.peak', 100)),
    );
    expect(c.rows.map((r) => [r.id, r.status])).toEqual([
      ['frame.count', 'removed'], ['mem.rss.peak', 'added'],
    ]);
    expect(c.rows.every((r) => r.delta === undefined)).toBe(true);
    expect(c.rows.every((r) => r.deltaPct === undefined)).toBe(true);
  });

  it('takes the current fidelity, or the baseline fidelity for a removed metric', () => {
    const c = compareResults(
      result(metricOf('frame.count', 5, 'exact'), metricOf('frame.fps', 30, 'proxy')),
      result(metricOf('frame.count', 6, 'proxy')),
    );
    const byId = new Map(c.rows.map((r) => [r.id, r]));
    expect(byId.get('frame.count')?.fidelity).toBe('proxy');
    expect(byId.get('frame.fps')?.fidelity).toBe('proxy');
  });

  it('refuses to invent a direction for an unknown metric', () => {
    const c = compareResults(
      result(metricOf('custom.thing', 1)),
      result(metricOf('custom.thing', 2)),
    );
    expect(c.rows[0].status).toBe('incomparable');
    expect(c.rows[0].delta).toBe(1);
    expect(c.rows[0].deltaPct).toBe(100);
  });

  it('treats a string metric as incomparable but reports both values', () => {
    const c = compareResults(
      result(metricOf('startup.mode', 'cold')),
      result(metricOf('startup.mode', 'warm')),
    );
    expect(c.rows[0]).toMatchObject({
      baseline: 'cold', current: 'warm', status: 'incomparable',
    });
    expect(c.rows[0].delta).toBeUndefined();
    expect(c.rows[0].deltaPct).toBeUndefined();
  });

  it('treats a numeric-vs-string pair as incomparable', () => {
    const c = compareResults(
      result(metricOf('frame.count', 5)),
      result(metricOf('frame.count', '5')),
    );
    expect(c.rows[0].status).toBe('incomparable');
    expect(c.rows[0].delta).toBeUndefined();
  });

  it('always reports all six totals', () => {
    const c = compareResults(result(), result());
    expect(Object.keys(c.totals).sort()).toEqual([
      'added', 'improved', 'incomparable', 'regressed', 'removed', 'unchanged',
    ]);
    expect(Object.values(c.totals)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('counts every row in exactly one total', () => {
    const c = compareResults(
      result(
        metricOf('frame.count', 5),          // removed
        metricOf('frame.jank.rate', 40),     // improved
        metricOf('custom.thing', 1),         // incomparable
      ),
      result(
        metricOf('frame.jank.rate', 30),
        metricOf('custom.thing', 2),
        metricOf('mem.rss.peak', 100),       // added
      ),
    );
    const sum = Object.values(c.totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(c.rows.length);
    expect(c.totals).toMatchObject({
      removed: 1, improved: 1, incomparable: 1, added: 1,
    });
  });

  it('is byte-identical across runs and sorted by id', () => {
    const run = () => compareResults(
      result(metricOf('b', 1), metricOf('a', 2)),
      result(metricOf('b', 3), metricOf('a', 1)),
    );
    const a = run();
    expect(a.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(run()));
  });
});

describe('METRIC_DIRECTIONS', () => {
  it('pins the documented directions', () => {
    expect(METRIC_DIRECTIONS['frame.jank.rate']).toBe('lower');
    expect(METRIC_DIRECTIONS['frame.fps']).toBe('higher');
    expect(METRIC_DIRECTIONS['frame.count']).toBe('higher');
    expect(METRIC_DIRECTIONS['frame.rendered.count']).toBe('higher');
    expect(METRIC_DIRECTIONS['binder.latency.avg']).toBe('lower');
    expect(METRIC_DIRECTIONS['binder.transactions.count']).toBe('lower');
    expect(METRIC_DIRECTIONS['thread.redundant.instructions.ratio']).toBe('lower');
    expect(METRIC_DIRECTIONS['mem.rss.peak']).toBe('lower');
    expect(METRIC_DIRECTIONS['mem.measure.rss.avg']).toBe('lower');
    expect(METRIC_DIRECTIONS['mem.measure.rss.peak']).toBe('lower');
    expect(METRIC_DIRECTIONS['startup.duration']).toBe('lower');
    expect(METRIC_DIRECTIONS['render.fps.live']).toBe('higher');
    expect(METRIC_DIRECTIONS['render.hitch.count']).toBe('lower');
    expect(METRIC_DIRECTIONS['empty_frame.count']).toBe('lower');
    expect(METRIC_DIRECTIONS['empty_frame.rate']).toBe('lower');
    expect(METRIC_DIRECTIONS['rs_skip.frames.count']).toBe('lower');
    expect(METRIC_DIRECTIONS['rs_skip.trace.accuracy']).toBe('higher');
    expect(METRIC_DIRECTIONS['components.builds.count']).toBe('lower');
    expect(METRIC_DIRECTIONS['components.recycled.count']).toBe('higher');
    expect(METRIC_DIRECTIONS['components.reuse.rate']).toBe('higher');
  });

  it('leaves a count with no better direction incomparable', () => {
    // More vsync signals is neither better nor worse; only the anomaly rate
    // built on them is. `undefined` is what makes the comparison say so.
    expect(METRIC_DIRECTIONS['vsync.signals.count']).toBeUndefined();
    expect(METRIC_DIRECTIONS['vsync.anomaly.rate']).toBe('lower');
  });

  it('has no direction for a degraded proxy', () => {
    expect(METRIC_DIRECTIONS['render.degraded']).toBeUndefined();
  });
});
