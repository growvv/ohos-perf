import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One row of `callstack` with camelCase field names.
 *
 * `ts` and `dur` are nanoseconds; `0`/`''` mean absent. The column is spelled
 * `argsetid` (no underscore), so its field keeps that spelling. `flag`,
 * `traceLevel`, `traceTag`, `customCategory` and `customArgs` are stored as
 * text even though some look numeric.
 */
export interface CallstackEvent {
  id: number;
  ts: number;
  dur: number;
  callid: number;
  cat: string;
  name: string;
  depth: number;
  cookie: number;
  parentId: number;
  argsetid: number;
  chainId: string;
  spanId: string;
  parentSpanId: string;
  flag: string;
  traceLevel: string;
  traceTag: string;
  customCategory: string;
  customArgs: string;
  childCallid: number;
}

/**
 * A callstack row plus its arguments, keyed by the `data_dict` text.
 *
 * Values are strings when `args.datatype = 1` and the value is present in
 * `data_dict`; otherwise they stay the raw numeric `args.value`. Arguments
 * whose key has no `data_dict` row are dropped (matching HapRay).
 */
export interface CallstackEventWithArgs extends CallstackEvent {
  args: Record<string, string | number>;
}

interface CallstackRow {
  id: number | null;
  ts: number | null;
  dur: number | null;
  callid: number | null;
  cat: string | null;
  name: string | null;
  depth: number | null;
  cookie: number | null;
  parent_id: number | null;
  argsetid: number | null;
  chainId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  flag: string | null;
  trace_level: string | null;
  trace_tag: string | null;
  custom_category: string | null;
  custom_args: string | null;
  child_callid: number | null;
}

interface CallstackArgRow extends CallstackRow {
  arg_key: number | null;
  arg_datatype: number | null;
  arg_value: number | null;
  arg_key_text: string | null;
  arg_value_text: string | null;
}

/** Default cap for `matching()`; callers can raise or lower it per query. */
const DEFAULT_MATCH_LIMIT = 1000;

const SELECT_CALLSTACK = `SELECT id, ts, dur, callid, cat, name, depth, cookie,
       parent_id, argsetid, chainId, spanId, parentSpanId, flag, trace_level,
       trace_tag, custom_category, custom_args, child_callid
FROM callstack`;

const SELECT_CALLSTACK_ARGS = `SELECT c.id AS id, c.ts AS ts, c.dur AS dur,
       c.callid AS callid, c.cat AS cat, c.name AS name, c.depth AS depth,
       c.cookie AS cookie, c.parent_id AS parent_id, c.argsetid AS argsetid,
       c.chainId AS chainId, c.spanId AS spanId, c.parentSpanId AS parentSpanId,
       c.flag AS flag, c.trace_level AS trace_level, c.trace_tag AS trace_tag,
       c.custom_category AS custom_category, c.custom_args AS custom_args,
       c.child_callid AS child_callid, a.key AS arg_key,
       a.datatype AS arg_datatype, a.value AS arg_value,
       kd.data AS arg_key_text, vd.data AS arg_value_text
FROM callstack c
LEFT JOIN args a ON c.argsetid = a.argset
LEFT JOIN data_dict kd ON a.key = kd.id
LEFT JOIN data_dict vd ON a.value = vd.id AND a.datatype = 1`;

function toCallstack(row: CallstackRow): CallstackEvent {
  const cookie = num(row['cookie']);
  return {
    id: num(row.id),
    ts: num(row.ts),
    dur: num(row.dur),
    callid: num(row.callid),
    cat: str(row.cat),
    name: str(row.name),
    depth: num(row.depth),
    cookie,
    parentId: num(row.parent_id),
    argsetid: num(row.argsetid),
    chainId: str(row.chainId),
    spanId: str(row.spanId),
    parentSpanId: str(row.parentSpanId),
    flag: str(row.flag),
    traceLevel: str(row.trace_level),
    traceTag: str(row.trace_tag),
    customCategory: str(row.custom_category),
    customArgs: str(row.custom_args),
    childCallid: num(row.child_callid),
  };
}

/**
 * Typed accessor over `callstack`.
 *
 * All list accessors share `ORDER BY ts, id` and inclusive `ts` ranges.
 * `callstack`, `args` and `data_dict` are core trace_streamer tables, so no
 * `hasTable()` guard is used.
 */
export class CallstackQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All callstack rows in `[startNs, endNs]` (or the whole trace). */
  all(range?: TimeRange): CallstackEvent[] {
    const sql = range
      ? `${SELECT_CALLSTACK} WHERE ts >= ? AND ts <= ? ORDER BY ts, id`
      : `${SELECT_CALLSTACK} ORDER BY ts, id`;
    const params = range ? [range.startNs, range.endNs] : [];
    return this.db.query<CallstackRow>(sql, params).map(toCallstack);
  }

  /**
   * Rows whose `name` matches `pattern` as a SQL `LIKE` operand.
   *
   * `pattern` is always bound, never interpolated, so a pattern containing
   * quotes or a `--` comment is matched as text. The result is capped by
   * `opts.limit` (default {@link DEFAULT_MATCH_LIMIT}), and `opts.range`
   * restricts `ts` inclusively.
   */
  matching(pattern: string, opts: { range?: TimeRange; limit?: number } = {}): CallstackEvent[] {
    const where = ['name LIKE ?'];
    const params: unknown[] = [pattern];
    if (opts.range) {
      where.push('ts >= ?', 'ts <= ?');
      params.push(opts.range.startNs, opts.range.endNs);
    }
    params.push(opts.limit ?? DEFAULT_MATCH_LIMIT);
    return this.db
      .query<CallstackRow>(
        `${SELECT_CALLSTACK} WHERE ${where.join(' AND ')} ORDER BY ts, id LIMIT ?`,
        params,
      )
      .map(toCallstack);
  }

  /**
   * Callstack rows with their arguments resolved through `args` + `data_dict`.
   *
   * A key is **always** looked up in `data_dict`; a value is looked up only
   * when `datatype = 1`. Unresolvable keys are skipped. Rows are grouped by
   * `callstack.id` and returned in `ts, id` order; when the same key appears
   * more than once for one row, the last `args.id` wins.
   */
  withArgs(range?: TimeRange): CallstackEventWithArgs[] {
    const where = range ? 'WHERE c.ts >= ? AND c.ts <= ?' : '';
    const params = range ? [range.startNs, range.endNs] : [];
    const rows = this.db.query<CallstackArgRow>(
      `${SELECT_CALLSTACK_ARGS}
${where}
ORDER BY c.ts, c.id, a.id`,
      params,
    );

    const events = new Map<number, CallstackEventWithArgs>();
    for (const row of rows) {
      let event = events.get(num(row.id));
      if (!event) {
        event = { ...toCallstack(row), args: {} };
        events.set(event.id, event);
      }
      if (row.arg_key == null || row.arg_key_text == null) continue;
      event.args[str(row.arg_key_text)] =
        row.arg_datatype === 1 && row.arg_value_text != null
          ? str(row.arg_value_text)
          : num(row.arg_value);
    }
    return [...events.values()];
  }
}
