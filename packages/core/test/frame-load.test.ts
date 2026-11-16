import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { PerfQuery } from '../src/query/perf';
import { FrameLoadIndex } from '../src/analyze/frame-load';

let dir: string;

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
  flag INT, depth INT, frame_no INT)`;
const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;
const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT,
  process_id INT, thread_name TEXT)`;
const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT,
  timeStamp INT, thread_id INT, event_count INT, event_type_id INT,
  timestamp_trace INT, cpu_id INT, thread_state TEXT)`;

/**
 * Two app threads, one other-process thread, samples straddling frame edges.
 *
 * - frame [1000, 2000] -> 5 + 7 + 3 = 15
 * - frame [1500, 2500] -> 7 + 3 + 11 = 21
 * - unique weight in [1000, 2500] -> 26
 */
function perfDb(name: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES
    (0, 100, 4999, 'main'), (1, 101, 4999, 'worker'), (2, 102, 6000, 'other')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
    (1, 10, 1999, 100, 7, 1, 1999, 0, 'S'),
    (2, 11, 2000, 101, 3, 1, 2000, 0, 'S'),
    (3, 11, 2001, 101, 11, 1, 2001, 0, 'S'),
    (4, 12, 500, 102, 13, 1, 500, 0, 'S'),
    (5, 13, 3000, 100, 99, 1, 3000, 0, 'S')`);
  d.close();
  return openDb(path);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-frameload-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FrameLoadIndex', () => {
  it('sums app-thread event_count inside an inclusive frame window', () => {
    const db = perfDb('index.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index).toBeDefined();
      // [1000,2000]: 5 + 7 (thread 100) + 3 (thread 101 at the inclusive end).
      expect(index.load({ ts: 1000, dur: 1000 })).toBe(15);
      // [1500,2500]: 7 + 3 + 11.
      expect(index.load({ ts: 1500, dur: 1000 })).toBe(21);
      expect(index.sampleRows).toBe(4);
      expect(index.threadCount).toBe(2);
      // Unique weight: 5 + 7 + 3 + 11. Frame loads above overlap and sum to 36.
      expect(index.spanWeight).toBe(26);
    } finally {
      db.close();
    }
  });

  it('counts a sample exactly at ts in a zero-duration frame', () => {
    const db = perfDb('point.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index.load({ ts: 2000, dur: 0 })).toBe(3);
    } finally {
      db.close();
    }
  });

  it('splits a frame window by app thread, sorted by weight then thread id', () => {
    const db = perfDb('threads.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index.threadLoads({ ts: 1000, dur: 1000 })).toEqual([
        { threadId: 100, threadName: 'main', samples: 12 },
        { threadId: 101, threadName: 'worker', samples: 3 },
      ]);
      expect(index.threadLoads({ ts: 1500, dur: 1000 })).toEqual([
        { threadId: 101, threadName: 'worker', samples: 14 },
        { threadId: 100, threadName: 'main', samples: 7 },
      ]);
    } finally {
      db.close();
    }
  });

  it('returns undefined without perf rows or without app threads', () => {
    const empty = join(dir, 'empty.db');
    const d = new DatabaseSync(empty);
    d.exec(PERF_THREAD_DDL);
    d.exec(PERF_SAMPLE_DDL);
    d.close();
    const db = openDb(empty);
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999], range: { startNs: 0, endNs: 10 },
      })).toBeUndefined();
    } finally {
      db.close();
    }
    const noTablesPath = join(dir, 'empty2.db');
    new DatabaseSync(noTablesPath).close();
    const noTables = openDb(noTablesPath);
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(noTables), pids: [4999], range: { startNs: 0, endNs: 10 },
      })).toBeUndefined();
    } finally {
      noTables.close();
    }
    const db2 = perfDb('no-app-thread.db');
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(db2), pids: [7777], range: { startNs: 0, endNs: 5000 },
      })).toBeUndefined();
    } finally {
      db2.close();
    }
  });
});
