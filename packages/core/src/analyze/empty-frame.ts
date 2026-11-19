// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import type { Frame } from '../query/frames';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { resolveAppIpids } from './context';
import { FrameLoadIndex, NO_SAMPLES, noSamplesReason } from './frame-load';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * Empty-frame detection with HapRay's false-positive filters.
 *
 * An empty frame is a `frame_slice` row with `flag = 2` ("nothing needed to be
 * drawn"). The platform records it, but some of those frames were in fact
 * drawn — HapRay filters two shapes of false positive, and this module ports
 * both:
 *
 * 1. **A buffer submission inside the frame.** The frame's own thread
 *    (`frame_slice.itid` joins `thread.id`) emitted a NativeWindow buffer API
 *    event in `[ts, ts + dur]`, so content *was* handed to the compositor.
 *    Ported literally from `frame_analyzer_empty.py::_filter_false_positives`,
 *    including the process-name exclusions (`render_service`, `rmrenderservice`,
 *    `ohos.sceneboard`, `system_%`, `com.ohos.%`) and the four `LIKE` patterns.
 * 2. **A non-empty sibling under the same `vsync` and `itid`.** The same
 *    thread already drew a real frame for this display signal, so the empty row
 *    is a second record of the same present.
 *
 * Rule 1 is a faithful port. Rule 2 is **not present at HapRay `9386e4e`** —
 * the upstream filter has rule 1 only — so it is an additional guard this
 * package adds; it is reported separately (`rule2`) rather than folded into
 * `rule1`, and a caller can tell which rule dropped a frame.
 *
 * Rule 1's process-name clause is unreachable on a well-formed trace: `itid` is
 * a globally unique `thread.id`, so an app frame's thread cannot belong to a
 * system process. It is ported verbatim anyway — it costs one predicate and it
 * is what upstream does.
 *
 * ## Why the raw SQL
 *
 * `CallstackQuery.matching` takes a single `LIKE` pattern, while rule 1 needs
 * four `OR`ed patterns joined to `thread` and `process`. Requiring `trace.ark`
 * alongside `trace.frames` is what guarantees those tables exist, so this
 * module never sees `no such table` — the analyzer degrades instead.
 */

/** HapRay's buffer-API patterns; a frame containing any of them was drawn. */
const BUFFER_PATTERNS = [
  '%RequestBuffer%',
  '%FlushBuffer%',
  '%DoFlushBuffer%',
  '%NativeWindow%',
] as const;

/** Processes whose buffer events never mean the app drew the frame. */
const SYSTEM_PROCESSES = ['render_service', 'rmrenderservice', 'ohos.sceneboard'];

/** The two filter verdicts, plus the frames that survived both. */
export interface EmptyFrameFilter {
  /** Frames no rule dropped. */
  confirmed: Frame[];
  /** Frames dropped by either rule, in input order. */
  filtered: Frame[];
  /** Frames dropped because their own thread submitted a buffer inside them. */
  rule1: Frame[];
  /** Frames dropped because the same `(vsync, itid)` already drew a frame. */
  rule2: Frame[];
}

/** A buffer-API event, keyed by the `thread.id` that emitted it. */
interface BufferEventRow {
  itid: number | null;
  ts: number | null;
}

/**
 * Frames whose own thread emitted a NativeWindow buffer API event inside them.
 *
 * `dur <= 0` means the column was NULL or zero. HapRay computes
 * `ts + NaN`, which is never `>=` an event's timestamp, so a zero-duration
 * frame is never filtered by this rule; matching that behaviour means the
 * window is only checked when it is a real interval.
 */
function ruleOneFrames(db: QueryHandle, frames: readonly Frame[]): Set<Frame> {
  const windows = frames.filter((frame) => frame.dur > 0);
  if (windows.length === 0) return new Set();

  // A reduce, not `Math.min(...)`: one argument per empty frame overflows
  // V8's argument limit (about 124k) on a long capture.
  const minTs = windows.reduce((min, frame) => Math.min(min, frame.ts), windows[0].ts);
  const maxTs = windows.reduce(
    (max, frame) => Math.max(max, frame.ts + frame.dur),
    windows[0].ts + windows[0].dur,
  );

  const patterns = BUFFER_PATTERNS.map(() => 'c.name LIKE ?').join(' OR ');
  const exclusions = SYSTEM_PROCESSES.map(() => '?').join(', ');
  const rows = db.query<BufferEventRow>(
    `SELECT c.callid AS itid, c.ts AS ts
FROM callstack c
JOIN thread t ON c.callid = t.id
JOIN process p ON t.ipid = p.ipid
WHERE c.ts >= ? AND c.ts <= ?
  AND p.name NOT IN (${exclusions})
  AND p.name NOT LIKE 'system_%'
  AND p.name NOT LIKE 'com.ohos.%'
  AND (${patterns})
ORDER BY c.ts`,
    [minTs, maxTs, ...SYSTEM_PROCESSES, ...BUFFER_PATTERNS],
  );

  // Ascending timestamps per thread, so each frame is one binary search.
  const byThread = new Map<number, number[]>();
  for (const row of rows) {
    if (row.itid === null || row.ts === null) continue;
    const list = byThread.get(row.itid);
    if (list === undefined) byThread.set(row.itid, [row.ts]);
    else list.push(row.ts);
  }

  const dropped = new Set<Frame>();
  for (const frame of windows) {
    const timestamps = byThread.get(frame.itid);
    if (timestamps === undefined) continue;
    const end = frame.ts + frame.dur;
    // First event at or after the frame's start; inside the window if <= end.
    let low = 0;
    let high = timestamps.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (timestamps[mid] < frame.ts) low = mid + 1;
      else high = mid;
    }
    if (low < timestamps.length && timestamps[low] <= end) dropped.add(frame);
  }
  return dropped;
}

/** `(vsync, itid)` keys under which some non-empty actual frame was drawn. */
function ruleTwoFrames(db: QueryHandle, frames: readonly Frame[]): Set<Frame> {
  const vsyncs = [...new Set(frames.map((frame) => frame.vsync).filter((v) => v > 0))];
  const itids = [...new Set(frames.map((frame) => frame.itid).filter((id) => id > 0))];
  if (vsyncs.length === 0 || itids.length === 0) return new Set();

  const rows = db.query<{ vsync: number | null; itid: number | null }>(
    `SELECT DISTINCT vsync, itid FROM frame_slice
WHERE type = 0 AND flag IS NOT NULL AND flag != 2
  AND vsync IN (${vsyncs.map(() => '?').join(', ')})
  AND itid IN (${itids.map(() => '?').join(', ')})`,
    [...vsyncs, ...itids],
  );
  const drawn = new Set(
    rows.map((row) => `${row.vsync ?? ''}:${row.itid ?? ''}`),
  );

  const dropped = new Set<Frame>();
  for (const frame of frames) {
    if (frame.vsync <= 0) continue;
    if (drawn.has(`${frame.vsync}:${frame.itid}`)) dropped.add(frame);
  }
  return dropped;
}

/**
 * Splits `frames` into confirmed empties and the ones each rule dropped.
 *
 * Input order is preserved in every output list, and a frame dropped by both
 * rules appears in both — the lists answer "which rule would have caught this",
 * not "which rule did".
 */
export function filterEmptyFrames(
  db: QueryHandle,
  frames: readonly Frame[],
): EmptyFrameFilter {
  const rule1 = ruleOneFrames(db, frames);
  const rule2 = ruleTwoFrames(db, frames);
  return {
    confirmed: frames.filter((frame) => !rule1.has(frame) && !rule2.has(frame)),
    filtered: frames.filter((frame) => rule1.has(frame) || rule2.has(frame)),
    rule1: frames.filter((frame) => rule1.has(frame)),
    rule2: frames.filter((frame) => rule2.has(frame)),
  };
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

/** The proxy + explanation a caller gets when nothing can be measured. */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  return {
    metrics: [
      metric({
        id: 'empty_frame.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no empty-frame measurement' },
        provenance: { collector: 'hitrace', device: ctx.deviceId },
      }),
    ],
    evidence: [
      evidence({
        kind: 'no_data',
        severity: 'info',
        subject: { process: appProcessName(ctx) },
        window: ctx.window,
        signals: {},
        explain: reason,
        drillDown: [],
        key: 'empty-frame:no-data',
      }),
    ],
  };
}

/** The rate above which a confirmed empty frame is a warning, in percent. */
const WARN_RATE = 10;

/** How many confirmed empties carry a rank in their evidence signals. */
const RANK_LIMIT = 10;

const MODERATE_SHARE = 3;
const SEVERE_SHARE = 10;

/**
 * The documented severity ladder for a load share.
 *
 * `severe` is the top rung: the numerator is a subset of the denominator by
 * construction, so a share above 100% cannot occur and upstream's unreachable
 * `extreme` label is deliberately not ported.
 */
type EmptyLoadSeverity = 'normal' | 'moderate' | 'severe';

function severityOf(share: number): EmptyLoadSeverity {
  if (share < MODERATE_SHARE) return 'normal';
  if (share < SEVERE_SHARE) return 'moderate';
  return 'severe';
}

/**
 * Emits `empty_frame.*` metrics and one `empty_frame` evidence per confirmed
 * frame.
 *
 * `empty_frame.rate` is **this package's** definition — `confirmed / app actual
 * frames × 100` — not a HapRay field: upstream reports empty-frame counts and
 * load, not a rate. It is omitted when the app rendered no actual frames, so a
 * consumer never reads a fabricated 0% as "the app never wasted a frame".
 */
export class EmptyFrameAnalyzer implements Analyzer {
  readonly id = 'empty-frame';
  readonly requires: CapabilityId[] = ['trace.frames', 'trace.ark'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return degradedResult(ctx, 'the trace database handle is not available');
    }
    const ipids = resolveAppIpids(ctx.processes, ctx.app);
    if (ipids.length === 0) {
      return degradedResult(
        ctx,
        'no app process was identified in this trace, so empty frames cannot be attributed',
      );
    }

    const all = ctx.frames.all(ctx.window);
    const appFrames = all.filter((frame) => ipids.includes(frame.ipid));
    const actual = appFrames.filter((frame) => frame.type === 0);
    const empties = actual.filter((frame) => frame.flag === 2);

    if (actual.length === 0) {
      return {
        metrics: [],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: { process: appProcessName(ctx) },
            window: ctx.window,
            signals: {},
            explain:
              'the app rendered no actual frames in this window, so there is no ' +
              'empty-frame rate to report',
            drillDown: [
              {
                label: 'All frames in window',
                tool: 'frames.all',
                args: { window: ctx.window },
                returns: 'Frame[]',
                estRows: all.length,
              },
            ],
            key: 'empty-frame:no-frames',
          }),
        ],
      };
    }

    const filter = empties.length > 0
      ? filterEmptyFrames(ctx.db, empties)
      : { confirmed: [], filtered: [], rule1: [], rule2: [] };
    const rate = (filter.confirmed.length / actual.length) * 100;
    const process = appProcessName(ctx);
    const prov = {
      collector: 'hitrace',
      table: 'frame_slice',
      rows: actual.length,
      device: ctx.deviceId,
    };

    const metrics: Metric[] = [
      metric({
        id: 'empty_frame.count',
        value: filter.confirmed.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'empty_frame.filtered.count',
        value: filter.filtered.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'empty_frame.rate',
        value: rate,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    // Empty-frame load: the summed per-frame load of confirmed empties over
    // the summed per-frame load of every app actual frame. The range is the
    // union of the requested window and the frames' own span, so samples
    // outside the window but inside a frame are visible to the mismatch guard.
    let loadOf = new Map<Frame, number>();
    let totalLoad = 0;
    let loadIndex: FrameLoadIndex | undefined;
    // True only when a load was actually measured for every actual frame.
    // Both degraded paths leave it false, so the evidence omits load rather
    // than reporting the 0 an absent measurement would look like.
    let loadMeasured = false;
    if (ctx.perf !== undefined && ctx.perf.hasSamples()) {
      // A reduce, not `Math.min(...)`: spreading one argument per frame
      // overflows V8's argument limit (about 124k) on a long capture and
      // crashes the analyzer instead of degrading.
      const firstTs = actual.reduce((min, frame) => (frame.ts < min ? frame.ts : min), actual[0].ts);
      const lastEnd = actual.reduce(
        (max, frame) => Math.max(max, frame.ts + Math.max(0, frame.dur)),
        actual[0].ts + Math.max(0, actual[0].dur),
      );
      loadIndex = FrameLoadIndex.build({
        perf: ctx.perf,
        pids: ctx.app.pids,
        range: {
          startNs: Math.min(ctx.window.startNs, firstTs),
          endNs: Math.max(ctx.window.endNs, lastEnd),
        },
      });
    }

    const loadProv = {
      collector: 'hiperf',
      table: 'perf_sample',
      rows: loadIndex?.sampleRows ?? 0,
      device: ctx.deviceId,
    };

    if (loadIndex === undefined) {
      metrics.push(
        metric({
          id: 'empty_frame.load.degraded',
          value: 0,
          unit: 'count',
          fidelity: 'proxy',
          // Name the actual gap: samples for another process are not the same
          // problem as a capture with no --hiperf at all.
          degraded: {
            reason:
              ctx.perf === undefined
                ? NO_SAMPLES
                : noSamplesReason(ctx.perf, ctx.app.pids),
            fallback: 'no empty-frame load',
          },
          provenance: { collector: 'hiperf', device: ctx.deviceId },
          window: ctx.window,
        }),
      );
    } else {
      loadOf = new Map(actual.map((frame) => [frame, loadIndex.load(frame)] as const));
      totalLoad = [...loadOf.values()].reduce((sum, load) => sum + load, 0);
      const emptyLoad = filter.confirmed.reduce(
        (sum, frame) => sum + (loadOf.get(frame) ?? 0),
        0,
      );
      if (totalLoad === 0 && loadIndex.spanWeight > 0) {
        metrics.push(
          metric({
            id: 'empty_frame.load.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: {
              reason:
                'perf samples exist but none fall inside any app frame window; frame ' +
                'and perf timestamps may use different time bases',
              fallback: 'no empty-frame load',
            },
            provenance: { collector: 'hiperf', device: ctx.deviceId },
            window: ctx.window,
          }),
        );
      } else {
        const share = totalLoad > 0 ? (emptyLoad / totalLoad) * 100 : 0;
        loadMeasured = true;
        metrics.push(
          metric({
            id: 'empty_frame.load.total',
            value: emptyLoad,
            unit: 'count',
            provenance: loadProv,
            fidelity: 'exact',
            window: ctx.window,
          }),
          metric({
            id: 'empty_frame.load.share',
            value: share,
            unit: '%',
            provenance: loadProv,
            fidelity: 'exact',
            window: ctx.window,
          }),
          metric({
            id: 'empty_frame.load.severity',
            value: severityOf(share),
            unit: 'none',
            provenance: loadProv,
            fidelity: 'exact',
            window: ctx.window,
          }),
        );
      }
    }

    // Rank among confirmed empties by load, highest first; only the top
    // `RANK_LIMIT` carry their ordinal, the rest read 0. The evidence array
    // itself stays chronological, so the rank travels as a signal.
    const rankedEmpties = [...filter.confirmed].sort(
      (a, b) =>
        (loadOf.get(b) ?? 0) - (loadOf.get(a) ?? 0) ||
        a.ts - b.ts ||
        a.id - b.id,
    );
    const loadRankOf = new Map<number, number>();
    rankedEmpties.slice(0, RANK_LIMIT).forEach((frame, i) => loadRankOf.set(frame.id, i + 1));

    // How many empties sharing this frame's (vsync, itid) the rules dropped.
    // Usually 0 — a frame that survived both rules had no filtered sibling —
    // but it tells a reader that a group was partially filtered.
    const filteredByGroup = new Map<string, number>();
    for (const frame of filter.filtered) {
      const key = `${frame.vsync}:${frame.itid}`;
      filteredByGroup.set(key, (filteredByGroup.get(key) ?? 0) + 1);
    }

    const evidenceItems = filter.confirmed.map((frame) =>
      evidence({
        kind: 'empty_frame',
        severity: rate >= WARN_RATE ? 'warn' : 'info',
        subject: { process, frameNo: frame.id },
        // The frame's own interval: `frame_no` is 0 on every real row, so the
        // window is what makes the id unique (see `frames.ts`).
        window: { startNs: frame.ts, endNs: frame.ts + frame.dur },
        signals: {
          vsync: frame.vsync,
          filtered: filteredByGroup.get(`${frame.vsync}:${frame.itid}`) ?? 0,
          // Load fields appear only when a load was measured. In the two
          // degraded paths they would read 0/0/1..n — a fabricated zero and a
          // fabricated ranking, contradicting `empty_frame.load.degraded`.
          ...(loadMeasured
            ? {
                load: loadOf.get(frame) ?? 0,
                loadShare:
                  totalLoad > 0 ? ((loadOf.get(frame) ?? 0) / totalLoad) * 100 : 0,
                loadRank: loadRankOf.get(frame.id) ?? 0,
              }
            : {}),
        },
        explain:
          `${process} frame at vsync ${frame.vsync} drew nothing ` +
          `(flag 2, dur ${(frame.dur / 1e6).toFixed(1)}ms) and no buffer was submitted for it`,
        drillDown: [
          { label: 'Frame detail', tool: 'frames.get', args: { id: frame.id }, returns: 'Frame' },
          ...(loadMeasured
            ? [{
                label: 'Load by symbol',
                tool: 'frame.load.symbols',
                args: { startNs: frame.ts, endNs: frame.ts + frame.dur },
                returns: 'PerfLeafAttribution[]',
              }]
            : []),
        ],
      }));

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
