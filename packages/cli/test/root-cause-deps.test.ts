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

/**
 * A scene whose jank rate is decided by the fixture: `stuttered` flag-1 frames
 * out of `rendered` actual frames, so the movement has a real number to compare.
 *
 * `metadata` writes a `scene.json`; without one the app resolves to `unknown`
 * and the two runs are comparable by accident rather than by agreement.
 */
function jankScene(options: {
  stuttered: number;
  rendered: number;
  app?: string;
  startedAtNs?: number;
}): { root: string; sceneDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-movement-'));
  roots.push(root);
  const sceneDir = join(root, 'scene');
  mkdirSync(sceneDir);
  const db = new DatabaseSync(join(sceneDir, 'trace.db'));
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  const insert = db.prepare(
    'INSERT INTO frame_slice VALUES (?, ?, ?, 17, 44, 0, 16000000, \'\', 0, 0, \'actural\', ?, 0, ?)',
  );
  for (let index = 0; index < options.rendered; index += 1) {
    const flag = index < options.stuttered ? 1 : 0;
    insert.run(index, 1000 + index, index, flag, index);
  }
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  db.exec(`INSERT INTO process VALUES (0, 17, 17, 'com.demo', 0, 0, 1, 1, 0)`);
  db.close();
  if (options.app !== undefined) {
    writeFileSync(join(sceneDir, 'scene.json'), JSON.stringify({
      version: 1,
      app: { packageName: options.app, processNames: [options.app] },
      pids: [17],
      deviceId: 'emu',
      ...(options.startedAtNs === undefined ? {} : { startedAtNs: options.startedAtNs }),
      capture: { startedAtMs: 0, durationMs: 1000, collectors: [] },
    }));
  }
  return { root, sceneDir };
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

describe('realDeps().rootCause — --baseline', () => {
  it('writes the movement of two scenes, naming the metric that regressed', async () => {
    // 1 of 4 frames stuttered (25%), then 2 of 4 (50%): the jank rate rose.
    const before = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo', startedAtNs: 1000 });
    const after = jankScene({ stuttered: 2, rendered: 4, app: 'com.demo', startedAtNs: 2000 });
    const result = await realDeps('0.27.0').rootCause({
      input: after.sceneDir,
      baseline: before.sceneDir,
      outDir: join(after.root, 'out'),
      offline: true,
    });

    const row = result.document.movement?.rows.find((entry) => entry.id === 'frame.jank.rate');
    expect(row?.status).toBe('regressed');
    expect(row?.from).toBe(25);
    expect(row?.to).toBe(50);
    // The artifact on disk is the same document, not a second rendering.
    const written = JSON.parse(
      readFileSync(join(result.outDir, 'root-cause.json'), 'utf8'),
    ) as typeof result.document;
    expect(written.movement?.rows).toEqual(result.document.movement?.rows);
  });

  it('accepts a baseline given as a saved report bundle', async () => {
    const before = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo', startedAtNs: 1000 });
    const after = jankScene({ stuttered: 2, rendered: 4, app: 'com.demo', startedAtNs: 2000 });
    const deps = realDeps('0.27.0');
    const bundle = await deps.report({ sceneDir: before.sceneDir, outDir: join(before.root, 'bundle') });

    const result = await deps.rootCause({
      input: after.sceneDir,
      baseline: join(before.root, 'bundle'),
      outDir: join(after.root, 'out'),
      offline: true,
    });
    expect(bundle.files).toContain('report.json');
    expect(result.document.movement?.from.label).toContain('bundle');
    expect(result.document.movement?.rows.some((row) => row.status === 'regressed')).toBe(true);
  });

  it('refuses a baseline for a different app before asking a model', async () => {
    const before = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo', startedAtNs: 1000 });
    const after = jankScene({ stuttered: 2, rendered: 4, app: 'com.other', startedAtNs: 2000 });
    process.env['OHOS_PERF_AGENT_BASE_URL'] = 'https://e.test/v1';
    process.env['OHOS_PERF_AGENT_API_KEY'] = 'k';
    let asked = false;
    const model: AgentModel = {
      async decide() {
        asked = true;
        return { done: true, reason: '{}' };
      },
    };

    await expect(realDeps('0.27.0', { rootCauseModel: () => model }).rootCause({
      input: after.sceneDir,
      baseline: before.sceneDir,
      outDir: join(after.root, 'out'),
    })).rejects.toMatchObject({ code: 'ROOT_CAUSE_BAD_BASELINE' });
    expect(asked).toBe(false);
    // The message names both apps, so the reader can see which file is which.
    await expect(realDeps('0.27.0').rootCause({
      input: after.sceneDir,
      baseline: before.sceneDir,
      outDir: join(after.root, 'out2'),
      offline: true,
    })).rejects.toThrow(/com\.demo.*com\.other/);
  });

  it('reads the baseline as `from` even when it was captured later', async () => {
    // `buildTrend` orders by start time; a movement must not, or a baseline
    // captured later would silently invert every verdict.
    const late = jankScene({ stuttered: 2, rendered: 4, app: 'com.demo', startedAtNs: 5000 });
    const early = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo', startedAtNs: 1000 });
    const result = await realDeps('0.27.0').rootCause({
      input: early.sceneDir,
      baseline: late.sceneDir,
      outDir: join(early.root, 'out'),
      offline: true,
    });
    const row = result.document.movement?.rows.find((entry) => entry.id === 'frame.jank.rate');
    expect(row?.from).toBe(50);
    expect(row?.to).toBe(25);
    expect(row?.status).toBe('improved');
  });

  it('never asks a model under --offline even with a baseline', async () => {
    const before = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo' });
    const after = jankScene({ stuttered: 2, rendered: 4, app: 'com.demo' });
    process.env['OHOS_PERF_AGENT_BASE_URL'] = 'https://e.test/v1';
    process.env['OHOS_PERF_AGENT_API_KEY'] = 'k';
    const model = stubModel({ summary: 's', suspects: [], caveats: [], needsMoreData: [] });

    const result = await realDeps('0.27.0', { rootCauseModel: () => model }).rootCause({
      input: after.sceneDir,
      baseline: before.sceneDir,
      outDir: join(after.root, 'out'),
      offline: true,
    });
    expect(model.turns).toHaveLength(0);
    expect(result.document.movement).toBeDefined();
    expect(result.fellBackToOffline).toBeUndefined();
  });

  it('reports a metric the baseline did not measure as a gap, not an improvement', async () => {
    // The baseline has no `process` table, so the binder analyzer cannot run
    // there; its metrics must be gaps on that side, never a rise from zero.
    const before = jankScene({ stuttered: 1, rendered: 4, app: 'com.demo' });
    const after = jankScene({ stuttered: 2, rendered: 4, app: 'com.demo' });
    const result = await realDeps('0.27.0').rootCause({
      input: after.sceneDir,
      baseline: before.sceneDir,
      outDir: join(after.root, 'out'),
      offline: true,
    });
    const { movement } = result.document;
    expect(movement).toBeDefined();
    for (const row of movement!.rows) {
      if (row.status !== 'gap') continue;
      expect(row.delta).toBeUndefined();
      expect(row.gap?.reason).toContain(row.id);
    }
    // Nothing in this pair of scenes is an improvement: they differ only in
    // how many frames stuttered.
    expect(movement!.totals.improved).toBe(0);
  });
});
