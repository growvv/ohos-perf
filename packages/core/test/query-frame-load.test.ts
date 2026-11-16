import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { runNamedQuery, type QueryContext } from '../src/query/registry';

let dir: string;
let db: QueryHandle;

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT,
  type_desc TEXT, flag INT, depth INT, frame_no INT)`;

const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
  thread_name TEXT)`;
const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
  thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT,
  thread_state TEXT)`;
const PERF_CALLCHAIN_DDL = `CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT,
  ip INT, vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
  source_file_id INT, line_number INT)`;
const PERF_FILES_DDL = `CREATE TABLE perf_files(id INT, file_id INT, serial_id INT,
  symbol TEXT, path TEXT)`;

/** One app actual frame; `flag` 1 keeps it in the rendered set. */
function insertFrame(
  d: DatabaseSync,
  id: number,
  ts: number,
  flag = 1,
): void {
  d.prepare(`INSERT INTO frame_slice VALUES
    (?, ?, ?, 17, 44, 0, 16666667, '', 0, 0, 'actual', ?, 0, 0)`)
    .run(id, ts, id + 1, flag);
}

function ctx(target: QueryHandle): QueryContext {
  return {
    db: target,
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-frameload-'));
  const path = join(dir, 'trace.db');
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  // 10 rendered frames from 1.0 s to 1.9 s, then one at exactly 2.0 s: the
  // second falls into the next 1 s window.
  for (let i = 0; i < 10; i++) insertFrame(d, i, 1_000_000_000 + i * 100_000_000);
  insertFrame(d, 10, 2_000_000_000);

  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES (0, 100, 4999, 'main'),
    (1, 101, 4999, 'worker')`);
  d.exec(PERF_SAMPLE_DDL);
  // Window 1000..2000: thread 100 carries 12, thread 101 carries 3 (total 15).
  d.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
    (1, 10, 1100, 100, 7, 1, 1100, 0, 'S'),
    (2, 11, 1200, 101, 3, 1, 1200, 0, 'S'),
    (3, 12, 3000, 100, 4, 1, 3000, 0, 'S')`);
  d.exec(PERF_CALLCHAIN_DDL);
  d.exec(`INSERT INTO perf_callchain VALUES
    (0, 10, 0, 0, 0, 0, 200, 1, 'rawB', 0, 0),
    (1, 11, 0, 0, 0, 0, 201, 1, 'rawA', 0, 0),
    (2, 12, 0, 0, 0, 0, 200, 1, 'rawB', 0, 0)`);
  d.exec(PERF_FILES_DDL);
  d.exec(`INSERT INTO perf_files VALUES
    (0, 200, 1, 'leafB()', '/lib/libb.so'),
    (1, 201, 1, 'leafA()', '/lib/liba.so')`);
  d.close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('frame load named queries', () => {
  it('returns the 1s fps series for a window', () => {
    const r = runNamedQuery(ctx(db), 'frames.fpsSeries', {
      startNs: 0, endNs: 5_000_000_000,
    });
    expect(r.rows).toEqual([
      { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 10, fps: 10 },
      { startNs: 2_000_000_000, endNs: 3_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('splits a frame window by thread with shares', () => {
    const r = runNamedQuery(ctx(db), 'frame.load.threads', {
      startNs: 1000, endNs: 2000,
    });
    expect(r.rows).toEqual([
      { threadId: 100, threadName: 'main', samples: 12, share: 80 },
      { threadId: 101, threadName: 'worker', samples: 3, share: 20 },
    ]);
  });

  it('attributes symbols and files with shares of the window weight', () => {
    expect(
      runNamedQuery(ctx(db), 'frame.load.symbols', { startNs: 1000, endNs: 2000 }).rows,
    ).toEqual([
      { symbol: 'leafB()', filePath: '/lib/libb.so', samples: 12, share: 80 },
      { symbol: 'leafA()', filePath: '/lib/liba.so', samples: 3, share: 20 },
    ]);
    expect(
      runNamedQuery(ctx(db), 'frame.load.files', { startNs: 1000, endNs: 2000 }).rows,
    ).toEqual([
      { filePath: '/lib/libb.so', samples: 12, share: 80 },
      { filePath: '/lib/liba.so', samples: 3, share: 20 },
    ]);
  });

  it('reads perf tables from perfDb when the scene keeps them apart', () => {
    // A real `--hiperf` scene stores perf tables in perf.db, not trace.db:
    // trace.db holds frame_slice and perf.db holds perf_thread/perf_sample.
    // Reading only ctx.db made every frame.load.* query return [] on device.
    const tracePath = join(dir, 'split-trace.db');
    const trace = new DatabaseSync(tracePath);
    trace.exec(FRAME_DDL);
    insertFrame(trace, 0, 1_000_000_000);
    trace.close();

    const perfPath = join(dir, 'split-perf.db');
    const perf = new DatabaseSync(perfPath);
    perf.exec(PERF_THREAD_DDL);
    perf.exec(`INSERT INTO perf_thread VALUES (0, 100, 4999, 'main')`);
    perf.exec(PERF_SAMPLE_DDL);
    perf.exec(`INSERT INTO perf_sample VALUES (0, 0, 1000, 100, 5, 1, 1000, 0, 'S')`);
    perf.close();

    const traceDb = openDb(tracePath);
    const perfDb = openDb(perfPath);
    try {
      const split: QueryContext = { ...ctx(traceDb), perfDb };
      expect(
        runNamedQuery(split, 'frame.load.threads', { startNs: 1000, endNs: 2000 }).rows,
      ).toEqual([{ threadId: 100, threadName: 'main', samples: 5, share: 100 }]);
    } finally {
      traceDb.close();
      perfDb.close();
    }
  });

  it('returns [] without perf tables and validates required args', () => {
    const barePath = join(dir, 'bare.db');
    new DatabaseSync(barePath).close();
    const bare = ctx(openDb(barePath));
    try {
      expect(
        runNamedQuery(bare, 'frame.load.threads', { startNs: 0, endNs: 1 }).rows,
      ).toEqual([]);
      expect(
        runNamedQuery(bare, 'frame.load.symbols', { startNs: 0, endNs: 1 }).rows,
      ).toEqual([]);
      expect(
        runNamedQuery(bare, 'frame.load.files', { startNs: 0, endNs: 1 }).rows,
      ).toEqual([]);
      expect(() => runNamedQuery(bare, 'frames.fpsSeries', {})).toThrow(/startNs/);
    } finally {
      bare.db.close();
    }
  });
});
