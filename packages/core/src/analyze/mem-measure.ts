import type { CapabilityId } from '../device/capability';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** The filter whose values are the process's resident set size. */
const RSS_FILTER = 'mem.rss';

/**
 * The `mem.*` filters report KiB, verified against `/proc/<pid>/status`
 * (`mem.rss` 664420 matched `VmRSS: 664584 kB`; `mem.vm.size` 106161468
 * matched `VmSize: 106161468 kB` exactly). The metric is labeled `bytes`, so
 * the conversion happens here, once, where the filter's meaning is known.
 */
const BYTES_PER_KIB = 1024;

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * The `ipid` of every app pid, in `ctx.app.pids` order, without duplicates.
 *
 * `ctx.app.pids` are **pids** and `process_measure_filter.ipid` is an
 * **ipid**: the two number spaces overlap, so comparing them directly would
 * silently read another process's rows (measured on the Mate 60: sceneboard
 * has `pid=6500` and `ipid=117`). `ProcessQuery.byPid` is the only safe
 * translation. `ipid` 0 is a NULL column, not a process.
 */
function appIpids(ctx: AnalyzeContext): number[] {
  const ipids: number[] = [];
  const seen = new Set<number>();
  for (const pid of ctx.app.pids) {
    const ipid = ctx.processes.byPid(pid)?.ipid;
    if (ipid === undefined || !Number.isInteger(ipid) || ipid <= 0) continue;
    if (seen.has(ipid)) continue;
    seen.add(ipid);
    ipids.push(ipid);
  }
  return ipids;
}

/**
 * The documented answer to "the capture produced no usable measurement".
 *
 * A zero labeled `exact` would read as a real measurement; a `proxy` zero with
 * a reason and one `no_data` evidence item says what is missing and how to
 * capture it.
 */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  const metrics: Metric[] = [
    metric({
      id: 'mem.measure.degraded',
      value: 0,
      unit: 'count',
      fidelity: 'proxy',
      degraded: { reason, fallback: 'no process_measure measurement' },
      provenance: { collector: 'hiprofiler', device: ctx.deviceId },
    }),
  ];
  const evidenceItems = [
    evidence({
      kind: 'no_data',
      severity: 'info',
      subject: { process: appProcessName(ctx) },
      window: ctx.window,
      signals: {},
      explain: reason,
      drillDown: [],
      key: 'mem-measure:no-rows',
    }),
  ];
  return { metrics, evidence: evidenceItems };
}

/**
 * Exact per-process RSS from the memory-plugin's `process_measure` table.
 *
 * The engine gates this analyzer on `mem.native_hook`; the context handle is
 * still checked because the field is optional. Rows are narrowed twice: to
 * the app's process ids (the table is device-wide) and to the `mem.rss`
 * filter. The app's OS pids are translated through `process` to the trace's
 * ipids first; either narrowing can leave nothing, and an empty pid list is
 * never allowed to fall back to "all processes": that would attribute
 * device-wide memory to the app. Every empty case takes the degraded path, as
 * does an absent table.
 */
export class MemoryMeasureAnalyzer implements Analyzer {
  readonly id = 'mem-measure';
  readonly requires: CapabilityId[] = ['mem.native_hook'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const query = ctx.memMeasure;
    if (query === undefined) {
      return degradedResult(
        ctx,
        'no MemMeasureQuery was provided; process_measure was not read for this analysis',
      );
    }
    if (ctx.app.pids.length === 0) {
      return degradedResult(
        ctx,
        'the capture has no pid for the app; process_measure rows are device-wide' +
          ' and cannot be attributed',
      );
    }
    const ipids = appIpids(ctx);
    if (ipids.length === 0) {
      return degradedResult(
        ctx,
        'no process row in the trace matches the app pids; process_measure is' +
          ' keyed by ipid and cannot be attributed',
      );
    }

    // The reason must name the actual missing input. A hitrace scene also
    // carries `process_measure` (with `H:` counters), so "no rows" alone
    // cannot tell "the memory plugin never ran" from "it ran and this app had
    // no samples"; the filter names do. Only the absent-table case is a
    // capture problem the user can fix with `--plugins memory`.
    if (!query.hasTable()) {
      return degradedResult(
        ctx,
        'this scene has no process_measure tables;' +
          ' capture with `--hiprofiler --plugins memory`',
      );
    }
    if (!query.filters().some((filter) => filter.name === RSS_FILTER)) {
      return degradedResult(
        ctx,
        'the capture\'s process_measure_filter has no mem.rss entry;' +
          ' the memory plugin did not report RSS',
      );
    }
    const rows = query
      .forIpids(ipids, ctx.window)
      .filter((row) => row.name === RSS_FILTER);
    if (rows.length === 0) {
      return degradedResult(
        ctx,
        'process_measure has mem.rss filters but no rows for the app\'s ipids' +
          ' in this window; the app may not have run while memory was sampled',
      );
    }
    // `num()` maps a NULL column to 0, which means "absent", not a real
    // zero; a live process's resident set is never 0 KiB. A negative value is
    // corrupt data, not a negative footprint. Dropping both keeps an absent
    // value out of the mean and out of a would-be exact-zero metric.
    const values = rows
      .map((row) => row.value)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (values.length === 0) {
      return degradedResult(
        ctx,
        'the app\'s mem.rss rows exist but none holds a usable value',
      );
    }

    const bytes = values.map((value) => value * BYTES_PER_KIB);
    let peak = bytes[0];
    let total = 0;
    for (const value of bytes) {
      if (value > peak) peak = value;
      total += value;
    }
    const provenance = {
      collector: 'hiprofiler',
      rows: bytes.length,
      device: ctx.deviceId,
    };
    // Sorted by id: `avg` before `peak` (D5).
    const metrics: Metric[] = [
      metric({
        id: 'mem.measure.rss.avg',
        value: Math.round(total / bytes.length),
        unit: 'bytes',
        fidelity: 'exact',
        provenance,
      }),
      metric({
        id: 'mem.measure.rss.peak',
        value: peak,
        unit: 'bytes',
        fidelity: 'exact',
        provenance,
      }),
    ];
    return { metrics, evidence: [] };
  }
}
