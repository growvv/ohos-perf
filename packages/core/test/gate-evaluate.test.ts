import { describe, it, expect } from 'vitest';
import type { AnalyzeResult } from '../src/analyze/types';
import { evaluateGate, renderGateJson } from '../src/gate/evaluate';
import { parseBudgetDocument } from '../src/gate/schema';
import type { Metric } from '../src/report/metric';

/*
 * A gate's whole value is that it cannot pass on data it does not have. Every
 * test below that asserts `missing` is really asserting that property: an
 * absent metric, a degraded proxy and a zero-baseline percentage all used to
 * be the shapes a naive threshold check would read as a comfortable pass.
 */

function metricOf(
  id: string,
  value: number | string,
  extra: Partial<Metric> = {},
): Metric {
  return {
    id,
    value,
    unit: 'count',
    fidelity: 'exact',
    provenance: { collector: 'test', device: 'd' },
    ...extra,
  };
}

const run = (metrics: Metric[]): AnalyzeResult => ({ metrics, evidence: [] });

const doc = (budgets: unknown[]) =>
  parseBudgetDocument({ schemaVersion: 1, name: 'gate', budgets });

describe('evaluateGate', () => {
  it('passes a max budget at the boundary and fails one above it', () => {
    const atLimit = evaluateGate(doc([{ id: 'frame.jank.rate', max: 5 }]), run([metricOf('frame.jank.rate', 5)]));
    expect(atLimit.verdicts).toEqual([
      {
        id: 'frame.jank.rate',
        status: 'pass',
        value: 5,
        bound: { kind: 'max', limit: 5 },
      },
    ]);
    expect(atLimit.status).toBe('pass');

    const over = evaluateGate(doc([{ id: 'frame.jank.rate', max: 5 }]), run([metricOf('frame.jank.rate', 7.5)]));
    expect(over.verdicts[0]).toMatchObject({ status: 'fail', value: 7.5, excess: 2.5 });
    expect(over.status).toBe('fail');
  });

  it('passes a min budget at the boundary and fails one below it', () => {
    const atLimit = evaluateGate(doc([{ id: 'frame.fps', min: 55 }]), run([metricOf('frame.fps', 55)]));
    expect(atLimit.verdicts[0]).toMatchObject({ status: 'pass', value: 55 });

    const under = evaluateGate(doc([{ id: 'frame.fps', min: 55 }]), run([metricOf('frame.fps', 52.25)]));
    expect(under.verdicts[0]).toMatchObject({ status: 'fail', excess: 2.75 });
  });

  it('judges a delta budget against the baseline and echoes it', () => {
    const passing = evaluateGate(
      doc([{ id: 'frame.avg.duration', maxDelta: 1 }]),
      run([metricOf('frame.avg.duration', 17)]),
      run([metricOf('frame.avg.duration', 16)]),
    );
    expect(passing.verdicts[0]).toMatchObject({ status: 'pass', value: 17, baseline: 16 });

    const failing = evaluateGate(
      doc([{ id: 'frame.avg.duration', maxDelta: 1 }]),
      run([metricOf('frame.avg.duration', 18)]),
      run([metricOf('frame.avg.duration', 16)]),
    );
    expect(failing.verdicts[0]).toMatchObject({ status: 'fail', excess: 1 });
  });

  it('judges a percentage delta against the magnitude of the baseline', () => {
    // 100 -> 104 is a 4% rise; the budget allows 5%.
    expect(
      evaluateGate(
        doc([{ id: 'mem.pss.mean', maxDeltaPct: 5 }]),
        run([metricOf('mem.pss.mean', 104)]),
        run([metricOf('mem.pss.mean', 100)]),
      ).verdicts[0],
    ).toMatchObject({ status: 'pass' });

    // 100 -> 110 is 10%; the budget allows 5%, so it is 5 points over.
    expect(
      evaluateGate(
        doc([{ id: 'mem.pss.mean', maxDeltaPct: 5 }]),
        run([metricOf('mem.pss.mean', 110)]),
        run([metricOf('mem.pss.mean', 100)]),
      ).verdicts[0],
    ).toMatchObject({ status: 'fail', excess: 5 });

    // A negative baseline divides by its magnitude: -100 -> -90 is a 10% fall
    // toward zero, not a -10% one.
    expect(
      evaluateGate(
        doc([{ id: 'x', maxDeltaPct: 5 }]),
        run([metricOf('x', -90)]),
        run([metricOf('x', -100)]),
      ).verdicts[0],
    ).toMatchObject({ status: 'fail', excess: 5 });
  });

  it('reports a metric the run never emitted as missing and fails the gate', () => {
    const result = evaluateGate(
      doc([{ id: 'frame.count', max: 1000 }, { id: 'frame.fps', min: 55 }]),
      run([metricOf('frame.count', 900)]),
    );
    expect(result.verdicts[1]).toEqual({
      id: 'frame.fps',
      status: 'missing',
      bound: { kind: 'min', limit: 55 },
      reason: 'the run emitted no frame.fps',
    });
    expect(result.status).toBe('fail');
    expect(result.totals).toEqual({ pass: 1, fail: 0, missing: 1 });
  });

  it('treats a degraded metric as missing, even though its value is 0', () => {
    const result = evaluateGate(
      doc([{ id: 'frame.fps', min: 55 }]),
      run([
        metricOf('frame.fps', 0, {
          degraded: { reason: 'no frame_slice rows', fallback: '0' },
        }),
      ]),
    );
    expect(result.verdicts[0]).toMatchObject({
      status: 'missing',
      reason: 'frame.fps is degraded: no frame_slice rows',
    });
    expect(result.verdicts[0]!.value).toBeUndefined();
  });

  it('treats a non-numeric metric as missing', () => {
    const result = evaluateGate(
      doc([{ id: 'components.top.name', max: 1 }]),
      run([metricOf('components.top.name', 'Column')]),
    );
    expect(result.verdicts[0]).toMatchObject({
      status: 'missing',
      reason: 'components.top.name is not numeric (string)',
    });
  });

  it('refuses to compute a percentage against a zero baseline', () => {
    const result = evaluateGate(
      doc([{ id: 'frame.count', maxDeltaPct: 10 }]),
      run([metricOf('frame.count', 5)]),
      run([metricOf('frame.count', 0)]),
    );
    expect(result.verdicts[0]).toMatchObject({
      status: 'missing',
      reason: 'a percentage of a zero frame.count baseline is undefined',
    });
    expect(result.verdicts[0]!.excess).toBeUndefined();
  });

  it('still allows an absolute delta from a zero baseline', () => {
    expect(
      evaluateGate(
        doc([{ id: 'frame.count', maxDelta: 3 }]),
        run([metricOf('frame.count', 2)]),
        run([metricOf('frame.count', 0)]),
      ).verdicts[0],
    ).toMatchObject({ status: 'pass', baseline: 0 });
  });

  it('reports a delta budget with no baseline as missing, never as a pass', () => {
    const result = evaluateGate(
      doc([{ id: 'frame.fps', maxDeltaPct: 5 }]),
      run([metricOf('frame.fps', 60)]),
    );
    expect(result.verdicts[0]).toMatchObject({
      status: 'missing',
      reason: 'the baseline emitted no frame.fps',
    });
    expect(result.status).toBe('fail');
  });

  it('reports a non-numeric baseline as missing', () => {
    const result = evaluateGate(
      doc([{ id: 'x', maxDelta: 1 }]),
      run([metricOf('x', 5)]),
      run([metricOf('x', 'n/a')]),
    );
    expect(result.verdicts[0]).toMatchObject({
      status: 'missing',
      reason: 'the baseline x is not numeric (string)',
    });
  });

  it('keeps verdicts in document order and counts each exactly once', () => {
    const result = evaluateGate(
      doc([
        { id: 'b.metric', max: 1 },
        { id: 'a.metric', max: 1 },
        { id: 'c.metric', min: 1 },
      ]),
      run([metricOf('a.metric', 2), metricOf('b.metric', 1)]),
    );
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual([
      'a.metric',
      'b.metric',
      'c.metric',
    ]);
    expect(result.totals).toEqual({ pass: 1, fail: 1, missing: 1 });
    expect(result.name).toBe('gate');
  });

  it('is deterministic for the same inputs', () => {
    const d = doc([{ id: 'frame.jank.rate', max: 5 }, { id: 'frame.fps', min: 55 }]);
    const current = run([metricOf('frame.jank.rate', 6), metricOf('frame.fps', 50)]);
    expect(evaluateGate(d, current)).toEqual(evaluateGate(d, current));
  });

  it('rounds the excess to three decimals so output is byte-stable', () => {
    const result = evaluateGate(
      doc([{ id: 'x', max: 0.1 }]),
      run([metricOf('x', 0.1 + 0.2)]),
    );
    expect(result.verdicts[0]!.excess).toBe(0.2);
  });
});

describe('renderGateJson', () => {
  it('matches the analyze --json convention: two spaces and a trailing newline', () => {
    const result = evaluateGate(doc([{ id: 'x', max: 1 }]), run([metricOf('x', 0)]));
    expect(renderGateJson(result)).toBe(JSON.stringify(result, null, 2) + '\n');
  });
});
