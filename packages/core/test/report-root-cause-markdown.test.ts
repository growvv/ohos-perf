import { describe, it, expect } from 'vitest';
import { buildRootCauseDocument, type RootCauseDocument } from '../src/report/root-cause';
import { renderRootCauseMarkdown } from '../src/report/root-cause-markdown';
import { buildMovement } from '../src/report/movement';
import type { Evidence } from '../src/report/evidence';
import type { Metric } from '../src/report/metric';

/*
 * P28 task 3 — the human report.
 *
 * HapRay writes `root_cause.md` and an `_evidence.md` companion. The ordering
 * is the part that matters: a reader opens this file to find out what to fix,
 * so the verdict and the ranked observations come before the model's prose, and
 * an ungrounded suspect is marked where it appears rather than in a footnote.
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

const base: RootCauseDocument = buildRootCauseDocument({
  app: 'com.demo',
  device: 'dev-1',
  window: { startNs: 0, endNs: 2_000_000_000 },
  generator: { name: '@ohos-perf/core', version: '0.23.0' },
  evidence: [
    evidence({
      id: 'ev-jank', severity: 'critical', subject: { process: 'com.demo', thread: 'main', frameNo: 42 },
      signals: { 'frames.worst_ms': 118.5, library: 'libapp.so' },
      explain: 'frame 42 took 118.5 ms against a 16.7 ms budget',
    }),
    evidence({ id: 'ev-info', severity: 'info', explain: 'nothing much' }),
  ],
});

describe('renderRootCauseMarkdown', () => {
  it('leads with the verdict and the totals', () => {
    const md = renderRootCauseMarkdown(base);
    expect(md).toMatch(/^# Root cause/);
    expect(md).toContain('frame 42 took 118.5 ms');
    expect(md).toContain('1 critical');
  });

  it('puts the ranked observations before any model prose', () => {
    const withAnalysis: RootCauseDocument = {
      ...base,
      analysis: {
        model: 'test-model', summary: 'the main thread stalls',
        suspects: [{
          rank: 1, evidenceIds: ['ev-jank'], metrics: [], rootCause: 'long frame', fix: 'split the work',
          confidence: 'high', ungrounded: [],
        }],
        caveats: [], needsMoreData: [],
      },
    };
    const md = renderRootCauseMarkdown(withAnalysis);
    const observationsAt = md.indexOf('Observations');
    const analysisAt = md.indexOf('Model analysis');
    expect(observationsAt).toBeGreaterThan(-1);
    expect(analysisAt).toBeGreaterThan(observationsAt);
  });

  it('names the model that answered, and the evidence each suspect cites', () => {
    const md = renderRootCauseMarkdown({
      ...base,
      analysis: {
        model: 'test-model', summary: 's',
        suspects: [{
          rank: 1, evidenceIds: ['ev-jank'], metrics: [], rootCause: 'long frame', fix: 'split',
          confidence: 'high', ungrounded: [],
        }],
        caveats: [], needsMoreData: [],
      },
    });
    expect(md).toContain('test-model');
    expect(md).toContain('ev-jank');
  });

  it('marks an ungrounded suspect where it appears', () => {
    // The reader has to know before acting on it; a footnote is read after the
    // fix has been applied.
    const md = renderRootCauseMarkdown({
      ...base,
      analysis: {
        model: 'm', summary: 's',
        suspects: [{
          rank: 1, evidenceIds: [], metrics: [], rootCause: 'aboutToAppear rebuilds the list',
          fix: 'memoize', confidence: 'medium', ungrounded: ['aboutToAppear'],
        }],
        caveats: [], needsMoreData: [],
      },
    });
    expect(md).toMatch(/ungrounded/i);
    expect(md).toContain('aboutToAppear');
  });

  it('says so plainly when there is no analysis section', () => {
    const md = renderRootCauseMarkdown(base);
    expect(md).toMatch(/no model analysis|offline/i);
    expect(md).not.toContain('Model analysis');
  });

  it('states caveats and what would raise confidence', () => {
    const md = renderRootCauseMarkdown({
      ...base,
      analysis: {
        model: 'm', summary: 's', suspects: [],
        caveats: ['the capture was short'],
        needsMoreData: ['a longer trace'],
      },
    });
    expect(md).toContain('the capture was short');
    expect(md).toContain('a longer trace');
  });

  it('says how many observations are gaps rather than findings', () => {
    const doc = buildRootCauseDocument({
      app: 'com.demo', device: 'dev-1',
      window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [
        evidence({ id: 'gap', kind: 'degraded_capability', explain: 'hilog skipped' }),
        evidence({
          id: 'real', severity: 'critical', signals: { worstMs: 118.5 },
          explain: 'frame 42 took 118.5 ms',
        }),
      ],
    });
    const md = renderRootCauseMarkdown(doc);
    expect(md).toMatch(/1 report a gap in the capture/);
    // The verdict still leads with the finding, not the missing collector.
    expect(md.indexOf('frame 42 took 118.5 ms')).toBeLessThan(md.indexOf('hilog skipped'));
  });

  it('says "the whole capture" instead of printing the whole-database sentinel', () => {
    // Measured defect: a scene with no `trace_range` renders the marker as a
    // 285-year span ("0..9007199254740991 ns (9007199.25 s)"). The rest of the
    // package already says "the whole capture" for this range.
    const doc = buildRootCauseDocument({
      app: 'com.demo', device: 'dev-1',
      window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [evidence({ id: 'e' })],
    });
    const md = renderRootCauseMarkdown(doc);
    expect(md).toContain('window  the whole capture');
    expect(md).not.toContain('9007199');
  });

  it('renders byte-identically twice', () => {
    expect(renderRootCauseMarkdown(base)).toBe(renderRootCauseMarkdown(base));
  });

  it('renders a document with no observations without pretending it measured something', () => {
    const empty = buildRootCauseDocument({
      app: 'com.demo', device: 'dev-1',
      window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [],
    });
    const md = renderRootCauseMarkdown(empty);
    expect(md).toMatch(/no evidence/i);
  });

  it('escapes a markdown table pipe in a signal value', () => {
    const doc = buildRootCauseDocument({
      app: 'com.demo', device: 'dev-1',
      window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [evidence({ id: 'e', signals: { note: 'a|b' } })],
    });
    expect(renderRootCauseMarkdown(doc)).toContain('a\\|b');
  });
});

describe('renderRootCauseMarkdown — movement', () => {
  const metric = (id: string, value: number, fidelity: Metric['fidelity'] = 'exact'): Metric => ({
    id,
    value,
    unit: 'count',
    fidelity,
    provenance: { collector: 'hitrace', device: 'emu' },
  });
  const movement = buildMovement(
    {
      label: 'v1', app: 'com.demo', device: 'emu',
      result: {
        metrics: [
          metric('frame.jank.rate', 10),
          metric('frame.fps', 50),
          metric('fault.total.count', 1),
          metric('only.in.v1', 3),
          metric('frame.empty.rate', 4, 'approximate'),
        ],
        evidence: [evidence({ id: 'a', kind: 'jank' })],
      },
    },
    {
      label: 'v2', app: 'com.demo', device: 'emu',
      result: {
        metrics: [
          metric('frame.jank.rate', 15),
          metric('frame.fps', 60),
          metric('fault.total.count', 4),
          metric('frame.empty.rate', 9),
        ],
        evidence: [evidence({ id: 'b', kind: 'jank' }), evidence({ id: 'c', kind: 'thermal' })],
      },
    },
  );
  const doc: RootCauseDocument = buildRootCauseDocument({
    app: 'com.demo', device: 'dev-1',
    window: { startNs: 0, endNs: 1 },
    generator: { name: '@ohos-perf/core', version: '0.27.0' },
    evidence: [evidence({ id: 'ev-jank', severity: 'critical', signals: { ms: 118.5 } })],
    movement,
  });

  it('puts what moved before the verdict', () => {
    const md = renderRootCauseMarkdown(doc);
    const movedAt = md.indexOf('## What moved');
    const verdictAt = md.indexOf('## Verdict');
    expect(movedAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeGreaterThan(movedAt);
  });

  it('is absent entirely when there is no baseline', () => {
    expect(renderRootCauseMarkdown(base)).not.toContain('## What moved');
  });

  it('names both runs and states the movement verdict', () => {
    const md = renderRootCauseMarkdown(doc);
    expect(md).toContain('v1 → v2');
    expect(md).toContain(movement.verdict);
  });

  it('lists each metric with its status and a dash for a gap', () => {
    const md = renderRootCauseMarkdown(doc);
    expect(md).toContain('frame.jank.rate');
    expect(md).toContain('regressed');
    // A gap has no value on one side; printing 0 would be a measurement.
    const gapLine = md.split('\n').find((line) => line.includes('only.in.v1'))!;
    expect(gapLine).toContain('—');
    expect(gapLine).toContain('gap');
  });

  it('prints a gap reason and never a delta for it', () => {
    const lines = renderRootCauseMarkdown(doc).split('\n');
    const reasonLine = lines.find((line) => line.startsWith('- `only.in.v1`'))!;
    expect(reasonLine).toContain('the to run emitted no only.in.v1');
    const gapRow = lines.find((line) => line.startsWith('| only.in.v1'))!;
    expect(gapRow.endsWith('| — |')).toBe(true);
  });

  it('shows an incomparable delta without calling it better or worse', () => {
    const line = renderRootCauseMarkdown(doc)
      .split('\n')
      .find((line) => line.includes('fault.total.count'))!;
    expect(line).toContain('incomparable');
    expect(line).not.toContain('regressed');
    expect(line).not.toContain('improved');
  });

  it('counts findings by kind for both runs', () => {
    const md = renderRootCauseMarkdown(doc);
    expect(md).toContain('thermal');
    expect(md).toMatch(/findings/i);
  });

  it('renders byte-identically twice', () => {
    expect(renderRootCauseMarkdown(doc)).toBe(renderRootCauseMarkdown(doc));
  });

  it('marks a row whose two sides were measured with different fidelity', () => {
    // A +125% read from an approximate baseline against an exact run is a
    // weaker claim than two exact ones, and `compare` already says so per row.
    const line = renderRootCauseMarkdown(doc)
      .split('\n')
      .find((line) => line.startsWith('| frame.empty.rate'))!;
    expect(line).toContain('approximate');
    expect(line).toContain('exact');
  });

  it('does not clutter a row whose sides agree on fidelity', () => {
    const line = renderRootCauseMarkdown(doc)
      .split('\n')
      .find((line) => line.startsWith('| frame.jank.rate'))!;
    expect(line).not.toContain('exact');
    expect(line).not.toContain('approximate');
  });
});
