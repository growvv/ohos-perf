// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import type { Frame } from '../query/frames';
import { FrameQuery } from '../query/frames';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { TimeRange } from '../types';
import { resolveAppIpids } from './context';
import { FrameLoadIndex } from './frame-load';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * RenderService-skip reverse tracing.
 *
 * Ported from `frame_analyzer_rs_skip.py` and `frame_rs_skip_backtrack_nw.py`.
 * A `DisplayNode skip` event on a RenderService thread means RS decided not to
 * composite a frame. Working backwards, the app frame that fed that decision is
 * found through the NativeWindow buffer events RS consumed:
 *
 * 1. every RenderService `frame_slice` row whose inclusive `[ts, ts + dur]`
 *    contains a skip event holds that event;
 * 2. for each such frame, the five buffer events (`AcquireBuffer`,
 *    `DoFlushBuffer`, `ConsumeAndUpdateAllNodes`) nearest to the frame's start
 *    within a 500 ms lookback are candidates;
 * 3. for each candidate, the ten app frames nearest to the event within
 *    `[event - 500 ms, event + 10 ms]` are candidates;
 * 4. the closest (app frame, event) pair wins; no pair leaves the frame
 *    untraced.
 *
 * ## Ids
 *
 * HapRay numbers frames by SQLite **`rowid`**, which is `frame_slice.id + 1`.
 * `Frame.id` is the `id` column, and evidence and `frames.get` both use it, so
 * this port reports `id` throughout. On the measured `real_device` trace the
 * four traced frames are ids 294/306/314/318 (rowids 295/307/315/319).
 *
 * ## Why the raw SQL
 *
 * The joins (`callstack ⋈ thread`, `frame_slice` self-relations) are not
 * covered by a query class. `trace.ark` is required alongside `trace.frames`
 * precisely so `callstack`/`thread`/`process` exist and this module can never
 * hit `no such table`.
 */

/** RS buffer-API events that carry a submitted frame. */
const BUFFER_PATTERNS = [
  '%AcquireBuffer%',
  '%DoFlushBuffer%',
  '%ConsumeAndUpdateAllNodes%',
] as const;

/** The skip event this analyzer traces back from. */
const SKIP_PATTERN = '%DisplayNode skip%';

/** RS frame start lookback for buffer events, in nanoseconds (500 ms). */
const EVENT_LOOKBACK_NS = 500_000_000;
/** App-frame lookahead past a buffer event, in nanoseconds (10 ms). */
const APP_LOOKAHEAD_NS = 10_000_000;
/** HapRay keeps the five buffer events nearest the frame start. */
const MAX_EVENTS = 5;
/** HapRay keeps the ten app frames nearest each buffer event. */
const MAX_APP_FRAMES = 10;
/** How far either side of an `UnMarsh` event its `sched_wakeup` may sit. */
const WAKEUP_WINDOW_NS = 10_000_000;
/** How many wakeup hops HapRay walks looking for an app thread. */
const MAX_CHAIN_DEPTH = 5;

/** Which backtracking method produced a trace. */
export type RsSkipTraceMethod = 'rs_api' | 'nativewindow';

/** One RenderService frame that skipped, and what it traced back to. */
export interface RsSkipFrame {
  frame: Frame;
  /** `DisplayNode skip` rows inside the frame's inclusive window. */
  events: number;
  traced?: {
    frame: Frame;
    /** The buffer or `UnMarsh` event's timestamp. */
    eventNs: number;
    /** `|appFrame.ts - eventNs|`. */
    timeDiffNs: number;
    method: RsSkipTraceMethod;
  };
}

export interface RsSkipResult {
  /** RenderService frames with at least one skip event, ordered by `ts`. */
  frames: RsSkipFrame[];
  /** Every skip event assigned to a frame. */
  totalEvents: number;
}

/** `frame_slice` columns needed to place a frame without a `Frame` row. */
interface SkipRow {
  frame_id: number | null;
  skip_ts: number | null;
}

/** A buffer-API event on a RenderService thread. */
interface BufferRow {
  ts: number | null;
}

/** `places` in `[ts - before, ts + after]`, nearest to `ts` first. */
function nearest(
  values: readonly number[],
  anchor: number,
  before: number,
  after: number,
  limit: number,
): number[] {
  return values
    .filter((value) => value >= anchor - before && value <= anchor + after)
    .sort((a, b) => {
      const distance = Math.abs(a - anchor) - Math.abs(b - anchor);
      return distance !== 0 ? distance : a - b;
    })
    .slice(0, limit);
}

/**
 * Resolves the RenderService ipids a trace actually has.
 *
 * Only the name HapRay's own queries use: `render_service`. A trace whose
 * RenderService row is named something else simply yields no ipid, and the
 * analyzer says so instead of guessing.
 */
function renderServiceIpids(processes: { all(): Array<{ ipid: number; name: string }> }): number[] {
  const ipids: number[] = [];
  for (const process of processes.all()) {
    if (process.name === 'render_service' && !ipids.includes(process.ipid)) {
      ipids.push(process.ipid);
    }
  }
  return ipids;
}

/** `callstack`/`instant`/`thread` are all the API path reads. */
function hasTable(db: QueryHandle, name: string): boolean {
  return (
    db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    ).length > 0
  );
}

/** `recv data from <pid>` in an `UnMarsh RSTransactionData` event name. */
const UNMARSH_PID = /recv data from (\d+)/;

/** The pid an `UnMarsh` event says the transaction came from. */
export function parseUnmarshPid(name: string): number | undefined {
  const match = UNMARSH_PID.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** One `sched_wakeup` row, in the shape the chain walk needs. */
interface WakeupRow {
  ref: number | null;
  wakeup_from: number | null;
  ts: number | null;
}

/** Everything the API path needs, read once per analysis. */
interface ApiCaches {
  /** `itid` → `(waker itid, ts)`, newest first. */
  wakeups: Map<number, Array<{ from: number; ts: number }>>;
  /** `itid` → the pid of the process that owns it. */
  threadPid: Map<number, number>;
  /** app pid → the itid of its UI thread, when the trace names one. */
  uiThread: Map<number, number>;
  /** `UnMarsh` events on RenderService threads, by frame window. */
  unmarsh: Array<{ ts: number; itid: number; pid: number }>;
}

/**
 * Reads the tables the system-API backtracking needs.
 *
 * Returns `undefined` when the trace lacks `instant`: without it the API path
 * cannot follow a wakeup, and claiming it ran would be a guess. `thread` and
 * `process` are already required by `trace.ark`.
 */
function readApiCaches(db: QueryHandle, rsIpids: readonly number[]): ApiCaches | undefined {
  if (!hasTable(db, 'instant')) return undefined;

  const wakeups = new Map<number, Array<{ from: number; ts: number }>>();
  const rows = db.query<WakeupRow>(
    `SELECT ref, wakeup_from, ts FROM instant
WHERE name = 'sched_wakeup' AND ref_type = 'itid'
  AND ref IS NOT NULL AND wakeup_from IS NOT NULL AND ts IS NOT NULL
ORDER BY ref, ts DESC`,
  );
  for (const row of rows) {
    if (row.ref === null || row.wakeup_from === null || row.ts === null) continue;
    const list = wakeups.get(row.ref);
    if (list === undefined) wakeups.set(row.ref, [{ from: row.wakeup_from, ts: row.ts }]);
    else list.push({ from: row.wakeup_from, ts: row.ts });
  }

  const threadPid = new Map<number, number>();
  const uiThread = new Map<number, number>();
  for (const row of db.query<{ id: number; name: string | null; pid: number; process: string | null }>(
    `SELECT t.id, t.name, p.pid, p.name AS process
FROM thread t JOIN process p ON t.ipid = p.ipid
ORDER BY t.id`,
  )) {
    threadPid.set(row.id, row.pid);
    // HapRay's UI-thread rule: the process-named thread first, then any name
    // containing `UI`/`ui`. `ORDER BY t.id` makes the tie-break deterministic.
    const named = row.name === row.process;
    const uiLike = row.name !== null && (row.name.includes('UI') || row.name.includes('ui'));
    if ((named || uiLike) && !uiThread.has(row.pid)) uiThread.set(row.pid, row.id);
  }

  const rsMarks = rsIpids.map(() => '?').join(', ');
  const unmarsh: ApiCaches['unmarsh'] = [];
  for (const row of db.query<{ ts: number | null; callid: number | null; name: string | null }>(
    `SELECT c.ts, c.callid, c.name FROM callstack c
JOIN thread t ON c.callid = t.id
WHERE t.ipid IN (${rsMarks}) AND c.name LIKE '%UnMarsh RSTransactionData%'
ORDER BY c.ts`,
    [...rsIpids],
  )) {
    if (row.ts === null || row.callid === null || row.name === null) continue;
    const pid = parseUnmarshPid(row.name);
    // A `data size:` row names no pid; only `recv data from` can be traced.
    if (pid === undefined) continue;
    unmarsh.push({ ts: row.ts, itid: row.callid, pid });
  }

  return { wakeups, threadPid, uiThread, unmarsh };
}

/**
 * The wakeup nearest `ts` on `itid`, searching `[ts - before, ts + after]`.
 *
 * HapRay's chain step searches only backwards; its first hop searches both
 * ways. Both bounds are parameters so each caller can match its own window.
 */
function nearestWakeup(
  caches: ApiCaches,
  itid: number,
  ts: number,
  before: number,
  after: number,
): { from: number; ts: number } | undefined {
  let best: { from: number; ts: number } | undefined;
  let bestDiff = Infinity;
  for (const wakeup of caches.wakeups.get(itid) ?? []) {
    if (wakeup.ts < ts - before || wakeup.ts > ts + after) continue;
    const diff = Math.abs(wakeup.ts - ts);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = wakeup;
    }
  }
  return best;
}

/**
 * The app thread an `UnMarsh` event can be attributed to, or `undefined`.
 *
 * HapRay tries the direct waker first (the RS IPC thread's `sched_wakeup`
 * names an app thread), then walks up to {@link MAX_CHAIN_DEPTH} hops back
 * looking for one. A waker belonging to another process is not the app: the
 * walk keeps going rather than borrowing a stranger's frame.
 */
function appThreadFor(caches: ApiCaches, ipcItid: number, eventNs: number, appPid: number): number | undefined {
  let current = nearestWakeup(caches, ipcItid, eventNs, WAKEUP_WINDOW_NS, WAKEUP_WINDOW_NS);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && current !== undefined; depth += 1) {
    if (caches.threadPid.get(current.from) === appPid) return current.from;
    // The chain step searches backwards only, from the wakeup it just found.
    current = nearestWakeup(caches, current.from, current.ts, EVENT_LOOKBACK_NS, 0);
  }
  return undefined;
}

/**
 * Traces every RenderService skip back to the app frame that fed it.
 *
 * Both `appIpids` and `rsIpids` must already be resolved; an empty list matches
 * nothing rather than widening the query. `window` bounds the RenderService
 * frames and the skip events considered — the buffer and app-frame windows are
 * relative to each frame, so they may reach slightly outside it.
 */
export function computeRsSkip(
  db: QueryHandle,
  opts: { window: TimeRange; appIpids: readonly number[]; rsIpids: readonly number[] },
): RsSkipResult {
  if (opts.rsIpids.length === 0) return { frames: [], totalEvents: 0 };

  const rsMarks = opts.rsIpids.map(() => '?').join(', ');
  const rows = db.query<SkipRow>(
    `SELECT fs.id AS frame_id, c.ts AS skip_ts
FROM callstack c
JOIN thread t ON c.callid = t.id
JOIN frame_slice fs ON fs.ipid = t.ipid
WHERE c.name LIKE ?
  AND t.ipid IN (${rsMarks})
  AND fs.type = 0
  AND fs.flag IS NOT NULL
  AND fs.ts >= ? AND fs.ts <= ?
  AND c.ts >= ? AND c.ts <= ?
  AND fs.ts <= c.ts
  AND fs.ts + COALESCE(fs.dur, 0) >= c.ts
ORDER BY fs.ts, fs.id, c.ts`,
    [SKIP_PATTERN, ...opts.rsIpids, opts.window.startNs, opts.window.endNs,
      opts.window.startNs, opts.window.endNs],
  );
  if (rows.length === 0) return { frames: [], totalEvents: 0 };

  // Skip events per frame, in the query's deterministic order.
  const skipsByFrame = new Map<number, number>();
  for (const row of rows) {
    if (row.frame_id === null) continue;
    skipsByFrame.set(row.frame_id, (skipsByFrame.get(row.frame_id) ?? 0) + 1);
  }

  // Frames are read through FrameQuery so `Frame.flag` is never a coerced NULL.
  const rsFrames = allFrames(db, opts.window).filter(
    (frame) => frame.type === 0 && opts.rsIpids.includes(frame.ipid),
  );
  const frames = rsFrames
    .filter((frame) => skipsByFrame.has(frame.id))
    .map((frame) => ({ frame, events: skipsByFrame.get(frame.id) ?? 0 }));

  if (frames.length === 0 || opts.appIpids.length === 0) {
    return {
      frames: frames.map((entry) => ({ ...entry })),
      totalEvents: rows.length,
    };
  }

  // One buffer-event query over the union of every frame's lookback window.
  // A reduce, not `Math.min(...)`: one argument per frame overflows V8's
  // argument limit (about 124k) on a long capture and throws instead of
  // returning a result.
  const minNs =
    frames.reduce((min, entry) => Math.min(min, entry.frame.ts), frames[0].frame.ts) -
    EVENT_LOOKBACK_NS;
  const maxNs = frames.reduce(
    (max, entry) => Math.max(max, entry.frame.ts + entry.frame.dur),
    frames[0].frame.ts + frames[0].frame.dur,
  );
  const bufferPatterns = BUFFER_PATTERNS.map(() => 'c.name LIKE ?').join(' OR ');
  const bufferRows = db.query<BufferRow>(
    `SELECT c.ts AS ts
FROM callstack c
JOIN thread t ON c.callid = t.id
WHERE t.ipid IN (${rsMarks})
  AND (${bufferPatterns})
  AND c.ts >= ? AND c.ts <= ?
ORDER BY c.ts`,
    [...opts.rsIpids, ...BUFFER_PATTERNS, minNs, maxNs],
  );
  const bufferTs = bufferRows
    .map((row) => row.ts)
    .filter((ts): ts is number => ts !== null);

  const appFrames = allFrames(db, opts.window).filter(
    (frame) => frame.type === 0 && opts.appIpids.includes(frame.ipid),
  );
  // One frame per timestamp, lowest `id` winning: `frame_slice` can hold two
  // frames at the same `ts`, and `ORDER BY ts` does not order the tie.
  const appByTs = new Map<number, Frame>();
  for (const frame of appFrames) {
    const existing = appByTs.get(frame.ts);
    if (existing === undefined || frame.id < existing.id) appByTs.set(frame.ts, frame);
  }
  const appTs = [...appByTs.keys()].sort((a, b) => a - b);

  // The system-API path: an `UnMarsh` event on an RS IPC thread names the pid
  // that sent the transaction, and the thread that woke that IPC thread (or a
  // chain of wakeups behind it) is the app thread whose frame was submitted.
  // HapRay tries this first and falls back to the buffer path.
  const api = readApiCaches(db, opts.rsIpids);
  const appPidSet = new Set<number>();
  for (const ipid of opts.appIpids) {
    // The pid a process row carries; `appIpids` is all this function receives.
    const row = db.query<{ pid: number | null }>(
      'SELECT pid FROM process WHERE ipid = ? ORDER BY id LIMIT 1',
      [ipid],
    )[0];
    if (row?.pid !== null && row?.pid !== undefined) appPidSet.add(row.pid);
  }

  /** Nearest app frame to `eventNs`, from the app threads the event names. */
  const apiTrace = (frame: Frame): RsSkipFrame['traced'] => {
    if (api === undefined) return undefined;
    const inWindow = api.unmarsh.filter(
      (event) =>
        event.ts >= frame.ts - EVENT_LOOKBACK_NS && event.ts <= frame.ts + frame.dur,
    );
    // HapRay keeps the five events nearest the frame start.
    inWindow.sort((a, b) => Math.abs(a.ts - frame.ts) - Math.abs(b.ts - frame.ts) || a.ts - b.ts);
    let best: RsSkipFrame['traced'];
    for (const event of inWindow.slice(0, MAX_EVENTS)) {
      // Only the app under analysis: another pid's transaction is not ours.
      if (!appPidSet.has(event.pid)) continue;
      const threadItid = appThreadFor(api, event.itid, event.ts, event.pid);
      if (threadItid === undefined) continue;
      const near = nearest(appTs, event.ts, EVENT_LOOKBACK_NS, APP_LOOKAHEAD_NS, MAX_APP_FRAMES);
      for (const ts of near) {
        const match = appByTs.get(ts);
        if (match === undefined || match.itid !== threadItid) continue;
        const timeDiffNs = Math.abs(ts - event.ts);
        if (best !== undefined && timeDiffNs >= best.timeDiffNs) continue;
        best = { frame: match, eventNs: event.ts, timeDiffNs, method: 'rs_api' };
      }
    }
    return best;
  };

  const traced = frames.map((entry) => {
    const frame = entry.frame;
    const viaApi = apiTrace(frame);
    if (viaApi !== undefined) return { ...entry, traced: viaApi };

    const candidates = nearest(bufferTs, frame.ts, EVENT_LOOKBACK_NS, frame.dur, MAX_EVENTS);
    let best: RsSkipFrame['traced'];

    for (const eventNs of candidates) {
      const near = nearest(appTs, eventNs, EVENT_LOOKBACK_NS, APP_LOOKAHEAD_NS, MAX_APP_FRAMES);
      for (const ts of near) {
        const timeDiffNs = Math.abs(ts - eventNs);
        if (best !== undefined && timeDiffNs >= best.timeDiffNs) continue;
        const match = appByTs.get(ts);
        if (match === undefined) continue;
        best = { frame: match, eventNs, timeDiffNs, method: 'nativewindow' };
      }
    }
    return { ...entry, ...(best === undefined ? {} : { traced: best }) };
  });

  return { frames: traced, totalEvents: rows.length };
}

/** Every complete frame in `window`, read through the typed accessor. */
function allFrames(db: QueryHandle, window: TimeRange): Frame[] {
  return new FrameQuery(db).all(window);
}

/**
 * Summed `perf_sample.event_count` inside every traced frame, or `undefined`.
 *
 * HapRay sums the app **process's** threads, not the frame's own thread: the
 * work a skipped frame cost includes whatever its workers did for it. That is
 * the same scope `frame-load` measures, so the index is reused rather than
 * re-querying.
 *
 * `undefined` when there is nothing to measure — no perf capture, no app
 * thread, or no sample inside any window. Zero instructions would be a
 * measurement the capture never made.
 */
function instructionWaste(ctx: AnalyzeContext, frames: readonly RsSkipFrame[]): number | undefined {
  if (ctx.perf === undefined || !ctx.perf.hasSamples()) return undefined;
  if (ctx.app.pids.length === 0) return undefined;

  const tracedFrames = frames
    .map((entry) => entry.traced?.frame)
    .filter((frame): frame is Frame => frame !== undefined);
  if (tracedFrames.length === 0) return undefined;

  const firstTs = tracedFrames.reduce((min, frame) => Math.min(min, frame.ts), tracedFrames[0].ts);
  const lastEnd = tracedFrames.reduce(
    (max, frame) => Math.max(max, frame.ts + Math.max(0, frame.dur)),
    tracedFrames[0].ts + Math.max(0, tracedFrames[0].dur),
  );
  const index = FrameLoadIndex.build({
    perf: ctx.perf,
    pids: ctx.app.pids,
    range: { startNs: firstTs, endNs: lastEnd },
  });
  if (index === undefined) return undefined;

  let total = 0;
  for (const frame of tracedFrames) total += index.load(frame);
  return total > 0 ? total : undefined;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort order for evidence: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * Emits `rs_skip.*` metrics and one `rs_skip` evidence per RenderService frame
 * that skipped.
 *
 * `rs_skip.trace.accuracy` is traced / skip frames × 100 — HapRay's
 * `trace_accuracy`, emitted only when at least one skip frame exists. A trace
 * with no `render_service` process or no skip event produces one `no_data` item
 * naming what is missing rather than four fabricated zeros.
 */
export class RsSkipAnalyzer implements Analyzer {
  readonly id = 'rs-skip';
  readonly requires: CapabilityId[] = ['trace.frames', 'trace.ark'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return noData(ctx, 'the trace database handle is not available');
    }
    const rsIpids = renderServiceIpids(ctx.processes);
    if (rsIpids.length === 0) {
      return noData(ctx, 'the trace has no render_service process, so there is no RS skip to trace');
    }

    const appIpids = resolveAppIpids(ctx.processes, ctx.app);
    // The reverse trace needs the app's ipid to recognise the frames RS
    // consumed. Without it `computeRsSkip` never attempts a trace, so the
    // trace metrics would be an unmeasured 0 dressed as `exact`.
    const appKnown = appIpids.length > 0;
    const result = computeRsSkip(ctx.db, { window: ctx.window, appIpids, rsIpids });

    if (result.frames.length === 0) {
      return noData(
        ctx,
        'no DisplayNode skip event fell inside a render_service frame in this window, ' +
        'so no frame was skipped by RenderService',
      );
    }

    const traced = result.frames.filter((entry) => entry.traced !== undefined).length;
    const prov = {
      collector: 'hitrace',
      table: 'frame_slice',
      rows: result.frames.length,
      device: ctx.deviceId,
    };
    const metrics: Metric[] = [
      metric({
        id: 'rs_skip.events.count',
        value: result.totalEvents,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'rs_skip.frames.count',
        value: result.frames.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];
    if (appKnown) {
      // Wasted CPU: the app built a frame, RS declined to composite it, so the
      // work is spent for nothing. The waste is the app frame's own duration.
      // An untraced skip contributes nothing — there is no app frame to charge.
      let wasteNs = 0;
      for (const entry of result.frames) {
        if (entry.traced !== undefined) wasteNs += entry.traced.frame.dur;
      }

      metrics.push(
        metric({
          id: 'rs_skip.trace.accuracy',
          value: (traced / result.frames.length) * 100,
          unit: '%',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
        metric({
          id: 'rs_skip.traced.count',
          value: traced,
          unit: 'count',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
      );
      // Absent, not zero, when nothing traced: `0 ms` of waste would claim the
      // app did no wasted work on a capture where the trace could not say.
      if (wasteNs > 0) {
        metrics.push(
          metric({
            id: 'rs_skip.cpu_waste.ms',
            value: wasteNs / 1e6,
            unit: 'ms',
            provenance: prov,
            fidelity: 'exact',
            window: ctx.window,
          }),
        );
      }

      // HapRay charges the same waste in sampled instruction weight. Duration
      // says how long the app spun; weight says how much work that was, and a
      // thread that slept through its frame contributes to neither.
      const instructions = instructionWaste(ctx, result.frames);
      if (instructions !== undefined) {
        metrics.push(
          metric({
            id: 'rs_skip.cpu_waste.instructions',
            value: instructions,
            unit: 'count',
            provenance: { collector: 'hiperf', table: 'perf_sample', device: ctx.deviceId },
            fidelity: 'exact',
            window: ctx.window,
          }),
        );
      }

      // Which backtracking method produced each trace. A reader whose trace
      // shows zero `rs_api` frames is on a NativeWindow framework, and one
      // whose trace shows zero of both has no sampling to trace at all.
      const byMethod: Record<RsSkipTraceMethod, number> = { rs_api: 0, nativewindow: 0 };
      for (const entry of result.frames) {
        if (entry.traced !== undefined) byMethod[entry.traced.method] += 1;
      }
      if (traced > 0) {
        for (const method of ['rs_api', 'nativewindow'] as const) {
          metrics.push(
            metric({
              id: `rs_skip.traced.${method}.count`,
              value: byMethod[method],
              unit: 'count',
              provenance: prov,
              fidelity: 'exact',
              window: ctx.window,
            }),
          );
        }
      }
    } else {
      metrics.push(
        metric({
          id: 'rs_skip.trace.degraded',
          value: 0,
          unit: 'count',
          fidelity: 'proxy',
          degraded: {
            reason:
              'no app process was identified in this trace, so a skip cannot be ' +
              'traced back to one of its frames',
            fallback: 'no reverse trace',
          },
          provenance: { collector: 'hitrace', device: ctx.deviceId },
          window: ctx.window,
        }),
      );
    }

    const items = result.frames.map((entry) => {
      const { frame, traced: match } = entry;
      const startNs = frame.ts;
      const endNs = frame.ts + frame.dur;
      const drillDown: Evidence['drillDown'] = [
        {
          label: 'Skip events in frame',
          tool: 'callstack.matching',
          args: { pattern: SKIP_PATTERN, startNs, endNs },
          returns: 'CallstackEvent[]',
          estRows: entry.events,
        },
      ];
      if (match !== undefined) {
        drillDown.push({
          label: 'Traced app frame',
          tool: 'frames.get',
          args: { id: match.frame.id },
          returns: 'Frame',
        });
      }

      return evidence({
        kind: 'rs_skip',
        severity: 'warn',
        // RS decided not to composite, so the frame is RenderService's own.
        subject: { process: 'render_service' },
        window: { startNs, endNs },
        signals: match === undefined
          ? { skipEvents: entry.events }
          : {
            skipEvents: entry.events,
            appFrameId: match.frame.id,
            appFrameFlag: match.frame.flag,
            timeDiffMs: match.timeDiffNs / 1e6,
            method: match.method,
          },
        explain: match === undefined
          ? `render_service skipped ${entry.events} frame(s) at vsync ${frame.vsync}; ` +
            'no app frame could be traced back to it'
          : `render_service skipped the frame at vsync ${frame.vsync}; ` +
            `${appProcessName(ctx)} frame ${match.frame.id} fed it ` +
            (match.method === 'rs_api'
              ? `(${(match.timeDiffNs / 1e6).toFixed(2)}ms from the UnMarsh transaction)`
              : `(${(match.timeDiffNs / 1e6).toFixed(2)}ms from its buffer event)`),
        drillDown,
      });
    });

    metrics.sort(byMetricId);
    items.sort(byEvidenceOrder);
    return { metrics, evidence: items };
  }
}

/** The single `no_data` item used by every unmeasurable path. */
function noData(ctx: AnalyzeContext, explain: string): AnalyzeResult {
  return {
    metrics: [],
    evidence: [
      evidence({
        kind: 'no_data',
        severity: 'info',
        subject: { process: appProcessName(ctx) },
        window: ctx.window,
        signals: {},
        explain,
        drillDown: [],
        key: 'rs-skip:no-data',
      }),
    ],
  };
}
