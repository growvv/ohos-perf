import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentModel, AgentTurn } from '@ohos-perf/core';
import { realDeps } from '../src/deps';

/*
 * P28 task 4 — the `root-cause` seam.
 *
 * The behaviours pinned here are the ones that differ from HapRay:
 *
 * 1. `--offline` never consults the endpoint. A promise not to call a model
 *    must not depend on the model being absent.
 * 2. A missing endpoint falls back to the offline report and says so, rather
 *    than failing — the ranked evidence is the product.
 * 3. The model's answer is checked against the evidence it was given: an id
 *    the run did not produce is not presented as measured.
 * 4. A saved `report.json` is read, not re-analyzed, so a document over an old
 *    run describes what that run measured.
 */

const ENV_KEYS = [
  'OHOS_PERF_AGENT_BASE_URL', 'OHOS_PERF_AGENT_API_KEY', 'OHOS_PERF_AGENT_MODEL',
  'GLM_BASE_URL', 'GLM_API_KEY', 'GLM_MODEL',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createTraceDb(path: string): void {
  const db = new DatabaseSync(path);
  // One over-budget frame: the `jank` analyzer produces a critical evidence
  // item from it, which is what gives the document something to rank.
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  db.exec(`INSERT INTO frame_slice VALUES
    (0, 1000, 0, 17, 44, 0, 118500000, '', 0, 0, 'actural', 0, 0, 0)`);
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  db.exec(`INSERT INTO process VALUES (0, 17, 17, 'com.demo', 0, 0, 1, 1, 0)`);
  db.close();
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scene(): { root: string; sceneDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-rootcause-'));
  roots.push(root);
  mkdirSync(join(root, 'scene'));
  createTraceDb(join(root, 'scene', 'trace.db'));
  return { root, sceneDir: join(root, 'scene') };
}

/** A model that returns a fixed answer and records the turns it saw. */
function stubModel(answer: unknown): AgentModel & { turns: AgentTurn[] } {
  const turns: AgentTurn[] = [];
  return {
    turns,
    async decide(turn) {
      turns.push(turn);
      return { done: true, reason: JSON.stringify(answer) };
    },
  };
}

describe('realDeps().rootCause', () => {
  it('writes the three artifacts and reruns byte-identically', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.23.0');
    const first = await deps.rootCause({ input: sceneDir, outDir: join(root, 'a'), offline: true });
    const second = await deps.rootCause({ input: sceneDir, outDir: join(root, 'b'), offline: true });

    expect(first.files).toEqual([
      'root-cause.json', 'root-cause.md', 'root-cause.evidence.json',
    ]);
    for (const file of first.files) {
      expect(existsSync(join(first.outDir, file)), file).toBe(true);
      expect(readFileSync(join(second.outDir, file))).toEqual(readFileSync(join(first.outDir, file)));
    }
    expect(first.fellBackToOffline).toBeUndefined();
  });

  it('never asks the model under --offline, even when an endpoint is configured', async () => {
    const { root, sceneDir } = scene();
    process.env['OHOS_PERF_AGENT_BASE_URL'] = 'https://e.test/v1';
    process.env['OHOS_PERF_AGENT_API_KEY'] = 'k';
    const model = stubModel({ summary: 's', suspects: [], caveats: [], needsMoreData: [] });
    const result = await realDeps('0.23.0', { rootCauseModel: () => model })
      .rootCause({ input: sceneDir, outDir: join(root, 'out'), offline: true });

    expect(model.turns).toHaveLength(0);
    expect(result.document.analysis).toBeUndefined();
    expect(result.fellBackToOffline).toBeUndefined();
  });

  it('falls back to the offline report when no endpoint is configured', async () => {
    const { root, sceneDir } = scene();
    const result = await realDeps('0.23.0')
      .rootCause({ input: sceneDir, outDir: join(root, 'out') });

    expect(result.fellBackToOffline).toBe(true);
    expect(result.document.analysis).toBeUndefined();
    // The fallback still writes a usable report — that is the whole point.
    const md = readFileSync(join(result.outDir, 'root-cause.md'), 'utf8');
    expect(md).toMatch(/offline/i);
  });

  it('attaches the model answer and checks its citations', async () => {
    const { root, sceneDir } = scene();
    process.env['OHOS_PERF_AGENT_BASE_URL'] = 'https://e.test/v1';
    process.env['OHOS_PERF_AGENT_API_KEY'] = 'k';
    const model = stubModel({
      summary: 'the main thread stalls',
      suspects: [{
        evidenceIds: ['ev-made-up'], rootCause: 'aboutToAppear rebuilds the list',
        fix: 'memoize', confidence: 'high',
      }],
      caveats: [], needsMoreData: [],
    });
    const result = await realDeps('0.23.0', { rootCauseModel: () => model })
      .rootCause({ input: sceneDir, outDir: join(root, 'out') });

    expect(model.turns).toHaveLength(1);
    const suspect = result.document.analysis!.suspects[0]!;
    expect(suspect.evidenceIds).toEqual([]);
    expect(suspect.ungrounded).toContain('ev-made-up');
    expect(suspect.ungrounded).toContain('aboutToAppear');
    expect(result.fellBackToOffline).toBeUndefined();
  });

  it('writes the exact prompt input as root-cause.evidence.json', async () => {
    const { root, sceneDir } = scene();
    const result = await realDeps('0.23.0')
      .rootCause({ input: sceneDir, outDir: join(root, 'out'), offline: true });
    const bundle = JSON.parse(
      readFileSync(join(result.outDir, 'root-cause.evidence.json'), 'utf8'),
    ) as { observations: unknown[]; prompt: string };
    expect(bundle.observations).toHaveLength(result.document.observations.length);
    // The prompt is the one a model would receive, ids included.
    expect(bundle.prompt).toContain(result.document.observations[0]!.evidenceId);
  });

  it('reads a saved report.json instead of re-analyzing the scene', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.23.0');
    const bundle = await deps.report({ sceneDir, outDir: join(root, 'bundle') });
    expect(bundle.files).toContain('report.json');

    // The report is edited to carry evidence a re-analysis could not produce:
    // if the saved file is read, that id appears in the document.
    const file = join(root, 'bundle', 'report.json');
    const model = JSON.parse(readFileSync(file, 'utf8')) as {
      sections: Array<{ evidence: Array<{ id: string }> }>;
    };
    const section = model.sections.find((entry) => entry.evidence.length > 0)!;
    section.evidence[0]!.id = 'ev-from-the-saved-report';
    writeFileSync(file, JSON.stringify(model));

    const result = await deps.rootCause({
      input: join(root, 'bundle'), outDir: join(root, 'out'), offline: true,
    });
    expect(result.document.observations.map((item) => item.evidenceId))
      .toContain('ev-from-the-saved-report');
  });

  it('refuses a file that is not a report document, naming it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-rootcause-'));
    roots.push(root);
    const file = join(root, 'not-a-report.json');
    writeFileSync(file, JSON.stringify({ hello: 'world' }));

    await expect(realDeps('0.23.0').rootCause({
      input: file, outDir: join(root, 'out'), offline: true,
    })).rejects.toThrow(/not a report document/);
  });
});
