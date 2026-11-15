import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';import { fileURLToPath } from 'node:url';
import type { Scene, SceneLayout } from '@ohos-perf/core';
import { manifestPath, packageVersion, realDeps } from '../src/deps';

/** The manifest as an independent reader sees it, not through `deps.ts`. */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

/** Minimal trace database the analyzer can query. */
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

/** A scene whose database returns no rows; used to observe the layout only. */
function emptyScene(): Scene {
  return {
    dir: '',
    traceDb: { path: '', query: () => [], close: () => {} },
    query: () => [],
    close: () => {},
  };
}

describe('packageVersion', () => {
  it('reads the version from package.json', () => {
    expect(packageVersion()).toBe(manifest.version);
  });

  it('actually reads the manifest instead of returning a constant', () => {
    // A hard-coded value that happens to match today's manifest would pass the
    // assertion above; pointing at a different file proves the read happens.
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-manifest-'));
    try {
      const other = join(dir, 'package.json');
      writeFileSync(other, JSON.stringify({ version: '7.7.7' }));
      expect(packageVersion(other)).toBe('7.7.7');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves package.json one level above the module', () => {
    // Holds for both `src/deps.ts` and the bundled `dist/index.js`.
    expect(manifestPath).toBe(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
  });

  it('falls back to 0.0.0 instead of throwing when the manifest is missing', () => {
    // `realDeps()` runs at module load, so a throw here would make `--help`
    // crash. The version is metadata; a broken install must stay usable.
    expect(() => packageVersion(join(tmpdir(), 'ohosperf-no-such-dir', 'package.json'))).not.toThrow();
    expect(packageVersion(join(tmpdir(), 'ohosperf-no-such-dir', 'package.json'))).toBe('0.0.0');
  });

  it('falls back to 0.0.0 when the version is empty or whitespace', () => {
    // `typeof version === 'string'` alone would let `--version` print a blank
    // line; an empty version is metadata we do not have, not a version.
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-emptyversion-'));
    try {
      const empty = join(dir, 'empty.json');
      writeFileSync(empty, JSON.stringify({ version: '' }));
      expect(packageVersion(empty)).toBe('0.0.0');

      const blank = join(dir, 'blank.json');
      writeFileSync(blank, JSON.stringify({ version: '   ' }));
      expect(packageVersion(blank)).toBe('0.0.0');

      const padded = join(dir, 'padded.json');
      writeFileSync(padded, JSON.stringify({ version: ' 7.7.7 ' }));
      expect(packageVersion(padded)).toBe('7.7.7');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to 0.0.0 when the manifest is malformed or has no version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-badmanifest-'));
    try {
      const broken = join(dir, 'package.json');
      writeFileSync(broken, '{ not json');
      expect(packageVersion(broken)).toBe('0.0.0');

      const versionless = join(dir, 'versionless.json');
      writeFileSync(versionless, JSON.stringify({ name: 'x' }));
      expect(packageVersion(versionless)).toBe('0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('realDeps().analyze', () => {
  it('resolves a relative scene directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-'));
    const before = process.cwd();
    try {
      mkdirSync(join(parent, 'scene1'));
      createTraceDb(join(parent, 'scene1', 'trace.db'));
      process.chdir(parent);

      const result = await realDeps('0.0.0').analyze('scene1');

      const count = result.metrics.find((m) => m.id === 'frame.count');
      expect(count?.value).toBe(2);
    } finally {
      // `process.cwd` is shared by the whole worker: never leak a chdir.
      process.chdir(before);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('hands ingestion an absolute root, even for a relative argument', async () => {
    const layouts: SceneLayout[] = [];
    const deps = realDeps('0.0.0', {
      ingest: async (_streamer, layout) => {
        layouts.push(layout);
        return emptyScene();
      },
    });

    await deps.analyze('relative-scene');

    expect(layouts).toHaveLength(1);
    expect(layouts[0].root).toBe(resolve('relative-scene'));
    expect(isAbsolute(layouts[0].root)).toBe(true);
  });

  it('closes the scene when analysis fails', async () => {
    let closed = false;
    const scene: Scene = {
      dir: 'scene1',
      traceDb: {
        path: '',
        query: () => { throw new Error('query exploded'); },
        close: () => {},
      },
      query: () => [],
      close: () => { closed = true; },
    };
    const deps = realDeps('0.0.0', { ingest: async () => scene });

    await expect(deps.analyze('scene1')).rejects.toThrow('query exploded');
    expect(closed).toBe(true);
  });

  it('degrades analyzers whose tables are missing, without throwing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      // The synthetic DB has only frame_slice + process: frames and startup run,
      // every other analyzer is explicitly degraded rather than silently zeroed.
      expect(ids).toContain('frame.count');
      expect(ids).toContain('binder.degraded');
      expect(ids).toContain('fault-tree.degraded');
      expect(ids).toContain('threads.degraded');
      expect(ids).toContain('memory.degraded');
      const binder = result.metrics.find((m) => m.id === 'binder.degraded');
      expect(binder?.fidelity).toBe('proxy');
      const degraded = result.evidence.filter((e) => e.kind === 'degraded_capability');
      expect(degraded.length).toBeGreaterThan(0);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runs memory instead of degrading it when procfs.jsonl has samples', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(
        join(parent, 'procfs.jsonl'),
        `${JSON.stringify({ ts: 1, pid: 42, status: { vmRssBytes: 2048, vmHwmBytes: 2048, threads: 1 } })}\n`,
      );
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      expect(ids).not.toContain('memory.degraded');
      expect(ids.some((id) => id.startsWith('mem.'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not claim mem.procfs for an empty procfs.jsonl', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'procfs.jsonl'), '');
      const result = await realDeps('0.0.0').analyze(parent);
      // A file with no usable samples is not a capture: the analyzer must
      // degrade rather than report an exact zero as a measurement.
      expect(result.metrics.map((m) => m.id)).toContain('memory.degraded');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reads scene.json metadata when it is valid', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1', startedAtNs: 1_000_000_000,
      }));
      // The startup analyzer consumes the marker; a bad metadata reader would
      // drop it. Assert the run still succeeds and stays deterministic.
      const a = await realDeps('0.0.0').analyze(parent);
      const b = await realDeps('0.0.0').analyze(parent);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('realDeps().collect', () => {
  it('resolves the output directory and closes the scene', async () => {
    const seen: unknown[] = [];
    let closed = false;
    const scene = {
      close: () => { closed = true; },
    };
    const deps = realDeps('0.0.0', {
      collectDevice: async () => ({
        id: 't1',
        kind: 'emulator',
        collect: async (opts: unknown) => {
          seen.push(opts);
          return { ingest: async () => scene as unknown as Scene };
        },
      }),
    });
    const result = await deps.collect({
      app: 'com.demo', durationMs: 10_000, out: 'relative-scene',
      procfs: true, coldStart: 'EntryAbility',
    });
    expect(result).toEqual({
      sceneDir: resolve('relative-scene'),
      device: { id: 't1', kind: 'emulator' },
    });
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      sceneRoot: resolve('relative-scene'),
      procfs: true,
      coldStart: { ability: 'EntryAbility' },
    }]);
    expect(closed).toBe(true);
  });
});

describe('realDeps().capsReport', () => {
  it('reports hdc failure without probing the device', async () => {
    const deps = realDeps('0.0.0', {
      hdc: { resolvePath: async () => { throw new Error('no hdc'); } },
      connectDevice: async () => { throw new Error('must not be called'); },
    });
    const report = await deps.capsReport();
    expect(report).toEqual({ hdcOk: false, hdcError: 'no hdc', capabilities: [] });
  });

  it('treats a missing device as environmental, but records why', async () => {
    const deps = realDeps('0.0.0', {
      hdc: { resolvePath: async () => '/hdc' },
      connectDevice: async () => { throw new Error('no device'); },
    });
    const report = await deps.capsReport();
    expect(report.hdcOk).toBe(true);
    // "we could not ask" must be distinguishable from "we asked, got zero".
    expect(report.probeError).toBe('no device');
    expect(report.capabilities).toEqual([]);
  });

  it('records a capabilities() failure as a probe error, not an empty matrix', async () => {
    const deps = realDeps('0.0.0', {
      hdc: { resolvePath: async () => '/hdc' },
      connectDevice: async () => ({
        id: 't1',
        kind: 'emulator',
        abi: 'x86_64',
        capabilities: async () => {
          throw new Error('probe exploded');
        },
      }),
    });
    const report = await deps.capsReport();
    expect(report.hdcOk).toBe(true);
    // The device answered, but its probe failed: that is not "zero capabilities".
    expect(report.probeError).toBe('probe exploded');
    expect(report.capabilities).toEqual([]);
  });

  it('does not set probeError when the device genuinely reports zero capabilities', async () => {
    const deps = realDeps('0.0.0', {
      hdc: { resolvePath: async () => '/hdc' },
      connectDevice: async () => ({
        id: 't1',
        kind: 'emulator',
        abi: 'x86_64',
        capabilities: async () => ({ all: () => [] }),
      }),
    });
    const report = await deps.capsReport();
    expect(report.hdcOk).toBe(true);
    expect(report.probeError).toBeUndefined();
    expect(report.capabilities).toEqual([]);
  });
});

describe('realDeps()', () => {
  it('defaults the version to the manifest', () => {
    expect(realDeps().version).toBe(manifest.version);
  });

  it('reads package.json relative to the module, not the cwd', () => {
    // A CLI invoked from any directory must still report its own version.
    const elsewhere = mkdtempSync(join(tmpdir(), 'ohosperf-cwd-'));
    const before = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(packageVersion()).toBe(manifest.version);
    } finally {
      process.chdir(before);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
