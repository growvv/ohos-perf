import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';import { fileURLToPath } from 'node:url';
import type { Scene, SceneLayout, UiNode } from '@ohos-perf/core';
import { encodePng } from '@ohos-perf/core';
import {
  manifestPath, offlineCapabilities, packageVersion, realDeps,
  type CapabilityMatrixDb,
} from '../src/deps';
import { makeZip } from '../../core/test/helpers/hap-zip-writer';
import { makeElf64, OP, text } from '../../core/test/helpers/elf-writer';

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

/**
 * A trace database with every table the offline matrix gates on, so no
 * analyzer degrades and the app identity actually reaches the three
 * app-scoped analyzers. All data tables are empty except one frame row (so
 * frames never emits its own `no_data`) and a `trace_range` row (fault-tree
 * reads it unguarded). `processRows` is an optional VALUES body for `process`,
 * e.g. `(0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`.
 */
function createFullTraceDb(path: string, processRows?: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  db.exec(`INSERT INTO frame_slice VALUES
    (0, 1000, 0, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 0)`);
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  if (processRows !== undefined) db.exec(`INSERT INTO process VALUES ${processRows}`);
  db.exec(`CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`);
  db.exec(`CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
    cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT,
    chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
    trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT)`);
  db.exec('CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT)');
  db.exec('CREATE TABLE data_dict(id INT, data TEXT)');
  db.exec('CREATE TABLE trace_range(start_ts INT, end_ts INT)');
  db.exec('INSERT INTO trace_range VALUES (0, 10000000000)');
  db.exec(`CREATE TABLE sched_slice(id INT, ts INT, dur INT, ts_end INT, cpu INT,
    itid INT, ipid INT, end_state TEXT, priority INT, arg_setid INT)`);
  db.exec(`CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
    ref_type TEXT, value REAL)`);
  db.exec(`CREATE TABLE thread_state(ts INT, dur INT, cpu INT, itid INT, tid INT,
    pid INT, state TEXT, arg_setid INT)`);
  db.exec(`CREATE TABLE app_startup(id INT, call_id INT, ipid INT, tid INT,
    start_time INT, end_time INT, start_name INT, packed_name TEXT)`);
  db.close();
}

/**
 * A scene database with exactly the named tables (minimal column shape), for
 * asserting that the offline matrix gates on the full table set. `trace_range`
 * always carries one row so an analyzer that does run can resolve a range.
 */
function createTableSetDb(path: string, tables: string[]): void {
  const db = new DatabaseSync(path);
  const ddl: Record<string, string> = {
    frame_slice: `CREATE TABLE frame_slice(id INT, ts INT, dur INT, type INT, flag INT,
      ipid INT, itid INT, vsync INT, callstack_id INT, src TEXT, dst INT,
      type_desc TEXT, depth INT, frame_no INT)`,
    process: `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
      switch_count INT, thread_count INT, slice_count INT, mem_count INT)`,
    thread: `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
      end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`,
    callstack: `CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
      cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT,
      chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
      trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT)`,
    args: 'CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT)',
    data_dict: 'CREATE TABLE data_dict(id INT, data TEXT)',
    trace_range: 'CREATE TABLE trace_range(start_ts INT, end_ts INT)',
    sched_slice: `CREATE TABLE sched_slice(id INT, ts INT, dur INT, ts_end INT,
      cpu INT, itid INT, ipid INT, end_state TEXT, priority INT, arg_setid INT)`,
    instant: `CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
      ref_type TEXT, value REAL)`,
    thread_state: `CREATE TABLE thread_state(ts INT, dur INT, cpu INT, itid INT,
      tid INT, pid INT, state TEXT, arg_setid INT)`,
    app_startup: `CREATE TABLE app_startup(id INT, call_id INT, ipid INT, tid INT,
      start_time INT, end_time INT, start_name INT, packed_name TEXT)`,
  };
  for (const table of tables) db.exec(ddl[table]);
  if (tables.includes('trace_range')) {
    db.exec('INSERT INTO trace_range VALUES (0, 10000000000)');
  }
  if (tables.includes('frame_slice')) {
    db.exec(`INSERT INTO frame_slice VALUES
      (0, 1000, 16000000, 0, 0, 17, 44, 0, 0, '', 0, 'actural', 0, 0)`);
  }
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
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-meta-'));
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

  // Fix round 1, item 1: a scene.json written by Device.collect is the
  // authority on which collectors ran. A stale procfs.jsonl must be ignored
  // when it says hitrace only; hand-built scenes without metadata still work.
  const procfsSample =
    `${JSON.stringify({ ts: 1, pid: 42, status: { vmRssBytes: 2048, vmHwmBytes: 2048, threads: 1 } })}\n`;

  function writeMeta(parent: string, collectors: string[]): void {
    writeFileSync(join(parent, 'scene.json'), JSON.stringify({
      version: 1,
      app: { packageName: 'com.demo', processNames: ['com.demo'] },
      pids: [], deviceId: 't1',
      capture: { startedAtMs: 1, durationMs: 2, collectors },
    }));
  }

  it('ignores a stale procfs.jsonl when scene.json lists only hitrace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-stale-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'procfs.jsonl'), procfsSample);
      writeMeta(parent, ['hitrace']);
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      expect(ids).toContain('memory.degraded');
      expect(ids.some((id) => id.startsWith('mem.'))).toBe(false);
      // mem.procfs is absent from the matrix, so the degraded reason names it.
      const degraded = result.evidence.filter((e) => e.kind === 'degraded_capability');
      expect(degraded.length).toBeGreaterThan(0);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('decodes a declared screenshot.png for the ui analyzer', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-analyze-shot-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'screenshot.png'), encodePng({
        width: 3, height: 2,
        data: new Uint8Array(3 * 2 * 4).fill(200),
      }));
      writeMeta(parent, ['hitrace', 'screenshot']);
      const result = await realDeps('0.0.0').analyze(parent);
      const width = result.metrics.find((m) => m.id === 'ui.screenshot.width');
      expect(width?.value).toBe(3);
      expect(width?.fidelity).toBe('exact');
      // No ui.json in this scene: the tree half degrades on its own.
      expect(result.metrics.find((m) => m.id === 'ui.nodes.count')?.fidelity).toBe('proxy');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('degrades the image half with the decoder message, not a crash', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-analyze-shot-bad-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'screenshot.png'), new Uint8Array([1, 2, 3, 4]));
      writeMeta(parent, ['hitrace', 'screenshot']);
      const result = await realDeps('0.0.0').analyze(parent);
      const width = result.metrics.find((m) => m.id === 'ui.screenshot.width');
      expect(width?.fidelity).toBe('proxy');
      expect(width?.degraded?.reason).toMatch(/not a PNG/);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a screenshot.png that scene.json does not list', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-analyze-shot-stale-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'screenshot.png'), encodePng({
        width: 3, height: 2,
        data: new Uint8Array(3 * 2 * 4).fill(200),
      }));
      writeMeta(parent, ['hitrace']);
      const result = await realDeps('0.0.0').analyze(parent);
      // Neither artifact is declared, so the analyzer takes its no-data path
      // rather than reading the stale file: no exact image metric appears.
      const ids = result.metrics.map((m) => m.id);
      expect(ids).toContain('ui.degraded');
      expect(ids).not.toContain('ui.screenshot.width');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runs memory when scene.json lists hitrace and procfs', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-meta-procfs-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'procfs.jsonl'), procfsSample);
      writeMeta(parent, ['hitrace', 'procfs']);
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      expect(ids).not.toContain('memory.degraded');
      expect(ids.some((id) => id.startsWith('mem.'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('trusts procfs.jsonl when scene.json is absent', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-legacy-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'procfs.jsonl'), procfsSample);
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      expect(ids).not.toContain('memory.degraded');
      expect(ids.some((id) => id.startsWith('mem.'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 1, item 6: trace.sched needs BOTH sched_slice and instant.
  it('does not claim trace.sched when only one of its tables exists', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-sched-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      // Add sched_slice only; instant is absent.
      const db = new DatabaseSync(join(parent, 'trace.db'));
      db.exec('CREATE TABLE sched_slice(id INT, ts INT)');
      db.close();
      const result = await realDeps('0.0.0').analyze(parent);
      // threads requires sched+thread_state; with trace.sched absent the
      // analyzer must degrade rather than run against a half-present signal.
      expect(result.metrics.map((m) => m.id)).toContain('threads.degraded');
      // Assert the matrix directly too: `instant` alone is not enough, and
      // `sched_slice` alone (the case built above) is not enough either.
      const fakeDb = (names: string[]): CapabilityMatrixDb => ({
        query: <T = Record<string, unknown>>(): T[] =>
          names.map((name) => ({ name })) as unknown as T[],
      });
      const matrix = offlineCapabilities(fakeDb(['sched_slice', 'frame_slice']), {});
      expect(matrix.has('trace.sched')).toBe(false);
      expect(matrix.get('trace.sched')).toBeUndefined();
      const both = offlineCapabilities(fakeDb(['sched_slice', 'instant']), {});
      expect(both.has('trace.sched')).toBe(true);

      // I2: trace.binder is gated on the full unguarded table set. One missing
      // table (args) must drop the capability rather than let the analyzer run
      // and crash on `no such table`.
      const binderTables = [
        'callstack', 'args', 'data_dict', 'process', 'thread', 'trace_range',
      ];
      const fullBinder = offlineCapabilities(fakeDb(binderTables), {});
      expect(fullBinder.has('trace.binder')).toBe(true);
      const minusArgs = offlineCapabilities(
        fakeDb(binderTables.filter((name) => name !== 'args')),
        {},
      );
      expect(minusArgs.has('trace.binder')).toBe(false);
      // trace.ark gates the GC and component analyzers, which join callstack
      // to thread and process; a trace missing either join must not claim it.
      const arkTables = ['callstack', 'thread', 'process'];
      expect(offlineCapabilities(fakeDb(arkTables), {}).has('trace.ark')).toBe(true);
      expect(offlineCapabilities(fakeDb(['callstack', 'thread']), {}).has('trace.ark')).toBe(false);
      // render.vsync scopes frame_slice rows through process; either table
      // missing means the cadence cannot be attributed to the app.
      expect(offlineCapabilities(fakeDb(['frame_slice', 'process']), {}).has('render.vsync'))
        .toBe(true);
      expect(offlineCapabilities(fakeDb(['frame_slice']), {}).has('render.vsync')).toBe(false);
      // startup.app_startup is dead: no capability row is emitted for it.
      expect(offlineCapabilities(fakeDb(['app_startup']), {}).has('startup.app_startup'))
        .toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('feeds a hidumper.json capture into the render analyzer', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-hidumper-wire-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      const capture = {
        version: 1,
        intervalMs: 10_000,
        samples: [
          { ts: 1, fpsCounts: [{ refreshRate: 60, count: 1000 }],
            hitches: [{ windowId: 'w1', over16_67: 3, over33: 1, over66: 0 }] },
          { ts: 2, fpsCounts: [{ refreshRate: 60, count: 1600 }],
            hitches: [{ windowId: 'w1', over16_67: 9, over33: 2, over66: 1 }] },
        ],
      };
      writeFileSync(join(parent, 'hidumper.json'), JSON.stringify(capture));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 10_000, collectors: ['hitrace', 'hidumper'] },
      }));

      const result = await realDeps('0.0.0').analyze(parent);
      const metric = (id: string): number | string | undefined =>
        result.metrics.find((m) => m.id === id)?.value;
      // 600 frames over 10 s; 6 hitches over the window.
      expect(metric('render.fps.live')).toBe(60);
      expect(metric('render.hitch.count')).toBe(6);
      expect(result.metrics.some((m) => m.id === 'render.degraded')).toBe(false);
      const evidence = result.evidence.find((e) => e.kind === 'fps_baseline');
      expect(evidence?.signals).toMatchObject({ window: 'w1', over16_67: 6 });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a stale hidumper.json that scene.json does not list', async () => {
    // Re-collecting into the same directory without --hidumper leaves the old
    // file behind. Trusting it would report the previous capture's hitches as
    // this capture's, which is the same class of bug the procfs gate prevents.
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-hidumper-stale-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'hidumper.json'), JSON.stringify({
        version: 1, intervalMs: 1000,
        samples: [
          { ts: 1, fpsCounts: [{ refreshRate: 60, count: 1 }], hitches: [] },
          { ts: 2, fpsCounts: [{ refreshRate: 60, count: 2 }], hitches: [] },
        ],
      }));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 10_000, collectors: ['hitrace'] },
      }));

      const result = await realDeps('0.0.0').analyze(parent);
      expect(result.metrics.some((m) => m.id === 'render.fps.live')).toBe(false);
      expect(result.metrics.some((m) => m.id === 'render.degraded')).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('claims mem.native_hook for a nativehook-only scene, not just a memory-plugin one', async () => {
    // `collect --hiprofiler --plugins nativehook` produces `native_hook*` and
    // neither `process_measure` table. The old rule required the memory
    // plugin's tables, so the analyzer never ran on the capture its own
    // collector produces: `analyze` reported `native-memory.degraded` with the
    // data sitting in the database. Either table family satisfies the row.
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-nativehook-scene-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      const raw = new DatabaseSync(join(parent, 'trace.db'));
      raw.exec(`CREATE TABLE native_hook(id INT, callchain_id INT, ipid INT,
        itid INT, event_type INT, sub_type_id INT, start_ts INT, end_ts INT, dur INT,
        addr INT, heap_size INT, all_heap_size INT, current_size_dur INT,
        last_lib_id INT, last_symbol_id INT)`);
      raw.exec('CREATE TABLE native_hook_frame(id INT, callchain_id INT, depth INT,' +
        ' ip INT, symbol_id INT, file_id INT, offset INT, symbol_offset INT, vaddr INT)');
      raw.exec("INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)");
      raw.exec(`INSERT INTO native_hook VALUES
        (0, 10, 17, 100, 0, 0, 1000, 0, 0, 4096, 100, 0, 0, 1, 2)`);
      raw.exec('CREATE TABLE data_dict(id INT, data TEXT)');
      raw.exec("INSERT INTO data_dict VALUES (1, 'libfoo.so'), (2, 'foo()')");
      raw.close();

      const result = await realDeps('0.0.0').analyze(parent, 'com.demo');
      const ids = result.metrics.map((m) => m.id);
      expect(ids).not.toContain('native-memory.degraded');
      expect(ids).toContain('mem.native.total.peak');

      const tableDb = (names: string[]): CapabilityMatrixDb => ({
        query: <T = Record<string, unknown>>(): T[] =>
          names.map((name) => ({ name })) as unknown as T[],
      });
      expect(offlineCapabilities(tableDb(['native_hook']), {}).has('mem.native_hook')).toBe(true);
      // The memory plugin's tables still satisfy the row.
      expect(offlineCapabilities(tableDb(['process_measure', 'process_measure_filter']), {})
        .has('mem.native_hook')).toBe(true);
      // Neither family: absent.
      expect(offlineCapabilities(tableDb(['frame_slice']), {}).has('mem.native_hook')).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('feeds a hilog.log capture into the hilog analyzer', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-hilog-scene-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'hilog.log'), [
        '11-17 05:12:10.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 1 us',
        '11-17 05:12:11.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 2 us',
        '11-17 05:12:12.000  4999  5010 I A00000/com.demo/Image: unrelated',
        '',
      ].join('\n'));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: {
          startedAtMs: Date.UTC(2026, 10, 17, 5, 12), durationMs: 10_000,
          collectors: ['hitrace', 'hilog'], hilog: { lines: 3 },
        },
      }));

      const result = await realDeps('0.0.0').analyze(parent);
      const value = (id: string): unknown => result.metrics.find((m) => m.id === id)?.value;
      expect(value('hilog.lines.count')).toBe(3);
      expect(value('hilog.rule.no_dmp.count')).toBe(2);
      expect(result.metrics.some((m) => m.id === 'hilog.degraded')).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a stale hilog.log that scene.json does not list', async () => {
    // A re-capture without --hilog leaves the previous log in the directory.
    // The descriptor is the authority, so the stale log must not be analyzed.
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-hilog-stale-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'hilog.log'),
        '11-17 05:12:10.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 1 us\n');
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));
      const result = await realDeps('0.0.0').analyze(parent);
      expect(result.metrics.map((m) => m.id)).toContain('hilog.degraded');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('feeds a thermal.jsonl capture into the thermal analyzer', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-thermal-scene-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'thermal.jsonl'), [
        '{"elapsedMs":0,"readings":[{"sensor":"Battery","raw":31000,"unit":"millidegree_celsius","celsius":31}]}',
        '{"elapsedMs":2000,"readings":[{"sensor":"Battery","raw":32000,"unit":"millidegree_celsius","celsius":32}]}',
        '',
      ].join('\n'));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: {
          startedAtMs: 0, durationMs: 2_000,
          collectors: ['hitrace', 'thermal'], thermal: { samples: 2 },
        },
      }));

      const result = await realDeps('0.0.0').analyze(parent);
      const value = (id: string): unknown => result.metrics.find((m) => m.id === id)?.value;
      expect(value('thermal.samples.count')).toBe(2);
      expect(value('thermal.battery.start.celsius')).toBe(31);
      expect(value('thermal.battery.end.celsius')).toBe(32);
      expect(value('thermal.battery.rise.celsius')).toBe(1);
      expect(result.metrics.some((m) => m.id === 'thermal.degraded')).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a stale thermal.jsonl that scene.json does not list', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-thermal-stale-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'thermal.jsonl'),
        '{"elapsedMs":0,"readings":[{"sensor":"Battery","raw":31000,"unit":"millidegree_celsius","celsius":31}]}\n');
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));
      const result = await realDeps('0.0.0').analyze(parent);
      expect(result.metrics.map((m) => m.id)).toContain('thermal.degraded');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('claims perf.samples only when perf_sample has rows', () => {
    const tableDb = (names: string[]): CapabilityMatrixDb => ({
      query: <T = Record<string, unknown>>(): T[] =>
        names.map((name) => ({ name })) as unknown as T[],
    });
    // `SELECT 1 FROM perf_sample LIMIT 1` returns one row for a non-empty
    // table and none for an empty one.
    const perfWithRows: CapabilityMatrixDb = {
      query: <T = Record<string, unknown>>(sql: string): T[] => {
        if (sql.includes('sqlite_master')) return [{ name: 'perf_sample' }] as unknown as T[];
        if (sql.includes('perf_sample')) return [{ 1: 1 }] as unknown as T[];
        return [];
      },
    };
    const perfEmpty: CapabilityMatrixDb = {
      query: <T = Record<string, unknown>>(sql: string): T[] =>
        (sql.includes('sqlite_master') ? [{ name: 'perf_sample' }] : []) as unknown as T[],
    };

    expect(offlineCapabilities(tableDb(['frame_slice']), {}, perfWithRows)
      .has('perf.samples')).toBe(true);
    // The table exists but holds no samples: an empty capture is not a
    // capability, so the analyzer degrades instead of reporting a quiet app.
    expect(offlineCapabilities(tableDb(['frame_slice']), {}, perfEmpty)
      .has('perf.samples')).toBe(false);
    // No perf database at all.
    expect(offlineCapabilities(tableDb(['frame_slice']), {})
      .has('perf.samples')).toBe(false);
  });

  it('reads perf samples from the perf database, not the trace database', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-perfdb-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      // A decoy `perf_sample` in the trace database: a hiperf capture lives in
      // the scene's own perf.db, so the trace copy must never grant the
      // capability. Seed a row here so "the table exists and has rows" is not
      // the reason it is ignored.
      const raw = new DatabaseSync(join(parent, 'trace.db'));
      raw.exec('CREATE TABLE perf_sample(id INT, thread_id INT)');
      raw.exec('INSERT INTO perf_sample VALUES (0, 42)');
      raw.close();

      const perfState = async (): Promise<Record<string, unknown> | undefined> => {
        const result = await realDeps('0.0.0').query({
          sceneDir: parent,
          name: 'caps.get',
          args: { ids: ['perf.samples'] },
        });
        return result.rows[0] as Record<string, unknown> | undefined;
      };

      // Only the decoy exists: no capability.
      expect(await perfState()).toMatchObject({ id: 'perf.samples', available: false });

      const perf = new DatabaseSync(join(parent, 'perf.db'));
      perf.exec('CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,' +
        ' thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT,' +
        ' cpu_id INT, thread_state TEXT)');
      // Single-quoted: SQLite reads a double-quoted token as an identifier.
      perf.exec("INSERT INTO perf_sample VALUES (0, 0, 1, 42, 1, 0, 1, 0, '-')");
      perf.close();

      // The scene's perf.db now holds a sample, so the capability appears.
      expect(await perfState()).toMatchObject({ id: 'perf.samples', available: true });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 2, item 1: a scene.json that exists but cannot be read is a
  // corrupt descriptor, not "no metadata". Only a genuinely absent file means
  // a legacy hand-built scene whose procfs.jsonl we may trust.
  async function analyzeWithMeta(meta: string | undefined): Promise<string[]> {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-cli-corrupt-'));
    try {
      createTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'procfs.jsonl'), procfsSample);
      if (meta !== undefined) writeFileSync(join(parent, 'scene.json'), meta);
      const result = await realDeps('0.0.0').analyze(parent);
      return result.metrics.map((m) => m.id);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  it('does not grant procfs for malformed scene.json JSON', async () => {
    const ids = await analyzeWithMeta('{ not json');
    expect(ids).toContain('memory.degraded');
    expect(ids.some((id) => id.startsWith('mem.'))).toBe(false);
  });

  it('does not grant procfs for a wrong-version scene.json', async () => {
    const ids = await analyzeWithMeta(JSON.stringify({
      version: 2, app: { packageName: 'x', processNames: ['x'] },
      pids: [], deviceId: 't1',
      capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace', 'procfs'] },
    }));
    expect(ids).toContain('memory.degraded');
    expect(ids.some((id) => id.startsWith('mem.'))).toBe(false);
  });

  it('does not grant procfs for a valid scene.json without capture', async () => {
    const ids = await analyzeWithMeta(JSON.stringify({
      version: 1, app: { packageName: 'x', processNames: ['x'] },
      pids: [], deviceId: 't1',
    }));
    expect(ids).toContain('memory.degraded');
    expect(ids.some((id) => id.startsWith('mem.'))).toBe(false);
  });

  it('trusts procfs.jsonl when scene.json is genuinely absent (positive control)', async () => {
    const ids = await analyzeWithMeta(undefined);
    expect(ids).not.toContain('memory.degraded');
    expect(ids.some((id) => id.startsWith('mem.'))).toBe(true);
  });

  // I1: scene.json is the identity source when --app is omitted.
  it('resolves the app from scene.json exactly as an explicit --app does', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-appmeta-'));
    try {
      createFullTraceDb(
        join(parent, 'trace.db'),
        "(0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)",
      );
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
      }));

      const fromScene = await realDeps('0.0.0').analyze(parent);
      // A separate directory with no scene.json, app supplied explicitly.
      const plain = mkdtempSync(join(tmpdir(), 'ohosperf-appplain-'));
      try {
        createFullTraceDb(
          join(plain, 'trace.db'),
          "(0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)",
        );
        const fromApp = await realDeps('0.0.0').analyze(plain, 'com.demo');
        expect(fromScene.metrics.map((m) => [m.id, m.value])).toEqual(
          fromApp.metrics.map((m) => [m.id, m.value]),
        );
      } finally {
        rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('uses scene.json pids when the named app is absent from process', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-appmeta-pids-'));
    try {
      // No process row for com.ghost, but the descriptor carries a real pid.
      createFullTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.ghost', processNames: ['com.ghost'] },
        pids: [42], deviceId: 't1',
      }));

      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      // Binder ran with pids [42] instead of taking the no-app-pid branch.
      expect(ids).toContain('binder.transactions.count');
      const evidence = result.evidence as unknown as ReadonlyArray<{ explain: string }>;
      const noAppPid = evidence.filter((e) => /no app pid/.test(e.explain));
      expect(noAppPid).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('emits three no-app-pid no_data items with no scene.json and no --app', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-appmeta-none-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      const result = await realDeps('0.0.0').analyze(parent);

      const evidence = result.evidence as unknown as ReadonlyArray<{ explain: string }>;
      const noAppPid = evidence.filter((e) => /no app pid/.test(e.explain));
      expect(noAppPid).toHaveLength(3);
      const explains = noAppPid.map((e) => e.explain).sort();
      expect(explains.some((text) => /fault-tree metrics skipped/.test(text))).toBe(true);
      expect(explains.some((text) => /binder analysis skipped/.test(text))).toBe(true);
      expect(explains.some((text) => /thread analysis skipped/.test(text))).toBe(true);

      const ids = result.metrics.map((m) => m.id);
      expect(ids).not.toContain('binder.transactions.count');
      expect(ids.some((id) => /^fault\.(arkui|av_codec|Audio)\./.test(id))).toBe(false);
      expect(ids.some((id) => id.startsWith('thread.'))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // I2: a capability must not be claimed for a trace missing one of the
  // tables its analyzers read unguarded. `callstack` + an empty `process`
  // (the standard scene shape) but no `args`/`data_dict`/`thread`/`trace_range`
  // used to grant trace.binder (keyed on `callstack` alone), and the analyzer
  // then crashed on the first missing table instead of degrading.
  it('degrades binder and fault-tree when the binder table set is incomplete', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-tablegating-'));
    try {
      createTableSetDb(join(parent, 'trace.db'), [
        'callstack', 'frame_slice', 'process',
      ]);
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      expect(ids).toContain('binder.degraded');
      expect(ids).toContain('fault-tree.degraded');

      const evidence = result.evidence as unknown as ReadonlyArray<{
        kind: string;
        explain: string;
      }>;
      const degraded = evidence.filter((e) => e.kind === 'degraded_capability');
      expect(degraded.some((e) => /trace\.binder/.test(e.explain))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('degrades frames when frame_slice is absent but the binder tables exist', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-tablegating-frames-'));
    try {
      createTableSetDb(join(parent, 'trace.db'), [
        'callstack', 'args', 'data_dict', 'process', 'thread', 'trace_range',
      ]);
      const result = await realDeps('0.0.0').analyze(parent);
      const ids = result.metrics.map((m) => m.id);
      // trace.binder is fully satisfied, so binder runs; trace.frames is not.
      expect(ids).toContain('frames.degraded');
      expect(ids).not.toContain('binder.degraded');
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 2 (R1): a scene with no `process` table used to exit 1 with a
  // raw `no such table: process`, because app resolution runs `byName` before
  // the offline capability matrix can degrade anything. With the query-layer
  // guard, the literal round-1 scenario (callstack + frame_slice only, with an
  // explicit --app) succeeds and degrades the app-scoped analyzers.
  it('succeeds with degraded binder/fault-tree on a scene with no process table', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-no-process-'));
    try {
      createTableSetDb(join(parent, 'trace.db'), ['callstack', 'frame_slice']);
      const result = await realDeps('0.0.0').analyze(parent, 'com.demo');
      const ids = result.metrics.map((m) => m.id);
      expect(ids).toContain('binder.degraded');
      expect(ids).toContain('fault-tree.degraded');
      // No raw SQL error surfaced as an exception or a thrown analyzer.
      expect(result.metrics.every((m) => Number.isFinite(m.value))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('realDeps().collect', () => {
  it('forwards --target to the device connector', async () => {
    // `emulator list --json` prints a target id, and `collect --target` is the
    // handoff that consumes it. The CLI test stops at the CliDeps boundary, so
    // this is the only place that proves the id reaches `connect()`.
    const asked: (string | undefined)[] = [];
    const deps = realDeps('0.0.0', {
      collectDevice: async (target) => {
        asked.push(target);
        return {
          id: target ?? 'first',
          kind: 'emulator',
          collect: async () => ({ ingest: async () => ({ close: () => {} } as unknown as Scene) }),
        };
      },
    });
    await deps.collect({ durationMs: 10_000, out: 'scene', target: '127.0.0.1:5555' });
    await deps.collect({ durationMs: 10_000, out: 'scene' });
    expect(asked).toEqual(['127.0.0.1:5555', undefined]);
  });

  it('forwards --target to the gesture connector', async () => {
    // A gesture that lands on the wrong attached device is invisible in the
    // output: the tool prints the same `No Error` either way.
    const asked: (string | undefined)[] = [];
    const deps = realDeps('0.0.0', {
      gestureDevice: async (target) => {
        asked.push(target);
        return { id: target ?? 'first', gesture: async (g) => ({ gesture: g, output: 'No Error' }) };
      },
    });
    const gesture = { action: 'key', key: 'Home' } as const;
    await deps.gesture({ gesture, target: '127.0.0.1:5555' });
    await deps.gesture({ gesture });
    expect(asked).toEqual(['127.0.0.1:5555', undefined]);
  });

  it('forwards the hiprofiler plugin list to device.collect', async () => {
    const seen: unknown[] = [];
    const deps = realDeps('0.0.0', {
      collectDevice: async () => ({
        id: 't1',
        kind: 'emulator',
        collect: async (opts: unknown) => {
          seen.push(opts);
          return { ingest: async () => ({ close: () => {} } as unknown as Scene) };
        },
      }),
    });
    await deps.collect({
      app: 'com.demo',
      durationMs: 10_000,
      out: 'hipro-scene',
      hiprofiler: { plugins: ['gpu', 'xpower'] },
    });
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      sceneRoot: resolve('hipro-scene'),
      hiprofiler: { plugins: ['gpu', 'xpower'] },
    }]);
  });

  it('forwards the thermal request and reports its sample count from scene.json', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-collect-thermal-'));
    try {
      const seen: unknown[] = [];
      const deps = realDeps('0.0.0', {
        collectDevice: async () => ({
          id: 't1',
          kind: 'emulator',
          collect: async (opts: unknown) => {
            seen.push(opts);
            return {
              ingest: async () => {
                writeFileSync(join(parent, 'scene.json'), JSON.stringify({
                  version: 1,
                  app: { packageName: 'com.demo', processNames: ['com.demo'] },
                  pids: [], deviceId: 't1',
                  capture: {
                    startedAtMs: 0, durationMs: 10_000,
                    collectors: ['hitrace', 'thermal'], thermal: { samples: 3 },
                  },
                }));
                return { close: () => {} } as unknown as Scene;
              },
            };
          },
        }),
      });
      const result = await deps.collect({
        durationMs: 10_000, out: parent, thermal: { intervalMs: 1000 },
      });
      expect(seen).toEqual([{
        app: undefined,
        durationMs: 10_000,
        sceneRoot: resolve(parent),
        thermal: { intervalMs: 1000 },
      }]);
      expect(result.thermal).toEqual({ samples: 3 });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

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
      hiperf: { frequency: 500 }, hidumper: true, uitest: true,
    });
    // No scene.json exists beside the fake scene, so the collectors list is
    // empty rather than invented: the output reports what the descriptor says.
    expect(result).toEqual({
      sceneDir: resolve('relative-scene'),
      device: { id: 't1', kind: 'emulator' },
      collectors: [],
    });
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      sceneRoot: resolve('relative-scene'),
      procfs: true,
      coldStart: { ability: 'EntryAbility' },
      hiperf: { frequency: 500 },
      hidumper: true,
      uitest: true,
    }]);
    expect(closed).toBe(true);
  });

  it('forwards the screenshot flag and reports its dimensions from scene.json', async () => {
    const seen: unknown[] = [];
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-collect-shot-'));
    try {
      const deps = realDeps('0.0.0', {
        collectDevice: async () => ({
          id: 't1',
          kind: 'emulator',
          collect: async (opts: unknown) => {
            seen.push(opts);
            return {
              ingest: async () => {
                writeFileSync(join(parent, 'scene.json'), JSON.stringify({
                  version: 1,
                  app: { packageName: '', processNames: [] },
                  pids: [], deviceId: 't1',
                  capture: {
                    startedAtMs: 1, durationMs: 2,
                    collectors: ['hitrace', 'screenshot'],
                    screenshot: { width: 5, height: 3, bytes: 100 },
                  },
                }));
                return { close: () => {} } as unknown as Scene;
              },
            };
          },
        }),
      });
      const result = await deps.collect({ durationMs: 10_000, out: parent, screenshot: true });
      expect(seen).toEqual([{
        durationMs: 10_000, sceneRoot: parent, screenshot: true,
      }]);
      expect(result.screenshot).toEqual({ width: 5, height: 3 });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reports the collectors and capture counts written to scene.json', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-collect-out-'));
    try {
      const deps = realDeps('0.0.0', {
        collectDevice: async () => ({
          id: 't1',
          kind: 'emulator',
          collect: async () => ({
            ingest: async () => {
              // The real collectors write these before ingest; the output must
              // come from the descriptor, not from the request flags.
              writeFileSync(join(parent, 'scene.json'), JSON.stringify({
                version: 1,
                app: { packageName: 'com.demo', processNames: ['com.demo'] },
                pids: [], deviceId: 't1',
                capture: {
                  startedAtMs: 1, durationMs: 2,
                  collectors: ['hitrace', 'hiperf', 'hidumper', 'uitest'],
                  hiperf: { samples: 150 },
                  hidumper: { frames: 0 },
                  uitest: { nodes: 2 },
                },
              }));
              writeFileSync(join(parent, 'ui.json'), JSON.stringify({
                attributes: { type: 'root' },
                children: [{ attributes: { type: 'text', text: 'a' }, children: [] }],
              }));
              return { close: () => {} } as unknown as Scene;
            },
          }),
        }),
      });
      const result = await deps.collect({
        app: 'com.demo', durationMs: 10_000, out: parent,
        hiperf: {}, hidumper: true, uitest: true,
      });
      expect(result).toEqual({
        sceneDir: parent,
        device: { id: 't1', kind: 'emulator' },
        collectors: ['hitrace', 'hiperf', 'hidumper', 'uitest'],
        hiperf: { samples: 150 },
        // A zero-frame render capture is reported, not dropped: the descriptor
        // recorded the collector ran and saw nothing.
        hidumper: { frames: 0 },
        ui: { nodes: 2 },
      });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reports the hilog line count written to scene.json', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-collect-hilog-'));
    try {
      const seen: unknown[] = [];
      const deps = realDeps('0.0.0', {
        collectDevice: async () => ({
          id: 't1',
          kind: 'emulator',
          collect: async (opts: unknown) => {
            seen.push(opts);
            return {
              ingest: async () => {
                writeFileSync(join(parent, 'scene.json'), JSON.stringify({
                  version: 1,
                  app: { packageName: 'com.demo', processNames: ['com.demo'] },
                  pids: [], deviceId: 't1',
                  capture: {
                    startedAtMs: 1, durationMs: 2,
                    collectors: ['hitrace', 'hilog'], hilog: { lines: 42 },
                  },
                }));
                return { close: () => {} } as unknown as Scene;
              },
            };
          },
        }),
      });
      const result = await deps.collect({ durationMs: 10_000, out: parent, hilog: true });
      expect(seen).toEqual([{ durationMs: 10_000, sceneRoot: parent, hilog: true }]);
      expect(result).toEqual({
        sceneDir: parent,
        device: { id: 't1', kind: 'emulator' },
        collectors: ['hitrace', 'hilog'],
        hilog: { lines: 42 },
      });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('realDeps().capsReport', () => {
  it('forwards --target to the device connector', async () => {
    // `caps --target X` must probe X, and no flag must keep the old
    // first-connected-target behaviour.
    const asked: (string | undefined)[] = [];
    const deps = realDeps('0.0.0', {
      connectDevice: async (target) => {
        asked.push(target);
        return { id: 't1', kind: 'emulator', abi: 'x86_64', capabilities: async () => ({ all: () => [] }) };
      },
      hdc: { resolvePath: async () => '/hdc' },
    });
    await deps.capsReport('127.0.0.1:5555');
    await deps.capsReport();
    expect(asked).toEqual(['127.0.0.1:5555', undefined]);
  });

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

describe('realDeps().query', () => {
  it('runs a named query and closes the scene it opened', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      const r = await realDeps('0.0.0').query({
        sceneDir: parent,
        name: 'frames.all',
        args: { window: { startNs: 0, endNs: 2000 } },
      });
      expect(r.rows).toHaveLength(1);
      expect(r.total).toBe(1);
      // An unclosed SQLite handle blocks this on Windows.
      rmSync(parent, { recursive: true });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('answers ui.get from the scene\'s ui.json', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-ui-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'ui.json'), JSON.stringify({
        attributes: { type: '', bundleName: '', bounds: '[0,0][1216,2688]' },
        children: [
          {
            attributes: {
              type: 'Image', bundleName: 'com.demo', abilityName: 'EntryAbility',
              bounds: '[10,200][300,500]', text: '', id: '',
              clickable: 'true', enabled: 'true', scrollable: 'false',
            },
            children: [],
          },
        ],
      }));

      const all = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'ui.get', args: {},
      });
      expect(all.total).toBe(2);
      const mine = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'ui.get', args: { bundleName: 'com.demo' },
      });
      expect(mine.rows).toEqual([expect.objectContaining({ type: 'Image', depth: 1 })]);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a ui.json that scene.json does not list', async () => {
    // A re-capture without --uitest leaves the previous tree behind. The
    // descriptor is the authority, so the stale tree must not answer ui.get.
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-uistale-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'ui.json'), JSON.stringify({
        attributes: { type: 'Root' },
        children: [{ attributes: { type: 'Stale' }, children: [] }],
      }));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));
      const r = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'ui.get', args: {},
      });
      expect(r).toMatchObject({ rows: [], total: 0, truncated: false });
      const caps = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'caps.get', args: { ids: ['ui.tree'] },
      });
      expect(caps.rows[0]).toMatchObject({ id: 'ui.tree', available: false });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('returns no ui.get rows for a scene without ui.json', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-noui-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      const r = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'ui.get', args: {},
      });
      expect(r).toMatchObject({ rows: [], total: 0, truncated: false });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('answers hilog.matches from the scene\'s hilog.log', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-hilog-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'hilog.log'), [
        '11-17 05:12:10.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 1 us',
        '11-17 05:12:11.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 4, cost 2 us',
        '',
      ].join('\n'));
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: {
          startedAtMs: Date.UTC(2026, 10, 17, 5, 12), durationMs: 10_000,
          collectors: ['hitrace', 'hilog'], hilog: { lines: 2 },
        },
      }));

      const r = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'hilog.matches', args: { rule: 'no_dmp' },
      });
      expect(r.rows).toEqual([expect.objectContaining({ ruleName: 'no_dmp', lineIndex: 0 })]);

      const rules = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'hilog.rules', args: {},
      });
      expect(rules.rows).toContainEqual({ name: 'no_dmp', count: 1 });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('ignores a hilog.log that scene.json does not list', async () => {
    // Same staleness rule as every other scene artifact: the descriptor is the
    // authority, so a re-capture without --hilog must not answer hilog queries.
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-hilogstale-'));
    try {
      createFullTraceDb(join(parent, 'trace.db'));
      writeFileSync(join(parent, 'hilog.log'),
        '11-17 05:12:10.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 1 us\n');
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));
      const r = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'hilog.matches', args: {},
      });
      expect(r).toMatchObject({ rows: [], total: 0, truncated: false });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects an unknown query name before opening the scene', async () => {
    await expect(realDeps('0.0.0').query({
      sceneDir: join(tmpdir(), 'ohosperf-does-not-exist'),
      name: 'nope',
    })).rejects.toThrow(/unknown query "nope"; available: .*frames\.get/);
  });

  it('rejects malformed arguments before opening the scene', async () => {
    await expect(realDeps('0.0.0').query({
      sceneDir: join(tmpdir(), 'ohosperf-does-not-exist'),
      name: 'frames.get',
      args: {},
    })).rejects.toThrow(/frames\.get: missing number argument "id"/);
  });

  it('resolves the app from scene.json, lets --app win, and fabricates no pids', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-app-'));
    try {
      // createFullTraceDb already creates process/thread/callstack/args/
      // data_dict and one frame row; seed one completed binder transaction
      // through a raw handle (the helper only exposes `processRows`).
      createFullTraceDb(
        join(parent, 'trace.db'),
        "(0, 17, 5000, 'com.demo', 0, 0, 1, 0, 0), "
        + "(1, 200, 6000, 'render_service', 0, 0, 1, 0, 0)",
      );
      const raw = new DatabaseSync(join(parent, 'trace.db'));
      raw.exec(`
        INSERT INTO thread VALUES
          (10, 5000, 5000, 'main', 0, 0, 17, 1, 0),
          (20, 6001, 6001, 'RSThread', 0, 0, 200, 0, 0);
        INSERT INTO data_dict VALUES
          (1, 'transaction id'), (2, 'calling tid'), (3, 'code'),
          (4, 'destination process');
        INSERT INTO args VALUES
          (1, 1, 0, 1, 1), (2, 2, 0, 5000, 1), (3, 3, 1, 100, 1),
          (4, 1, 0, 1, 2), (5, 4, 0, 5000, 2), (6, 3, 1, 102, 2);
        INSERT INTO callstack VALUES
          (1, 1000000000, 0, 10, 'binder', 'H:binder transaction', 0, 0, 0, 1,
           '', '', '', '', '', '', '', '', 0),
          (2, 1002000000, 0, 20, 'binder', 'H:binder reply', 0, 0, 0, 2,
           '', '', '', '', '', '', '', '', 0);
      `);
      raw.close();

      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [], deviceId: 't1', startedAtNs: 1_000_000_000,
      }));
      const fromMeta = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'binder.processStats',
      });
      expect(fromMeta.rows).toEqual([
        expect.objectContaining({
          callerProc: 'com.demo', calleeProc: 'render_service', count: 1,
        }),
      ]);

      // An explicit --app must win over a descriptor that names a different,
      // absent app; deleting scene.json would only prove the flag works when
      // there is nothing to conflict with.
      writeFileSync(join(parent, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'com.other', processNames: ['com.other'] },
        pids: [9999], deviceId: 't1',
        capture: { startedAtMs: 0, durationMs: 1, collectors: ['hitrace'] },
      }));
      const fromFlag = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'binder.processStats', app: 'com.demo',
      });
      expect(fromFlag.rows).toHaveLength(1);
      rmSync(join(parent, 'scene.json'));

      const withoutApp = await realDeps('0.0.0').query({
        sceneDir: parent, name: 'binder.processStats',
      });
      expect(withoutApp).toMatchObject({ rows: [], total: 0 });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('exposes the same sorted tool list as the registry', () => {
    expect(realDeps('0.0.0').tools().map((t) => t.name)).toEqual([
      'binder.processStats', 'callstack.matching', 'callstack.range', 'caps.get',
      'frame.load.files', 'frame.load.symbols', 'frame.load.threads',
      'frames.all', 'frames.fpsSeries', 'frames.get',
      'hilog.around', 'hilog.matches', 'hilog.rules',
      'mem.native.callchain', 'mem.native.categories', 'mem.native.timeline',
      'mem.native.unreleased',
      'symbol.stats', 'threads.pattern', 'ui.get', 'ui.tree',
    ]);
  });
});

describe('realDeps().compare', () => {
  /** A scene whose single frame row is the only metric input compare reads. */
  function scene(parent: string, ts: number): void {
    createTraceDb(join(parent, 'trace.db'));
    const raw = new DatabaseSync(join(parent, 'trace.db'));
    raw.exec(`UPDATE frame_slice SET ts = ${ts}`);
    raw.close();
  }

  it('compares two scene directories through the same analyzer path as analyze', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-compare-dirs-'));
    try {
      const base = join(parent, 'base');
      const cur = join(parent, 'cur');
      mkdirSync(base);
      mkdirSync(cur);
      scene(base, 1000);
      scene(cur, 2000);

      const c = await realDeps('0.0.0').compare({ baseline: base, current: cur });
      // Both scenes have the same table shape, so every id is present on both
      // sides and nothing is added or removed.
      expect(c.totals.added).toBe(0);
      expect(c.totals.removed).toBe(0);
      expect(c.rows.map((row) => row.id)).toEqual(
        [...c.rows.map((row) => row.id)].sort(),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reads analyze --json files as inputs', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-compare-files-'));
    try {
      const write = (name: string, metrics: unknown[]): string => {
        const path = join(parent, name);
        writeFileSync(path, JSON.stringify({ metrics, evidence: [] }));
        return path;
      };
      const metric = (value: number) => ({
        id: 'frame.jank.rate', value, unit: 'count', fidelity: 'exact',
        provenance: { collector: 'test', device: 'd' },
      });
      const c = await realDeps('0.0.0').compare({
        baseline: write('a.json', [metric(40)]),
        current: write('b.json', [metric(30)]),
      });
      expect(c.rows).toEqual([expect.objectContaining({
        id: 'frame.jank.rate', delta: -10, status: 'improved',
      })]);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects a file that is not an analyze --json document', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ohosperf-compare-bad-'));
    try {
      const path = join(parent, 'bad.json');
      writeFileSync(path, '{"rows":[]}');
      await expect(realDeps('0.0.0').compare({ baseline: path, current: path }))
        .rejects.toMatchObject({ code: 'COMPARE_BAD_INPUT' });
      const notJson = join(parent, 'not.json');
      writeFileSync(notJson, '{ not json');
      await expect(realDeps('0.0.0').compare({ baseline: notJson, current: notJson }))
        .rejects.toMatchObject({ code: 'COMPARE_BAD_INPUT' });
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('fails on a path that is neither a scene nor a file', async () => {
    await expect(realDeps('0.0.0').compare({
      baseline: join(tmpdir(), 'ohosperf-does-not-exist.json'),
      current: join(tmpdir(), 'ohosperf-does-not-exist.json'),
    })).rejects.toMatchObject({ code: 'COMPARE_BAD_INPUT' });
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

describe('realDeps().explore', () => {
  /** A virtual clock, so a settle costs no real time. */
  function clock(): { now(): number; sleep(ms: number): Promise<void>; slept: number[] } {
    let at = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => at,
      sleep: async (ms) => {
        slept.push(ms);
        at += ms;
      },
    };
  }

  const node = (
    overrides: Partial<UiNode> & { bounds: string },
  ): UiNode => ({
    depth: 1, type: 'Button', bundleName: 'com.demo', abilityName: 'Main',
    text: '', id: '', clickable: true, enabled: true, scrollable: false,
    children: 0, ...overrides,
  });

  const screen = (bounds: string): UiNode[] => [
    node({ id: 'root', bounds: '[0,0][100,100]', clickable: false }),
    node({ id: 'b', bounds }),
  ];
  /** A screen with nothing left to tap. */
  const terminal = (): UiNode[] => [
    node({ id: 'root', bounds: '[0,0][100,100]', clickable: false }),
  ];

  it('reports states reached, not taps spent', async () => {
    // Two screens, one tap each, then the walk is exhausted. The back it tries
    // from the dead end moves nothing, so it is recorded as no change rather
    // than as progress toward a third screen.
    let current = screen('[0,0][10,10]');
    const deps = realDeps('0.0.0', {
      exploreClock: clock(),
      exploreDevice: async () => ({
        id: 'emu-1',
        kind: 'emulator',
        uiTree: async () => current,
        gesture: async (g) => {
          current = terminal();
          return { gesture: g, output: 'No Error' };
        },
      }),
    });
    const result = await deps.explore({ app: 'com.demo', maxSteps: 10, strategy: 'depth_first' });
    expect(result.device).toEqual({ id: 'emu-1', kind: 'emulator' });
    expect(result.steps).toBe(2);
    expect(result.navigated).toBe(1);
    expect(result.noChange).toBe(1);
    expect(result.backs).toBe(1);
    expect(result.statesReached).toBe(2);
    expect(result.exhausted).toBe(true);
  });

  it('counts a dead tap as no change rather than progress', async () => {
    const current = screen('[0,0][10,10]');
    const deps = realDeps('0.0.0', {
      exploreClock: clock(),
      exploreDevice: async () => ({
        id: 'emu-1',
        kind: 'emulator',
        uiTree: async () => current,
        gesture: async (g) => ({ gesture: g, output: 'No Error' }),
      }),
    });
    const result = await deps.explore({ app: 'com.demo', maxSteps: 10, strategy: 'depth_first' });
    expect(result.navigated).toBe(0);
    expect(result.noChange).toBe(1);
    expect(result.statesReached).toBe(1);
  });

  it('records the seed a random walk used, so the order can be replayed', async () => {
    const current = screen('[0,0][10,10]');
    const deps = realDeps('0.0.0', {
      exploreClock: clock(),
      exploreDevice: async () => ({
        id: 'emu-1',
        kind: 'emulator',
        uiTree: async () => current,
        gesture: async (g) => ({ gesture: g, output: 'No Error' }),
      }),
    });
    const result = await deps.explore({ app: 'com.demo', maxSteps: 2, strategy: 'random', seed: 11 });
    expect(result.seed).toBe(11);
  });

  it('forwards --target to the device resolver', async () => {
    const asked: Array<string | undefined> = [];
    const deps = realDeps('0.0.0', {
      exploreClock: clock(),
      exploreDevice: async (target) => {
        asked.push(target);
        return {
          id: target ?? 'first',
          kind: 'emulator',
          uiTree: async () => screen('[0,0][10,10]'),
          gesture: async (g) => ({ gesture: g, output: 'No Error' }),
        };
      },
    });
    await deps.explore({ app: 'com.demo', maxSteps: 1, strategy: 'depth_first', target: 'emu-9' });
    expect(asked).toEqual(['emu-9']);
  });
});

describe('realDeps().opt', () => {
  it('reads a bare .so and reports its instruction mix and verdict', async () => {
    // The seam takes a path and reads it, so this exercises the real ELF
    // reader and the real analyzer over bytes written to disk.
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-cli--opt-'));
    try {
      const path = join(dir, 'libdemo.so');
      writeFileSync(path, makeElf64([
        { name: '.text', type: 1, flags: 6, data: text(...Array.from({ length: 40 }, () => OP.vector), ...Array.from({ length: 60 }, () => OP.add)) },
        {
          name: '.symtab',
          symbols: [
            { name: 'main', bind: 1, type: 2, size: 32 },
            { name: 'lto_priv.0.abc', bind: 0, type: 2, size: 16 },
          ],
        },
      ]));
      const result = await realDeps('0.0.0').opt({ packagePath: path });
      expect(result.analysis.totals).toMatchObject({ binaries: 1, lto: 1 });
      const binary = result.analysis.binaries[0]!;
      expect(binary.verdict).toMatchObject({ level: 'high', basis: 'inferred' });
      expect(binary.facts.instructions.total).toBe(100);
      expect(result.analysis.metrics.find((m) => m.id === 'binary.instructions.count')?.value).toBe(100);
      expect(result.capabilities[0]?.id).toBe('static.hap');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the arm64 libraries out of a package', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-cli--opthap-'));
    try {
      const path = join(dir, 'demo.hap');
      const lib = makeElf64([{ name: '.text', type: 1, flags: 6, data: text(OP.ret, OP.bl) }]);
      writeFileSync(path, makeZip([
        { name: 'module.json', data: new TextEncoder().encode('{}') },
        { name: 'libs/arm64/liba.so', data: lib, method: 0 },
        { name: 'libs/arm64/libb.so', data: lib, method: 0 },
      ]));
      const result = await realDeps('0.0.0').opt({ packagePath: path });
      expect(result.analysis.binaries.map((b) => b.path))
        .toEqual(['libs/arm64/liba.so', 'libs/arm64/libb.so']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('realDeps().analyze with a supplied coverage report', () => {
  it('reads coverageReport.json from the scene and reports it as approximate', async () => {
    // bjc writes this file; nothing here produces it. A scene that carries one
    // gets coverage metrics naming the file, and a scene that does not gets a
    // no_data item — the distinction HapRay's silent skip cannot make.
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-cli--cov-'));
    try {
      createTraceDb(join(root, 'trace.db'));
      writeFileSync(
        join(root, 'coverageReport.json'),
        JSON.stringify({
          date: '2026-11-17T10:00:00.000Z',
          summary: {
            lines: { total: 400, covered: 300, pct: 75 },
            functions: { total: 40, covered: 30, pct: 75 },
            branches: { total: 80, covered: 40, pct: 50 },
          },
          files: [
            {
              path: 'entry/src/main/ets/pages/Index.ets',
              summary: {
                lines: { total: 400, covered: 300, pct: 75 },
                functions: { total: 40, covered: 30, pct: 75 },
                branches: { total: 80, covered: 40, pct: 50 },
              },
            },
          ],
        }),
      );
      const result = await realDeps('0.0.0').analyze(root);
      // `AnalyzeOutput` is the narrow view the renderer needs; `provenance` is
      // on the metric the implementation actually returns, so the test reads it
      // through the same widening cast this file uses for `explain`.
      const lines = result.metrics.find((m) => m.id === 'coverage.lines.percent') as
        | { value: number | string; fidelity: string; provenance: { collector: string } }
        | undefined;
      expect(lines?.value).toBe(75);
      expect(lines?.fidelity).toBe('approximate');
      expect(lines?.provenance.collector).toBe('scene:coverageReport.json');
      expect(result.evidence.some((item) => item.kind === 'coverage')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no coverage data, with a reason, when the scene has no report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-cli--nocov-'));
    try {
      createTraceDb(join(root, 'trace.db'));
      const result = await realDeps('0.0.0').analyze(root);
      const noData = result.evidence.find(
        (item) => item.kind === 'no_data' &&
          (item as unknown as { explain: string }).explain.includes('coverageReport.json'),
      );
      expect(noData).toBeDefined();
      expect(result.metrics.some((m) => m.id.startsWith('coverage.'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('realDeps().analyze with a supplied heap snapshot', () => {
  /** Two objects of 64 and 32 bytes under the root, one detached. */
  function heap(): string {
    return JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
          node_types: [
            ['hidden', 'array', 'string', 'object'],
            'string', 'number', 'number', 'number', 'number',
          ],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [
            ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
            'string_or_number', 'node',
          ],
        },
        node_count: 3,
        edge_count: 2,
      },
      nodes: [0, 0, 1, 0, 2, 0, 3, 1, 2, 64, 0, 2, 3, 2, 3, 32, 0, 1],
      edges: [2, 1, 6, 2, 2, 12],
      strings: ['', 'A', 'B'],
    });
  }

  it('analyzes a scene\'s snapshot and reports the heap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-cli--heap-'));
    try {
      createTraceDb(join(root, 'trace.db'));
      writeFileSync(join(root, 'jsheap.heapsnapshot'), heap());
      const result = await realDeps('0.0.0').analyze(root);
      const total = result.metrics.find((m) => m.id === 'jsheap.total.bytes') as
        | { value: number | string; fidelity: string; provenance: { collector: string } }
        | undefined;
      expect(total?.value).toBe(96);
      expect(total?.fidelity).toBe('exact');
      expect(total?.provenance.collector).toBe('scene:jsheap.heapsnapshot');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores a snapshot the scene descriptor does not declare', async () => {
    // A `jsheap.heapsnapshot` left by an earlier capture must not be reported
    // as this scene's heap: `scene.json` is the authority on what ran.
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-cli--staleheap-'));
    try {
      createTraceDb(join(root, 'trace.db'));
      writeFileSync(join(root, 'jsheap.heapsnapshot'), heap());
      writeFileSync(
        join(root, 'scene.json'),
        JSON.stringify({
          schemaVersion: '1',
          app: { packageName: 'com.demo', processNames: ['com.demo'] },
          pids: [1],
          capture: { startedAtMs: 0, durationMs: 1000, collectors: ['hitrace'] },
        }),
      );
      const result = await realDeps('0.0.0').analyze(root);
      expect(result.metrics.some((m) => m.id.startsWith('jsheap.'))).toBe(false);
      const noData = result.evidence.find(
        (item) => item.kind === 'no_data' &&
          (item as unknown as { explain: string }).explain.includes('jsheap.heapsnapshot'),
      );
      expect(noData).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
