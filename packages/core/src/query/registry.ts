import { computeBinderAnalysis } from '../analyze/binder';
import { computeThreadAnalysis } from '../analyze/threads-score';
import { analyzeThreadWakeup } from '../analyze/threads-wakeup';
import type { QueryHandle } from '../db/driver';
import type {
  CapabilityId, CapabilityMatrix, CapabilityState,
} from '../device/capability';
import { OhosPerfError } from '../errors';
import type { AppIdentity } from '../types';
import { CallstackQuery } from './callstack';
import { FrameQuery } from './frames';

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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badArgs(query, `missing number argument "${name}"`);
  }
  return value;
}

function stringArg(
  query: string,
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw badArgs(query, `missing string argument "${name}"`);
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
    name: 'threads.pattern',
    description:
      'Redundant-thread patterns matching a display name, a variant name, or a `name_*` label.',
    args: [
      { name: 'threadName', type: 'string', required: true, description: 'pattern display name' },
    ],
    returns: 'RedundantThreadPattern[]',
    parseArgs(args) {
      rejectUnknownArgs('threads.pattern', args, ['threadName']);
      stringArg('threads.pattern', args, 'threadName');
    },
    run(ctx, args) {
      const name = stringArg('threads.pattern', args, 'threadName');
      const results = analyzeThreadWakeup(ctx.db, { appPids: ctx.app.pids });
      const patterns = computeThreadAnalysis(results).redundantThreadsSummary.redundant_threads;
      return patterns.filter(
        (pattern) =>
          pattern.thread_name === name ||
          pattern.thread_name_variants.includes(name) ||
          `${pattern.thread_name}_*` === name,
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
  const total = rows.length;
  const truncated = total > limit;
  return {
    query: name,
    rows: truncated ? rows.slice(0, limit) : rows,
    total,
    truncated,
  };
}
