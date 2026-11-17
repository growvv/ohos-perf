import { describe, it, expect } from 'vitest';
import {
  buildRootCauseDocument,
  type RootCauseDocument,
  type RootCauseSuspect,
} from '../src/report/root-cause';
import {
  askRootCause,
  groundingVocabulary,
  parseRootCauseAnswer,
  rootCausePrompt,
  ungroundedNames,
} from '../src/report/root-cause-model';
import { OhosPerfError } from '../src/errors';
import type { AgentModel, AgentTurn } from '../src/scenario/agent';
import type { Evidence } from '../src/report/evidence';

/*
 * P28 task 2 — the model turn, and the check on what it says.
 *
 * HapRay asks a model for a root cause and prints the answer. Nothing checks
 * whether the file, symbol or thread it names exists in the run — so an
 * invented `aboutToAppear` reads exactly like a measured one. Here every name a
 * suspect cites is looked up in what the evidence actually carried, and a
 * suspect that names only things nobody measured is marked `ungrounded`.
 */

function evidence(overrides: Partial<Evidence> & Pick<Evidence, 'id'>): Evidence {
  return {
    kind: 'jank',
    severity: 'warn',
    subject: { process: 'com.demo', thread: 'main' },
    window: { startNs: 0, endNs: 1_000_000 },
    signals: {},
    explain: 'the frame took 118.5 ms',
    drillDown: [],
    ...overrides,
  };
}

const items: Evidence[] = [
  evidence({
    id: 'ev-jank',
    severity: 'critical',
    subject: { process: 'com.demo', thread: 'main', frameNo: 42 },
    signals: { 'frames.worst_ms': 118.5, library: 'libapp.so' },
    explain: 'frame 42 took 118.5 ms against a 16.7 ms budget',
  }),
  evidence({
    id: 'ev-thread',
    kind: 'thread_redundancy',
    subject: { process: 'com.demo', thread: 'worker-3' },
    signals: { 'thread.wakeups': 900 },
    explain: 'worker-3 woke 900 times and slept immediately',
  }),
];

const doc: RootCauseDocument = buildRootCauseDocument({
  app: 'com.demo',
  device: 'dev-1',
  window: { startNs: 0, endNs: 2_000_000_000 },
  generator: { name: '@ohos-perf/core', version: '0.23.0' },
  evidence: items,
});

/** A model that returns a fixed answer, and records the turn it was given. */
function stub(answer: unknown): AgentModel & { turns: AgentTurn[] } {
  const turns: AgentTurn[] = [];
  return {
    turns,
    async decide(request) {
      turns.push(request);
      return typeof answer === 'string'
        ? { done: true, reason: answer }
        : { done: true, reason: JSON.stringify(answer) };
    },
  };
}

describe('rootCausePrompt', () => {
  it('carries the observations and their ids, so a citation can be checked', () => {
    const prompt = rootCausePrompt(doc);
    expect(prompt).toContain('ev-jank');
    expect(prompt).toContain('ev-thread');
    expect(prompt).toContain('118.5');
  });

  it('tells the model the answer is JSON and that citations are verified', () => {
    const prompt = rootCausePrompt(doc);
    expect(prompt).toMatch(/JSON/i);
    expect(prompt).toMatch(/evidenceIds|evidence id/i);
  });

  it('does not leak the analysis field into the prompt', () => {
    // A second turn would otherwise show the model its own previous answer as
    // if it were evidence.
    const withAnalysis: RootCauseDocument = {
      ...doc,
      analysis: {
        model: 'm', summary: 'prior', suspects: [], caveats: [], needsMoreData: [],
      },
    };
    expect(rootCausePrompt(withAnalysis)).not.toContain('prior');
  });

  it('names an unidentified app and an offline analysis as such', () => {
    // Measured defect: the prompt read "app unknown on offline", which is two
    // sentinels printed as if they were a name.
    const sparse: RootCauseDocument = buildRootCauseDocument({
      app: 'unknown', device: 'offline',
      window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [],
    });
    const prompt = rootCausePrompt(sparse);
    expect(prompt).toContain('not identified in this capture');
    expect(prompt).toContain('an offline analysis');
    expect(prompt).not.toContain('app unknown on offline');
  });
});

describe('parseRootCauseAnswer', () => {
  it('keeps the ids the run actually produced', () => {
    const analysis = parseRootCauseAnswer(
      JSON.stringify({
        summary: 'the main thread stalls on a long frame',
        suspects: [{
          evidenceIds: ['ev-jank'],
          rootCause: 'frame 42 is over budget',
          fix: 'split the work',
          confidence: 'high',
        }],
        caveats: [],
        needsMoreData: [],
      }),
      doc,
      'test-model',
    );
    expect(analysis.suspects[0]!.evidenceIds).toEqual(['ev-jank']);
    expect(analysis.suspects[0]!.ungrounded).toEqual([]);
    expect(analysis.model).toBe('test-model');
  });

  it('rejects an invented evidence id instead of presenting it as measured', () => {
    const analysis = parseRootCauseAnswer(
      JSON.stringify({
        summary: 's',
        suspects: [{
          evidenceIds: ['ev-jank', 'ev-made-up'],
          rootCause: 'r', fix: 'f', confidence: 'medium',
        }],
        caveats: [], needsMoreData: [],
      }),
      doc,
      'm',
    );
    expect(analysis.suspects[0]!.evidenceIds).toEqual(['ev-jank']);
    expect(analysis.suspects[0]!.ungrounded).toContain('ev-made-up');
  });

  it('keeps a fully ungrounded suspect, marked, rather than dropping it', () => {
    // Dropping it would hide that the model invented something; a reader has to
    // see the model tried and what it produced.
    const analysis = parseRootCauseAnswer(
      JSON.stringify({
        summary: 's',
        suspects: [{
          evidenceIds: ['nothing-here'],
          rootCause: 'r', fix: 'f', confidence: 'low',
        }],
        caveats: [], needsMoreData: [],
      }),
      doc,
      'm',
    );
    expect(analysis.suspects).toHaveLength(1);
    expect(analysis.suspects[0]!.evidenceIds).toEqual([]);
    expect(analysis.suspects[0]!.ungrounded).toEqual(['nothing-here']);
  });

  it('refuses an answer that is not JSON, naming what came back', () => {
    expect(() => parseRootCauseAnswer('I think it is the main thread.', doc, 'm'))
      .toThrow(OhosPerfError);
    try {
      parseRootCauseAnswer('I think it is the main thread.', doc, 'm');
    } catch (error) {
      expect((error as OhosPerfError).code).toBe('ROOT_CAUSE_BAD_RESPONSE');
      expect((error as Error).message).toContain('I think it is the main thread');
    }
  });

  it('accepts an answer with zero suspects', () => {
    // "I found nothing" is a valid answer, and must not be an error: the run
    // still has its observations.
    const analysis = parseRootCauseAnswer(
      JSON.stringify({ summary: 'nothing stands out', suspects: [], caveats: ['low load'], needsMoreData: [] }),
      doc,
      'm',
    );
    expect(analysis.suspects).toEqual([]);
    expect(analysis.caveats).toEqual(['low load']);
  });

  it('numbers the suspects in the order the model returned them', () => {
    const analysis = parseRootCauseAnswer(
      JSON.stringify({
        summary: 's',
        suspects: [
          { evidenceIds: ['ev-jank'], rootCause: 'first', fix: 'f', confidence: 'high' },
          { evidenceIds: ['ev-thread'], rootCause: 'second', fix: 'f', confidence: 'low' },
        ],
        caveats: [], needsMoreData: [],
      }),
      doc,
      'm',
    );
    expect(analysis.suspects.map((s) => [s.rank, s.rootCause]))
      .toEqual([[1, 'first'], [2, 'second']]);
  });
});

describe('ungroundedNames', () => {
  const vocabulary = groundingVocabulary(doc);

  it('collects the process, thread and signal strings the evidence carried', () => {
    expect(vocabulary.has('com.demo')).toBe(true);
    expect(vocabulary.has('worker-3')).toBe(true);
    expect(vocabulary.has('libapp.so')).toBe(true);
  });

  it('collects the names the analyzer itself wrote in its explanation', () => {
    // Measured defect: a live run over a sparse capture had the model repeat
    // `ui.json`, `startedAtNs` and `thread_state` back from the evidence's own
    // `explain` sentences, and the check flagged all three as invented. A name
    // the analyzer printed is a name this run reported.
    const sparse: RootCauseDocument = buildRootCauseDocument({
      app: 'com.demo',
      device: 'dev-1',
      window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '0.23.0' },
      evidence: [evidence({
        id: 'ev-gap',
        kind: 'degraded_capability',
        explain: 'threads skipped: missing trace.thread_state: capability not probed',
        signals: { missing: 'trace.thread_state' },
      })],
    });
    const found = groundingVocabulary(sparse);
    expect(found.has('trace.thread_state')).toBe(true);
    // The kind is a word the run produced too.
    expect(found.has('degraded_capability')).toBe(true);
  });

  it('flags a symbol the run never measured', () => {
    const suspect: RootCauseSuspect = {
      rank: 1, evidenceIds: ['ev-jank'], rootCause: 'aboutToAppear is slow',
      fix: 'f', confidence: 'high', ungrounded: [],
    };
    expect(ungroundedNames(suspect, vocabulary)).toContain('aboutToAppear');
  });

  it('does not flag a name the evidence carried', () => {
    const suspect: RootCauseSuspect = {
      rank: 1, evidenceIds: ['ev-jank'], rootCause: 'worker-3 wakes too often',
      fix: 'f', confidence: 'high', ungrounded: [],
    };
    expect(ungroundedNames(suspect, vocabulary)).toEqual([]);
  });

  it('does not flag an ordinary hyphenated word as a name', () => {
    // Measured defect: "Re-run" and "app-level" were reported as ungrounded
    // claims. A hyphen is how English is written, not how code is named.
    const suspect: RootCauseSuspect = {
      rank: 1, evidenceIds: ['ev-jank'],
      rootCause: 'Re-run the capture with app-level probes enabled',
      fix: 'use an end-to-end capture', confidence: 'high', ungrounded: [],
    };
    expect(ungroundedNames(suspect, vocabulary)).toEqual([]);
  });

  it('ignores ordinary prose, so the check is about names and not words', () => {
    // A naive check would flag "the frame took 118.5 ms" for every word.
    const suspect: RootCauseSuspect = {
      rank: 1, evidenceIds: ['ev-jank'],
      rootCause: 'the frame took too long because the main thread was busy',
      fix: 'move the work off the main thread', confidence: 'high', ungrounded: [],
    };
    expect(ungroundedNames(suspect, vocabulary)).toEqual([]);
  });
});

describe('askRootCause', () => {
  it('calls the model exactly once and attaches its analysis', async () => {
    const model = stub({
      summary: 'main thread stalls',
      suspects: [{ evidenceIds: ['ev-jank'], rootCause: 'long frame', fix: 'split', confidence: 'high' }],
      caveats: [], needsMoreData: [],
    });
    const result = await askRootCause(model, doc, { model: 'test-model' });
    expect(model.turns).toHaveLength(1);
    expect(result.analysis?.summary).toBe('main thread stalls');
    expect(result.analysis?.suspects[0]!.evidenceIds).toEqual(['ev-jank']);
    // The deterministic half is unchanged by the model's presence.
    expect(result.observations).toEqual(doc.observations);
    expect(result.summary).toEqual(doc.summary);
  });

  it('marks a suspect naming an unmeasured symbol, and keeps its citation check separate', async () => {
    const model = stub({
      summary: 's',
      suspects: [{
        evidenceIds: ['ev-jank'],
        rootCause: 'aboutToAppear rebuilds the list',
        fix: 'memoize', confidence: 'medium',
      }],
      caveats: [], needsMoreData: [],
    });
    const result = await askRootCause(model, doc, { model: 'm' });
    const suspect = result.analysis!.suspects[0]!;
    expect(suspect.evidenceIds).toEqual(['ev-jank']);
    expect(suspect.ungrounded).toContain('aboutToAppear');
  });

  it('records which model answered', async () => {
    const model = stub({ summary: 's', suspects: [], caveats: [], needsMoreData: [] });
    const result = await askRootCause(model, doc, { model: 'glm-4.6' });
    expect(result.analysis?.model).toBe('glm-4.6');
  });

  it('never mutates the document it was given', async () => {
    const before = JSON.stringify(doc);
    const model = stub({ summary: 's', suspects: [], caveats: [], needsMoreData: [] });
    await askRootCause(model, doc, { model: 'm' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
