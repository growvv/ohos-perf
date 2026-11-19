import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import type { Frame } from '../src/query/frames';
import { FrameQuery } from '../src/query/frames';
import { PerfQuery } from '../src/query/perf';
import { ProcessQuery } from '../src/query/process';
import { EmptyFrameAnalyzer, filterEmptyFrames } from '../src/analyze/empty-frame';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

let dir: string;

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT,
  type_desc TEXT, flag INT, depth INT, frame_no INT)`;

const CALLSTACK_DDL = `CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
  cat TEXT, name TEXT)`;

const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;

/** One frame with every column this analyzer reads; other fields are filler. */
function frame(
  id: number,
  ts: number,
  vsync: number,
  flag: 0 | 1 | 2 | 3,
  itid = 44,
  ipid = 17,
  dur = 16_000_000,
  type: 0 | 1 = 0,
): Frame {
  return {
    id, ts, dur, vsync, ipid, itid, callstackId: 0, flag, type,
    typeDesc: type === 0 ? 'actual' : 'expect', src: '', dst: 0, depth: 0, frameNo: 0,
  };
}

/** One `callstack` row: `callid` is the owning `thread.id`. */
function event(ts: number, name: string, callid = 44, id = 1): {
  id: number; ts: number; dur: number; callid: number; cat: string; name: string;
} {
  return { id, ts, dur: 0, callid, cat: 'ace', name };
}

interface Fixture {
  frames?: Frame[];
  events?: ReturnType<typeof event>[];
  perf?: Array<{ id: number; ts: number; threadId: number; count: number }>;
  /** Default true: write the two app `perf_thread` rows. */
  perfAppThreads?: boolean;
}

const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT,
  process_id INT, thread_name TEXT)`;

const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT,
  timeStamp INT, thread_id INT, event_count INT, event_type_id INT,
  timestamp_trace INT, cpu_id INT, thread_state TEXT)`;

/** Writes a fixture into a fresh trace database and returns its handle. */
function dbWith(name: string, fixture: Fixture): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  d.exec(CALLSTACK_DDL);
  d.exec(THREAD_DDL);
  d.exec(PROCESS_DDL);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 2, 0, 0),
    (1, 18, 5000, 'ohos.sceneboard', 0, 0, 1, 0, 0)`);
  d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'com.demo', 0, 0, 17, 1, 0),
    (45, 45, 450, 'worker', 0, 0, 17, 0, 0),
    (46, 46, 460, 'ohos.sceneboard', 0, 0, 18, 1, 0)`);

  const insertFrame = d.prepare(`INSERT INTO frame_slice VALUES
    (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, 0, 0)`);
  for (const f of fixture.frames ?? []) {
    insertFrame.run(
      f.id, f.ts, f.vsync, f.ipid, f.itid, f.callstackId, f.dur,
      f.type, f.typeDesc, f.flag,
    );
  }

  const insertEvent = d.prepare('INSERT INTO callstack VALUES (?, ?, ?, ?, ?, ?)');
  for (const e of fixture.events ?? []) {
    insertEvent.run(e.id, e.ts, e.dur, e.callid, e.cat, e.name);
  }

  if (fixture.perf !== undefined) {
    d.exec(PERF_THREAD_DDL);
    d.exec(PERF_SAMPLE_DDL);
    // `perfAppThreads: false` models a capture whose perf rows belong to
    // another process: the tables exist, no app thread does.
    if (fixture.perfAppThreads !== false) {
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 4999, 'main'),
        (1, 101, 4999, 'worker')`);
    }
    const insertSample = d.prepare(
      'INSERT INTO perf_sample VALUES (?, 0, ?, ?, ?, 0, ?, 0, 0)',
    );
    for (const sample of fixture.perf) {
      insertSample.run(sample.id, sample.ts, sample.threadId, sample.count, sample.ts);
    }
  }
  d.close();
  return openDb(path);
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'trace.frames', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
    { id: 'trace.ark', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(
  target: QueryHandle,
  appPids: number[] = [4999],
  appName = 'com.demo',
): AnalyzeContext {
  return {
    db: target,
    frames: new FrameQuery(target),
    perf: new PerfQuery(target),
    processes: new ProcessQuery(target),
    app: { packageName: appName, pids: appPids, processNames: [appName] },
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
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-empty-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('filterEmptyFrames', () => {
  it('confirms an empty frame with no buffer event and no non-empty sibling', () => {
    const db = dbWith('confirm.db', { frames: [frame(0, 1e9, 100, 2)] });
    const empty = frame(0, 1e9, 100, 2);
    const f = filterEmptyFrames(db, [empty]);
    expect(f.confirmed).toEqual([empty]);
    expect(f.rule1).toEqual([]);
    expect(f.rule2).toEqual([]);
    db.close();
  });

  it('filters a frame whose own thread emitted a buffer API event inside it', () => {
    const db = dbWith('rule1.db', {
      frames: [frame(0, 1e9, 100, 2)],
      events: [event(1e9 + 5e6, 'H:RequestBuffer')],
    });
    const empty = frame(0, 1e9, 100, 2);
    const f = filterEmptyFrames(db, [empty]);
    expect(f.rule1).toEqual([empty]);
    expect(f.confirmed).toEqual([]);
    db.close();
  });

  it('does not filter on a buffer event emitted by another thread', () => {
    // Same process, different `thread.id`: the frame's own thread drew nothing.
    const db = dbWith('other-thread.db', {
      frames: [frame(0, 1e9, 100, 2)],
      events: [event(1e9 + 5e6, 'H:RequestBuffer', 45)],
    });
    const empty = frame(0, 1e9, 100, 2);
    expect(filterEmptyFrames(db, [empty]).confirmed).toEqual([empty]);
    db.close();
  });

  it('filters a frame when the same vsync and itid already drew a non-empty frame', () => {
    const db = dbWith('rule2.db', {
      frames: [frame(0, 1e9, 100, 2), frame(1, 1.001e9, 100, 0)],
    });
    const empty = frame(0, 1e9, 100, 2);
    const f = filterEmptyFrames(db, [empty]);
    expect(f.rule2).toEqual([empty]);
    expect(f.confirmed).toEqual([]);
    db.close();
  });

  it('does not filter a frame whose dur is NULL', () => {
    // `dur` 0 stands for a NULL column. HapRay compares `ts + NaN`, which is
    // never inside a window, so an event at exactly `ts` must not filter.
    const db = dbWith('null-dur.db', {
      frames: [frame(0, 1e9, 100, 2, 44, 17, 0)],
      events: [event(1e9, 'H:FlushBuffer')],
    });
    const empty = frame(0, 1e9, 100, 2, 44, 17, 0);
    const f = filterEmptyFrames(db, [empty]);
    expect(f.rule1).toEqual([]);
    expect(f.confirmed).toEqual([empty]);
    db.close();
  });

  it('ignores a buffer event that falls outside the frame window', () => {
    const db = dbWith('outside.db', {
      frames: [frame(0, 1e9, 100, 2)],
      // One nanosecond after `ts + dur`; and one before `ts`.
      events: [event(1e9 + 16_000_001, 'H:DoFlushBuffer', 44, 1), event(999_999_999, 'H:NativeWindow', 44, 2)],
    });
    const empty = frame(0, 1e9, 100, 2);
    expect(filterEmptyFrames(db, [empty]).confirmed).toEqual([empty]);
    db.close();
  });
});

describe('EmptyFrameAnalyzer', () => {
  it('reports a rate over the app’s actual frames', async () => {
    // 10 actual app frames, one of them empty and unfiltered -> 10%.
    const others = Array.from({ length: 9 }, (_, i) => frame(i + 1, 2e9 + i * 20e6, 200 + i, 0));
    const db = dbWith('rate.db', { frames: [frame(0, 1e9, 100, 2), ...others] });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    expect(metricOf(r, 'empty_frame.count').value).toBe(1);
    expect(metricOf(r, 'empty_frame.filtered.count').value).toBe(0);
    expect(metricOf(r, 'empty_frame.rate').value).toBeCloseTo(10, 6);
    db.close();
  });

  it('emits one evidence item per confirmed frame over its own window', async () => {
    const db = dbWith('evidence.db', { frames: [frame(7, 1e9, 100, 2)] });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    const items = r.evidence.filter((e) => e.kind === 'empty_frame');
    expect(items).toHaveLength(1);
    expect(items[0].subject).toEqual({ process: 'com.demo', frameNo: 7 });
    expect(items[0].window).toEqual({ startNs: 1e9, endNs: 1e9 + 16e6 });
    expect(items[0].signals).toMatchObject({ vsync: 100, filtered: 0 });
    // No perf capture here, so no load was measured and the symbol drill-down
    // would resolve to nothing; only the frame detail is offered.
    expect(items[0].drillDown).toEqual([
      { label: 'Frame detail', tool: 'frames.get', args: { id: 7 }, returns: 'Frame' },
    ]);
    db.close();
  });

  it('reports empty-frame load, share and severity from exact windows', async () => {
    const db = dbWith('empty-load.db', {
      frames: [
        frame(0, 1_000_000_000, 1, 0, 44, 17, 100_000_000), // rendered, 50+50
        frame(1, 2_000_000_000, 2, 2, 44, 17, 100_000_000), // empty, 3
        frame(2, 3_000_000_000, 3, 0, 44, 17, 100_000_000), // rendered, 0
      ],
      perf: [
        { id: 0, ts: 1_050_000_000, threadId: 100, count: 50 },
        { id: 1, ts: 1_080_000_000, threadId: 101, count: 50 },
        { id: 2, ts: 2_050_000_000, threadId: 100, count: 3 },
      ],
    });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    const get = (id: string) => metricOf(r, id);
    expect(get('empty_frame.load.total').value).toBe(3);
    // Loads: 100 + 3 + 0 = 103; 3 / 103 * 100 = 2.9126...% -> normal.
    expect(get('empty_frame.load.share').value).toBeCloseTo(2.9126, 3);
    expect(get('empty_frame.load.severity').value).toBe('normal');
    expect(metricOf(r, 'empty_frame.count').value).toBe(1);
    // Measured load: the signals and the symbol drill-down are present.
    const emptyItem = r.evidence.find((e) => e.kind === 'empty_frame')!;
    expect(emptyItem.signals).toMatchObject({ load: 3, loadRank: 1 });
    expect(emptyItem.drillDown.map((d) => d.tool)).toContain('frame.load.symbols');
    db.close();
  });

  it('grades load share at 3 and 10 percent boundaries', async () => {
    const severity = async (emptyCount: number) => {
      const db = dbWith(`empty-sev-${emptyCount}.db`, {
        frames: [
          frame(0, 1_000_000_000, 1, 0, 44, 17, 100_000_000),
          frame(1, 2_000_000_000, 2, 2, 44, 17, 100_000_000),
        ],
        perf: [
          { id: 0, ts: 1_050_000_000, threadId: 100, count: 97 },
          { id: 1, ts: 2_050_000_000, threadId: 100, count: emptyCount },
        ],
      });
      try {
        return metricOf(
          await new EmptyFrameAnalyzer().run(ctxWith(db)),
          'empty_frame.load.severity',
        ).value;
      } finally {
        db.close();
      }
    };
    expect(await severity(2)).toBe('normal'); // 2/99 = 2.02%
    expect(await severity(3)).toBe('moderate'); // 3/100 = 3%
    expect(await severity(10)).toBe('moderate'); // 10/107 = 9.35%
    expect(await severity(11)).toBe('severe'); // 11/108 = 10.19%
  });

  it('omits load signals from empty-frame evidence when load is unavailable', async () => {
    // Without perf samples the analyzer emits `empty_frame.load.degraded`, so
    // there is no load to report. Emitting load=0 / loadShare=0 / loadRank=1
    // per frame would claim the empties had zero load and that one was worst,
    // contradicting the degraded metric in the same result.
    const db = dbWith('empty-load-noperf-signals.db', {
      frames: [
        frame(0, 1_000_000_000, 1, 2),
        frame(1, 2_000_000_000, 2, 2),
      ],
    });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    expect(r.metrics.map((m) => m.id)).toContain('empty_frame.load.degraded');
    expect(r.evidence).toHaveLength(2);
    for (const item of r.evidence) {
      expect(item.signals).not.toHaveProperty('load');
      expect(item.signals).not.toHaveProperty('loadShare');
      expect(item.signals).not.toHaveProperty('loadRank');
      expect(item.drillDown.map((d) => d.tool)).not.toContain('frame.load.symbols');
    }
    db.close();
  });

  it('omits load signals when samples exist but none land in a frame window', async () => {
    // The time-base-mismatch path: loadIndex built, every load zero, so the
    // metrics degrade. The evidence must not then claim a zero load either.
    const db = dbWith('empty-load-mismatch.db', {
      frames: [frame(0, 1_000_000_000, 1, 2)],
      perf: [{ id: 0, ts: 9_000_000_000, threadId: 100, count: 7 }],
    });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    expect(r.metrics.map((m) => m.id)).toContain('empty_frame.load.degraded');
    const item = r.evidence.find((e) => e.kind === 'empty_frame')!;
    expect(item.signals).not.toHaveProperty('load');
    expect(item.signals).not.toHaveProperty('loadRank');
    db.close();
  });

  it('names the app-thread gap when samples exist but none belong to the app', async () => {
    // A perf capture with samples for another process: the reason must not
    // claim the capture lacked --hiperf, which would send a reader to rebuild
    // an app that is not the problem.
    const db = dbWith('empty-load-otherproc.db', {
      frames: [frame(0, 1_000_000_000, 1, 2)],
      perf: [{ id: 0, ts: 1_050_000_000, threadId: 102, count: 9 }],
      perfAppThreads: false,
    });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    const degraded = metricOf(r, 'empty_frame.load.degraded');
    expect(degraded.fidelity).toBe('proxy');
    expect(String(degraded.degraded?.reason)).toMatch(/no perf thread belongs to the app/i);
    expect(String(degraded.degraded?.reason)).not.toMatch(/--hiperf/);
    db.close();
  });

  it('degrades empty-frame load without perf samples', async () => {
    const db = dbWith('empty-load-noperf.db', {
      frames: [frame(0, 1_000_000_000, 1, 2)],
    });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    expect(r.metrics.map((m) => m.id)).toContain('empty_frame.load.degraded');
    expect(r.metrics.some((m) => m.id === 'empty_frame.load.total')).toBe(false);
    expect(metricOf(r, 'empty_frame.count').value).toBe(1);
    db.close();
  });

  it('never reports an exact 0% empty rate for an app with no frames', async () => {
    // The only frames belong to sceneboard, so the app rendered nothing.
    const db = dbWith('no-frames.db', { frames: [frame(0, 1e9, 100, 2, 46, 18)] });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
    expect(r.metrics).toEqual([]);
    expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
    db.close();
  });

  it('degrades instead of crashing when the process is not in the trace', async () => {
    // `com.absent` names no row in the fixture, by pid or by comm; the app
    // named `com.demo` is in the fixture and must be found through its name
    // when no pid was recorded.
    const db = dbWith('no-app.db', { frames: [frame(0, 1e9, 100, 2)] });
    const r = await new EmptyFrameAnalyzer().run(ctxWith(db, [], 'com.absent'));
    expect(metricOf(r, 'empty_frame.degraded')).toMatchObject({
      value: 0, unit: 'count', fidelity: 'proxy',
    });
    expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
    db.close();
  });

  it('degrades instead of crashing when the context has no database', async () => {
    const db = dbWith('no-db.db', { frames: [frame(0, 1e9, 100, 2)] });
    const r = await new EmptyFrameAnalyzer().run({ ...ctxWith(db), db: undefined });
    expect(metricOf(r, 'empty_frame.degraded').fidelity).toBe('proxy');
    expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
    db.close();
  });
});
