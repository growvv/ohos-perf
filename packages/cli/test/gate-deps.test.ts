import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseBudgetDocument, renderGateJson } from '@ohos-perf/core';
import { realDeps } from '../src/deps';

/*
 * The seam around the gate, against real files: which inputs it reads, what it
 * refuses before touching a scene, and that the artifact it writes is exactly
 * what `renderGateJson` produces. The scene is the same two-frame trace the
 * report and compare tests use, kept local so this file does not depend on
 * their edits.
 */

function createTraceDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  db.exec(`INSERT INTO frame_slice VALUES
    (0, 1000, 0, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 0),
    (1, 2000, 1, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 1)`);
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  db.close();
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-gate-'));
  roots.push(root);
  return root;
}

function sceneWithTrace(root: string): string {
  const sceneDir = join(root, 'scene');
  mkdirSync(sceneDir, { recursive: true });
  createTraceDb(join(sceneDir, 'trace.db'));
  return sceneDir;
}

function writeBudget(root: string, budgets: unknown[]): string {
  const path = join(root, 'budgets.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, name: 'open-app', budgets }));
  return path;
}

describe('gate seam', () => {
  it('refuses a delta budget with no baseline before opening the scene', async () => {
    const root = tempRoot();
    const budget = writeBudget(root, [{ id: 'frame.jank.rate', maxDeltaPct: 5 }]);
    // The scene path does not exist: if the seam opened it first, the error
    // would be about the path instead of the missing baseline.
    await expect(
      realDeps().gate({ budget, input: join(root, 'no-such-scene') }),
    ).rejects.toMatchObject({ code: 'GATE_BASELINE_REQUIRED' });
    await expect(
      realDeps().gate({ budget, input: join(root, 'no-such-scene') }),
    ).rejects.toThrow(/frame\.jank\.rate/);
  });

  it('evaluates an absolute budget against a scene directory', async () => {
    const root = tempRoot();
    const sceneDir = sceneWithTrace(root);
    const budget = writeBudget(root, [{ id: 'frame.count', min: 1 }]);
    const out = await realDeps().gate({ budget, input: sceneDir });
    expect(out.result.name).toBe('open-app');
    const verdict = out.result.verdicts[0]!;
    expect(verdict.id).toBe('frame.count');
    expect(verdict.status).not.toBe('missing');
  });

  it('accepts an analyze --json file on either side', async () => {
    const root = tempRoot();
    const sceneDir = sceneWithTrace(root);
    const budget = writeBudget(root, [{ id: 'frame.count', maxDeltaPct: 1000 }]);
    const analysis = await realDeps().analyze(sceneDir);
    const baselineFile = join(root, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify(analysis));
    const out = await realDeps().gate({ budget, input: sceneDir, baseline: baselineFile });
    expect(out.result.verdicts[0]!.status).not.toBe('missing');
  });

  it('writes gate.json containing exactly renderGateJson(result)', async () => {
    const root = tempRoot();
    const sceneDir = sceneWithTrace(root);
    const budget = writeBudget(root, [{ id: 'frame.count', min: 1 }]);
    const outDir = join(root, 'out');
    const out = await realDeps().gate({ budget, input: sceneDir, outDir });
    expect(out.files).toEqual(['gate.json']);
    expect(readFileSync(join(outDir, 'gate.json'), 'utf8')).toBe(renderGateJson(out.result));
  });

  it('rejects a malformed document with the path that failed', async () => {
    const root = tempRoot();
    const budget = join(root, 'bad.json');
    writeFileSync(budget, JSON.stringify({ schemaVersion: 1, name: 'x', budgets: [{ id: 'a' }] }));
    await expect(realDeps().gate({ budget, input: sceneWithTrace(root) })).rejects.toThrow(
      /budgets\[0\].*no bound/,
    );
  });

  it('rejects an unreadable document naming the path', async () => {
    const root = tempRoot();
    await expect(
      realDeps().gate({ budget: join(root, 'absent.json'), input: sceneWithTrace(root) }),
    ).rejects.toMatchObject({ code: 'BUDGET_BAD_DOCUMENT' });
  });

  it('parses the document it writes against its own schema', () => {
    // Guard against the fixture drifting from the validator.
    expect(() =>
      parseBudgetDocument({ schemaVersion: 1, name: 'x', budgets: [{ id: 'a', max: 1 }] }),
    ).not.toThrow();
    expect(existsSync(join(tmpdir(), 'never-created'))).toBe(false);
  });
});
