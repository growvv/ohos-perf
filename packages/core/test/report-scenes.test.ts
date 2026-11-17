import { describe, it, expect } from 'vitest';
import { compareScenes } from '../src/report/scenes';
import type { Metric } from '../src/report/metric';

/*
 * HapRay pivots its comparison by scene + step + version. Our typed comparison
 * works on two flat metric sets, so a multi-step run compared as one loses
 * which step moved.
 *
 * `compareScenes` keeps the per-step attribution: each step is compared
 * against the same step in the baseline, and a step present on one side only
 * is reported as added or removed rather than dropped.
 */

const metric = (id: string, value: number): Metric => ({
  id,
  value,
  unit: 'count',
  fidelity: 'exact',
  provenance: { collector: 'hitrace', table: 'frame_slice', rows: 1, device: 'emu' },
});

const result = (...metrics: Metric[]) => ({ metrics, evidence: [] });

describe('compareScenes', () => {
  it('compares each step against the same step, not the run total', () => {
    const baseline = [
      { stepId: 'open', result: result(metric('frame.count', 10)) },
      { stepId: 'scroll', result: result(metric('frame.count', 20)) },
    ];
    const current = [
      { stepId: 'open', result: result(metric('frame.count', 12)) },
      { stepId: 'scroll', result: result(metric('frame.count', 20)) },
    ];
    const compared = compareScenes(baseline, current);
    expect(compared.steps.map((s) => s.stepId)).toEqual(['open', 'scroll']);
    expect(compared.steps[0]!.rows[0]).toMatchObject({
      id: 'frame.count', baseline: 10, current: 12,
    });
    expect(compared.steps[1]!.rows[0]).toMatchObject({ id: 'frame.count', status: 'unchanged' });
  });

  it('reports a step on one side only as added or removed', () => {
    const compared = compareScenes(
      [{ stepId: 'open', result: result(metric('frame.count', 10)) }],
      [
        { stepId: 'open', result: result(metric('frame.count', 10)) },
        { stepId: 'new', result: result(metric('frame.count', 1)) },
      ],
    );
    expect(compared.steps.find((s) => s.stepId === 'new')!.status).toBe('added');
    expect(compared.steps.find((s) => s.stepId === 'open')!.status).toBe('compared');
  });

  it('names a step removed from the baseline', () => {
    const compared = compareScenes(
      [
        { stepId: 'open', result: result(metric('frame.count', 10)) },
        { stepId: 'gone', result: result(metric('frame.count', 5)) },
      ],
      [{ stepId: 'open', result: result(metric('frame.count', 10)) }],
    );
    expect(compared.steps.find((s) => s.stepId === 'gone')!.status).toBe('removed');
  });

  it('is byte-stable: the same input gives the same JSON whatever the order', () => {
    const baseline = [
      { stepId: 'b', result: result(metric('frame.count', 1)) },
      { stepId: 'a', result: result(metric('frame.count', 2)) },
    ];
    const a = JSON.stringify(compareScenes(baseline, baseline));
    const b = JSON.stringify(compareScenes([...baseline].reverse(), [...baseline].reverse()));
    expect(a).toBe(b);
  });
});
