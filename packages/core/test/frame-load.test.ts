import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { PerfQuery } from '../src/query/perf';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { FrameLoadAnalyzer, FrameLoadIndex } from '../src/analyze/frame-load';
import type { AnalyzeContext } from '../src/analyze/types';
import { CapabilityMatrix } from '../src/device/capability';

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

/** A trace with the two app processes and the given frame_slice rows. */
function traceWith(name: string, framesSql: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  d.exec(PROCESS_DDL);
  d.exec(THREAD_DDL);
  d.exec(`INSERT INTO process VALUES
    (0, 17, 4999, 'com.demo', 0, 0, 1, 1, 0),
    (1, 18, 6000, 'render_service', 0, 0, 1, 1, 0)`);
  d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'main', 0, 0, 17, 1, 0)`);
  d.exec(`INSERT INTO frame_slice VALUES ${framesSql}`);
  d.close();
  return openDb(path);
}

/** Only a sample at 900us-equivalent ns, outside the frames at 1000-2000. */
function mismatchPerf(name: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES (0, 100, 4999, 'main')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(`INSERT INTO perf_sample VALUES (0, 10, 900000, 100, 50, 1, 900000, 0, 'S')`);
  d.close();
  return openDb(path);
}

function ctxFor(db: QueryHandle, perf?: QueryHandle): AnalyzeContext {
  const available = {
    available: true, collector: 'x', fidelity: 'exact' as const,
    probe: { command: 'p', stdout: '', stderr: '', code: 0 },
  };
  const caps = new CapabilityMatrix([
    { id: 'trace.frames', ...available },
    { id: 'perf.samples', ...available },
  ]);
  return {
    frames: new FrameQuery(db), processes: new ProcessQuery(db),
    ...(perf === undefined ? {} : { perf: new PerfQuery(perf) }),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 10_000 },
    caps, deviceId: 'emu',
  };
}

describe('FrameLoadAnalyzer', () => {
  it('reports per-frame load for rendered app actual frames only', async () => {
    const trace = traceWith('analyzer.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0),
      (2, 4000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 2, 0, 0),
      (3, 5000, 0, 17, 44, 0, 1000, '', 0, 1, 'expect', 0, 0, 0),
      (4, 6000, 0, 18, 45, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    const perf = perfDb('analyzer-perf.db');
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.load.frames.count').value).toBe(2);
      expect(get('frame.load.total').value).toBe(36);
      expect(get('frame.load.avg').value).toBe(18);
      expect(get('frame.load.min').value).toBe(15);
      expect(get('frame.load.max').value).toBe(21);
      expect(get('frame.load.top10.share').value).toBeCloseTo(100, 5);
      // The index reads the analysis window, so it includes the 99-weight
      // sample at 3000 that no frame window covers: 5+7+3+11+99.
      expect(get('frame.load.span.weight').value).toBe(125);
      expect(get('frame.load.total').provenance).toEqual({
        collector: 'hiperf', table: 'perf_sample', rows: 5, device: 'emu',
      });
      for (const m of r.metrics) expect(Number.isFinite(m.value as number)).toBe(true);
    } finally { trace.close(); perf.close(); }
  });

  it('emits top-frame evidence ranked by load with attribution signals', async () => {
    const trace = traceWith('analyzer-rank.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0)`);
    const perf = perfDb('analyzer-rank-perf.db');
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const ev = r.evidence.filter((e) => e.kind === 'frame_load');
      expect(ev).toHaveLength(2);
      // Evidence is chronological; rank carries the load ordering.
      expect(ev.map((e) => [e.window.startNs, e.signals.rank])).toEqual([
        [1000, 2], [1500, 1],
      ]);
      expect(ev[1].signals.load).toBe(21);
      expect(ev[1].signals.topThread).toBe('worker');
      expect(ev[1].signals.topThreadLoad).toBe(14);
      expect(ev[1].drillDown.map((d) => d.tool)).toEqual([
        'frames.get', 'frame.load.threads', 'frame.load.symbols', 'callstack.range',
      ]);
      expect(ev[1].explain).toContain('sampled events');
    } finally { trace.close(); perf.close(); }
  });

  it('degrades without perf samples instead of reporting zeros', async () => {
    const trace = traceWith('analyzer-noperf.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace));
      expect(r.metrics.map((m) => m.id)).toEqual(['frame.load.degraded']);
      expect(r.metrics[0].fidelity).toBe('proxy');
      expect(String(r.metrics[0].degraded?.reason)).toMatch(/perf samples|--hiperf/);
      expect(r.evidence[0].kind).toBe('no_data');
    } finally { trace.close(); }
  });

  it('degrades when samples exist but none fall inside a frame window', async () => {
    const trace = traceWith('analyzer-mismatch.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    const perf = mismatchPerf('analyzer-mismatch-perf.db');
    try {
      const c = ctxFor(trace, perf);
      c.window = { startNs: 0, endNs: 2_000_000 };
      const r = await new FrameLoadAnalyzer().run(c);
      expect(r.metrics.map((m) => m.id)).toEqual(['frame.load.degraded']);
      expect(String(r.metrics[0].degraded?.reason)).toMatch(/time base|inside any frame/);
    } finally { trace.close(); perf.close(); }
  });

  it('is deterministic across runs', async () => {
    const trace = traceWith('analyzer-det.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0)`);
    const perf = perfDb('analyzer-det-perf.db');
    try {
      const a = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const b = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally { trace.close(); perf.close(); }
  });
});
