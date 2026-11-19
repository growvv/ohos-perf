// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { Frame } from '../query/frames';
import { round2HalfEven } from './components';
import { resolveAppIpids } from './context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * VSync cadence anomalies over the app's own frames.
 *
 * Ported from `hapray/core/common/frame/frame_analyzer_vsync.py`. HapRay groups
 * frames by `vsync`, measures the gap between consecutive groups' first
 * timestamps, and reports two kinds of finding:
 *
 * - a **frequency period**: three or more consecutive intervals outside the
 *   normal 30–120 Hz band (8.33–33.3 ms), classified `high`/`low` frequency
 *   and graded by average frequency and duration;
 * - a **mismatch**: a `vsync` group holding only actual frames or only expect
 *   frames, which means the prediction and the render disagreed.
 *
 * `anomalyRate` is `(periods + mismatches) / signals × 100` and can exceed 100
 * — a period and a mismatch can both count against the same signal. That is
 * HapRay's definition, not a bug to clamp.
 *
 * The analysis is scoped to the app's frames. Device-wide groups mix
 * sceneboard and RenderService cadence into the app's rate: on the recorded
 * emulator trace the app has 60 groups out of 169 device-wide.
 */

/** Normal band: 120 Hz (8.33 ms) to 30 Hz (33.3 ms), as nanoseconds. */
const NORMAL_MIN_NS = 8.33 * 1_000_000;
const NORMAL_MAX_NS = 33.3 * 1_000_000;
/** A run must hold at least this many intervals to be a period. */
const MIN_PERIOD_INTERVALS = 3;

export type VsyncPeriodKind = 'high_frequency' | 'low_frequency';
export type VsyncSeverity = 'low' | 'medium' | 'high';

export interface VsyncPeriod {
  kind: VsyncPeriodKind;
  startVsync: number;
  endVsync: number;
  /** Absolute trace nanoseconds; the window an evidence item covers. */
  startNs: number;
  endNs: number;
  intervalCount: number;
  avgIntervalNs: number;
  avgFrequencyHz: number;
  severity: VsyncSeverity;
}

export interface VsyncAnalysis {
  /** Distinct `vsync` values the app rendered under. */
  signals: number;
  mismatches: number;
  periods: VsyncPeriod[];
  anomalyRate: number;
}

/** One `vsync` group: its frames' earliest timestamp and type counts. */
interface VsyncGroup {
  vsync: number;
  minTs: number;
  actual: number;
  expect: number;
}

/** One interval between consecutive groups, as HapRay computes it. */
interface Interval {
  prevVsync: number;
  vsync: number;
  ns: number;
  startNs: number;
}

/**
 * Python's `round(x, 2)`, which is half-even on the exact double.
 *
 * `round2HalfEven` lives in `components.ts` (it was written there for HapRay's
 * reuse ratio); importing it keeps one implementation of Python's rounding in
 * the package. `Math.round(x * 100) / 100` would disagree at exact midpoints —
 * `0.625` becomes `0.63` instead of Python's `0.62`.
 */
function round2(value: number): number {
  return round2HalfEven(value);
}

/** Groups frames by `vsync`, dropping frames with no `vsync`, sorted by time. */
function groupByVsync(frames: readonly Frame[]): VsyncGroup[] {
  const groups = new Map<number, VsyncGroup>();
  for (const frame of frames) {
    // A frame without a vsync cannot be placed on the cadence axis. The query
    // layer maps NULL to 0; 0 is not a vsync value, so it is dropped too.
    if (!Number.isFinite(frame.vsync) || frame.vsync <= 0) continue;
    const group = groups.get(frame.vsync);
    if (group === undefined) {
      groups.set(frame.vsync, {
        vsync: frame.vsync,
        minTs: frame.ts,
        actual: frame.type === 0 ? 1 : 0,
        expect: frame.type === 1 ? 1 : 0,
      });
      continue;
    }
    group.minTs = Math.min(group.minTs, frame.ts);
    // Counted strictly: HapRay uses `types.count(0)` / `types.count(1)`, so a
    // frame of any third type belongs to neither side.
    if (frame.type === 0) group.actual += 1;
    else if (frame.type === 1) group.expect += 1;
  }
  // Sort by first timestamp; ties break on vsync so the order is byte-stable.
  return [...groups.values()].sort((a, b) =>
    a.minTs !== b.minTs ? a.minTs - b.minTs : a.vsync - b.vsync);
}

/** Gaps between consecutive groups' earliest timestamps. */
function intervalsOf(groups: readonly VsyncGroup[]): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 1; i < groups.length; i++) {
    const previous = groups[i - 1];
    const current = groups[i];
    intervals.push({
      prevVsync: previous.vsync,
      vsync: current.vsync,
      ns: current.minTs - previous.minTs,
      startNs: previous.minTs,
    });
  }
  return intervals;
}

/** HapRay's severity ladder for a high-frequency period. */
function highSeverity(avgHz: number, durationMs: number): VsyncSeverity {
  if (avgHz > 200 || durationMs > 100) return 'high';
  if (avgHz > 150 || durationMs > 50) return 'medium';
  return 'low';
}

/** HapRay's severity ladder for a low-frequency period. */
function lowSeverity(avgHz: number, durationMs: number): VsyncSeverity {
  if (avgHz < 15 || durationMs > 200) return 'high';
  if (avgHz < 20 || durationMs > 100) return 'medium';
  return 'low';
}

/**
 * Runs of ≥3 consecutive anomalous intervals, as HapRay builds them.
 *
 * A run's duration is measured from the first interval's start to the last
 * interval's end, and its average interval is the mean of its intervals.
 */
function findPeriods(
  intervals: readonly Interval[],
  kind: VsyncPeriodKind,
): VsyncPeriod[] {
  const high = kind === 'high_frequency';
  const periods: VsyncPeriod[] = [];
  let run: { start: Interval; end: Interval; total: number; count: number } | undefined;

  const flush = (): void => {
    if (run === undefined || run.count < MIN_PERIOD_INTERVALS) {
      run = undefined;
      return;
    }
    const avgIntervalNs = run.total / run.count;
    const avgFrequencyHz = 1e9 / avgIntervalNs;
    const startNs = run.start.startNs;
    const endNs = run.end.startNs + run.end.ns;
    const durationMs = (endNs - startNs) / 1e6;
    periods.push({
      kind,
      startVsync: run.start.prevVsync,
      endVsync: run.end.vsync,
      startNs,
      endNs,
      intervalCount: run.count,
      avgIntervalNs,
      avgFrequencyHz,
      severity: high
        ? highSeverity(avgFrequencyHz, durationMs)
        : lowSeverity(avgFrequencyHz, durationMs),
    });
    run = undefined;
  };

  for (const interval of intervals) {
    const anomalous = high ? interval.ns < NORMAL_MIN_NS : interval.ns > NORMAL_MAX_NS;
    if (anomalous) {
      if (run === undefined) {
        run = { start: interval, end: interval, total: interval.ns, count: 1 };
      } else {
        run.end = interval;
        run.total += interval.ns;
        run.count += 1;
      }
      continue;
    }
    flush();
  }
  flush();
  return periods;
}

/**
 * The pure VSync analysis over an already app-scoped frame list.
 *
 * Exported so a caller can test or reuse the algorithm without a database.
 */
export function computeVsyncAnomalies(frames: readonly Frame[]): VsyncAnalysis {
  const groups = groupByVsync(frames);
  const signals = groups.length;
  if (signals === 0) return { signals: 0, mismatches: 0, periods: [], anomalyRate: 0 };

  const intervals = intervalsOf(groups);
  const periods = [
    ...findPeriods(intervals, 'high_frequency'),
    ...findPeriods(intervals, 'low_frequency'),
  ];
  // HapRay appends one mismatch per unmet side, so a group whose frames are
  // all of some third `type` would count twice. Ported literally: on a
  // well-formed trace every group holds a 0 or a 1 and the two agree.
  let mismatches = 0;
  for (const group of groups) {
    if (group.actual === 0) mismatches += 1;
    if (group.expect === 0) mismatches += 1;
  }
  return {
    signals,
    mismatches,
    periods,
    anomalyRate: round2(((periods.length + mismatches) / signals) * 100),
  };
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/** HapRay's `high`/`medium`/`low` mapped onto the evidence severity scale. */
function evidenceSeverity(severity: VsyncSeverity): 'info' | 'warn' | 'critical' {
  if (severity === 'high') return 'critical';
  if (severity === 'medium') return 'warn';
  return 'info';
}

/**
 * Emits `vsync.*` metrics and one `vsync_anomaly` evidence item per period.
 *
 * Only the app's frames are analyzed; an app that rendered nothing in the
 * window produces no metrics and one `no_data` item rather than an exact 0%
 * anomaly rate, which would read as "the cadence was perfect".
 */
export class VsyncAnalyzer implements Analyzer {
  readonly id = 'vsync';
  readonly requires: CapabilityId[] = ['render.vsync'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const ipids = resolveAppIpids(ctx.processes, ctx.app);
    const all = ctx.frames.all(ctx.window);
    const frames = ipids.length === 0 ? [] : all.filter((frame) => ipids.includes(frame.ipid));

    if (frames.length === 0) {
      const reason = ipids.length === 0
        ? 'no app process was identified in this trace, so VSync cadence cannot be attributed'
        : 'the app rendered no frames in this window, so there is no VSync cadence to analyze';
      return {
        metrics: [],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: { process: appProcessName(ctx) },
            window: ctx.window,
            signals: {},
            explain: reason,
            drillDown: [],
            key: 'vsync:no-frames',
          }),
        ],
      };
    }

    const analysis = computeVsyncAnomalies(frames);
    const metrics: Metric[] = [
      metric({
        id: 'vsync.anomaly.rate',
        value: analysis.anomalyRate,
        unit: '%',
        provenance: { collector: 'hitrace', table: 'frame_slice', rows: frames.length, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'vsync.mismatch.count',
        value: analysis.mismatches,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'frame_slice', rows: frames.length, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'vsync.periods.count',
        value: analysis.periods.length,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'frame_slice', rows: frames.length, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'vsync.signals.count',
        value: analysis.signals,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'frame_slice', rows: frames.length, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    const process = appProcessName(ctx);
    const items = analysis.periods.map((period) =>
      evidence({
        kind: 'vsync_anomaly',
        severity: evidenceSeverity(period.severity),
        subject: { process },
        window: { startNs: period.startNs, endNs: period.endNs },
        signals: {
          kind: period.kind,
          intervalCount: period.intervalCount,
          avgFrequencyHz: round2(period.avgFrequencyHz),
          startVsync: period.startVsync,
          endVsync: period.endVsync,
          severity: period.severity,
        },
        explain: explainPeriod(period),
        drillDown: [
          {
            label: 'Frames in the period',
            tool: 'frames.all',
            args: { window: { startNs: period.startNs, endNs: period.endNs } },
            returns: 'Frame[]',
            estRows: period.intervalCount + 1,
          },
        ],
      }));

    return { metrics, evidence: items };
  }
}

/** One sentence naming the period in relative milliseconds, as HapRay does. */
function explainPeriod(period: VsyncPeriod): string {
  const label = period.kind === 'high_frequency' ? 'high' : 'low';
  const durationMs = (period.endNs - period.startNs) / 1e6;
  return `${label}-frequency VSync period: ${period.intervalCount} intervals, ` +
    `${period.avgFrequencyHz.toFixed(1)}Hz average, ${durationMs.toFixed(1)}ms long ` +
    `(vsync ${period.startVsync}..${period.endVsync}, severity ${period.severity})`;
}
