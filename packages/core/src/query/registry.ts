import { computeBinderAnalysis } from '../analyze/binder';
import { computeFpsWindows } from '../analyze/fps';
import {
  FrameLoadIndex, type FrameLoadThread, type PerfFileAttribution,
} from '../analyze/frame-load';
import {
  aggregateUnreleased,
  buildNativeTimeline,
  loadNativeMemory,
  type NativeTimelineBucket,
  type UnreleasedRow,
} from '../analyze/native-memory';
import { NativeHookQuery } from './native-hook';
import {
  computeThreadAnalysis, type RedundantThreadPattern,
} from '../analyze/threads-score';
import { analyzeThreadWakeup } from '../analyze/threads-wakeup';
import type { UiNode } from './ui';
import type { QueryHandle } from '../db/driver';
import type {
  CapabilityId, CapabilityMatrix, CapabilityState,
} from '../device/capability';
import { OhosPerfError } from '../errors';
import type { DrillDownHandle } from '../report/evidence';
import type { AppIdentity } from '../types';
import { CallstackQuery } from './callstack';
import { FrameQuery } from './frames';
import { PerfQuery } from './perf';

/**
 * Named drill-down queries: the tools an agent calls after reading
 * `Evidence.drillDown`.
 *
 * A definition is a stable, documented name plus a deterministic row producer
 * over an already-open trace database. The registry performs no IO of its own,
 * never writes, and never returns rows in an order the underlying query did
 * not fix. `Evidence.drillDown[].tool` values are these names — the static
 * guard in `test/drilldown.test.ts` keeps the two from drifting apart.
 */

/** Rows returned when the caller does not ask for a limit. */
export const DEFAULT_QUERY_LIMIT = 100;
/** Hard ceiling on rows returned by one call, so no drill-down dumps a table. */
export const MAX_QUERY_LIMIT = 1000;

/** Everything a named query may read: one open database, the app, the matrix. */
export interface QueryContext {
  readonly db: QueryHandle;
  readonly app: AppIdentity;
  readonly caps: CapabilityMatrix;
  /**
   * The scene's flattened UI tree, when the capture included a `uitest`
   * dump. Absent means the scene has no `ui.json`; `ui.get` then returns no
   * rows rather than failing.
   */
  readonly uiTree?: readonly UiNode[];
}

/** One argument a query accepts, for `ohos-perf tools` and validation. */
export interface QueryArgument {
  readonly name: string;
  readonly type: 'number' | 'string' | 'string[]' | 'object';
  readonly required: boolean;
  readonly description: string;
}

/** One registered query. `run` returns rows in the query's documented order. */
export interface NamedQueryDefinition {
  readonly name: string;
  readonly description: string;
  readonly args: readonly QueryArgument[];
  readonly returns: string;
  /** Throws QUERY_BAD_ARGS for missing, unknown, or wrongly typed arguments. */
  parseArgs(args: Record<string, unknown>): void;
  run(ctx: QueryContext, args: Record<string, unknown>): unknown[];
  /**
   * Exact match count when `run` caps its own fetch; defaults to
   * `rows.length`. Must apply the same filter as `run` so `total` stays
   * deterministic for fixed arguments (D5).
   */
  count?(ctx: QueryContext, args: Record<string, unknown>): number;
}

/** A definition without its function, safe to serialise as a tool list. */
export interface NamedQueryInfo {
  readonly name: string;
  readonly description: string;
  readonly args: readonly QueryArgument[];
  readonly returns: string;
}

/** The envelope every query returns. */
export interface NamedQueryResult {
  readonly query: string;
  readonly rows: unknown[];
  /** Matched rows before the output limit was applied. */
  readonly total: number;
  readonly truncated: boolean;
}

/** One category total from `mem.native.categories`. */
export interface NativeCategoryTotal {
  category: number;
  categoryName: string;
  subCategory: string;
  size: number;
  count: number;
}

/** One frame of a `mem.native.callchain` result. */
export interface NativeCallchainFrame {
  callchainId: number;
  depth: number;
  ip: number;
  symbol: string;
  file: string;
}

function badArgs(query: string, detail: string): OhosPerfError {
  return new OhosPerfError(`${query}: ${detail}`, { code: 'QUERY_BAD_ARGS' });
}

function rejectUnknownArgs(
  query: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw badArgs(query, `unknown argument "${key}"`);
  }
}

function numberArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): number {
  const value = args[name];
  if (value === undefined) throw badArgs(query, `missing number argument "${name}"`);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badArgs(query, `argument "${name}" must be a finite number`);
  }
  return value;
}

function stringArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];
  if (value === undefined) throw badArgs(query, `missing string argument "${name}"`);
  if (typeof value !== 'string' || value === '') {
    throw badArgs(query, `argument "${name}" must be a non-empty string`);
  }
  return value;
}

/**
 * Any string, including `''`.
 *
 * Unnamed threads are a real pattern: the wakeup analysis maps a NULL
 * `thread.name` to `''` and the analyzer emits that value as a
 * `threads.pattern` handle, so an empty name must stay valid.
 */
function nameArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];
  if (typeof value !== 'string') {
    throw badArgs(query, `missing string argument "${name}"`);
  }
  return value;
}

function optionalNumberArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badArgs(query, `argument "${name}" must be a finite number`);
  }
  return value;
}

function optionalStringArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw badArgs(query, `argument "${name}" must be a non-empty string`);
  }
  return value;
}

function stringArrayArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): string[] {
  const value = args[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item !== '')
  ) {
    throw badArgs(query, `argument "${name}" must be a non-empty array of strings`);
  }
  return value as string[];
}

function windowArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): { startNs: number; endNs: number } {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badArgs(query, `missing object argument "${name}"`);
  }
  const window = value as Record<string, unknown>;
  rejectUnknownArgs(query, window, ['startNs', 'endNs']);
  const startNs = numberArg(query, window, 'startNs');
  const endNs = numberArg(query, window, 'endNs');
  if (endNs < startNs) throw badArgs(query, 'endNs must be >= startNs');
  return { startNs, endNs };
}

/** `startNs`/`endNs` are optional as a pair; one without the other is an error. */
function rangeArg(
  query: string,
  args: Record<string, unknown>,
): { startNs: number; endNs: number } | undefined {
  if (args.startNs === undefined && args.endNs === undefined) return undefined;
  const startNs = numberArg(query, args, 'startNs');
  const endNs = numberArg(query, args, 'endNs');
  if (endNs < startNs) throw badArgs(query, 'endNs must be >= startNs');
  return { startNs, endNs };
}

/** Like {@link rangeArg}, but the range is mandatory. */
function requiredRange(
  query: string,
  args: Record<string, unknown>,
): { startNs: number; endNs: number } {
  const range = rangeArg(query, args);
  if (range === undefined) throw badArgs(query, 'missing number argument "startNs"');
  return range;
}

/**
 * App-thread ids that carry perf samples, sorted.
 *
 * `perf_thread` is optional, so an absent table or an app with no perf
 * threads yields `[]` and every caller returns no rows rather than throwing.
 */
function perfThreadIds(ctx: QueryContext): number[] {
  const perf = new PerfQuery(ctx.db);
  if (ctx.app.pids.length === 0) return [];
  const ids = perf.threads([...ctx.app.pids]).map((thread) => thread.threadId);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Weight share of `samples` over `total`, in percent. */
function shareOf(samples: number, total: number): number {
  return total > 0 ? (samples / total) * 100 : 0;
}

/**
 * True when one redundant-thread pattern answers the requested name.
 *
 * A pattern answers to three names: its display name (the only variant, or
 * `name_*` when it groups several), any individual variant name, and its
 * `name_*` label. The empty string matches unnamed patterns.
 */
export function patternMatchesName(
  pattern: Pick<RedundantThreadPattern, 'thread_name' | 'thread_name_variants'>,
  name: string,
): boolean {
  return (
    pattern.thread_name === name ||
    pattern.thread_name_variants.includes(name) ||
    `${pattern.thread_name}_*` === name
  );
}

function filterBinderStats(
  stats: ReturnType<typeof computeBinderAnalysis>['processStats'],
  callerProc: string | undefined,
  calleeProc: string | undefined,
): typeof stats {
  return stats.filter(
    (stat) =>
      (callerProc === undefined || stat.callerProc === callerProc) &&
      (calleeProc === undefined || stat.calleeProc === calleeProc),
  );
}

const DEFINITIONS: NamedQueryDefinition[] = [
  {
    name: 'binder.processStats',
    description:
      'Binder process-pair statistics for the analyzed app, optionally narrowed to one caller/callee pair.',
    args: [
      { name: 'callerProc', type: 'string', required: false, description: 'caller process name' },
      { name: 'calleeProc', type: 'string', required: false, description: 'callee process name' },
    ],
    returns: 'BinderProcessStat[]',
    parseArgs(args) {
      rejectUnknownArgs('binder.processStats', args, ['callerProc', 'calleeProc']);
      optionalStringArg('binder.processStats', args, 'callerProc');
      optionalStringArg('binder.processStats', args, 'calleeProc');
    },
    run(ctx, args) {
      if (ctx.app.pids.length === 0) return [];
      return filterBinderStats(
        computeBinderAnalysis(ctx.db, { appPids: ctx.app.pids }).processStats,
        optionalStringArg('binder.processStats', args, 'callerProc'),
        optionalStringArg('binder.processStats', args, 'calleeProc'),
      );
    },
  },
  {
    name: 'callstack.matching',
    description:
      'Callstack rows whose name matches a bound SQL LIKE pattern, optionally inside a time range (at most 1000 rows).',
    args: [
      { name: 'pattern', type: 'string', required: true, description: 'SQL LIKE pattern' },
      { name: 'startNs', type: 'number', required: false, description: 'range start, with endNs' },
      { name: 'endNs', type: 'number', required: false, description: 'range end, with startNs' },
    ],
    returns: 'CallstackEvent[]',
    parseArgs(args) {
      rejectUnknownArgs('callstack.matching', args, ['pattern', 'startNs', 'endNs']);
      stringArg('callstack.matching', args, 'pattern');
      rangeArg('callstack.matching', args);
    },
    count(ctx, args) {
      const pattern = stringArg('callstack.matching', args, 'pattern');
      const range = rangeArg('callstack.matching', args);
      return new CallstackQuery(ctx.db).countMatching(pattern,
        range === undefined ? {} : { range });
    },
    run(ctx, args) {
      const pattern = stringArg('callstack.matching', args, 'pattern');
      const range = rangeArg('callstack.matching', args);
      return new CallstackQuery(ctx.db).matching(pattern, {
        ...(range === undefined ? {} : { range }),
        limit: MAX_QUERY_LIMIT,
      });
    },
  },
  {
    name: 'callstack.range',
    description: 'Callstack rows inside an inclusive time range.',
    args: [
      { name: 'startNs', type: 'number', required: true, description: 'range start (ns)' },
      { name: 'endNs', type: 'number', required: true, description: 'range end (ns)' },
    ],
    returns: 'CallstackEvent[]',
    parseArgs(args) {
      rejectUnknownArgs('callstack.range', args, ['startNs', 'endNs']);
      if (rangeArg('callstack.range', args) === undefined) {
        throw badArgs('callstack.range', 'missing number argument "startNs"');
      }
    },
    run(ctx, args) {
      const range = rangeArg('callstack.range', args);
      if (range === undefined) {
        throw badArgs('callstack.range', 'missing number argument "startNs"');
      }
      return new CallstackQuery(ctx.db).all(range);
    },
  },
  {
    name: 'caps.get',
    description:
      'Capability states for the requested ids, in the requested order; unknown ids report as not probed.',
    args: [
      { name: 'ids', type: 'string[]', required: true, description: 'capability ids' },
    ],
    returns: 'CapabilityState[]',
    parseArgs(args) {
      rejectUnknownArgs('caps.get', args, ['ids']);
      stringArrayArg('caps.get', args, 'ids');
    },
    run(ctx, args) {
      return stringArrayArg('caps.get', args, 'ids').map((id) => {
        const state = ctx.caps.get(id as CapabilityId);
        if (state !== undefined) return state;
        const synthesized: CapabilityState = {
          id: id as CapabilityId,
          available: false,
          fidelity: 'exact',
          reason: 'capability not probed',
          probe: { command: '', stdout: '', stderr: '', code: 0 },
        };
        return synthesized;
      });
    },
  },
  {
    name: 'frame.load.files',
    description:
      'Sampled-event weight (perf_sample.event_count, not row counts) of the app ' +
      'threads in a time range, attributed to the leaf symbol\'s file and ' +
      'sorted by weight. Shares are of the window\'s summed app-thread weight.',
    args: [
      { name: 'startNs', type: 'number', required: true, description: 'range start (ns)' },
      { name: 'endNs', type: 'number', required: true, description: 'range end (ns)' },
    ],
    returns: 'PerfFileAttribution[]',
    parseArgs(args) {
      rejectUnknownArgs('frame.load.files', args, ['startNs', 'endNs']);
      requiredRange('frame.load.files', args);
    },
    run(ctx, args) {
      const range = requiredRange('frame.load.files', args);
      const threadIds = perfThreadIds(ctx);
      if (threadIds.length === 0) return [];
      const perf = new PerfQuery(ctx.db);
      const total = perf.eventCount(threadIds, range);
      const byFile = new Map<string, number>();
      for (const row of perf.leafAttribution(threadIds, range)) {
        byFile.set(row.filePath, (byFile.get(row.filePath) ?? 0) + row.samples);
      }
      return [...byFile.entries()]
        .map(([filePath, samples]): PerfFileAttribution & { share: number } => ({
          filePath,
          samples,
          share: shareOf(samples, total),
        }))
        .sort(
          (a, b) =>
            b.samples - a.samples ||
            (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0),
        );
    },
  },
  {
    name: 'frame.load.symbols',
    description:
      'Sampled-event weight (perf_sample.event_count, not row counts) of the app ' +
      'threads in a time range, attributed to the leaf symbol of each callchain. ' +
      'Shares are of the window\'s summed app-thread weight, so unattributed ' +
      'samples stay visible as rows not summing to 100%.',
    args: [
      { name: 'startNs', type: 'number', required: true, description: 'range start (ns)' },
      { name: 'endNs', type: 'number', required: true, description: 'range end (ns)' },
    ],
    returns: 'PerfLeafAttribution[]',
    parseArgs(args) {
      rejectUnknownArgs('frame.load.symbols', args, ['startNs', 'endNs']);
      requiredRange('frame.load.symbols', args);
    },
    run(ctx, args) {
      const range = requiredRange('frame.load.symbols', args);
      const threadIds = perfThreadIds(ctx);
      if (threadIds.length === 0) return [];
      const perf = new PerfQuery(ctx.db);
      const total = perf.eventCount(threadIds, range);
      return perf
        .leafAttribution(threadIds, range)
        .map((row) => ({ ...row, share: shareOf(row.samples, total) }));
    },
  },
  {
    name: 'frame.load.threads',
    description:
      'Sampled-event weight (perf_sample.event_count, not row counts) of the app ' +
      'threads in a time range, split by thread and sorted by weight. Shares ' +
      'are of the summed weight of the returned rows.',
    args: [
      { name: 'startNs', type: 'number', required: true, description: 'range start (ns)' },
      { name: 'endNs', type: 'number', required: true, description: 'range end (ns)' },
    ],
    returns: 'FrameLoadThread[]',
    parseArgs(args) {
      rejectUnknownArgs('frame.load.threads', args, ['startNs', 'endNs']);
      requiredRange('frame.load.threads', args);
    },
    run(ctx, args) {
      const range = requiredRange('frame.load.threads', args);
      if (ctx.app.pids.length === 0) return [];
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(ctx.db),
        pids: ctx.app.pids,
        range,
      });
      if (index === undefined) return [];
      const rows = index.threadLoads({
        ts: range.startNs,
        dur: range.endNs - range.startNs,
      });
      const total = rows.reduce((sum, row) => sum + row.samples, 0);
      return rows.map(
        (row): FrameLoadThread & { share: number } => ({
          ...row,
          share: shareOf(row.samples, total),
        }),
      );
    },
  },
  {
    name: 'frames.all',
    description: 'Every complete frame inside a time window, ordered by ts.',
    args: [
      { name: 'window', type: 'object', required: true, description: '{ startNs, endNs }' },
    ],
    returns: 'Frame[]',
    parseArgs(args) {
      rejectUnknownArgs('frames.all', args, ['window']);
      windowArg('frames.all', args, 'window');
    },
    run(ctx, args) {
      return new FrameQuery(ctx.db).all(windowArg('frames.all', args, 'window'));
    },
  },
  {
    name: 'frames.fpsSeries',
    description:
      'Frames per second in fixed 1-second tumbling windows starting at the first ' +
      'rendered frame in the range. A frame exactly on a boundary belongs to the ' +
      'next window; gaps longer than one second appear as explicit zero windows. ' +
      'The final window under-reports a capture that ends mid-second.',
    args: [
      { name: 'startNs', type: 'number', required: true, description: 'range start (ns)' },
      { name: 'endNs', type: 'number', required: true, description: 'range end (ns)' },
    ],
    returns: 'FpsWindow[]',
    parseArgs(args) {
      rejectUnknownArgs('frames.fpsSeries', args, ['startNs', 'endNs']);
      requiredRange('frames.fpsSeries', args);
    },
    run(ctx, args) {
      const range = requiredRange('frames.fpsSeries', args);
      return computeFpsWindows(new FrameQuery(ctx.db).all(range));
    },
  },
  {
    name: 'frames.get',
    description: 'One frame by frame_slice.id.',
    args: [
      { name: 'id', type: 'number', required: true, description: 'frame_slice row id' },
    ],
    returns: 'Frame',
    parseArgs(args) {
      rejectUnknownArgs('frames.get', args, ['id']);
      numberArg('frames.get', args, 'id');
    },
    run(ctx, args) {
      const frame = new FrameQuery(ctx.db).get(numberArg('frames.get', args, 'id'));
      return frame === undefined ? [] : [frame];
    },
  },
  {
    name: 'mem.native.callchain',
    description:
      'The full frame stack of one native callchain, ordered by depth, with each ' +
      'frame\'s file and symbol resolved from data_dict.',
    args: [
      {
        name: 'callchainId',
        type: 'number',
        required: true,
        description: 'native_hook.callchain_id',
      },
    ],
    returns: 'NativeCallchainFrame[]',
    parseArgs(args) {
      rejectUnknownArgs('mem.native.callchain', args, ['callchainId']);
      numberArg('mem.native.callchain', args, 'callchainId');
    },
    run(ctx, args) {
      const callchainId = numberArg('mem.native.callchain', args, 'callchainId');
      const query = new NativeHookQuery(ctx.db);
      const frames = query.frames([callchainId]).get(callchainId) ?? [];
      if (frames.length === 0) return [];
      const files = query.dataDict(frames.map((frame) => frame.fileId));
      const symbols = query.dataDict(frames.map((frame) => frame.symbolId));
      return frames.map(
        (frame): NativeCallchainFrame => ({
          callchainId: frame.callchainId,
          depth: frame.depth,
          ip: frame.ip,
          symbol: symbols.get(frame.symbolId) ?? '',
          file: files.get(frame.fileId) ?? '',
        }),
      );
    },
  },
  {
    name: 'mem.native.categories',
    description:
      'Unreleased native bytes at the end of the capture, aggregated by component ' +
      'category and sub-category (APP, ArkUI, OS_Runtime, RN, Flutter, WEB, KMP, ' +
      'SYS_SDK, Thread, UNKNOWN), sorted by size.',
    args: [],
    returns: 'NativeCategoryTotal[]',
    parseArgs(args) {
      rejectUnknownArgs('mem.native.categories', args, []);
    },
    run(ctx) {
      const snapshot = loadNativeMemory(ctx.db, ctx.app.pids);
      if (snapshot === undefined) return [];
      const rows = aggregateUnreleased(snapshot.pair.unreleasedAt(snapshot.endTs), snapshot.names);
      const totals = new Map<string, NativeCategoryTotal>();
      for (const row of rows) {
        const key = `${row.categoryName}|${row.subCategory}`;
        const existing = totals.get(key);
        if (existing !== undefined) {
          existing.size += row.size;
          existing.count += row.count;
          continue;
        }
        totals.set(key, {
          category: row.category,
          categoryName: row.categoryName,
          subCategory: row.subCategory,
          size: row.size,
          count: row.count,
        });
      }
      return [...totals.values()].sort(
        (a, b) =>
          b.size - a.size ||
          (a.categoryName < b.categoryName ? -1 : a.categoryName > b.categoryName ? 1 : 0) ||
          (a.subCategory < b.subCategory ? -1 : a.subCategory > b.subCategory ? 1 : 0),
      );
    },
  },
  {
    name: 'mem.native.timeline',
    description:
      'Native alloc and free bytes per fixed bucket anchored at the first app ' +
      'event, with the running total at each bucket end and the peak bucket ' +
      'flagged. Buckets with no events are omitted, not reported as zeros.',
    args: [
      {
        name: 'bucketMs',
        type: 'number',
        required: false,
        description: 'bucket width in milliseconds (default 1000, minimum 1)',
      },
    ],
    returns: 'NativeTimelineBucket[]',
    parseArgs(args) {
      rejectUnknownArgs('mem.native.timeline', args, ['bucketMs']);
      const bucketMs = optionalNumberArg('mem.native.timeline', args, 'bucketMs');
      if (bucketMs !== undefined && bucketMs < 1) {
        throw badArgs('mem.native.timeline', 'argument "bucketMs" must be at least 1');
      }
    },
    run(ctx, args) {
      const bucketMs = optionalNumberArg('mem.native.timeline', args, 'bucketMs') ?? 1000;
      const snapshot = loadNativeMemory(ctx.db, ctx.app.pids);
      if (snapshot === undefined) return [] as NativeTimelineBucket[];
      return buildNativeTimeline(snapshot.events, bucketMs * 1_000_000);
    },
  },
  {
    name: 'mem.native.unreleased',
    description:
      'Live native allocations at one instant, merged per callchain, process and ' +
      'thread, sorted by size. "Unreleased" means still allocated when the ' +
      'capture ended (or at the peak) — it is not a leak claim.',
    args: [
      {
        name: 'point',
        type: 'string',
        required: false,
        description: '"peak" (the highest running total) or "end" (default)',
      },
    ],
    returns: 'UnreleasedRow[]',
    parseArgs(args) {
      rejectUnknownArgs('mem.native.unreleased', args, ['point']);
      const point = optionalStringArg('mem.native.unreleased', args, 'point');
      if (point !== undefined && point !== 'peak' && point !== 'end') {
        throw badArgs('mem.native.unreleased', 'argument "point" must be "peak" or "end"');
      }
    },
    run(ctx, args) {
      const point = optionalStringArg('mem.native.unreleased', args, 'point') ?? 'end';
      const snapshot = loadNativeMemory(ctx.db, ctx.app.pids);
      if (snapshot === undefined) return [] as UnreleasedRow[];
      const instant = point === 'peak' ? snapshot.pair.peakTs : snapshot.endTs;
      return aggregateUnreleased(snapshot.pair.unreleasedAt(instant), snapshot.names);
    },
  },
  {
    name: 'threads.pattern',
    description:
      'Redundant-thread patterns matching a display name, a variant name, or a `name_*` label.',
    args: [
      { name: 'threadName', type: 'string', required: true, description: 'pattern display name' },
    ],
    returns: 'RedundantThreadPattern[]',
    parseArgs(args) {
      rejectUnknownArgs('threads.pattern', args, ['threadName']);
      nameArg('threads.pattern', args, 'threadName');
    },
    run(ctx, args) {
      const name = nameArg('threads.pattern', args, 'threadName');
      const results = analyzeThreadWakeup(ctx.db, { appPids: ctx.app.pids });
      const patterns = computeThreadAnalysis(results).redundantThreadsSummary.redundant_threads;
      return patterns.filter((pattern) => patternMatchesName(pattern, name));
    },
  },
  {
    name: 'ui.get',
    description:
      'The flattened UI tree in document order, optionally filtered by bundle name and depth.',
    args: [
      {
        name: 'bundleName',
        type: 'string',
        required: false,
        description: 'keep nodes whose bundleName is exactly this',
      },
      {
        name: 'maxDepth',
        type: 'number',
        required: false,
        description: 'keep nodes at depth <= maxDepth (root is 0)',
      },
    ],
    returns: 'UiNode[]',
    parseArgs(args) {
      rejectUnknownArgs('ui.get', args, ['bundleName', 'maxDepth']);
      optionalStringArg('ui.get', args, 'bundleName');
      const maxDepth = optionalNumberArg('ui.get', args, 'maxDepth');
      if (maxDepth !== undefined && maxDepth < 0) {
        throw badArgs('ui.get', 'argument "maxDepth" must not be negative');
      }
    },
    run(ctx, args) {
      const bundleName = optionalStringArg('ui.get', args, 'bundleName');
      const maxDepth = optionalNumberArg('ui.get', args, 'maxDepth');
      // Rows are already in document order, so filtering preserves it; no
      // sort is applied and none is needed for D5.
      return (ctx.uiTree ?? []).filter(
        (node) =>
          (bundleName === undefined || node.bundleName === bundleName) &&
          (maxDepth === undefined || node.depth <= maxDepth),
      );
    },
  },
];

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

/** Every registered query, sorted by name. */
export function queryDefinitions(): NamedQueryDefinition[] {
  return [...DEFINITIONS];
}

/** The definition for `name`, or `undefined` when no such query exists. */
export function lookupQuery(name: string): NamedQueryDefinition | undefined {
  return BY_NAME.get(name);
}

/** The names an unknown tool can be corrected against. */
export function unknownQueryError(name: string): OhosPerfError {
  const names = DEFINITIONS.map((definition) => definition.name).join(', ');
  return new OhosPerfError(
    `unknown query "${name}"; available: ${names}`,
    { code: 'QUERY_UNKNOWN' },
  );
}

/**
 * Resolve and validate an output limit.
 *
 * `undefined` selects {@link DEFAULT_QUERY_LIMIT}; anything that is not an
 * integer in `[1, MAX_QUERY_LIMIT]` is rejected rather than clamped, so a
 * caller that meant 5000 learns the contract instead of silently losing rows.
 */
export function resolveQueryLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new OhosPerfError(
      `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}, got ${String(limit)}`,
      { code: 'QUERY_BAD_LIMIT' },
    );
  }
  return limit;
}

/**
 * Run one named query and apply the output limit.
 *
 * Rows are ordered by the definition before the limit is applied; `total` is
 * counted on that full order, so `truncated` and the row count are stable for
 * fixed arguments (D5). Unknown names fail with the list of valid ones.
 */
export function runNamedQuery(
  ctx: QueryContext,
  name: string,
  args: Record<string, unknown> = {},
  opts: { limit?: number } = {},
): NamedQueryResult {
  const definition = lookupQuery(name);
  if (definition === undefined) throw unknownQueryError(name);

  const limit = resolveQueryLimit(opts.limit);
  const normalized = args ?? {};
  definition.parseArgs(normalized);
  const rows = definition.run(ctx, normalized);
  // A definition that caps its own fetch reports the exact count separately,
  // so `truncated` stays truthful even when `rows` cannot hold every match.
  const total =
    definition.count === undefined ? rows.length : definition.count(ctx, normalized);
  const truncated = total > limit;
  return {
    query: name,
    rows: truncated ? rows.slice(0, limit) : rows,
    total,
    truncated,
  };
}

/** Resolve one `Evidence.drillDown` handle into rows. */
export function runDrillDown(
  ctx: QueryContext,
  handle: DrillDownHandle,
  opts: { limit?: number } = {},
): NamedQueryResult {
  return runNamedQuery(ctx, handle.tool, handle.args, opts);
}
