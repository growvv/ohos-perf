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
    close: () => {},
  } as unknown as Scene;
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
    const scene = {
      traceDb: {
        path: '',
        query: () => { throw new Error('query exploded'); },
        close: () => {},
      },
      close: () => { closed = true; },
    } as unknown as Scene;
    const deps = realDeps('0.0.0', { ingest: async () => scene });

    await expect(deps.analyze('scene1')).rejects.toThrow('query exploded');
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

  it('treats a missing device as environmental', async () => {
    const deps = realDeps('0.0.0', {
      hdc: { resolvePath: async () => '/hdc' },
      connectDevice: async () => { throw new Error('no device'); },
    });
    const report = await deps.capsReport();
    expect(report.hdcOk).toBe(true);
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
