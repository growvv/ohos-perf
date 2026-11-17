import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
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
}

/** Writes a fixture into a fresh trace database and returns its handle. */
function dbWith(name: string, fixture: Fixture): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  d.exec(CALLSTACK_DDL);
  d.exec(THREAD_DDL);
  d.exec(PROCESS_DDL);
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
  d.close();
  return openDb(path);
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
