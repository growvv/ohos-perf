import { describe, it, expect } from 'vitest';
import { buildRootCauseDocument, type RootCauseDocument } from '../src/report/root-cause';
import { renderRootCauseMarkdown } from '../src/report/root-cause-markdown';
import type { Evidence } from '../src/report/evidence';

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
          rank: 1, evidenceIds: ['ev-jank'], rootCause: 'long frame', fix: 'split the work',
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
          rank: 1, evidenceIds: ['ev-jank'], rootCause: 'long frame', fix: 'split',
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
          rank: 1, evidenceIds: [], rootCause: 'aboutToAppear rebuilds the list',
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
