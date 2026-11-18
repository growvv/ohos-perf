// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { num } from '../query/rows';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';
import { computeBinderAnalysis, type BinderAnalysis } from './binder';

/**
 * HapRay's fault-tree payload, with the exact nesting and key names of
 * `fault_tree_analyzer.py:34-60`.
 *
 * `RS.ProcessedNodes.ts` is HapRay's own value: seconds since
 * `trace_range.start_ts`, not a nanosecond timestamp. It is kept verbatim so
 * the parity test compares the payload as HapRay produces it; the analyzer
 * labels the metric `unit: 'none'` rather than pretending it is a duration in
 * milliseconds. `soft_decoder` stays a boolean, like HapRay.
 */
export interface FaultTreeSignals {
  arkui: {
    animator: number;
    HandleOnAreaChangeEvent: number;
    HandleVisibleAreaChangeEvent: number;
    GetDefaultDisplay: number;
    MarshRSTransactionData: number;
  };
  RS: {
    ProcessedNodes: { ts: number; count: number };
    DisplayNodeSkipTimes: number;
    UnMarshRSTransactionData: number;
    AnimateSize: { nodeSizeSum: number; totalAnimationSizeSum: number };
  };
  av_codec: {
    soft_decoder: boolean;
    BroadcastControlInstructions: number;
    VideoDecodingInputFrameCount: number;
    VideoDecodingConsumptionFrame: number;
  };
  Audio: {
    AudioWriteCB: number;
    AudioReadCB: number;
    AudioPlayCb: number;
    AudioRecCb: number;
  };
}

/** One counter query's result plus the number of source rows it counted. */
interface Counter {
  value: number;
  rows: number;
}

/**
 * The nested payload plus the row count behind every metric, keyed by metric
 * id. `computeFaultTree` hides the second half; the analyzer needs it for
 * `provenance.rows` without running every query twice.
 */
interface FaultTreeComputation {
  signals: FaultTreeSignals;
  rows: Map<string, number>;
}

/** `sqlite_master` probe for the optional `perf_sample` table. */
function hasTable(db: QueryHandle, name: string): boolean {
  return (
    db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    ).length > 0
  );
}

/** `trace_range.start_ts`, or `0` when the trace has no range row. */
function traceStartNs(db: QueryHandle): number {
  const [row] = db.query<{ start_ts: number | null }>(
    'SELECT start_ts FROM trace_range LIMIT 1',
  );
  return num(row?.start_ts ?? null);
}

/**
 * HapRay `_collect_app_invoke_times`: matching callstack rows owned by one of
 * the app's process pids.
 *
 * `appPids` is checked before the statement is built: an empty list would
 * otherwise produce `pid IN ()`, which is invalid/no-op SQL and hides a
 * caller bug. HapRay interpolates the pids; this binds them as `?`.
 */
function countAppInvokes(
  db: QueryHandle,
  pattern: string,
  appPids: number[],
): Counter {
  if (appPids.length === 0) return { value: 0, rows: 0 };
  const placeholders = appPids.map(() => '?').join(', ');
  const [row] = db.query<{ n: number | null }>(
    `SELECT count(*) AS n FROM callstack
WHERE name LIKE ?
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE pid IN (${placeholders})
    )
  )`,
    [pattern, ...appPids],
  );
  const value = num(row?.n ?? null);
  return { value, rows: value };
}

/** HapRay `_collect_rs_invoke_times`: rows owned by `render_service`. */
function countRenderServiceInvokes(db: QueryHandle, pattern: string): Counter {
  const [row] = db.query<{ n: number | null }>(
    `SELECT count(*) AS n FROM callstack
WHERE name LIKE ?
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE name = 'render_service'
    )
  )`,
    [pattern],
  );
  const value = num(row?.n ?? null);
  return { value, rows: value };
}

/**
 * Callstack rows owned by `render_service` whose name matches `pattern`.
 *
 * `ORDER BY ts, id` replaces HapRay's undefined result order: the maximum
 * `ProcessedNodes` count must resolve ties to the earliest `ts` deterministically.
 */
function renderServiceRows(
  db: QueryHandle,
  pattern: string,
): Array<{ ts: number | null; name: string | null }> {
  return db.query<{ ts: number | null; name: string | null }>(
    `SELECT ts, name FROM callstack
WHERE name LIKE ?
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE name = 'render_service'
    )
  )
ORDER BY ts, id`,
    [pattern],
  );
}

/**
 * HapRay `_collect_rs_max_processed_node`.
 *
 * The row with the highest `ProcessedNodes: N` wins; equal counts keep the
 * first row in `ts` order (HapRay's loop has the same strict `>` comparison but
 * no ORDER BY, so its winner is undefined). `ts` stays HapRay's seconds-offset
 * value and is `0` when no row parses or every count is 0.
 */
function collectProcessedNodes(db: QueryHandle): {
  value: { ts: number; count: number };
  rows: number;
} {
  const rows = renderServiceRows(db, '%ProcessedNodes%');
  const startTs = traceStartNs(db);
  let count = 0;
  let ts = 0;
  for (const row of rows) {
    const match = /ProcessedNodes:\s*(\d+)/.exec(row.name ?? '');
    if (!match) continue;
    const nodes = Number.parseInt(match[1], 10);
    if (nodes > count) {
      count = nodes;
      ts = (num(row.ts) - startTs) / 1e9;
    }
  }
  return { value: { ts, count }, rows: rows.length };
}

/** HapRay `_collect_rs_animate_nodes`: sums every matching render_service row. */
function collectAnimateSize(db: QueryHandle): {
  value: { nodeSizeSum: number; totalAnimationSizeSum: number };
  rows: number;
} {
  const rows = renderServiceRows(db, '%H:Animate [nodeSize, totalAnimationSize]%');
  let nodeSizeSum = 0;
  let totalAnimationSizeSum = 0;
  for (const row of rows) {
    const match = /\[(\d+),\s*(\d+)\]/.exec(row.name ?? '');
    if (!match) continue;
    nodeSizeSum += Number.parseInt(match[1], 10);
    totalAnimationSizeSum += Number.parseInt(match[2], 10);
  }
  return { value: { nodeSizeSum, totalAnimationSizeSum }, rows: rows.length };
}

/** HapRay `_collect_av_codec_soft_decoder`; `rows` is the matched callstack count. */
function collectSoftDecoder(db: QueryHandle): { value: boolean; rows: number } {
  const [row] = db.query<{ n: number | null }>(
    `SELECT count(*) AS n FROM callstack
WHERE (name LIKE '%hevcdecoder%' OR name LIKE '%H:Fcodec%')
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE name LIKE 'av_codec_servic%'
    )
  )`,
  );
  const n = num(row?.n ?? null);
  return { value: n > 0, rows: n };
}

/**
 * HapRay `_collect_broadcast_control_instructions`: a `perf_sample` sum.
 *
 * `perf_sample` exists only when a perf trace was ingested; HapRay catches the
 * SQLite error and returns 0, so the guard reproduces that result without
 * relying on an exception.
 */
function collectBroadcastControlInstructions(db: QueryHandle): Counter {
  if (!hasTable(db, 'perf_sample')) return { value: 0, rows: 0 };
  const [row] = db.query<{ total: number | null; n: number | null }>(
    `SELECT sum(event_count) AS total, count(*) AS n
FROM perf_sample
WHERE callchain_id IN (
  SELECT id
  FROM thread
  WHERE ipid IN (
    SELECT ipid FROM process WHERE name LIKE '%av_session%'
  )
  AND name LIKE '%OS_AVSessionHdl%'
)`,
  );
  return { value: num(row?.total ?? null), rows: num(row?.n ?? null) };
}

/** HapRay `_collect_video_decoding_input_frames`. */
function collectVideoDecodingInputFrames(db: QueryHandle): Counter {
  const [row] = db.query<{ n: number | null }>(
    `SELECT count(name) AS n FROM callstack
WHERE name LIKE '%OnQueueInputBuffer%'
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE name LIKE 'av_codec_servic%'
    )
  )`,
  );
  const value = num(row?.n ?? null);
  return { value, rows: value };
}

/** HapRay `_collect_video_decoding_consumption_frames`. */
function collectVideoDecodingConsumptionFrames(db: QueryHandle): Counter {
  const [row] = db.query<{ n: number | null }>(
    `SELECT count(name) AS n FROM callstack
WHERE (name LIKE '%OnRenderOutputBuffer%' OR name LIKE '%OnReleaseOutputBuffer%')
  AND callid IN (
    SELECT id FROM thread
    WHERE ipid IN (
      SELECT ipid FROM process WHERE name LIKE 'av_codec_servic%'
    )
  )`,
  );
  const value = num(row?.n ?? null);
  return { value, rows: value };
}

/**
 * HapRay `_collect_thread_event_count`: the audio counters.
 *
 * The predicate is ported verbatim, including its oddity: `perf_sample.callchain_id`
 * is compared with `thread.id`, not with a thread id carried by the sample.
 * Missing `perf_sample` yields 0 via {@link hasTable}, like HapRay's caught
 * `sqlite3.Error`.
 */
function collectAudioThreadEvents(db: QueryHandle, threadPattern: string): Counter {
  if (!hasTable(db, 'perf_sample')) return { value: 0, rows: 0 };
  const [row] = db.query<{ total: number | null; n: number | null }>(
    `SELECT sum(event_count) AS total, count(*) AS n
FROM perf_sample
WHERE callchain_id IN (
  SELECT id
  FROM thread
  WHERE name LIKE ?
)`,
    [threadPattern],
  );
  return { value: num(row?.total ?? null), rows: num(row?.n ?? null) };
}

/**
 * Runs HapRay's fault-tree queries and returns the nested payload.
 *
 * This is the public, payload-only form used by the parity test. The analyzer
 * uses {@link computeFaultTreeDetailed}; both share one implementation, so the
 * metrics and the parity fixture can never drift apart.
 */
export function computeFaultTree(
  db: QueryHandle,
  opts: { appPids: number[] },
): FaultTreeSignals {
  return computeFaultTreeDetailed(db, opts).signals;
}

function computeFaultTreeDetailed(
  db: QueryHandle,
  opts: { appPids: number[] },
): FaultTreeComputation {
  const appPids = opts.appPids;
  const rows = new Map<string, number>();
  const put = (id: string, counter: Counter): number => {
    rows.set(id, counter.rows);
    return counter.value;
  };

  const animator = countAppInvokes(db, '%ohos.animator%', appPids);
  const areaChange = countAppInvokes(db, '%H:HandleOnAreaChangeEvent%', appPids);
  const visibleAreaChange = countAppInvokes(
    db,
    '%H:HandleVisibleAreaChangeEvent%',
    appPids,
  );
  const display = countAppInvokes(db, '%GetDefaultDisplay%', appPids);
  const marsh = countAppInvokes(db, '%H:MarshRSTransactionData cmdCount%', appPids);

  const processedNodes = collectProcessedNodes(db);
  rows.set('fault.RS.ProcessedNodes.ts', processedNodes.rows);
  rows.set('fault.RS.ProcessedNodes.count', processedNodes.rows);
  const displayNodeSkip = countRenderServiceInvokes(db, '%DisplayNode skip|%');
  const unmarsh = countRenderServiceInvokes(
    db,
    '%H:UnMarsh RSTransactionData: data size:%',
  );
  const animateSize = collectAnimateSize(db);
  rows.set('fault.RS.AnimateSize.nodeSizeSum', animateSize.rows);
  rows.set('fault.RS.AnimateSize.totalAnimationSizeSum', animateSize.rows);

  const softDecoder = collectSoftDecoder(db);
  const broadcast = collectBroadcastControlInstructions(db);
  const videoInput = collectVideoDecodingInputFrames(db);
  const videoConsumption = collectVideoDecodingConsumptionFrames(db);

  const audioWrite = collectAudioThreadEvents(db, '%OS_AudioWriteCB%');
  const audioRead = collectAudioThreadEvents(db, '%OS_AudioReadCB%');
  const audioPlay = collectAudioThreadEvents(db, '%OS_AudioPlayCb%');
  const audioRec = collectAudioThreadEvents(db, '%OS_AudioRecCb%');

  const signals: FaultTreeSignals = {
    arkui: {
      animator: put('fault.arkui.animator', animator),
      HandleOnAreaChangeEvent: put('fault.arkui.HandleOnAreaChangeEvent', areaChange),
      HandleVisibleAreaChangeEvent: put(
        'fault.arkui.HandleVisibleAreaChangeEvent',
        visibleAreaChange,
      ),
      GetDefaultDisplay: put('fault.arkui.GetDefaultDisplay', display),
      MarshRSTransactionData: put('fault.arkui.MarshRSTransactionData', marsh),
    },
    RS: {
      ProcessedNodes: processedNodes.value,
      DisplayNodeSkipTimes: put('fault.RS.DisplayNodeSkipTimes', displayNodeSkip),
      UnMarshRSTransactionData: put('fault.RS.UnMarshRSTransactionData', unmarsh),
      AnimateSize: animateSize.value,
    },
    av_codec: {
      soft_decoder: softDecoder.value,
      BroadcastControlInstructions: put(
        'fault.av_codec.BroadcastControlInstructions',
        broadcast,
      ),
      VideoDecodingInputFrameCount: put(
        'fault.av_codec.VideoDecodingInputFrameCount',
        videoInput,
      ),
      VideoDecodingConsumptionFrame: put(
        'fault.av_codec.VideoDecodingConsumptionFrame',
        videoConsumption,
      ),
    },
    Audio: {
      AudioWriteCB: put('fault.Audio.AudioWriteCB', audioWrite),
      AudioReadCB: put('fault.Audio.AudioReadCB', audioRead),
      AudioPlayCb: put('fault.Audio.AudioPlayCb', audioPlay),
      AudioRecCb: put('fault.Audio.AudioRecCb', audioRec),
    },
  };
  rows.set('fault.av_codec.soft_decoder', softDecoder.rows);

  return { signals, rows };
}

/**
 * Every metric this analyzer emits; order is fixed, the caller re-sorts by id.
 *
 * `perf_sample` counters are `proxy` when the table is absent: the collector
 * returns 0 for a missing table (as HapRay's caught exception does), and a
 * zero from a table that was never ingested is not a measured zero. Labelling
 * it `exact` would let a gate pass a `max` budget on data the run never had.
 */
function faultMetrics(
  signals: FaultTreeSignals,
  rows: Map<string, number>,
  ctx: AnalyzeContext,
  perfSamplePresent: boolean,
): Metric[] {
  const s = signals;
  const perfSample = perfSamplePresent
    ? { fidelity: 'exact' as const }
    : {
        fidelity: 'proxy' as const,
        degraded: {
          reason: 'perf_sample is absent, so this counter was never measured',
          fallback: '0',
        },
      };
  const specs: Array<{ id: string; value: number; unit: MetricUnit; table: string }> = [
    { id: 'fault.arkui.animator', value: s.arkui.animator, unit: 'count', table: 'callstack' },
    {
      id: 'fault.arkui.HandleOnAreaChangeEvent',
      value: s.arkui.HandleOnAreaChangeEvent,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.arkui.HandleVisibleAreaChangeEvent',
      value: s.arkui.HandleVisibleAreaChangeEvent,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.arkui.GetDefaultDisplay',
      value: s.arkui.GetDefaultDisplay,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.arkui.MarshRSTransactionData',
      value: s.arkui.MarshRSTransactionData,
      unit: 'count',
      table: 'callstack',
    },
    // HapRay's seconds-offset value, not a duration: `none`, not `ms`.
    {
      id: 'fault.RS.ProcessedNodes.ts',
      value: s.RS.ProcessedNodes.ts,
      unit: 'none',
      table: 'callstack',
    },
    {
      id: 'fault.RS.ProcessedNodes.count',
      value: s.RS.ProcessedNodes.count,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.RS.DisplayNodeSkipTimes',
      value: s.RS.DisplayNodeSkipTimes,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.RS.UnMarshRSTransactionData',
      value: s.RS.UnMarshRSTransactionData,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.RS.AnimateSize.nodeSizeSum',
      value: s.RS.AnimateSize.nodeSizeSum,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.RS.AnimateSize.totalAnimationSizeSum',
      value: s.RS.AnimateSize.totalAnimationSizeSum,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.av_codec.soft_decoder',
      value: s.av_codec.soft_decoder ? 1 : 0,
      unit: 'none',
      table: 'callstack',
    },
    // The broadcast counter is a perf_sample sum, not a callstack count.
    {
      id: 'fault.av_codec.BroadcastControlInstructions',
      value: s.av_codec.BroadcastControlInstructions,
      unit: 'count',
      table: 'perf_sample',
    },
    {
      id: 'fault.av_codec.VideoDecodingInputFrameCount',
      value: s.av_codec.VideoDecodingInputFrameCount,
      unit: 'count',
      table: 'callstack',
    },
    {
      id: 'fault.av_codec.VideoDecodingConsumptionFrame',
      value: s.av_codec.VideoDecodingConsumptionFrame,
      unit: 'count',
      table: 'callstack',
    },
    { id: 'fault.Audio.AudioWriteCB', value: s.Audio.AudioWriteCB, unit: 'count', table: 'perf_sample' },
    { id: 'fault.Audio.AudioReadCB', value: s.Audio.AudioReadCB, unit: 'count', table: 'perf_sample' },
    { id: 'fault.Audio.AudioPlayCb', value: s.Audio.AudioPlayCb, unit: 'count', table: 'perf_sample' },
    { id: 'fault.Audio.AudioRecCb', value: s.Audio.AudioRecCb, unit: 'count', table: 'perf_sample' },
  ];

  return specs.map((spec) =>
    metric({
      id: spec.id,
      value: spec.value,
      unit: spec.unit,
      ...(spec.table === 'perf_sample' ? perfSample : { fidelity: 'exact' as const }),
      provenance: {
        collector: 'hitrace+streamer',
        table: spec.table,
        rows: rows.get(spec.id) ?? 0,
        device: ctx.deviceId,
      },
    }),
  );
}

/** One non-zero fault-tree signal, ready to become evidence. */
interface FaultSignal {
  category: 'arkui' | 'RS' | 'av_codec' | 'Audio';
  name: string;
  count: number;
  process: string;
  /** Exact HapRay `LIKE` pattern(s) for a `callstack.matching` drill-down. */
  patterns: string[];
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * Collects the non-zero signals in the same order as HapRay's result object.
 *
 * Nested HapRay values become one signal per summed leaf: `ProcessedNodes`
 * contributes its node count (its `ts` is provenance, not a count), while
 * `AnimateSize` contributes `nodeSizeSum` and `totalAnimationSizeSum`
 * separately so neither sum is lost. Only signals with a single callstack-name
 * `LIKE` pattern get a drill-down; multi-pattern and perf_sample-sourced
 * counters have no exact `callstack.matching` query, so their `patterns` stay
 * empty rather than pointing an agent at the wrong table.
 */
function faultSignals(signals: FaultTreeSignals, appProcess: string): FaultSignal[] {
  const list: FaultSignal[] = [];
  const push = (
    category: FaultSignal['category'],
    name: string,
    count: number,
    process: string,
    ...patterns: string[]
  ): void => {
    if (count === 0) return;
    list.push({ category, name, count, process, patterns });
  };

  push('arkui', 'animator', signals.arkui.animator, appProcess, '%ohos.animator%');
  push(
    'arkui',
    'HandleOnAreaChangeEvent',
    signals.arkui.HandleOnAreaChangeEvent,
    appProcess,
    '%H:HandleOnAreaChangeEvent%',
  );
  push(
    'arkui',
    'HandleVisibleAreaChangeEvent',
    signals.arkui.HandleVisibleAreaChangeEvent,
    appProcess,
    '%H:HandleVisibleAreaChangeEvent%',
  );
  push(
    'arkui',
    'GetDefaultDisplay',
    signals.arkui.GetDefaultDisplay,
    appProcess,
    '%GetDefaultDisplay%',
  );
  push(
    'arkui',
    'MarshRSTransactionData',
    signals.arkui.MarshRSTransactionData,
    appProcess,
    '%H:MarshRSTransactionData cmdCount%',
  );

  push(
    'RS',
    'ProcessedNodes',
    signals.RS.ProcessedNodes.count,
    'render_service',
    '%ProcessedNodes%',
  );
  push(
    'RS',
    'DisplayNodeSkipTimes',
    signals.RS.DisplayNodeSkipTimes,
    'render_service',
    '%DisplayNode skip|%',
  );
  push(
    'RS',
    'UnMarshRSTransactionData',
    signals.RS.UnMarshRSTransactionData,
    'render_service',
    '%H:UnMarsh RSTransactionData: data size:%',
  );
  push(
    'RS',
    'AnimateSize.nodeSizeSum',
    signals.RS.AnimateSize.nodeSizeSum,
    'render_service',
    '%H:Animate [nodeSize, totalAnimationSize]%',
  );
  push(
    'RS',
    'AnimateSize.totalAnimationSizeSum',
    signals.RS.AnimateSize.totalAnimationSizeSum,
    'render_service',
    '%H:Animate [nodeSize, totalAnimationSize]%',
  );

  // `soft_decoder` is a boolean: a true value is one non-zero signal, false is
  // the zero case the brief says to skip.
  if (signals.av_codec.soft_decoder) {
    list.push({
      category: 'av_codec',
      name: 'soft_decoder',
      count: 1,
      process: 'av_codec_service',
      patterns: [],
    });
  }
  push(
    'av_codec',
    'BroadcastControlInstructions',
    signals.av_codec.BroadcastControlInstructions,
    'av_codec_service',
  );
  push(
    'av_codec',
    'VideoDecodingInputFrameCount',
    signals.av_codec.VideoDecodingInputFrameCount,
    'av_codec_service',
    '%OnQueueInputBuffer%',
  );
  push(
    'av_codec',
    'VideoDecodingConsumptionFrame',
    signals.av_codec.VideoDecodingConsumptionFrame,
    'av_codec_service',
  );

  push('Audio', 'AudioWriteCB', signals.Audio.AudioWriteCB, appProcess);
  push('Audio', 'AudioReadCB', signals.Audio.AudioReadCB, appProcess);
  push('Audio', 'AudioPlayCb', signals.Audio.AudioPlayCb, appProcess);
  push('Audio', 'AudioRecCb', signals.Audio.AudioRecCb, appProcess);

  return list;
}

function faultEvidence(
  signals: FaultTreeSignals,
  ctx: AnalyzeContext,
): Evidence[] {
  return faultSignals(signals, appProcessName(ctx)).map((signal) =>
    evidence({
      kind: 'fault_pattern',
      severity: 'info',
      subject: { process: signal.process },
      window: ctx.window,
      signals: { category: signal.category, count: signal.count },
      explain: `${signal.category} ${signal.name}: ${signal.count}`,
      drillDown: signal.patterns.map((pattern) => ({
        label: 'Matching callstack rows',
        tool: 'callstack.matching',
        args: { pattern },
        returns: 'CallstackEvent[]',
      })),
      // One evidence per (category, signal); without this, every signal in the
      // same window would share an id and a dedupe would drop all but one.
      key: `${signal.category}:${signal.name}`,
    }),
  );
}

/** Zero-metrics evidence for a context assembled without the raw handle. */
function missingDbEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'trace database handle (ctx.db) was not provided; fault-tree analysis skipped',
    drillDown: [],
    key: 'fault-tree:no-db',
  });
}

/**
 * Evidence for a run whose app was never identified.
 *
 * Without an app pid, every `countAppInvokes` counter is an unmeasurable zero,
 * not a finding. Report the cause instead of emitting those zeros as metrics.
 */
function noAppPidEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'no app pid was identified (analyze --app <packageName>, or a scene.json written by ohos-perf collect); app-scoped fault-tree metrics skipped',
    drillDown: [],
    key: 'fault-tree:no-app-pid',
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The `ipc_binder` metrics, from the typed binder analysis.
 *
 * HapRay reads its own `ipc_binder` section from a binder JSON file written by
 * an earlier step, and its registry order at rev 9386e4e means that file is
 * often stale or missing — so the section reports nothing rather than an
 * error. Deriving it from `BinderAnalysis` removes the ordering dependency
 * entirely.
 *
 * Returns an empty list when there is no completed transaction: an average or
 * a maximum over zero measurements is not a measurement, and a `0 ms` latency
 * would read as "the IPC was instant".
 */
function ipcBinderMetrics(
  analysis: BinderAnalysis | undefined,
  ctx: AnalyzeContext,
): Metric[] {
  if (analysis === undefined) return [];
  const completed = analysis.transactions.filter((tx) => tx.latencyMs !== null);
  if (completed.length === 0) return [];

  const latencies = completed.map((tx) => tx.latencyMs as number);
  let total = 0;
  let max = latencies[0]!;
  for (const latency of latencies) {
    total += latency;
    if (latency > max) max = latency;
  }
  const rows = analysis.transactions.length;
  const make = (
    id: string,
    value: number,
    unit: MetricUnit,
  ): Metric =>
    metric({
      id,
      value,
      unit,
      fidelity: 'exact',
      provenance: {
        collector: 'hitrace+streamer',
        table: 'binder_transaction',
        rows,
        device: ctx.deviceId,
      },
    });

  return [
    make('fault.ipc_binder.transactions.count', analysis.transactions.length, 'count'),
    make('fault.ipc_binder.latency.avg', total / latencies.length, 'ms'),
    make('fault.ipc_binder.latency.max', max, 'ms'),
  ];
}

/** Sort order for evidence: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Fault-tree analyzer over raw `callstack` / `perf_sample` SQL.
 *
 * The engine gates this analyzer on `trace.binder`; `ctx.db` is still checked
 * because the handle is optional on `AnalyzeContext` (Task 10 supplies it, but
 * older callers and unit tests do not). Without it the analyzer emits one
 * `no_data` evidence naming `ctx.db` and no metrics, instead of pretending the
 * zero values are measurements.
 *
 * With no app pid the app-scoped (`fault.arkui.*`, `fault.av_codec.*`,
 * `fault.Audio.*`) counters would all be unmeasurable zeros, so only the
 * render-service (`fault.RS.*`) metrics are emitted, alongside one `no_data`
 * evidence explaining how to identify the app. `ctx.db` stays checked first:
 * a missing handle is a different, already-tested cause.
 */
export class FaultTreeAnalyzer implements Analyzer {
  readonly id = 'fault-tree';
  readonly requires: CapabilityId[] = ['trace.binder'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return { metrics: [], evidence: [missingDbEvidence(ctx)] };
    }

    const { signals, rows } = computeFaultTreeDetailed(ctx.db, {
      appPids: ctx.app.pids,
    });
    const perfSamplePresent = hasTable(ctx.db, 'perf_sample');

    // An unidentified app has no pids to scope the app-invoke counters to, so
    // those zeros are not measurements. Keep the render-service metrics (whose
    // queries never used appPids) computed exactly as today, drop every
    // app-scoped metric, and report the cause instead of a confident zero.
    if (ctx.app.pids.length === 0) {
      const metrics = faultMetrics(signals, rows, ctx, perfSamplePresent).filter((m) =>
        m.id.startsWith('fault.RS.'),
      );
      metrics.sort(byMetricId);
      return { metrics, evidence: [noAppPidEvidence(ctx)] };
    }

    const metrics = faultMetrics(signals, rows, ctx, perfSamplePresent);
    const evidenceItems = faultEvidence(signals, ctx);

    // The binder section is derived, not read from a shared file, so it is
    // computed here rather than depending on another analyzer having run. It
    // needs the `args` table, which a trace without binder events may not
    // carry: absence of the table is absence of the data, not an error.
    const binder =
      ctx.binderAnalysis ??
      (hasTable(ctx.db, 'args')
        ? computeBinderAnalysis(ctx.db, { appPids: ctx.app.pids })
        : undefined);
    metrics.push(...ipcBinderMetrics(binder, ctx));

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
