import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';import { fileURLToPath } from 'node:url';
import type { Scene, SceneLayout } from '@ohos-perf/core';
import {
  manifestPath, offlineCapabilities, packageVersion, realDeps,
  type CapabilityMatrixDb,
} from '../src/deps';

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
      const matrix = offlineCapabilities(fakeDb(['sched_slice', 'frame_slice']), []);
      expect(matrix.has('trace.sched')).toBe(false);
      expect(matrix.get('trace.sched')).toBeUndefined();
      const both = offlineCapabilities(fakeDb(['sched_slice', 'instant']), []);
      expect(both.has('trace.sched')).toBe(true);

      // I2: trace.binder is gated on the full unguarded table set. One missing
      // table (args) must drop the capability rather than let the analyzer run
      // and crash on `no such table`.
      const binderTables = [
        'callstack', 'args', 'data_dict', 'process', 'thread', 'trace_range',
      ];
      const fullBinder = offlineCapabilities(fakeDb(binderTables), []);
      expect(fullBinder.has('trace.binder')).toBe(true);
      const minusArgs = offlineCapabilities(
        fakeDb(binderTables.filter((name) => name !== 'args')),
        [],
      );
      expect(minusArgs.has('trace.binder')).toBe(false);
      // startup.app_startup is dead: no capability row is emitted for it.
      expect(offlineCapabilities(fakeDb(['app_startup']), []).has('startup.app_startup'))
        .toBe(false);
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
