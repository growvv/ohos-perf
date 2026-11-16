import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { NativeMemoryAnalyzer } from '../src/analyze/native-memory';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

let dir: string;

const NATIVE_HOOK_DDL = `CREATE TABLE native_hook(id INT, callchain_id INT, ipid INT,
  itid INT, event_type INT, sub_type_id INT, start_ts INT, end_ts INT, dur INT,
  addr INT, heap_size INT, all_heap_size INT, current_size_dur INT,
  last_lib_id INT, last_symbol_id INT)`;

const NATIVE_FRAME_DDL = `CREATE TABLE native_hook_frame(id INT, callchain_id INT,
  depth INT, ip INT, symbol_id INT, file_id INT, offset INT, symbol_offset INT,
  vaddr INT)`;

const STATISTIC_DDL = `CREATE TABLE native_hook_statistic(id INT, callchain_id INT,
  ipid INT, ts INT, type INT, sub_type_id INT, apply_count INT, release_count INT,
  apply_size INT, release_size INT, last_lib_id INT, last_symbol_id INT)`;

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;

const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;

const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

/** The hook rows every non-degraded case shares. */
const EVENTS = `INSERT INTO native_hook VALUES
  (0, 10, 17, 100, 0, 0, 1000, 0, 0, 4096, 100, 0, 0, 1, 2),
  (1, 10, 17, 100, 0, 0, 2000, 0, 0, 8192, 50, 0, 0, 1, 3),
  (2, 10, 17, 100, 1, 0, 3000, 0, 0, 8192, 50, 0, 0, 1, 3),
  (3, 10, 17, 100, 0, 0, 4000, 0, 0, 4096, 20, 0, 0, 1, 2)`;

interface Fixture {
  /** `native_hook` rows; omitted leaves the table empty. */
  events?: boolean;
  /** `native_hook_statistic` rows, used when `events` is absent. */
  statistics?: boolean;
  /** Write the statistic row for ipid 18 (pid 5000) instead of the app's. */
  otherPid?: boolean;
  /** Add a second live callchain (11) on the same thread. */
  extraLiveCallchain?: boolean;
  /** Only growing allocations, so the peak is the last event. */
  growingOnly?: boolean;
  /** Process rows; an empty array leaves the app unresolved. */
  processes?: Array<[number, number, number, string]>;
}

function dbWith(name: string, fixture: Fixture): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);  d.exec(NATIVE_HOOK_DDL);
  d.exec(NATIVE_FRAME_DDL);
  d.exec(STATISTIC_DDL);
  d.exec(PROCESS_DDL);
  d.exec(THREAD_DDL);
  d.exec(DATA_DICT_DDL);
  const processes = fixture.processes ?? [[0, 17, 4999, 'com.demo']];
  for (const [id, ipid, pid, processName] of processes) {
    d.prepare('INSERT INTO process VALUES (?, ?, ?, ?, 0, 0, 1, 0, 0)')
      .run(id, ipid, pid, processName);
  }
  d.exec("INSERT INTO thread VALUES (0, 100, 500, 'main', 0, 0, 17, 1, 0)");
  if (fixture.events === false) {
    // No events.
  } else if (fixture.growingOnly === true) {
    d.exec(`INSERT INTO native_hook VALUES
      (0, 10, 17, 100, 0, 0, 1000, 0, 0, 4096, 100, 0, 0, 1, 2),
      (1, 10, 17, 100, 0, 0, 2000, 0, 0, 8192, 50, 0, 0, 1, 3)`);
  } else {
    d.exec(EVENTS);
    if (fixture.extraLiveCallchain === true) {
      // Still live at the end, on the same thread as callchain 10.
      d.exec(`INSERT INTO native_hook VALUES
        (4, 11, 17, 100, 0, 0, 5000, 0, 0, 4096, 70, 0, 0, 1, 2)`);
      d.exec('INSERT INTO native_hook_frame VALUES (2, 11, 0, 4096, 2, 1, 0, 0, 0)');
    }
  }
  if (fixture.statistics === true) {
    // ipid 18 is a second process, used to prove the table-wide presence check
    // does not stand in for an app-scoped one.
    d.exec('INSERT INTO process VALUES (1, 18, 5000, \'other\', 0, 0, 1, 0, 0)');
    d.exec(`INSERT INTO native_hook_statistic VALUES
      (0, 10, ${fixture.otherPid === true ? 18 : 17}, 5000, 0, 0, 3, 1, 170, 50, 1, 2)`);
  }
  d.exec(`INSERT INTO native_hook_frame VALUES
    (0, 10, 0, 4096, 2, 1, 0, 0, 0),
    (1, 10, 1, 8192, 3, 1, 0, 0, 0)`);
  d.exec(`INSERT INTO data_dict VALUES
    (1, '/system/lib64/libfoo.so'), (2, 'foo()'), (3, 'bar()')`);
  d.close();
  return openDb(path);
}

/** A database with none of the native tables at all. */
function bareDb(): QueryHandle {
  const path = join(dir, 'bare.db');
  new DatabaseSync(path).close();
  return openDb(path);
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'mem.native_hook', available: true, collector: 'hiprofiler', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(target: QueryHandle, appPids: number[] = [4999]): AnalyzeContext {
  return {
    db: target,
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    app: { packageName: 'com.demo', pids: appPids, processNames: ['com.demo'] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: fullCaps(),
    deviceId: 'offline',
  };
}

function metricOf(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-native-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NativeMemoryAnalyzer', () => {
  it('reports peak, trough, end and unreleased at both instants', async () => {
    const db = dbWith('basic.db', {});
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      const get = (id: string) => metricOf(r, id).value;
      expect(get('mem.native.events.count')).toBe(4);
      expect(get('mem.native.alloc.count')).toBe(3);
      expect(get('mem.native.alloc.bytes')).toBe(170);
      expect(get('mem.native.free.count')).toBe(1);
      expect(get('mem.native.free.bytes')).toBe(50);
      expect(get('mem.native.total.peak')).toBe(150);
      expect(get('mem.native.total.trough')).toBe(0);
      expect(get('mem.native.total.end')).toBe(120);
      expect(get('mem.native.unreleased.peak')).toBe(150);
      expect(get('mem.native.unreleased.end')).toBe(120);
      expect(get('mem.native.callchains.count')).toBe(1);
      expect(get('mem.native.peak.offset')).toBeCloseTo(0.001, 9);
      expect(metricOf(r, 'mem.native.total.peak').fidelity).toBe('exact');
      expect(metricOf(r, 'mem.native.total.peak').provenance).toMatchObject({
        collector: 'hiprofiler', table: 'native_hook', rows: 4,
      });
    } finally {
      db.close();
    }
  });

  it('keeps evidence ids distinct when several live rows share a thread', async () => {
    // Two live callchains on `main` at the same point share kind, process,
    // thread, pid and window. Without a key their ids collide, and the engine
    // turns that into DUPLICATE_EVIDENCE_ID — the whole analysis fails.
    const db = dbWith('collide.db', { extraLiveCallchain: true });
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      const items = r.evidence.filter((e) => e.kind === 'native_memory');
      expect(items.length).toBeGreaterThan(2);
      expect(new Set(items.map((e) => e.id)).size).toBe(items.length);
    } finally {
      db.close();
    }
  });

  it('keeps the peak and end evidence distinct when both fall at the same instant', async () => {
    // A monotonically growing capture peaks at its last event, so peakTs equals
    // endTs and both points share one window. Same thread, same process: the
    // ids collide unless the point participates in the key.
    const db = dbWith('same-instant.db', { growingOnly: true });
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      const items = r.evidence.filter((e) => e.kind === 'native_memory');
      expect(items.map((e) => e.signals.point).sort()).toEqual(['end', 'peak']);
      expect(new Set(items.map((e) => e.id)).size).toBe(2);
    } finally {
      db.close();
    }
  });

  it('degrades instead of reporting a zero when only another pid has statistics', async () => {
    // `hasStatistics()` is table-wide; the rows belong to pid 5000 while the
    // app is 4999. The fallback would report "0 bytes across 0 callchains".
    const db = dbWith('other-pid-stats.db', { events: false, statistics: true, otherPid: true });
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      expect(r.metrics.map((m) => m.id)).toEqual(['mem.native.degraded']);
      expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
    } finally {
      db.close();
    }
  });

  it('emits evidence for the peak and end points with drill-downs', async () => {
    const db = dbWith('evidence.db', {});
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      const items = r.evidence.filter((e) => e.kind === 'native_memory');
      expect(items.map((e) => e.signals.point).sort()).toEqual(['end', 'peak']);
      expect(new Set(items.map((e) => e.id)).size).toBe(2);
      for (const item of items) {
        expect(item.drillDown.map((d) => d.tool)).toEqual([
          'mem.native.callchain', 'mem.native.unreleased', 'frames.all',
        ]);
        expect(item.subject).toMatchObject({ process: 'com.demo', thread: 'main' });
      }
      const end = items.find((e) => e.signals.point === 'end')!;
      expect(end.signals).toMatchObject({
        size: 120, count: 2, callchainId: 10, pid: 4999, tid: 100,
        categoryName: 'SYS_SDK', subCategory: 'libfoo.so',
      });
      expect(end.severity).toBe('warn');
    } finally {
      db.close();
    }
  });

  it('degrades with a reason when native_hook is absent', async () => {
    const db = bareDb();
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      expect(metricOf(r, 'mem.native.degraded').fidelity).toBe('proxy');
      expect(metricOf(r, 'mem.native.degraded').degraded!.reason).toMatch(/nativehook/);
      expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
      expect(r.metrics.some((m) => m.id === 'mem.native.total.peak')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('falls back to statistics as proxy data and never claims a peak', async () => {
    const db = dbWith('stats.db', { events: false, statistics: true });
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      expect(metricOf(r, 'mem.native.statistic.fallback').fidelity).toBe('proxy');
      expect(metricOf(r, 'mem.native.unreleased.end').fidelity).toBe('proxy');
      expect(metricOf(r, 'mem.native.unreleased.end').value).toBe(120);
      expect(r.metrics.some((m) => m.id === 'mem.native.total.peak')).toBe(false);
      expect(r.metrics.some((m) => m.id === 'mem.native.unreleased.peak')).toBe(false);
      expect(metricOf(r, 'mem.native.unreleased.end').degraded!.reason).toMatch(/statistic/i);
      expect(metricOf(r, 'mem.native.callchains.count').value).toBe(1);
    } finally {
      db.close();
    }
  });

  it('degrades when the app has no process in the trace', async () => {
    const db = dbWith('noapp.db', { processes: [] });
    try {
      const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
      expect(metricOf(r, 'mem.native.degraded').value).toBe(0);
      expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
    } finally {
      db.close();
    }
  });

  it('degrades when the database handle is missing', async () => {
    const target = bareDb();
    try {
      const r = await new NativeMemoryAnalyzer().run({
        frames: new FrameQuery(target),
        processes: new ProcessQuery(target),
        app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
        window: { startNs: 0, endNs: 100 },
        caps: fullCaps(),
        deviceId: 'offline',
      });
      expect(metricOf(r, 'mem.native.degraded').degraded!.reason).toMatch(/database handle/);
    } finally {
      target.close();
    }
  });

  it('is deterministic across runs', async () => {
    const db = dbWith('determinism.db', {});
    try {
      const a = await new NativeMemoryAnalyzer().run(ctxWith(db));
      const b = await new NativeMemoryAnalyzer().run(ctxWith(db));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      db.close();
    }
  });
});
