import { describe, it, expect } from 'vitest';
import { CapabilityMatrix } from '../src/device/capability';
import { MemoryMeasureAnalyzer } from '../src/analyze/mem-measure';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { FrameQuery } from '../src/query/frames';
import type { MemMeasureQuery, ProcessMeasure } from '../src/query/mem-measure';
import type { ProcessQuery } from '../src/query/process';
import type { Metric } from '../src/report/metric';

const START = 1_000_000_000;
const WINDOW = { startNs: START, endNs: START + 3_000_000_000 };
const KIB = 1024;
const PROBE = { command: 'probe', stdout: '', stderr: '', code: 0 };
/** Measured on the Mate 60: the app pid and the trace's internal ipid differ. */
const APP_PID = 6500;
const APP_IPID = 117;
const OTHER_IPID = 118;

/** One `mem.rss` observation; `kib` is the raw filter value (KiB). */
function rss(kib: number, extra: Partial<ProcessMeasure> = {}): ProcessMeasure {
  return {
    tsNs: START,
    durNs: 996_745_833,
    filterId: 1,
    name: 'mem.rss',
    ipid: APP_IPID,
    value: kib,
    ...extra,
  };
}

/**
 * A context whose `memMeasure` is a structural stand-in for the query.
 *
 * The query's SQL and unit behavior is pinned in `query-mem-measure.test.ts`;
 * this suite exercises the analyzer's own rules (pid→ipid translation, filter
 * selection, aggregation, degradation). The other handles are stubs: only
 * `processes.byPid` is used.
 */
function ctxWith(
  rows: ProcessMeasure[],
  opts: { pids?: number[]; withQuery?: boolean } = {},
): AnalyzeContext {
  const memMeasure = {
    hasTable: () => true,
    all: () => [...rows],
    forIpids: (ipids: number[]) => rows.filter((row) => ipids.includes(row.ipid)),
    filters: () => [],
  } as unknown as MemMeasureQuery;
  const processes = {
    byPid: (pid: number) => (pid === APP_PID
      ? { id: APP_IPID, ipid: APP_IPID, pid: APP_PID, name: 'com.demo' }
      : undefined),
  } as unknown as ProcessQuery;
  return {
    frames: {} as FrameQuery,
    processes,
    ...(opts.withQuery === false ? {} : { memMeasure }),
    app: {
      packageName: 'com.demo',
      pids: opts.pids ?? [APP_PID],
      processNames: ['com.demo'],
    },
    window: WINDOW,
    caps: new CapabilityMatrix([
      { id: 'mem.native_hook', available: true, fidelity: 'exact', probe: PROBE },
    ]),
    deviceId: 't1',
  };
}

function metricOf(result: AnalyzeResult, id: string): Metric {
  const found = result.metrics.find((metricItem) => metricItem.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe('MemoryMeasureAnalyzer', () => {
  it('derives peak and average rss from process_measure rows in bytes', async () => {
    const result = await new MemoryMeasureAnalyzer().run(
      ctxWith([rss(1_000), rss(3_000)]),
    );

    // The filter reports KiB; a metric labeled `bytes` must convert.
    expect(metricOf(result, 'mem.measure.rss.peak').value).toBe(3_000 * KIB);
    expect(metricOf(result, 'mem.measure.rss.avg').value).toBe(2_000 * KIB);
    expect(metricOf(result, 'mem.measure.rss.peak').unit).toBe('bytes');
    expect(metricOf(result, 'mem.measure.rss.peak').fidelity).toBe('exact');
    expect(metricOf(result, 'mem.measure.rss.peak').provenance).toEqual({
      collector: 'hiprofiler',
      rows: 2,
      device: 't1',
    });
  });

  it('uses only the app process and the mem.rss filter', async () => {
    const result = await new MemoryMeasureAnalyzer().run(ctxWith([
      rss(1_000),
      rss(9_000, { ipid: OTHER_IPID }),
      rss(7_000, { name: 'mem.rss.anon' }),
    ]));

    expect(metricOf(result, 'mem.measure.rss.peak').value).toBe(1_000 * KIB);
    expect(metricOf(result, 'mem.measure.rss.avg').value).toBe(1_000 * KIB);
  });

  it('degrades rather than reporting a zero when the capture has no rows', async () => {
    const result = await new MemoryMeasureAnalyzer().run(ctxWith([]));

    expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
    expect(result.metrics[0].degraded?.reason).toContain('process_measure');
    expect(result.metrics[0].fidelity).toBe('proxy');
    expect(result.evidence.some((item) => item.kind === 'no_data')).toBe(true);
  });

  it('never attributes a device-wide row to the app when no pid is known', async () => {
    const result = await new MemoryMeasureAnalyzer().run(
      ctxWith([rss(5_000)], { pids: [] }),
    );

    expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
    expect(result.metrics[0].degraded?.reason).toContain('no pid');
  });

  it('degrades when the app pid has no process row in the trace', async () => {
    const result = await new MemoryMeasureAnalyzer().run(
      ctxWith([rss(5_000)], { pids: [999] }),
    );

    expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
    expect(result.metrics[0].degraded?.reason).toContain('ipid');
  });

  it('degrades when the context carries no query handle', async () => {
    const result = await new MemoryMeasureAnalyzer().run(
      ctxWith([], { withQuery: false }),
    );

    expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
  });
});
