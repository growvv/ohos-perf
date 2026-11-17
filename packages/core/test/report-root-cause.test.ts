import { describe, it, expect } from 'vitest';
import {
  buildRootCauseDocument,
  rankObservations,
  type RootCauseInput,
} from '../src/report/root-cause';
import type { Evidence } from '../src/report/evidence';

/*
 * P28 — the deterministic half of the root-cause report.
 *
 * HapRay's `root-cause` cannot run without an endpoint: `--skip-llm` writes a
 * "Pending Agent Inference" placeholder, so the artifact is empty without a
 * model. Here the ranking is our own severities, and the model is an optional
 * enrichment on top. These tests pin the half that must be true whether or not
 * any model answers.
 */

function evidence(overrides: Partial<Evidence> & Pick<Evidence, 'id'>): Evidence {
  return {
    kind: 'jank',
    severity: 'warn',
    subject: { process: 'com.demo' },
    window: { startNs: 0, endNs: 1_000_000 },
    signals: {},
    explain: 'something was slow',
    drillDown: [],
    ...overrides,
  };
}

const input: RootCauseInput = {
  app: 'com.demo',
  device: '5KPBB25927200695',
  window: { startNs: 0, endNs: 2_000_000_000 },
  generator: { name: '@ohos-perf/core', version: '0.23.0' },
  evidence: [],
};

describe('rankObservations', () => {
  it('orders critical before warn before info', () => {
    const ranked = rankObservations([
      evidence({ id: 'e-info', severity: 'info' }),
      evidence({ id: 'e-critical', severity: 'critical' }),
      evidence({ id: 'e-warn', severity: 'warn' }),
    ]);
    expect(ranked.map((item) => item.evidenceId)).toEqual(['e-critical', 'e-warn', 'e-info']);
  });

  it('breaks a severity tie by id, so the order is total', () => {
    // A total order is what makes two runs of the same capture produce the same
    // document; an unstable sort would make every diff a false change.
    const ranked = rankObservations([
      evidence({ id: 'b', severity: 'warn' }),
      evidence({ id: 'a', severity: 'warn' }),
      evidence({ id: 'c', severity: 'warn' }),
    ]);
    expect(ranked.map((item) => item.evidenceId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the measured signals verbatim and the explain sentence unchanged', () => {
    const item = evidence({
      id: 'e1',
      signals: { 'frames.count': 40, 'frames.worst_ms': 118.5, note: 'synthetic' },
      explain: 'the frame took 118.5 ms against a 16.7 ms budget',
    });
    const [observation] = rankObservations([item]);
    expect(observation!.signals).toEqual(item.signals);
    expect(observation!.explain).toBe(item.explain);
    expect(observation!.kind).toBe('jank');
    expect(observation!.subject.process).toBe('com.demo');
  });

  it('does not mutate the evidence it was given', () => {
    const items = [evidence({ id: 'b' }), evidence({ id: 'a' })];
    const before = JSON.stringify(items);
    rankObservations(items);
    expect(JSON.stringify(items)).toBe(before);
  });
});

describe('buildRootCauseDocument', () => {
  it('states a verdict from the highest-severity observation', () => {
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({ id: 'low', severity: 'info', explain: 'nothing much', signals: { count: 0 } }),
        evidence({
          id: 'bad', severity: 'critical', explain: 'the main thread was blocked for 400 ms',
          signals: { blockedMs: 400 },
        }),
      ],
    });
    expect(doc.summary.verdict).toContain('the main thread was blocked for 400 ms');
  });

  it('says so plainly when the capture produced no evidence', () => {
    // An empty run is a measurement too: "nothing was found" is different from
    // "nothing was measured", and the verdict has to say which.
    const doc = buildRootCauseDocument({ ...input, evidence: [] });
    expect(doc.summary.totals).toEqual({ info: 0, warn: 0, critical: 0, gaps: 0 });
    expect(doc.summary.verdict).toMatch(/no evidence/i);
  });

  it('leads with a measured finding, never with an analyzer that was skipped', () => {
    // Measured defect: a sparse capture produces fifteen `degraded_capability`
    // warnings, and the first version of the verdict led with "hilog skipped".
    // A root-cause report that opens with a missing collector tells the reader
    // the wrong thing: the gap is why nothing was measured, not what went wrong.
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({
          id: 'a-skipped', kind: 'degraded_capability', severity: 'warn',
          explain: 'hilog skipped: missing hilog.stream',
        }),
        evidence({
          id: 'z-jank', kind: 'jank', severity: 'warn',
          signals: { worstMs: 118.5 },
          explain: 'frame 42 took 118.5 ms against a 16.7 ms budget',
        }),
      ],
    });
    expect(doc.summary.verdict).toContain('frame 42 took 118.5 ms');
    expect(doc.summary.verdict).not.toContain('hilog skipped');
    // The gap is still counted, so a reader can see how much went unmeasured.
    expect(doc.summary.totals.gaps).toBe(1);
  });

  it('treats a kind that normally measures as a gap when it carries no fact', () => {
    // Measured defect: the `startup` analyzer reports "no startup data" as
    // `kind: 'startup'` with empty signals, and it outranked nothing but came
    // first by id — so the verdict opened with it instead of with the jank.
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({ id: 'a-startup', kind: 'startup', severity: 'info', explain: 'no startup data' }),
        evidence({ id: 'z-jank', kind: 'jank', severity: 'warn', explain: 'frame 42 took 118.5 ms', signals: { ms: 118.5 } }),
      ],
    });
    expect(doc.summary.verdict).toContain('frame 42 took 118.5 ms');
    expect(doc.summary.totals.gaps).toBe(1);
  });

  it('says the run measured nothing when every observation is a gap', () => {
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({ id: 'a', kind: 'degraded_capability', explain: 'symbols skipped' }),
        evidence({ id: 'b', kind: 'no_data', severity: 'info', explain: 'no UI capture' }),
      ],
    });
    expect(doc.summary.verdict).toMatch(/nothing was measured/i);
    expect(doc.summary.totals.gaps).toBe(2);
  });

  it('counts by severity and copies the scene identity', () => {
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({ id: 'a', severity: 'critical', signals: { n: 1 } }),
        evidence({ id: 'b', severity: 'warn', signals: { n: 2 } }),
        evidence({ id: 'c', severity: 'warn', signals: { n: 3 } }),
      ],
    });
    expect(doc.summary.totals).toEqual({ info: 0, warn: 2, critical: 1, gaps: 0 });
    expect(doc.scene).toEqual({
      app: 'com.demo', device: '5KPBB25927200695',
      window: { startNs: 0, endNs: 2_000_000_000 },
    });
    expect(doc.schemaVersion).toBe(1);
  });

  it('has no analysis section until a model answers', () => {
    const doc = buildRootCauseDocument({ ...input, evidence: [evidence({ id: 'a' })] });
    expect(doc.analysis).toBeUndefined();
  });

  it('is byte-identical for the same evidence in a different order', () => {
    // The engine emits evidence sorted, but a saved bundle could be reordered by
    // a tool; the document must not depend on that.
    const a = evidence({ id: 'a', severity: 'warn' });
    const b = evidence({ id: 'b', severity: 'critical' });
    const one = buildRootCauseDocument({ ...input, evidence: [a, b] });
    const two = buildRootCauseDocument({ ...input, evidence: [b, a] });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
