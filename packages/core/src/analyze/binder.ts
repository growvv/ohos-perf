// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { BinderQuery, type BinderEvent } from '../query/binder';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * HapRay's classifier keywords, verbatim from `ipc_binder_analyzer.py:26-27`.
 *
 * Matching is case-insensitive and substring-based. A response keyword always
 * wins over a request keyword: HapRay runs the request loop first and then
 * overwrites `role` in the response loop.
 */
const REQUEST_EVENT_KEYWORDS = ['binder transaction async', 'binder transaction'];
const RESPONSE_EVENT_KEYWORDS = ['binder async rcv', 'binder reply'];

/** One side of a binder transaction, as reported by `computeBinderAnalysis`. */
export interface BinderEndpoint {
  pid: number | null;
  tid: number | null;
  procName: string | null;
  threadName: string | null;
}

/**
 * One paired (or half) binder communication record.
 *
 * `latencyMs` is `null` unless both a request and a response exist. A half
 * transaction stays in `transactions` (it carries a `transaction id`) but never
 * contributes to `processStats`, `threadStats`, or `interfaceStats`.
 */
export interface BinderTransaction {
  transactionId: string | number;
  caller: BinderEndpoint;
  callee: BinderEndpoint;
  requestTs: number | null;
  responseTs: number | null;
  latencyMs: number | null;
}

/** HapRay `_aggregate_stats` row, camelCased for this package. */
export interface BinderProcessStat {
  callerProc: string;
  calleeProc: string;
  count: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  qps: number | null;
  avgIntervalMs: number | null;
}

/** HapRay `_aggregate_by_thread` row, camelCased for this package. */
export interface BinderThreadStat {
  callerProc: string;
  callerTid: number | null;
  callerThreadName: string | null;
  calleeProc: string;
  calleeTid: number | null;
  calleeThreadName: string | null;
  count: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  qps: number | null;
  avgIntervalMs: number | null;
}

/** HapRay `_aggregate_by_interface` row, camelCased for this package. */
export interface BinderInterfaceStat {
  code: string;
  count: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  qps: number | null;
  avgIntervalMs: number | null;
  topCallerProc: string;
  topCalleeProc: string;
  callerProcVariety: number;
  calleeProcVariety: number;
}

/** Everything `computeBinderAnalysis` derives from one trace database. */
export interface BinderAnalysis {
  transactions: BinderTransaction[];
  processStats: BinderProcessStat[];
  threadStats: BinderThreadStat[];
  interfaceStats: BinderInterfaceStat[];
}

interface ProcessRow {
  pid: number | null;
  name: string | null;
  ipid: number | null;
}

interface ThreadRow {
  id: number | null;
  tid: number | null;
  name: string | null;
  ipid: number | null;
}

interface ThreadInfo {
  id: number | null;
  tid: number | null;
  name: string | null;
  ipid: number | null;
  procPid: number | null;
  procName: string | null;
}

interface Maps {
  procByPid: Map<number | null, ProcessRow>;
  threadById: Map<number | null, ThreadInfo>;
  threadByTid: Map<number | null, ThreadInfo>;
}

/**
 * HapRay `_load_process_and_thread_maps`.
 *
 * Raw SQL is used rather than `ProcessQuery`/`ThreadQuery` because both
 * collapse SQL NULL to `0`/`''`; HapRay distinguishes `None` (missing name)
 * from a real empty string, and the public endpoint type keeps `null`.
 *
 * `ORDER BY id` makes the two "last write wins" duplicate rules deterministic:
 * `proc_by_pid`/`proc_by_ipid`/`thread_by_tid` keep the highest-id row, and
 * `thread_by_id` (used for the first-match `calling tid` filter) stays in id
 * order.
 */
function loadMaps(db: QueryHandle): Maps {
  const procByPid = new Map<number | null, ProcessRow>();
  const procByIpid = new Map<number | null, ProcessRow>();
  for (const row of db.query<ProcessRow>(
    'SELECT pid, name, ipid FROM process ORDER BY id',
  )) {
    procByPid.set(row.pid, row);
    if (row.ipid !== null) procByIpid.set(row.ipid, row);
  }

  const threadById = new Map<number | null, ThreadInfo>();
  const threadByTid = new Map<number | null, ThreadInfo>();
  for (const row of db.query<ThreadRow>(
    'SELECT id, tid, name, ipid FROM thread ORDER BY id',
  )) {
    const proc = row.ipid === null ? undefined : procByIpid.get(row.ipid);
    const info: ThreadInfo = {
      id: row.id,
      tid: row.tid,
      name: row.name,
      ipid: row.ipid,
      procPid: proc?.pid ?? null,
      procName: proc?.name ?? null,
    };
    threadById.set(row.id, info);
    if (row.tid !== null) threadByTid.set(row.tid, info);
  }

  return { procByPid, threadById, threadByTid };
}

/** HapRay `_classify_event`: as a request, a response, or neither. */
function classifyEvent(ev: BinderEvent): 'request' | 'response' | 'other' {
  const name = (ev.name ?? '').toLowerCase();
  let role: 'request' | 'response' | 'other' = 'other';
  for (const keyword of REQUEST_EVENT_KEYWORDS) {
    if (name.includes(keyword)) {
      role = 'request';
      break;
    }
  }
  for (const keyword of RESPONSE_EVENT_KEYWORDS) {
    if (name.includes(keyword)) {
      // The response keyword overrides a request keyword, as in HapRay.
      role = 'response';
      break;
    }
  }
  return role;
}

/**
 * HapRay `_load_binder_events`' app filter, one event at a time.
 *
 * An event is relevant when its `callid` is a thread of an app process, when
 * its `destination process` arg is an app pid, or when its `calling tid` arg
 * belongs to an app process. Unlike HapRay, an empty `appPids` filters every
 * event out instead of disabling the filter; the analysis then returns empty
 * arrays rather than every process's binder traffic.
 */
function isRelevantEvent(
  ev: BinderEvent,
  appPids: Set<number>,
  relevantThreadIds: Set<number | null>,
  threadById: Map<number | null, ThreadInfo>,
): boolean {
  if (relevantThreadIds.has(ev.callid)) return true;

  const destination = ev.args['destination process'];
  if (typeof destination === 'number' && appPids.has(destination)) return true;

  const callingTid = ev.args['calling tid'];
  if (typeof callingTid === 'number') {
    // HapRay breaks on the first thread carrying this tid, even when a later
    // duplicate tid row belongs to another process.
    for (const thread of threadById.values()) {
      if (thread.tid === callingTid) {
        return thread.procPid !== null && appPids.has(thread.procPid);
      }
    }
  }
  return false;
}

/** A numeric arg, or `null` when the value is missing or a string. */
function numericArg(value: string | number | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

interface Endpoint extends BinderEndpoint {
  args: Record<string, string | number>;
}

function emptyEndpoint(): Endpoint {
  return {
    pid: null,
    tid: null,
    procName: null,
    threadName: null,
    args: {},
  };
}

interface EnrichedTransaction {
  transactionId: string | number;
  caller: Endpoint;
  callee: Endpoint;
  requestTs: number | null;
  responseTs: number | null;
  latencyMs: number | null;
}

/** HapRay `extract_from_callid`: the accurate callstack -> thread lookup. */
function endpointFromCallid(
  ev: BinderEvent | null,
  threadById: Map<number | null, ThreadInfo>,
): Endpoint {
  if (ev === null) return emptyEndpoint();
  const thread = threadById.get(ev.callid);
  if (thread === undefined) return emptyEndpoint();
  return {
    pid: thread.procPid,
    tid: thread.tid,
    procName: thread.procName,
    threadName: thread.name,
    args: {},
  };
}

/**
 * HapRay `extract_from_args`: the fallback used only when the callid lookup did
 * not produce a process name.
 *
 * A request uses `calling tid`; a response prefers `destination thread` and
 * `destination process`, keeping HapRay's Python truthiness (`0`/`''` fall
 * through to the thread info).
 */
function endpointFromArgs(ev: BinderEvent, isRequest: boolean, maps: Maps): Endpoint {
  if (isRequest) {
    const tid = numericArg(ev.args['calling tid']);
    const thread = tid === null ? undefined : maps.threadByTid.get(tid);
    return {
      pid: thread?.procPid ?? null,
      tid,
      procName: thread?.procName ?? null,
      threadName: thread?.name ?? null,
      args: {},
    };
  }

  const tid = numericArg(ev.args['destination thread']);
  const pid = numericArg(ev.args['destination process']);
  const thread = tid === null ? undefined : maps.threadByTid.get(tid);
  const proc = pid === null ? undefined : maps.procByPid.get(pid);
  return {
    pid: pid || thread?.procPid || null,
    tid,
    procName: proc?.name || thread?.procName || null,
    threadName: thread?.name ?? null,
    args: {},
  };
}

/**
 * HapRay `_build_transactions` + `_enrich_with_proc_thread_info`.
 *
 * Events are grouped by their `transaction id` arg; events without one are
 * dropped. Within a group the earliest request (Python `min(ts)`) and the
 * latest response (`max(ts)`) win. Ties keep the first event in callstack-id
 * order, which is deterministic because `BinderQuery.events()` orders by id.
 */
function buildTransactions(
  events: BinderEvent[],
  maps: Maps,
): EnrichedTransaction[] {
  const groups = new Map<string | number, BinderEvent[]>();
  for (const ev of events) {
    const raw = ev.args['transaction id'];
    if (raw === undefined || raw === null) continue;
    // Keep Python's int/string dict-key distinction: `1` stays a number and
    // `'1'` stays a string.
    const key = typeof raw === 'number' ? raw : String(raw);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [ev]);
    else list.push(ev);
  }

  const enriched: EnrichedTransaction[] = [];
  for (const [transactionId, group] of groups) {
    let request: BinderEvent | null = null;
    let response: BinderEvent | null = null;
    for (const ev of group) {
      const role = classifyEvent(ev);
      if (role === 'request') {
        if (request === null || ev.ts < request.ts) request = ev;
      } else if (role === 'response') {
        if (response === null || ev.ts > response.ts) response = ev;
      }
    }
    if (request === null && response === null) continue;

    const caller = endpointFromCallid(request, maps.threadById);
    const callee = endpointFromCallid(response, maps.threadById);

    if (caller.procName === null && request !== null) {
      const fallback = endpointFromArgs(request, true, maps);
      // HapRay checks only the name, then replaces the whole endpoint.
      if (fallback.procName) Object.assign(caller, fallback);
    }
    if (callee.procName === null && response !== null) {
      const fallback = endpointFromArgs(response, false, maps);
      if (fallback.procName) Object.assign(callee, fallback);
    }

    if (request !== null) caller.args = request.args;
    if (response !== null) callee.args = response.args;

    enriched.push({
      transactionId,
      caller,
      callee,
      requestTs: request === null ? null : request.ts,
      responseTs: response === null ? null : response.ts,
      latencyMs:
        request === null || response === null
          ? null
          : (response.ts - request.ts) / 1_000_000,
    });
  }
  return enriched;
}

/** HapRay's `proc_name or f'pid={pid}'` label, including `None`. */
function procLabel(endpoint: Endpoint): string {
  if (endpoint.procName) return endpoint.procName;
  return `pid=${endpoint.pid === null ? 'None' : endpoint.pid}`;
}

interface TimingItem {
  latency: number;
  requestTs: number | null;
}

interface Timing {
  count: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  qps: number | null;
  avgIntervalMs: number | null;
}

/** Arithmetic mean, or `null` for an empty list; never `NaN`. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * HapRay's QPS / interval block, shared by all three aggregations.
 *
 * Requires more than one request timestamp and a positive span; otherwise both
 * values are `null`, exactly as in Python. The interval list is non-empty
 * whenever that guard passes, and `mean` is still null-guarded.
 */
function rateStats(requestTimes: number[]): {
  qps: number | null;
  avgIntervalMs: number | null;
} {
  if (requestTimes.length <= 1) return { qps: null, avgIntervalMs: null };
  let min = requestTimes[0];
  let max = requestTimes[0];
  for (const ts of requestTimes) {
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  const span = max - min;
  if (!(span > 0)) return { qps: null, avgIntervalMs: null };

  const qps = requestTimes.length / (span / 1_000_000_000);
  const sorted = [...requestTimes].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push((sorted[i] - sorted[i - 1]) / 1_000_000);
  }
  return { qps, avgIntervalMs: mean(intervals) };
}

/**
 * Count/mean/min/max/QPS over one group, or `null` when the group is empty.
 *
 * Only completed transactions are ever pushed into a group, so `count` is the
 * number of completed pairs; the empty guard makes the "mean of nothing" case
 * unreachable instead of returning `NaN`.
 */
function timing(items: TimingItem[]): Timing | null {
  if (items.length === 0) return null;
  const latencies = items.map((item) => item.latency);
  const requestTimes = items
    .map((item) => item.requestTs)
    .filter((ts): ts is number => ts !== null);
  const { qps, avgIntervalMs } = rateStats(requestTimes);
  let min = latencies[0];
  let max = latencies[0];
  let total = 0;
  for (const latency of latencies) {
    if (latency < min) min = latency;
    if (latency > max) max = latency;
    total += latency;
  }
  return {
    count: latencies.length,
    avgLatency: total / latencies.length,
    minLatency: min,
    maxLatency: max,
    qps,
    avgIntervalMs,
  };
}

interface ProcessGroup {
  callerProc: string;
  calleeProc: string;
  items: TimingItem[];
}

interface ThreadGroup {
  callerProc: string;
  callerTid: number | null;
  callerThreadName: string | null;
  calleeProc: string;
  calleeTid: number | null;
  calleeThreadName: string | null;
  items: TimingItem[];
}

interface InterfaceItem extends TimingItem {
  callerProc: string;
  calleeProc: string;
}

interface InterfaceGroup {
  code: string;
  items: InterfaceItem[];
}

/** HapRay `_aggregate_stats`. */
function aggregateProcessStats(enriched: EnrichedTransaction[]): BinderProcessStat[] {
  const groups = new Map<string, ProcessGroup>();
  for (const tx of enriched) {
    if (tx.latencyMs === null) continue;
    const callerProc = procLabel(tx.caller);
    const calleeProc = procLabel(tx.callee);
    const key = JSON.stringify([callerProc, calleeProc]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { callerProc, calleeProc, items: [] };
      groups.set(key, group);
    }
    group.items.push({ latency: tx.latencyMs, requestTs: tx.requestTs });
  }

  const stats: BinderProcessStat[] = [];
  for (const group of groups.values()) {
    const t = timing(group.items);
    if (t === null) continue;
    stats.push({
      callerProc: group.callerProc,
      calleeProc: group.calleeProc,
      ...t,
    });
  }
  // Count descending, then the pair identity ascending. Unlike HapRay's
  // unstable tie order, this is deterministic (D5).
  stats.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return compareStrings(a.callerProc, b.callerProc) ||
      compareStrings(a.calleeProc, b.calleeProc);
  });
  return stats;
}

/** HapRay `_aggregate_by_thread`. */
function aggregateThreadStats(enriched: EnrichedTransaction[]): BinderThreadStat[] {
  const groups = new Map<string, ThreadGroup>();
  for (const tx of enriched) {
    if (tx.latencyMs === null) continue;
    const group: Omit<ThreadGroup, 'items'> = {
      callerProc: procLabel(tx.caller),
      callerTid: tx.caller.tid,
      callerThreadName: tx.caller.threadName,
      calleeProc: procLabel(tx.callee),
      calleeTid: tx.callee.tid,
      calleeThreadName: tx.callee.threadName,
    };
    const key = JSON.stringify([
      group.callerProc,
      group.callerTid,
      group.callerThreadName,
      group.calleeProc,
      group.calleeTid,
      group.calleeThreadName,
    ]);
    let entry = groups.get(key);
    if (entry === undefined) {
      entry = { ...group, items: [] };
      groups.set(key, entry);
    }
    entry.items.push({ latency: tx.latencyMs, requestTs: tx.requestTs });
  }

  const stats: BinderThreadStat[] = [];
  for (const group of groups.values()) {
    const t = timing(group.items);
    if (t === null) continue;
    stats.push({
      callerProc: group.callerProc,
      callerTid: group.callerTid,
      callerThreadName: group.callerThreadName,
      calleeProc: group.calleeProc,
      calleeTid: group.calleeTid,
      calleeThreadName: group.calleeThreadName,
      ...t,
    });
  }
  stats.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return (
      compareStrings(a.callerProc, b.callerProc) ||
      compareNullableNumbers(a.callerTid, b.callerTid) ||
      compareNullableStrings(a.callerThreadName, b.callerThreadName) ||
      compareStrings(a.calleeProc, b.calleeProc) ||
      compareNullableNumbers(a.calleeTid, b.calleeTid) ||
      compareNullableStrings(a.calleeThreadName, b.calleeThreadName)
    );
  });
  return stats;
}

/**
 * HapRay `_aggregate_by_interface`.
 *
 * `code` is taken from caller args first, then callee args, and a transaction
 * with no code is skipped. Integer codes render as lowercase `0x<hex>`; string
 * codes stay as-is.
 */
function aggregateInterfaceStats(
  enriched: EnrichedTransaction[],
): BinderInterfaceStat[] {
  const groups = new Map<string | number, InterfaceGroup>();
  for (const tx of enriched) {
    if (tx.latencyMs === null) continue;
    let code: string | number | undefined;
    if (Object.prototype.hasOwnProperty.call(tx.caller.args, 'code')) {
      code = tx.caller.args['code'];
    } else if (Object.prototype.hasOwnProperty.call(tx.callee.args, 'code')) {
      code = tx.callee.args['code'];
    }
    if (code === undefined) continue;

    const key = typeof code === 'number' ? code : String(code);
    const codeRepr = typeof code === 'number' ? `0x${code.toString(16)}` : code;
    let group = groups.get(key);
    if (group === undefined) {
      group = { code: codeRepr, items: [] };
      groups.set(key, group);
    }
    group.items.push({
      latency: tx.latencyMs,
      requestTs: tx.requestTs,
      callerProc: procLabel(tx.caller),
      calleeProc: procLabel(tx.callee),
    });
  }

  const stats: BinderInterfaceStat[] = [];
  for (const group of groups.values()) {
    const t = timing(group.items);
    if (t === null) continue;
    const callerCounts = new Map<string, number>();
    const calleeCounts = new Map<string, number>();
    for (const item of group.items) {
      callerCounts.set(item.callerProc, (callerCounts.get(item.callerProc) ?? 0) + 1);
      calleeCounts.set(item.calleeProc, (calleeCounts.get(item.calleeProc) ?? 0) + 1);
    }
    stats.push({
      code: group.code,
      ...t,
      topCallerProc: topProc(callerCounts),
      topCalleeProc: topProc(calleeCounts),
      callerProcVariety: callerCounts.size,
      calleeProcVariety: calleeCounts.size,
    });
  }
  stats.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return compareStrings(a.code, b.code);
  });
  return stats;
}

/** Python `max(counter.items(), key=count)`, with insertion-order tie-break. */
function topProc(counts: Map<string, number>): string {
  let best = 'unknown';
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareStrings(a, b);
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function toTransaction(tx: EnrichedTransaction): BinderTransaction {
  return {
    transactionId: tx.transactionId,
    caller: {
      pid: tx.caller.pid,
      tid: tx.caller.tid,
      procName: tx.caller.procName,
      threadName: tx.caller.threadName,
    },
    callee: {
      pid: tx.callee.pid,
      tid: tx.callee.tid,
      procName: tx.callee.procName,
      threadName: tx.callee.threadName,
    },
    requestTs: tx.requestTs,
    responseTs: tx.responseTs,
    latencyMs: tx.latencyMs,
  };
}

/**
 * Port of HapRay `IpcBinderAnalyzer._analyze_impl` for one trace database.
 *
 * Filtering, request/response pairing, enrichment and the three aggregations
 * mirror `ipc_binder_analyzer.py` rev `9386e4e`. The deliberate differences:
 * an empty `appPids` filters everything (HapRay would disable the filter),
 * stats ties are broken by identity instead of Python's unstable order, and
 * no value is rounded here (HapRay rounds only when writing its report).
 * Every mean is guarded (`timing` returns `null` for an empty group), so a
 * trace with only half transactions never produces `NaN`.
 */
export function computeBinderAnalysis(
  db: QueryHandle,
  opts: { appPids: number[] },
): BinderAnalysis {
  const appPids = new Set(opts.appPids);
  const maps = loadMaps(db);

  const relevantThreadIds = new Set<number | null>();
  for (const [id, thread] of maps.threadById) {
    if (thread.procPid !== null && appPids.has(thread.procPid)) {
      relevantThreadIds.add(id);
    }
  }

  const events = new BinderQuery(db)
    .events()
    .filter((ev) => isRelevantEvent(ev, appPids, relevantThreadIds, maps.threadById));

  const enriched = buildTransactions(events, maps);
  // Aggregations run before the output sort so interface tie-breaks keep
  // HapRay's first-seen order.
  const processStats = aggregateProcessStats(enriched);
  const threadStats = aggregateThreadStats(enriched);
  const interfaceStats = aggregateInterfaceStats(enriched);

  const transactions = enriched
    .map(toTransaction)
    .sort((a, b) => {
      const aTs = a.requestTs ?? 0;
      const bTs = b.requestTs ?? 0;
      if (aTs !== bTs) return aTs - bTs;
      return compareStrings(String(a.transactionId), String(b.transactionId));
    });

  return { transactions, processStats, threadStats, interfaceStats };
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

function binderMetric(
  id: string,
  value: number,
  unit: MetricUnit,
  ctx: AnalyzeContext,
): Metric {
  return metric({
    id,
    value,
    unit,
    fidelity: 'exact',
    provenance: {
      collector: 'hitrace+streamer',
      table: 'callstack',
      device: ctx.deviceId,
    },
  });
}

/**
 * The six metric ids, with the five latency/pair metrics conditional on a
 * completed pair.
 *
 * `binder.transactions.count` still counts every transaction with an id,
 * including orphans, because that is a fact about the trace. Emitting 0 ms
 * latency or an empty pair count when nothing was paired would present missing
 * evidence as a measurement.
 */
function binderMetrics(analysis: BinderAnalysis, ctx: AnalyzeContext): Metric[] {
  const completed = analysis.transactions.filter((tx) => tx.latencyMs !== null);
  const metrics = [
    binderMetric('binder.transactions.count', analysis.transactions.length, 'count', ctx),
  ];
  if (completed.length === 0) return metrics;

  const latencies = completed.map((tx) => tx.latencyMs as number);
  let total = 0;
  let max = latencies[0];
  for (const latency of latencies) {
    total += latency;
    if (latency > max) max = latency;
  }
  metrics.push(
    binderMetric('binder.latency.avg', total / latencies.length, 'ms', ctx),
    binderMetric('binder.latency.max', max, 'ms', ctx),
    binderMetric('binder.process.pairs', analysis.processStats.length, 'count', ctx),
    binderMetric('binder.thread.pairs', analysis.threadStats.length, 'count', ctx),
    binderMetric('binder.interfaces.count', analysis.interfaceStats.length, 'count', ctx),
  );
  return metrics;
}

/** Top five process pairs by count, then caller/callee ascending. */
function binderEvidence(analysis: BinderAnalysis, ctx: AnalyzeContext): Evidence[] {
  return analysis.processStats.slice(0, 5).map((stat) =>
    evidence({
      kind: 'binder_hotspot',
      severity: 'info',
      subject: { process: stat.callerProc },
      window: ctx.window,
      signals: {
        calleeProc: stat.calleeProc,
        count: stat.count,
        avgLatencyMs: stat.avgLatency,
        maxLatencyMs: stat.maxLatency,
        // `qps` is omitted, never null or 0, when a pair has no measurable
        // rate (a single request timestamp). The stat field itself still
        // exposes `null`; evidence signals stay null-free by contract.
        ...(stat.qps === null ? {} : { qps: stat.qps }),
      },
      explain: `${stat.callerProc} -> ${stat.calleeProc}: ${stat.count} binder transactions`,
      drillDown: [
        {
          label: 'Binder process pair',
          tool: 'binder.processStats',
          args: { callerProc: stat.callerProc, calleeProc: stat.calleeProc },
          returns: 'BinderProcessStat',
        },
      ],
      // One evidence per process pair; without this, every pair in the same
      // window would share an id and a dedupe would drop all but one.
      key: `${stat.callerProc}->${stat.calleeProc}`,
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
      'trace database handle (ctx.db) was not provided; binder analysis skipped',
    drillDown: [],
  });
}

/** Zero-statistics evidence when every kept transaction is a half pair. */
function unpairedEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'no binder transaction could be paired with both a request and a response; latency and pair statistics skipped',
    drillDown: [],
  });
}

/**
 * Evidence for a run whose app was never identified.
 *
 * With no app pid the event filter keeps nothing, so a zero transaction count
 * is a statement about the missing identity, not about binder traffic.
 */
function noAppPidEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'no app pid was identified (analyze --app <packageName>, or a scene.json written by ohos-perf collect); binder analysis skipped',
    drillDown: [],
    key: 'binder:no-app-pid',
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
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
 * Binder analyzer over `callstack` / `args` / `data_dict` SQL.
 *
 * The engine gates this analyzer on `trace.binder`; `ctx.db` is still checked
 * because the handle is optional on `AnalyzeContext`. Without it the analyzer
 * emits one `no_data` evidence naming `ctx.db` and no metrics rather than
 * pretending zero binder traffic is a measurement.
 */
export class BinderAnalyzer implements Analyzer {
  readonly id = 'binder';
  readonly requires: CapabilityId[] = ['trace.binder'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return { metrics: [], evidence: [missingDbEvidence(ctx)] };
    }
    // An unidentified app filters every binder event out; a zero count is a
    // statement about the missing identity, not a measurement of traffic.
    // This replaces the misleading unpairedEvidence path for this case.
    if (ctx.app.pids.length === 0) {
      return { metrics: [], evidence: [noAppPidEvidence(ctx)] };
    }

    const analysis = computeBinderAnalysis(ctx.db, { appPids: ctx.app.pids });
    const metrics = binderMetrics(analysis, ctx);
    const hasCompletedPair = analysis.transactions.some((tx) => tx.latencyMs !== null);
    const evidenceItems = hasCompletedPair
      ? binderEvidence(analysis, ctx)
      : [unpairedEvidence(ctx)];

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
