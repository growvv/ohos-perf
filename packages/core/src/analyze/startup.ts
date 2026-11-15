import type { CapabilityId } from '../device/capability';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

const NS_PER_MS = 1_000_000;

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * The `ipid` of every app pid, in `ctx.app.pids` order, without duplicates.
 *
 * `ctx.app.pids` are **pids** and `app_startup.ipid` is an **ipid**: the two
 * number spaces overlap, so comparing them directly would silently attribute
 * another process's startup rows to the app. `ProcessQuery.byPid` is the only
 * safe translation (it resolves duplicate pids to the lowest row id, D5).
 */
function appIpids(ctx: AnalyzeContext): number[] {
  const ipids: number[] = [];
  const seen = new Set<number>();
  for (const pid of ctx.app.pids) {
    const ipid = ctx.processes.byPid(pid)?.ipid;
    // `ipid` 0 is a NULL column, not a process: the query layer maps NULL to 0,
    // and `app_startup` rows with a NULL/0 ipid would otherwise be attributed.
    if (ipid === undefined || !Number.isInteger(ipid) || ipid <= 0) {
      continue;
    }
    if (seen.has(ipid)) continue;
    seen.add(ipid);
    ipids.push(ipid);
  }
  return ipids;
}

/** The `startedAtNs` marker when it can address a trace timestamp. */
function startMarkerNs(ctx: AnalyzeContext): number | undefined {
  const startedAtNs = ctx.metadata?.startedAtNs;
  if (startedAtNs === undefined) return undefined;
  if (!Number.isFinite(startedAtNs) || startedAtNs < 0) return undefined;
  return startedAtNs;
}

function startupMetric(
  id: string,
  value: number,
  unit: MetricUnit,
  fidelity: 'exact' | 'approximate',
  provenance: Metric['provenance'],
  degraded?: Metric['degraded'],
): Metric {
  return metric({
    id,
    value,
    unit,
    fidelity,
    provenance,
    ...(degraded === undefined ? {} : { degraded }),
  });
}

/**
 * Why no startup duration could be measured.
 *
 * `invalid-frame` is separate from `no-frame` so a corrupt `frame_slice.dur`
 * (negative, which would otherwise be emitted as a negative measurement) is
 * reported as bad data rather than as a missing frame.
 */
type NoStartupReason = 'no-marker' | 'no-frame' | 'invalid-frame';

/** Zero-metrics evidence for a scene with neither startup rows nor a marker. */
function noStartupEvidence(ctx: AnalyzeContext, reason: NoStartupReason): Evidence {
  const explain = {
    'invalid-frame':
      'scene metadata carried a startedAtNs start marker and an actual frame' +
      ' followed it, but that frame has an invalid duration (negative or' +
      ' non-finite); app_startup has no rows for the app, so startup duration' +
      ' cannot be derived',
    'no-frame':
      'scene metadata carried a startedAtNs start marker, but no usable actual' +
      ' frame followed it; app_startup has no rows for the app, so startup' +
      ' duration cannot be derived',
    'no-marker':
      'no startup data: app_startup has no rows for the app and scene metadata' +
      ' carries no startedAtNs start marker; capture a cold start with the' +
      ' hitrace startup categories or record a start marker to measure startup',
  }[reason];
  return evidence({
    kind: 'startup',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain,
    drillDown: [],
    key: `startup:${reason}`,
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Startup analyzer over `app_startup`, with a marker-to-first-frame fallback.
 *
 * The engine gates this analyzer on `trace.frames` because the fallback reads
 * `frame_slice`. Three branches, in order:
 *
 * 1. Rows in `app_startup` for the app's resolved **ipids** with a usable
 *    `start_time > 0` and `end_time >= start_time`: `startup.count` is the row
 *    count and `startup.duration` the span from the earliest start to the
 *    latest end, exact.
 * 2. No rows but a `startedAtNs` start marker: the first actual (`type === 0`)
 *    frame at or after the marker yields an approximate duration from the
 *    marker to that frame's end. Expect frames are predictions, never drawn,
 *    so they cannot end a startup.
 * 3. Neither source: no metrics and one `startup`/info evidence naming both
 *    absent inputs, so a zero is never reported as a measurement.
 *
 * `startedAtNs` is device uptime nanoseconds, the same base as trace `ts`;
 * a negative or non-finite value is ignored rather than used.
 */
export class StartupAnalyzer implements Analyzer {
  readonly id = 'startup';
  readonly requires: CapabilityId[] = ['trace.frames'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const rows = (ctx.startup?.forIpids(appIpids(ctx)) ?? []).filter(
      (row) => row.startTime > 0 && row.endTime >= row.startTime,
    );

    if (rows.length > 0) {
      let earliestStart = rows[0].startTime;
      let latestEnd = rows[0].endTime;
      for (const row of rows) {
        if (row.startTime < earliestStart) earliestStart = row.startTime;
        if (row.endTime > latestEnd) latestEnd = row.endTime;
      }
      const provenance = {
        collector: 'hitrace+streamer',
        table: 'app_startup',
        rows: rows.length,
        device: ctx.deviceId,
      };
      const metrics = [
        startupMetric('startup.count', rows.length, 'count', 'exact', provenance),
        startupMetric(
          'startup.duration',
          (latestEnd - earliestStart) / NS_PER_MS,
          'ms',
          'exact',
          provenance,
        ),
      ];
      metrics.sort(byMetricId);
      return { metrics, evidence: [] };
    }

    const marker = startMarkerNs(ctx);
    if (marker !== undefined) {
      const frame = ctx.frames.actual().find((candidate) => candidate.ts >= marker);
      if (frame !== undefined) {
        const duration = (frame.ts + frame.dur - marker) / NS_PER_MS;
        // A negative duration means the frame ended before the marker: the row
        // is corrupt, and emitting it would report a negative startup time.
        if (Number.isFinite(duration) && duration >= 0) {
          return {
            metrics: [
              startupMetric(
                'startup.duration',
                duration,
                'ms',
                'approximate',
                {
                  collector: 'hitrace+streamer',
                  table: 'frame_slice',
                  rows: 1,
                  device: ctx.deviceId,
                },
                {
                  reason:
                    'app_startup table is empty; derived from start marker' +
                    ' and first frame',
                  fallback: 'marker-to-first-frame',
                },
              ),
            ],
            evidence: [],
          };
        }
        return { metrics: [], evidence: [noStartupEvidence(ctx, 'invalid-frame')] };
      }
      return { metrics: [], evidence: [noStartupEvidence(ctx, 'no-frame')] };
    }

    return { metrics: [], evidence: [noStartupEvidence(ctx, 'no-marker')] };
  }
}
