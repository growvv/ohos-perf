import { describe, it, expect } from 'vitest';
import {
  buildMovement,
  type MovementInput,
} from '../src/report/movement';
import type { AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';
import type { Evidence, EvidenceKind } from '../src/report/evidence';

/*
 * P32 task 1 — the deterministic cross-run movement.
 *
 * HapRay's multi-version page draws a line per metric and leaves the reading to
 * a human; its `root_cause` reads one run's report and never sees a second.
 * The question a reader actually asks after a regression — "what changed
 * between the release that was fine and this one?" — needs both halves: the
 * numbers that moved, and the rule that decides what "moved" means.
 *
 * The rule that matters most is the one this package already settled in
 * `buildTrend`: a metric a run did not measure is a gap, not a zero. A skipped
 * analyzer's zero must never read as an improvement, because a regression
 * report that opens with "jank rate improved from 12% to 0" sends the reader
 * after the wrong problem.
 */

function metric(
  id: string,
  value: number | string,
  options: Partial<Metric> = {},
): Metric {
  return {
    id,
    value,
    unit: 'count',
    fidelity: 'exact',
    provenance: { collector: 'hitrace', table: 'frame_slice', device: 'emu' },
    ...options,
  };
}

function evidence(kind: EvidenceKind, id: string): Evidence {
  return {
    id,
    kind,
    severity: 'warn',
    subject: { process: 'com.demo' },
    window: { startNs: 0, endNs: 1_000_000 },
    signals: { n: 1 },
    explain: 'something happened',
    drillDown: [],
  };
}

function input(
  label: string,
  metrics: Metric[],
  options: { app?: string; evidence?: Evidence[]; startedAtNs?: number } = {},
): MovementInput {
  const result: AnalyzeResult = {
    metrics,
    evidence: options.evidence ?? [],
  };
  return {
    label,
    app: options.app ?? 'com.demo',
    device: 'emu',
    startedAtNs: options.startedAtNs ?? 1000,
    result,
  };
}

describe('buildMovement — direction', () => {
  it('calls a lower-is-better metric that rose a regression', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 10)]),
      input('v2', [metric('frame.jank.rate', 15)]),
    );
    const [row] = movement.rows;
    expect(row!.status).toBe('regressed');
    expect(row!.delta).toBe(5);
    expect(row!.deltaPct).toBe(50);
    expect(movement.totals.regressed).toBe(1);
  });

  it('calls a lower-is-better metric that fell an improvement', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 10)]),
      input('v2', [metric('frame.jank.rate', 6)]),
    );
    expect(movement.rows[0]!.status).toBe('improved');
    expect(movement.rows[0]!.delta).toBe(-4);
  });

  it('calls a higher-is-better metric that rose an improvement', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.fps', 55)]),
      input('v2', [metric('frame.fps', 60)]),
    );
    expect(movement.rows[0]!.status).toBe('improved');
  });

  it('calls an equal value unchanged, not an improvement', () => {
    // A metric that did not move did not improve; counting it as one inflates
    // the improvement total with noise.
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 10)]),
      input('v2', [metric('frame.jank.rate', 10)]),
    );
    expect(movement.rows[0]!.status).toBe('unchanged');
    expect(movement.totals.improved).toBe(0);
  });

  it('records a numeric move of a metric with no known direction as incomparable', () => {
    const movement = buildMovement(
      input('v1', [metric('fault.total.count', 3)]),
      input('v2', [metric('fault.total.count', 7)]),
    );
    const [row] = movement.rows;
    expect(row!.status).toBe('incomparable');
    expect(row!.delta).toBe(4);
    expect(row!.deltaPct).toBeCloseTo(133.333, 2);
  });
});

describe('buildMovement — a gap is never a movement', () => {
  it('marks a metric only the baseline measured as a gap naming that side', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 10)]),
      input('v2', []),
    );
    const [row] = movement.rows;
    expect(row!.status).toBe('gap');
    expect(row!.gap?.side).toBe('to');
    expect(row!.gap?.reason).toContain('frame.jank.rate');
    expect(row!.delta).toBeUndefined();
    expect(movement.totals.improved).toBe(0);
  });

  it('marks a metric only the current run measured as a gap naming that side', () => {
    const movement = buildMovement(
      input('v1', []),
      input('v2', [metric('frame.jank.rate', 10)]),
    );
    expect(movement.rows[0]!.gap?.side).toBe('from');
  });

  it('treats a degraded metric as a gap, quoting the degradation reason', () => {
    // The skipped analyzer's zero is a stand-in, not a measurement. Reading it
    // as "jank fell to 0" is the defect this whole package exists to prevent.
    const degraded = {
      ...metric('frame.jank.rate', 0, { fidelity: 'proxy' }),
      degraded: { reason: 'missing trace.frame_slice', fallback: 'analyzer skipped' },
    };
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 12)]),
      input('v2', [degraded]),
    );
    const [row] = movement.rows;
    expect(row!.status).toBe('gap');
    expect(row!.gap?.side).toBe('to');
    expect(row!.gap?.reason).toContain('missing trace.frame_slice');
    expect(row!.to).toBeNull();
    expect(movement.totals.improved).toBe(0);
  });

  it('keeps *.degraded markers out of the rows and counts them', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.count', 10), metric('binder.degraded', 0, {
        fidelity: 'proxy',
        degraded: { reason: 'missing trace.binder', fallback: 'analyzer skipped' },
      })]),
      input('v2', [metric('frame.count', 10), metric('binder.degraded', 0, {
        fidelity: 'proxy',
        degraded: { reason: 'missing trace.binder', fallback: 'analyzer skipped' },
      })]),
    );
    expect(movement.rows.map((row) => row.id)).toEqual(['frame.count']);
    expect(movement.totals.skipped).toBe(1);
  });
});

describe('buildMovement — percentages', () => {
  it('omits the percentage when the baseline is zero but keeps the delta', () => {
    // A percentage of zero is infinite; the row still says the change happened.
    const movement = buildMovement(
      input('v1', [metric('startup.count', 0)]),
      input('v2', [metric('startup.count', 3)]),
    );
    const [row] = movement.rows;
    expect(row!.delta).toBe(3);
    expect(row!.deltaPct).toBeUndefined();
    expect(movement.totals.regressed).toBe(1);
  });
});

describe('buildMovement — ordering', () => {
  it('orders rows regressed, improved, unchanged, incomparable, gap', () => {
    const movement = buildMovement(
      input('v1', [
        metric('a.gap', 1),
        metric('frame.jank.rate', 10),
        metric('frame.fps', 50),
        metric('frame.count', 100),
        metric('fault.total.count', 1),
      ]),
      input('v2', [
        metric('frame.jank.rate', 20),
        metric('frame.fps', 60),
        metric('frame.count', 100),
        metric('fault.total.count', 5),
      ]),
    );
    expect(movement.rows.map((row) => [row.id, row.status])).toEqual([
      ['frame.jank.rate', 'regressed'],
      ['frame.fps', 'improved'],
      ['frame.count', 'unchanged'],
      ['fault.total.count', 'incomparable'],
      ['a.gap', 'gap'],
    ]);
  });

  it('orders regressions by percentage, largest first, then by id', () => {
    const movement = buildMovement(
      input('v1', [
        metric('frame.jank.rate', 10),
        metric('frame.empty.rate', 10),
        metric('frame.avg.duration', 10),
      ]),
      input('v2', [
        metric('frame.jank.rate', 20),
        metric('frame.empty.rate', 30),
        metric('frame.avg.duration', 20),
      ]),
    );
    // empty.rate +200%, then jank.rate and avg.duration at +100% broken by id.
    expect(movement.rows.map((row) => row.id)).toEqual([
      'frame.empty.rate',
      'frame.avg.duration',
      'frame.jank.rate',
    ]);
  });
});

describe('buildMovement — the caller owns the direction', () => {
  it('reads from the baseline even when it was captured later', () => {
    // `buildTrend` sorts by start time; a movement must not, because a baseline
    // captured later would silently invert every verdict.
    const movement = buildMovement(
      input('late', [metric('frame.jank.rate', 20)], { startedAtNs: 5000 }),
      input('early', [metric('frame.jank.rate', 10)], { startedAtNs: 1000 }),
    );
    const [row] = movement.rows;
    expect(row!.from).toBe(20);
    expect(row!.to).toBe(10);
    expect(row!.delta).toBe(-10);
    expect(row!.status).toBe('improved');
    expect(movement.from.label).toBe('late');
    expect(movement.to.label).toBe('early');
  });
});

describe('buildMovement — evidence', () => {
  it('counts findings by kind on both sides, sorted, with a delta', () => {
    const movement = buildMovement(
      input('v1', [], {
        evidence: [evidence('jank', 'a'), evidence('jank', 'b'), evidence('thermal', 'c')],
      }),
      input('v2', [], { evidence: [evidence('jank', 'd')] }),
    );
    expect(movement.evidence).toEqual([
      { kind: 'jank', from: 2, to: 1, delta: -1 },
      { kind: 'thermal', from: 1, to: 0, delta: -1 },
    ]);
  });
});

describe('buildMovement — refusals and invariants', () => {
  it('refuses runs from different apps, naming both', () => {
    expect(() =>
      buildMovement(
        input('v1', [metric('frame.count', 1)], { app: 'com.demo' }),
        input('v2', [metric('frame.count', 2)], { app: 'com.other' }),
      ),
    ).toThrow(/com\.demo.*com\.other/);
  });

  it('counts every row exactly once', () => {
    const movement = buildMovement(
      input('v1', [
        metric('frame.jank.rate', 10), metric('frame.fps', 50),
        metric('frame.count', 1), metric('fault.total.count', 1), metric('gone', 1),
      ]),
      input('v2', [
        metric('frame.jank.rate', 20), metric('frame.fps', 60),
        metric('frame.count', 1), metric('fault.total.count', 2),
      ]),
    );
    const { totals } = movement;
    expect(totals.regressed + totals.improved + totals.unchanged
      + totals.incomparable + totals.gaps).toBe(movement.rows.length);
  });

  it('does not mutate its inputs and is byte-stable', () => {
    const from = input('v1', [metric('frame.jank.rate', 10), metric('frame.fps', 50)], {
      evidence: [evidence('jank', 'a')],
    });
    const to = input('v2', [metric('frame.jank.rate', 12), metric('frame.fps', 55)]);
    const before = JSON.stringify([from, to]);
    const one = buildMovement(from, to);
    const two = buildMovement(from, to);
    expect(JSON.stringify([from, to])).toBe(before);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('states the worst regression in the verdict, naming both runs', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.jank.rate', 10), metric('frame.empty.rate', 10)]),
      input('v2', [metric('frame.jank.rate', 20), metric('frame.empty.rate', 30)]),
    );
    expect(movement.verdict).toContain('v1 → v2');
    expect(movement.verdict).toContain('frame.empty.rate');
    expect(movement.verdict).toContain('30');
    expect(movement.verdict).toMatch(/other regression/);
  });

  it('rounds the values it prints in the verdict, but not in the row', () => {
    // Measured defect on a live pair of traces: the sentence read "regressed
    // from 4.733727810650888 to 69.26406926406926", which is a number only a
    // machine reads. The row keeps the measured values; the sentence is prose.
    const movement = buildMovement(
      input('v1', [metric('frame.empty.rate', 4.733727810650888)]),
      input('v2', [metric('frame.empty.rate', 69.26406926406926)]),
    );
    expect(movement.verdict).toContain('from 4.734 to 69.264');
    expect(movement.verdict).not.toContain('4.733727810650888');
    expect(movement.rows[0]!.from).toBe(4.733727810650888);
  });

  it('says nothing regressed when only improvements moved', () => {
    const movement = buildMovement(
      input('v1', [metric('frame.fps', 50)]),
      input('v2', [metric('frame.fps', 60)]),
    );
    expect(movement.verdict).toMatch(/nothing regressed/);
    expect(movement.verdict).toContain('1 metric improved');
  });

  it('says nothing comparable moved when every metric is a gap', () => {
    const movement = buildMovement(input('v1', []), input('v2', []));
    expect(movement.verdict).toMatch(/nothing comparable moved/);
  });
});
