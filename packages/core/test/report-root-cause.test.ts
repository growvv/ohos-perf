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
        evidence({ id: 'low', severity: 'info', explain: 'nothing much' }),
        evidence({ id: 'bad', severity: 'critical', explain: 'the main thread was blocked for 400 ms' }),
      ],
    });
    expect(doc.summary.verdict).toContain('the main thread was blocked for 400 ms');
  });

  it('says so plainly when the capture produced no evidence', () => {
    // An empty run is a measurement too: "nothing was found" is different from
    // "nothing was measured", and the verdict has to say which.
    const doc = buildRootCauseDocument({ ...input, evidence: [] });
    expect(doc.summary.totals).toEqual({ info: 0, warn: 0, critical: 0 });
    expect(doc.summary.verdict).toMatch(/no evidence/i);
  });

  it('counts by severity and copies the scene identity', () => {
    const doc = buildRootCauseDocument({
      ...input,
      evidence: [
        evidence({ id: 'a', severity: 'critical' }),
        evidence({ id: 'b', severity: 'warn' }),
        evidence({ id: 'c', severity: 'warn' }),
      ],
    });
    expect(doc.summary.totals).toEqual({ info: 0, warn: 2, critical: 1 });
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
