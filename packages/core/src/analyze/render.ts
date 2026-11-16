import type { CapabilityId } from '../device/capability';
import type { HidumperCapture, WindowHitches } from '../collectors/hidumper';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { Analyzer, AnalyzeContext } from './types';

/** By metric id; the engine re-sorts, but the analyzer's own output stays ordered. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The evidence contract's order: kind, then window start, then id. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A cumulative counter can move backwards when the service restarts between
 * snapshots. A negative delta describes no frames and would silently subtract
 * from the total, so it is clamped to zero and the measurement is reported as
 * "nothing observed in this window" rather than a negative rate.
 */
function delta(start: number, end: number): number {
  return Math.max(0, end - start);
}

/**
 * Sum the per-refresh-rate frame deltas.
 *
 * Every bucket present in either snapshot contributes; a bucket that appears
 * only in the second snapshot is a mode the display switched into, and its
 * frames belong to this window.
 */
function frameDelta(capture: HidumperCapture): { frames: number; buckets: number } {
  const [start, end] = capture.samples;
  const rates = new Set<number>();
  for (const bucket of [...start.fpsCounts, ...end.fpsCounts]) rates.add(bucket.refreshRate);
  const countOf = (
    buckets: readonly { refreshRate: number; count: number }[],
    rate: number,
  ): number => buckets.find((bucket) => bucket.refreshRate === rate)?.count ?? 0;

  let frames = 0;
  for (const rate of rates) {
    frames += delta(countOf(start.fpsCounts, rate), countOf(end.fpsCounts, rate));
  }
  return { frames, buckets: rates.size };
}

/**
 * Per-window hitch deltas, keyed by `windowId`.
 *
 * A window present in only one snapshot is joined against zeros: a window
 * created during the capture starts at 0, and one destroyed during it has no
 * second reading to subtract, so its counters are not claimed.
 */
function hitchDeltas(capture: HidumperCapture): WindowHitches[] {
  const [start, end] = capture.samples;
  const byId = new Map<string, WindowHitches>();
  const ids = new Set<string>([
    ...start.hitches.map((window) => window.windowId),
    ...end.hitches.map((window) => window.windowId),
  ]);
  for (const id of ids) {
    const before = start.hitches.find((window) => window.windowId === id);
    const after = end.hitches.find((window) => window.windowId === id);
    byId.set(id, {
      windowId: id,
      over16_67: delta(before?.over16_67 ?? 0, after?.over16_67 ?? 0),
      over33: delta(before?.over33 ?? 0, after?.over33 ?? 0),
      over66: delta(before?.over66 ?? 0, after?.over66 ?? 0),
    });
  }
  return [...byId.values()].sort((a, b) => (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0));
}

/**
 * Live render analysis from the two RenderService counter snapshots.
 *
 * The counters are cumulative since boot, so every number here is a delta over
 * the capture window — the same window the trace covers, because the collector
 * brackets its snapshots around it. That makes FPS a proxy rather than an
 * exact measurement: the refresh-rate histogram counts frames presented, not
 * the app's frame pipeline, and it cannot attribute a frame to a process. The
 * hitch counters are exact for the windows they name.
 *
 * Without a capture the analyzer emits the documented `render.degraded` proxy
 * rather than zeros, so a consumer cannot read "no data" as "no jank".
 */
export class RenderAnalyzer implements Analyzer {
  readonly id = 'render';
  readonly requires: CapabilityId[] = ['render.fps_live'];

  async run(ctx: AnalyzeContext): Promise<{ metrics: Metric[]; evidence: Evidence[] }> {
    const capture = ctx.hidumper;
    if (capture === undefined) {
      return {
        metrics: [
          metric({
            id: 'render.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: { reason: 'no hidumper capture', fallback: 'analyzer skipped' },
            provenance: { collector: 'hidumper', device: ctx.deviceId },
          }),
        ],
        evidence: [],
      };
    }

    const { frames, buckets } = frameDelta(capture);
    const seconds = capture.intervalMs / 1000;
    const windows = hitchDeltas(capture);
    const hitchCount = windows.reduce((sum, window) => sum + window.over16_67, 0);
    const process = ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;

    const metrics: Metric[] = [
      metric({
        id: 'render.fps.live',
        value: seconds > 0 ? frames / seconds : 0,
        unit: 'fps',
        fidelity: 'proxy',
        provenance: { collector: 'hidumper', rows: buckets, device: ctx.deviceId },
      }),
      metric({
        id: 'render.hitch.count',
        value: hitchCount,
        unit: 'count',
        fidelity: 'exact',
        provenance: { collector: 'hidumper', rows: windows.length, device: ctx.deviceId },
      }),
    ];

    const evidenceItems = windows
      .filter((window) => window.over16_67 > 0)
      .map((window) =>
        evidence({
          kind: 'fps_baseline',
          severity: 'warn',
          subject: { process },
          window: ctx.window,
          signals: {
            window: window.windowId,
            over16_67: window.over16_67,
            over33: window.over33,
            over66: window.over66,
          },
          explain: 'window rendered frames over the 16.67 ms budget',
          drillDown: [
            {
              label: 'Hitch counters',
              tool: 'caps.get',
              args: { ids: ['render.hitch'] },
              returns: 'CapabilityState[]',
              estRows: 1,
            },
          ],
          key: window.windowId,
        }),
      );

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
