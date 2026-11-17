import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { PerfQuery } from '../src/query/perf';
import { ProcessQuery } from '../src/query/process';
import { RsSkipAnalyzer, computeRsSkip } from '../src/analyze/rs-skip';
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

const WINDOW = { startNs: 0, endNs: Number.MAX_SAFE_INTEGER };
/** render_service ipid 4, app ipid 17, a second app ipid 18. */
const RS = 4;
const APP = 17;

interface FrameRow {
  id: number;
  ts: number;
  dur: number;
  ipid: number;
  itid: number;
  type?: 0 | 1;
  flag?: 0 | 1 | 2 | 3;
}

interface EventRow {
  id: number;
  ts: number;
  name: string;
  callid: number;
}

interface Fixture {
  frames?: FrameRow[];
  events?: EventRow[];
  /** `sched_wakeup` rows: `[ref, wakeup_from, ts]`, all itids. */
  wakeups?: Array<[number, number, number]>;
  /** Omit `instant` entirely, as a trace captured without `trace.sched` has. */
  noInstant?: true;
  /** `perf_sample` rows for the app's threads; enables the instruction waste. */
  perf?: Array<{ ts: number; threadId: number; count: number }>;
}

/** Writes a fixture into a fresh trace database and returns its handle. */
function dbWith(name: string, fixture: Fixture): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  d.exec(CALLSTACK_DDL);
  d.exec(THREAD_DDL);
  d.exec(PROCESS_DDL);
  if (fixture.noInstant !== true) {
    d.exec(`CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
      ref_type TEXT, value INT)`);
  }
  d.exec(`INSERT INTO process VALUES (0, 4, 1528, 'render_service', 0, 0, 1, 0, 0),
    (1, 17, 6115, 'com.demo', 0, 0, 1, 0, 0),
    (2, 18, 6116, 'ohos.sceneboard', 0, 0, 1, 0, 0)`);
  d.exec(`INSERT INTO thread VALUES (4, 4, 40, 'RSUniRenderThr', 0, 0, 4, 1, 0),
    (44, 44, 440, 'com.demo', 0, 0, 17, 1, 0),
    (45, 45, 450, 'ohos.sceneboard', 0, 0, 18, 1, 0)`);

  const insertFrame = d.prepare(`INSERT INTO frame_slice VALUES
    (?, ?, 100, ?, ?, 0, ?, '', 0, ?, ?, ?, 0, 0)`);
  for (const f of fixture.frames ?? []) {
    const type = f.type ?? 0;
    insertFrame.run(
      f.id, f.ts, f.ipid, f.itid, f.dur, type,
      type === 0 ? 'actual' : 'expect', f.flag ?? 0,
    );
  }

  const insertEvent = d.prepare('INSERT INTO callstack VALUES (?, ?, 0, ?, ?, ?)');
  for (const e of fixture.events ?? []) {
    insertEvent.run(e.id, e.ts, e.callid, 'render_service', e.name);
  }

  if (fixture.perf !== undefined) {
    d.exec(`CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT, thread_name TEXT)`);
    d.exec(`CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT, thread_id INT,
      event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT, thread_state TEXT)`);
    // `perf_thread.thread_id` is the *tid*, which `thread.tid` carries: the
    // frame's `itid` is a different number space.
    d.exec(`INSERT INTO perf_thread VALUES (0, 440, 6115, 'com.demo')`);
    const insertSample = d.prepare(
      'INSERT INTO perf_sample VALUES (?, 0, ?, ?, ?, 0, ?, 0, 0)',
    );
    let id = 0;
    for (const sample of fixture.perf) {
      insertSample.run(id, sample.ts, sample.threadId, sample.count, sample.ts);
      id += 1;
    }
  }

  if (fixture.noInstant !== true) {
    const insertWakeup = d.prepare(
      `INSERT INTO instant VALUES (?, 'sched_wakeup', ?, ?, 'itid', 0)`,
    );
    for (const [ref, from, ts] of fixture.wakeups ?? []) {
      insertWakeup.run(ts, ref, from);
    }
  }
  d.close();  return openDb(path);
}

function opts(overrides: Partial<{ appIpids: number[]; rsIpids: number[] }> = {}) {
  return {
    window: WINDOW,
    appIpids: overrides.appIpids ?? [APP],
    rsIpids: overrides.rsIpids ?? [RS],
  };
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'trace.frames', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
    { id: 'trace.ark', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(target: QueryHandle): AnalyzeContext {
  return {
    db: target,
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    perf: new PerfQuery(target),
    app: { packageName: 'com.demo', pids: [6115], processNames: ['com.demo'] },
    window: WINDOW,
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

/** A RenderService frame with one skip event inside it. */
function skipFrameFixture(appFrame?: FrameRow): Fixture {
  return {
    frames: [
      { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
      ...(appFrame === undefined ? [] : [appFrame]),
    ],
    events: [{ id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 }],
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-rsskip-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('computeRsSkip', () => {
  it('traces a skip to the nearest app frame through a buffer event', () => {
    // Skip at 1e9+4ms; AcquireBuffer at 1e9+3ms; the app frame starts at
    // 1e9+3.5ms, so the gap between event and frame is 500µs.
    const db = dbWith('trace.db', {
      ...skipFrameFixture({ id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
    });
    const r = computeRsSkip(db, opts());
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].events).toBe(1);
    expect(r.frames[0].traced?.frame.id).toBe(21);
    expect(r.frames[0].traced?.timeDiffNs).toBe(500_000);
    expect(r.frames[0].traced?.eventNs).toBe(1e9 + 3e6);
    db.close();
  });

  it('leaves the trace undefined when no buffer event precedes the skip', () => {
    const db = dbWith('no-buffer.db', skipFrameFixture(
      { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
    ));
    expect(computeRsSkip(db, opts()).frames[0].traced).toBeUndefined();
    db.close();
  });

  it('does not attribute another process’s frame to the app', () => {
    // The nearest frame belongs to ipid 18, which is not the analyzed app.
    const db = dbWith('other-process.db', {
      ...skipFrameFixture({ id: 22, ts: 1e9 + 3.5e6, dur: 16e6, ipid: 18, itid: 45 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
    });
    expect(computeRsSkip(db, opts()).frames[0].traced).toBeUndefined();
    db.close();
  });

  it('assigns a skip event to the frame whose inclusive window contains it', () => {
    // The event lands exactly on `ts + dur`; upstream's `>=` keeps it.
    const db = dbWith('inclusive.db', {
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 11, ts: 1e9 + 16e6 + 1, dur: 16e6, ipid: RS, itid: 4 },
      ],
      events: [{ id: 1, ts: 1e9 + 16e6, name: 'H:DisplayNode skip', callid: 4 }],
    });
    const r = computeRsSkip(db, opts());
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0].frame.id).toBe(10);
    db.close();
  });

  it('counts every skip event inside a frame', () => {
    const db = dbWith('two-skips.db', {
      frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
      events: [
        { id: 1, ts: 1e9 + 2e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 12e6, name: 'H:DisplayNode skip', callid: 4 },
      ],
    });
    const r = computeRsSkip(db, opts());
    expect(r.frames[0].events).toBe(2);
    expect(r.totalEvents).toBe(2);
    db.close();
  });

  it('picks the closest of several buffer events', () => {
    const db = dbWith('nearest.db', {
      ...skipFrameFixture({ id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 - 100e6, name: 'H:AcquireBuffer', callid: 4 },
        { id: 3, ts: 1e9 + 3e6, name: 'H:DoFlushBuffer', callid: 4 },
      ],
    });
    expect(computeRsSkip(db, opts()).frames[0].traced?.eventNs).toBe(1e9 + 3e6);
    db.close();
  });

  it('ignores buffer events beyond the 500ms lookback', () => {
    const db = dbWith('too-old.db', {
      ...skipFrameFixture({ id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        // 600ms before the frame start: outside the window.
        { id: 2, ts: 1e9 - 600e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
    });
    expect(computeRsSkip(db, opts()).frames[0].traced).toBeUndefined();
    db.close();
  });

  it('returns no frames when the trace has no skip events', () => {
    const db = dbWith('no-skip.db', {
      frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
    });
    expect(computeRsSkip(db, opts())).toEqual({ frames: [], totalEvents: 0 });
    db.close();
  });
});

describe('RsSkipAnalyzer', () => {
  it('reports accuracy over the skip frames it found', async () => {
    // Two RS frames with skips. The first has a buffer event and an app frame
    // near it; the second is two seconds later, far past the 500ms lookback of
    // every buffer event, so it stays untraced.
    const db = dbWith('accuracy.db', {
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 11, ts: 1e9 + 2e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
        { id: 3, ts: 1e9 + 2e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
      ],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(metricOf(r, 'rs_skip.frames.count').value).toBe(2);
    expect(metricOf(r, 'rs_skip.events.count').value).toBe(2);
    expect(metricOf(r, 'rs_skip.traced.count').value).toBe(1);
    expect(metricOf(r, 'rs_skip.trace.accuracy').value).toBeCloseTo(50, 6);
    db.close();
  });

  it('emits one evidence item per skip frame with its drill-downs', async () => {
    const db = dbWith('evidence.db', {
      ...skipFrameFixture({ id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    const items = r.evidence.filter((e) => e.kind === 'rs_skip');
    expect(items).toHaveLength(1);
    expect(items[0].subject.process).toBe('render_service');
    expect(items[0].window).toEqual({ startNs: 1e9, endNs: 1e9 + 16e6 });
    expect(items[0].severity).toBe('warn');
    expect(items[0].signals).toMatchObject({
      skipEvents: 1, appFrameId: 21, appFrameFlag: 0, method: 'nativewindow',
    });
    expect(items[0].drillDown.map((d) => d.tool)).toEqual(['callstack.matching', 'frames.get']);
    db.close();
  });

  it('omits the trace metrics when the app is unknown, instead of an exact 0%', async () => {
    // The reverse trace needs the app's ipid to find the frames RS consumed.
    // Without it the trace never runs, so `traced = 0` is not a measurement and
    // must not be reported as `exact` — the same guard `gc` applies.
    const db = dbWith('no-app.db', {
      ...skipFrameFixture({ id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 }),
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
    });
    const r = await new RsSkipAnalyzer().run({
      ...ctxWith(db),
      app: { packageName: 'com.missing', pids: [], processNames: ['com.missing'] },
    });
    expect(metricOf(r, 'rs_skip.frames.count').value).toBe(1);
    const ids = r.metrics.map((m) => m.id);
    expect(ids).not.toContain('rs_skip.trace.accuracy');
    expect(ids).not.toContain('rs_skip.traced.count');
    expect(metricOf(r, 'rs_skip.trace.degraded').fidelity).toBe('proxy');
    expect(metricOf(r, 'rs_skip.trace.degraded').degraded?.reason).toContain('no app process');
    db.close();
  });

  it('emits no_data when the trace has no DisplayNode skip events', async () => {
    const db = dbWith('empty.db', {
      frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(r.metrics).toEqual([]);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].kind).toBe('no_data');
    expect(r.evidence[0].explain).toContain('DisplayNode skip');
    db.close();
  });

  it('emits no_data when the trace has no RenderService process', async () => {
    const db = dbWith('no-rs.db', { frames: [] });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(r.metrics).toEqual([]);
    expect(r.evidence[0].explain).toContain('render_service');
    db.close();
  });
});

describe('rs-skip CPU waste (parity row 12)', () => {
  /*
   * HapRay's `cpu_waste` is the point of the capability: a frame the app built
   * and RS then declined to composite is CPU spent for nothing. The waste is
   * the app frame's own duration — the work exists, and the screen never got
   * it.
   *
   * An untraced skip has no app frame, so it contributes no waste. Counting
   * the RS frame's duration there would charge the app for work it never did.
   */
  it('sums the traced app frames\' durations as the wasted CPU time', async () => {
    const db = dbWith('waste.db', {
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 11, ts: 1e9 + 2e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 12e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
        { id: 3, ts: 1e9 + 2e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
      ],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    // Only frame 21 was traced; the second skip has no app frame.
    expect(metricOf(r, 'rs_skip.cpu_waste.ms').value).toBe(12);
    db.close();
  });

  it('omits cpu_waste when nothing was traced', async () => {
    // Zero milliseconds of waste would claim the app did no work — for a
    // capture where the trace could not say. Absence, not zero.
    const db = dbWith('waste-none.db', {
      frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
      events: [{ id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 }],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(r.metrics.map((m) => m.id)).not.toContain('rs_skip.cpu_waste.ms');
    db.close();
  });
});

describe('rs-skip system-API backtracking (parity row 12)', () => {
  /*
   * HapRay tries `frame_rs_skip_backtrack_api.py` first and only falls back to
   * the NativeWindow path when it finds nothing. The API path is what makes
   * ArkUI/RN/KMP skips traceable at all: those frameworks submit through
   * `UnMarsh RSTransactionData`, which names the app's pid in its own event
   * name, so no buffer event has to be guessed at.
   *
   *   UnMarsh on an RS IPC thread  →  its `sched_wakeup` names the waker itid
   *   waker itid belongs to app pid  →  nearest app frame in [event-500ms, +10ms]
   *
   * When the wakeup does not name an app thread, HapRay walks the wakeup chain
   * up to 5 hops before giving up. That path is ported too, because on a real
   * trace the RS IPC thread is frequently woken by an OS thread rather than by
   * the app directly.
   */
  /** RS frame with one skip; the app's ipid/pid are `APP` / 6115. */
  const rsSkip = (extra: Partial<Fixture> = {}): Fixture => ({
    frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
    events: [{ id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 }],
    ...extra,
  });

  /** The unmarsh event the API path reads its pid from. */
  const unmarsh = (ts: number, pid: number): EventRow => ({
    id: 90, ts, callid: 4, name: `H:UnMarsh RSTransactionData: recv data from ${pid}|M0538`,
  });

  it('traces through the IPC wakeup when the waker is an app thread', async () => {
    const db = dbWith('api-wakeup.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        unmarsh(1e9 + 2e6, 6115),
      ],
      // The RS IPC thread (itid 4) was woken by the app thread (itid 44).
      wakeups: [[4, 44, 1e9 + 1.5e6]],
    }));
    const r = computeRsSkip(db, opts());
    expect(r.frames[0].traced?.frame.id).toBe(21);
    expect(r.frames[0].traced?.method).toBe('rs_api');
    db.close();
  });

  it('walks the wakeup chain when an OS thread woke the IPC thread', async () => {
    // itid 45 belongs to ohos.sceneboard (ipid 18), not the app. The chain
    // goes 4 ← 45 ← 44, so the app thread is two hops back.
    const db = dbWith('api-chain.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        unmarsh(1e9 + 2e6, 6115),
      ],
      wakeups: [
        [4, 45, 1e9 + 1.5e6],
        [45, 44, 1e9 + 1.4e6],
      ],
    }));
    const r = computeRsSkip(db, opts());
    expect(r.frames[0].traced?.frame.id).toBe(21);
    expect(r.frames[0].traced?.method).toBe('rs_api');
    db.close();
  });

  it('falls back to the NativeWindow path when the API path finds nothing', async () => {
    // An UnMarsh event with no wakeup at all: the API path has no thread to
    // follow, so the buffer path must still find the frame.
    const db = dbWith('api-fallback.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
        unmarsh(1e9 + 2e6, 6115),
      ],
    }));
    const r = computeRsSkip(db, opts());
    expect(r.frames[0].traced?.frame.id).toBe(21);
    expect(r.frames[0].traced?.method).toBe('nativewindow');
    db.close();
  });

  it('does not credit a pid that is not the analyzed app', async () => {
    // The UnMarsh names pid 9999. The wakeup points at a thread of that
    // process, but it is not the app under analysis, so the trace must fail
    // rather than borrow another process's frame.
    const db = dbWith('api-other-pid.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        unmarsh(1e9 + 2e6, 9999),
      ],
      wakeups: [[4, 44, 1e9 + 1.5e6]],
    }));
    expect(computeRsSkip(db, opts()).frames[0].traced).toBeUndefined();
    db.close();
  });

  it('names the method that produced the trace in the evidence', async () => {
    const db = dbWith('api-evidence.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        unmarsh(1e9 + 2e6, 6115),
      ],
      wakeups: [[4, 44, 1e9 + 1.5e6]],
    }));
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    const item = r.evidence.find((e) => e.kind === 'rs_skip');
    expect(item?.signals.method).toBe('rs_api');
    expect(item?.explain).toContain('UnMarsh');
    db.close();
  });

  it('degrades rather than guessing when the trace has no instant table', async () => {
    // `trace.sched` is what supplies `instant`. Without it the API path is
    // unavailable, and the NativeWindow path still answers — the metric must
    // not claim the API path ran.
    const db = dbWith('api-no-instant.db', rsSkip({
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 16e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 2, ts: 1e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
        unmarsh(1e9 + 2e6, 6115),
      ],
      noInstant: true,
    }));
    const r = computeRsSkip(db, opts());
    expect(r.frames[0].traced?.method).toBe('nativewindow');
    db.close();
  });
});

describe('rs-skip instruction waste and detection breakdown (parity row 12)', () => {
  /*
   * HapRay charges the wasted work in sampled instruction weight, not only in
   * milliseconds: `calculate_app_frame_cpu_waste` sums `perf_sample.event_count`
   * for every app-process thread inside the traced frame's window. A duration
   * says how long the app spun; the weight says how much work that was, and on
   * a busy thread the two disagree by an order of magnitude.
   *
   * The detection breakdown is what tells a reader whether the port actually
   * works on their trace: `rs_api` success means the framework submits through
   * UnMarsh (ArkUI/RN/KMP), `nativewindow` means the buffer path. A port that
   * silently reports only the total hides which half ran.
   */
  const tracedThroughApi = (perf?: Fixture['perf']): Fixture => ({
    frames: [
      { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
      { id: 21, ts: 1e9 + 3.5e6, dur: 12e6, ipid: APP, itid: 44 },
    ],
    events: [
      { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
      { id: 90, ts: 1e9 + 2e6, callid: 4,
        name: 'H:UnMarsh RSTransactionData: recv data from 6115|M0538' },
    ],
    wakeups: [[4, 44, 1e9 + 1.5e6]],
    ...(perf === undefined ? {} : { perf }),
  });

  it('sums the app thread weight inside the traced frame as instruction waste', async () => {
    // Samples at 1e9+4ms (weight 100) and 1e9+10ms (weight 250) fall inside
    // the traced frame [1e9+3.5ms, 1e9+15.5ms]; the one at 1e9+20ms does not.
    const db = dbWith('api-waste.db', tracedThroughApi([
      { ts: 1e9 + 4e6, threadId: 440, count: 100 },
      { ts: 1e9 + 10e6, threadId: 440, count: 250 },
      { ts: 1e9 + 20e6, threadId: 440, count: 999 },
    ]));
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(metricOf(r, 'rs_skip.cpu_waste.instructions').value).toBe(350);
    expect(metricOf(r, 'rs_skip.cpu_waste.instructions').unit).toBe('count');
    db.close();
  });

  it('omits the instruction metric when the scene has no perf samples', async () => {
    // Zero instructions would claim the app did no work; there was simply no
    // sampling. Absence, not zero — the same rule as the millisecond metric.
    const db = dbWith('api-waste-none.db', tracedThroughApi());
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(r.metrics.map((m) => m.id)).not.toContain('rs_skip.cpu_waste.instructions');
    // The millisecond waste still stands: it comes from the frame, not perf.
    expect(metricOf(r, 'rs_skip.cpu_waste.ms').value).toBe(12);
    db.close();
  });

  it('reports how many frames each backtracking method traced', async () => {
    // One skip frame traced through the API path, one through the buffer path.
    const db = dbWith('api-breakdown.db', {
      frames: [
        { id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 11, ts: 1e9 + 2e9, dur: 16e6, ipid: RS, itid: 4 },
        { id: 21, ts: 1e9 + 3.5e6, dur: 12e6, ipid: APP, itid: 44 },
        { id: 22, ts: 1e9 + 2e9 + 3.5e6, dur: 12e6, ipid: APP, itid: 44 },
      ],
      events: [
        { id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 90, ts: 1e9 + 2e6, callid: 4,
          name: 'H:UnMarsh RSTransactionData: recv data from 6115|M0538' },
        // The second frame has no UnMarsh, only a buffer event.
        { id: 3, ts: 1e9 + 2e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 },
        { id: 4, ts: 1e9 + 2e9 + 3e6, name: 'H:AcquireBuffer', callid: 4 },
      ],
      wakeups: [[4, 44, 1e9 + 1.5e6]],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    expect(metricOf(r, 'rs_skip.traced.rs_api.count').value).toBe(1);
    expect(metricOf(r, 'rs_skip.traced.nativewindow.count').value).toBe(1);
    db.close();
  });

  it('omits the breakdown when nothing traced, instead of two zeros', async () => {
    const db = dbWith('api-breakdown-none.db', {
      frames: [{ id: 10, ts: 1e9, dur: 16e6, ipid: RS, itid: 4 }],
      events: [{ id: 1, ts: 1e9 + 4e6, name: 'H:DisplayNode skip', callid: 4 }],
    });
    const r = await new RsSkipAnalyzer().run(ctxWith(db));
    const ids = r.metrics.map((m) => m.id);
    expect(ids).not.toContain('rs_skip.traced.rs_api.count');
    expect(ids).not.toContain('rs_skip.traced.nativewindow.count');
    db.close();
  });
});
