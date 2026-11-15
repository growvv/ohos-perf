import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { OhosPerfError } from '../src/errors';
import { analyzeThreadWakeup } from '../src/analyze/threads-wakeup';

const START = 1_000_000_000;
const MS = 1_000_000;

const here = dirname(fileURLToPath(import.meta.url));
const SPIKE_OUT = join(here, '../../../spike/out');
const EMU_DB = join(SPIKE_OUT, 'emu_big.db');
const REAL_DB = join(SPIKE_OUT, 'real_device.db');

/**
 * The tables every fixture needs.
 *
 * `process` and `thread` carry the full column sets `ProcessQuery.all()` and
 * `ThreadQuery.All()` select, because `analyzeThreadWakeup` reads the thread
 * start/end timestamps through `ThreadQuery`.
 */
const CORE_DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT);
  CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT);
  CREATE TABLE trace_range(start_ts INT, end_ts INT);
  CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
    ref_type TEXT, value REAL);
  CREATE TABLE thread_state(ts INT, dur INT, cpu INT, itid INT, tid INT,
    pid INT, state TEXT, arg_setid INT);
`;

const fixtureDirs: string[] = [];
let db: QueryHandle;
let missingPerfThreadDb: QueryHandle;
let frameSliceDb: QueryHandle;
let noRangeDb: QueryHandle;
let namesDb: QueryHandle;

/**
 * Two app threads and one render_service thread.
 *
 * HapRay's `analyze_all_threads_wakeup_chain` calls `find_wakeup_chain` with
 * `frame_start = range_start` and builds the instant cache over
 * `[range_start, range_end]`, so the BFS can only reach wakers at exactly the
 * range start (the two committed goldens confirm this: every chain is depth
 * 0). The wakeups therefore sit at `START`, the resolved range start.
 *
 * For itid 100 there are two wakers at the same timestamp: the system thread
 * 200 and app thread 300. The app-process preference must pick 300 even
 * though 200 sorts first in the cache; the subsequent hop then reaches 200 at
 * depth 2. The other instant rows exercise the fixed wakeup predicate.
 */
function seed(db: DatabaseSync): void {
  db.exec(CORE_DDL);
  db.exec(`
    INSERT INTO process VALUES
      (0, 10, 5000, 'com.demo', 0, 0, 2, 0, 0),
      (1, 20, 6000, 'render_service', 0, 0, 1, 0, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'app_main', NULL, NULL, 10, 1, 0),
      (300, 300, 5001, 'app_worker', ${START + 1}, 0, 10, 0, 0),
      (200, 200, 6001, 'RSUniRenderThread', NULL, NULL, 20, 0, 0);
    INSERT INTO trace_range VALUES (${START}, ${START + 10 * MS});
    INSERT INTO instant VALUES
      (${START}, 'sched_wakeup', 100, 300, 'itid', 0),
      (${START}, 'sched_wakeup', 100, 200, 'itid', 0),
      (${START}, 'sched_waking', 300, 200, 'itid', 0),
      (${START - 10 * MS}, 'sched_wakeup', 100, 999, 'itid', 0),
      (${START}, 'sched_switch', 100, 999, 'itid', 0),
      (${START}, 'sched_wakeup', 100, 999, 'cpu', 0),
      (${START}, 'sched_wakeup', 100, NULL, 'itid', 0),
      (${START}, 'sched_wakeup', NULL, 200, 'itid', 0);
    INSERT INTO thread_state VALUES
      (${START}, ${2 * MS}, 0, 100, 5000, 5000, 'R', 0),
      (${START + 4 * MS}, ${2 * MS}, 0, 100, 5000, 5000, 'S', 0),
      (${START - MS}, ${2 * MS}, 0, 300, 5001, 5000, 'R', 0),
      (${START - 2 * MS}, ${MS}, 0, 300, 5001, 5000, 'S', 0),
      (${START}, ${MS}, 0, 200, 6001, 6000, 'R', 0),
      (${START}, ${MS}, 0, 999, 5999, 5999, 'R', 0);
  `);
}

/**
 * `perf_sample` exists and has a row, but `perf_thread`/`perf_callchain`/
 * `perf_files` do not. HapRay guards each optional perf table; this fixture
 * pins that the analyzer never throws for the missing ones.
 */
function seedMissingPerfThread(db: DatabaseSync): void {
  db.exec(CORE_DDL);
  db.exec(`
    CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
      thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT,
      cpu_id INT, thread_state TEXT);
    INSERT INTO process VALUES
      (0, 10, 5000, 'com.demo', 0, 0, 1, 0, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'main', NULL, NULL, 10, 1, 0);
    INSERT INTO trace_range VALUES (${START}, ${START + 10 * MS});
    INSERT INTO instant VALUES
      (${START}, 'sched_wakeup', 100, 100, 'itid', 0);
    INSERT INTO thread_state VALUES
      (${START}, ${MS}, 0, 100, 5000, 5000, 'R', 0);
    INSERT INTO perf_sample VALUES
      (1, NULL, ${START}, 5000, 7, 1, ${START}, 0, '');
  `);
}

/**
 * No `trace_range`; the range must come from `frame_slice`, whose end is
 * extended to `max(ts + COALESCE(dur, 0))`. The state at `START + 8ms` is
 * inside the extended range and outside `[min(ts), max(ts)]`, so its presence
 * pins the extension.
 */
function seedFrameSlice(db: DatabaseSync): void {
  db.exec(CORE_DDL);
  db.exec(`
    CREATE TABLE frame_slice(ts INT, dur INT);
    INSERT INTO process VALUES
      (0, 10, 5000, 'com.demo', 0, 0, 1, 0, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'main', NULL, NULL, 10, 1, 0);
    INSERT INTO frame_slice VALUES
      (${START}, ${5 * MS}),
      (${START + 2 * MS}, ${10 * MS});
    INSERT INTO thread_state VALUES
      (${START + 2 * MS}, ${MS}, 0, 100, 5000, 5000, 'R', 0),
      (${START + 8 * MS}, ${2 * MS}, 0, 100, 5000, 5000, 'R', 0);
  `);
}

/** A database with no table from which HapRay can infer a time range. */
function seedNoRange(db: DatabaseSync): void {
  db.exec(CORE_DDL);
  db.exec(`
    DROP TABLE trace_range;
    INSERT INTO process VALUES
      (0, 10, 5000, 'com.demo', 0, 0, 1, 0, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'main', NULL, NULL, 10, 1, 0);
    INSERT INTO instant VALUES
      (${START}, 'sched_wakeup', 100, 100, 'itid', 0);
    INSERT INTO thread_state VALUES
      (${START}, ${MS}, 0, 100, 5000, 5000, 'R', 0);
  `);
}

/** Threads whose names exercise every `is_system_thread` rule. */
function seedNames(db: DatabaseSync): void {
  db.exec(CORE_DDL);
  db.exec(`
    INSERT INTO process VALUES
      (0, 10, 5000, 'com.demo', 0, 0, 7, 0, 0),
      (1, 20, 6000, 'ohos.sceneboard', 0, 0, 1, 0, 0),
      (2, 30, 7000, 'render_service', 0, 0, 1, 0, 0),
      (3, 40, 8000, 'sysmgr-main', 0, 0, 1, 0, 0),
      (4, 50, 9000, 'pbench.baseline', 0, 0, 1, 0, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'main', NULL, NULL, 10, 1, 0),
      (101, 101, 5001, 'OS_FFRT_3_0', NULL, NULL, 10, 0, 0),
      (102, 102, 5002, 'hiprofilerd_worker', NULL, NULL, 10, 0, 0),
      (103, 103, 5003, 'display_engine_render', NULL, NULL, 10, 0, 0),
      (104, 104, 5004, 'pp.worker', NULL, NULL, 10, 0, 0),
      (105, 105, 5005, 'irq/123', NULL, NULL, 10, 0, 0),
      (106, 106, 5006, 'worker', NULL, NULL, 10, 0, 0),
      (200, 200, 6000, 'main', NULL, NULL, 20, 1, 0),
      (300, 300, 7000, 'worker', NULL, NULL, 30, 1, 0),
      (400, 400, 8000, 'worker', NULL, NULL, 40, 1, 0),
      (500, 500, 9000, 'worker', NULL, NULL, 50, 1, 0);
    INSERT INTO trace_range VALUES (${START}, ${START + 10 * MS});
  `);
}

function createFixture(name: string, seedFn: (db: DatabaseSync) => void): QueryHandle {
  const fixtureDir = mkdtempSync(join(tmpdir(), `ohosperf-wakeup-${name}-`));
  fixtureDirs.push(fixtureDir);
  const path = join(fixtureDir, 't.db');
  const raw = new DatabaseSync(path);
  seedFn(raw);
  raw.close();
  return openDb(path);
}

beforeAll(() => {
  db = createFixture('primary', seed);
  missingPerfThreadDb = createFixture('perf', seedMissingPerfThread);
  frameSliceDb = createFixture('slice', seedFrameSlice);
  noRangeDb = createFixture('norange', seedNoRange);
  namesDb = createFixture('names', seedNames);
});

afterAll(() => {
  db.close();
  missingPerfThreadDb.close();
  frameSliceDb.close();
  noRangeDb.close();
  namesDb.close();
  for (const fixtureDir of fixtureDirs) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('analyzeThreadWakeup', () => {
  it('walks app1 <- app2 <- system in BFS order with depths 0, 1, 2', () => {
    const results = analyzeThreadWakeup(db, { appPids: [5000] });

    expect(results.map((r) => r.threadId)).toEqual([5000, 5001]);

    const [main, worker] = results;
    expect(main.wakeupThreads.map((w) => [w.itid, w.wakeupDepth])).toEqual([
      [100, 0],
      [300, 1],
      [200, 2],
    ]);
    // App-process wakers win over a system waker at the same timestamp.
    expect(main.wakeupThreads.map((w) => w.tid)).toEqual([5000, 5001, 6001]);
    expect(main.wakeupThreads.map((w) => w.threadName)).toEqual([
      'app_main',
      'app_worker',
      'RSUniRenderThread',
    ]);
    expect(main.wakeupThreads.map((w) => w.pid)).toEqual([5000, 5000, 6000]);
    expect(main.wakeupThreads.map((w) => w.processName)).toEqual([
      'com.demo',
      'com.demo',
      'render_service',
    ]);
    expect(main.wakeupThreads.map((w) => w.isSystemThread)).toEqual([
      false,
      false,
      true,
    ]);

    // No perf_sample table: every instruction count is zero, never undefined.
    expect(main.totalInstructions).toBe(0);
    expect(main.wakeupThreads.map((w) => w.instructionCount)).toEqual([0, 0, 0]);
    for (const thread of main.wakeupThreads) {
      expect(thread.callchains).toEqual([]);
    }

    // The chain starts at app_worker when app_worker is the subject.
    expect(worker.wakeupThreads.map((w) => [w.itid, w.wakeupDepth])).toEqual([
      [300, 0],
      [200, 1],
    ]);
  });

  it('maps the thread row start/end timestamps to null only when absent', () => {
    const [main, worker] = analyzeThreadWakeup(db, { appPids: [5000] });

    // Both columns are SQL NULL on this row: ThreadQuery reports 0, and the
    // public result exposes null rather than a bogus trace-origin timestamp.
    expect(main.threadInfo).toEqual({
      threadName: 'app_main',
      startTs: null,
      endTs: null,
    });
    // A real start_ts survives; a 0 end_ts still means absent.
    expect(worker.threadInfo).toEqual({
      threadName: 'app_worker',
      startTs: START + 1,
      endTs: null,
    });
  });

  it('keeps thread states that overlap the range, ordered by itid then ts', () => {
    const [main] = analyzeThreadWakeup(db, { appPids: [5000] });
    const [appMain, appWorker, system] = main.wakeupThreads;

    expect(appMain.threadStates).toEqual([
      { ts: START, dur: 2 * MS, state: 'R' },
      { ts: START + 4 * MS, dur: 2 * MS, state: 'S' },
    ]);
    // `[ts, ts+dur)` overlap: a state ending exactly at rangeStart is out, a
    // state straddling it is in.
    expect(appWorker.threadStates).toEqual([
      { ts: START - MS, dur: 2 * MS, state: 'R' },
    ]);
    expect(system.threadStates).toEqual([{ ts: START, dur: MS, state: 'R' }]);
    // States of a thread outside the chain never leak in.
    expect(main.wakeupThreads.some((w) => w.itid === 999)).toBe(false);
  });

  it('returns an empty array for empty app pids', () => {
    expect(analyzeThreadWakeup(db, { appPids: [] })).toEqual([]);
  });

  it('honours maxThreads before analyzing', () => {
    expect(
      analyzeThreadWakeup(db, { appPids: [5000], maxThreads: 1 }).map(
        (r) => r.threadId,
      ),
    ).toEqual([5000]);
    // HapRay treats a non-positive maxThreads as "no limit".
    expect(
      analyzeThreadWakeup(db, { appPids: [5000], maxThreads: 0 }),
    ).toHaveLength(2);
  });

  it('does not throw when perf_sample exists but perf_thread does not', () => {
    const [result] = analyzeThreadWakeup(missingPerfThreadDb, { appPids: [5000] });
    expect(result.threadId).toBe(5000);
    // The itid -> trace tid fallback still finds the sample even without
    // perf_thread, exactly as HapRay's `map_itid_to_perf_thread_id` does.
    expect(result.totalInstructions).toBe(7);
    expect(result.wakeupThreads.map((w) => w.instructionCount)).toEqual([7]);
    expect(result.wakeupThreads[0].callchains).toEqual([]);
  });

  it('infers the range from frame_slice and extends it by ts + dur', () => {
    const [result] = analyzeThreadWakeup(frameSliceDb, { appPids: [5000] });
    const states = result.wakeupThreads[0].threadStates;
    expect(states.map((state) => state.ts)).toEqual([
      START + 2 * MS,
      START + 8 * MS,
    ]);

    // An explicit range wins over the inferred one.
    const [explicit] = analyzeThreadWakeup(frameSliceDb, {
      appPids: [5000],
      timeRange: { startNs: START + 3 * MS, endNs: START + 12 * MS },
    });
    expect(explicit.wakeupThreads[0].threadStates.map((state) => state.ts)).toEqual([
      START + 8 * MS,
    ]);
  });

  it('throws THREAD_NO_TIME_RANGE when no trace table can supply one', () => {
    let error: unknown;
    try {
      analyzeThreadWakeup(noRangeDb, { appPids: [5000] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OhosPerfError);
    expect((error as OhosPerfError).code).toBe('THREAD_NO_TIME_RANGE');
  });

  it('classifies threads with HapRay system-thread keywords and prefixes', () => {
    const results = analyzeThreadWakeup(namesDb, {
      appPids: [5000, 6000, 7000, 8000, 9000],
    });
    const isSystem = new Map(
      results.map((r) => [r.threadId, r.wakeupThreads[0]?.isSystemThread]),
    );

    expect(isSystem.get(5000)).toBe(false); // 'main' in com.demo
    expect(isSystem.get(5001)).toBe(true); // OS_ prefix
    expect(isSystem.get(5002)).toBe(true); // substring 'hiprofilerd'
    expect(isSystem.get(5003)).toBe(true); // '_' suffix prefix
    expect(isSystem.get(5004)).toBe(true); // 'pp.' prefix
    expect(isSystem.get(5005)).toBe(true); // substring 'irq/'
    expect(isSystem.get(5006)).toBe(false); // plain app thread
    expect(isSystem.get(6000)).toBe(true); // process 'ohos.sceneboard'
    expect(isSystem.get(7000)).toBe(true); // process 'render_service'
    expect(isSystem.get(8000)).toBe(true); // process 'sysmgr-main'
    expect(isSystem.get(9000)).toBe(false); // process 'pbench.baseline'
  });
});

describe('real traces', () => {
  it.skipIf(!existsSync(EMU_DB))('emu_big yields 21 app-thread results', () => {
    const traceDb = openDb(EMU_DB);
    try {
      expect(analyzeThreadWakeup(traceDb, { appPids: [16702] })).toHaveLength(21);
    } finally {
      traceDb.close();
    }
  });

  it.skipIf(!existsSync(REAL_DB))('real_device yields 18 app-thread results', () => {
    const traceDb = openDb(REAL_DB);
    try {
      expect(analyzeThreadWakeup(traceDb, { appPids: [6115] })).toHaveLength(18);
    } finally {
      traceDb.close();
    }
  });
});
