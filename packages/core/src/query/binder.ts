import type { QueryHandle } from '../db/driver';
import { num, str } from './rows';

/**
 * One binder-related `callstack` row with its arguments resolved.
 *
 * `args` is keyed by the `data_dict` text for `args.key`. A value becomes a
 * string when `args.datatype = 1` and the value is present in `data_dict`;
 * otherwise it stays the numeric `args.value`. Keys missing from `data_dict`
 * are dropped, mirroring HapRay's loader.
 *
 * `code` is special-cased like HapRay: when its first whitespace-separated
 * token starts with `0x`, the token is parsed as hexadecimal and stored as a
 * number (for example `"0x10 Java Layer Dependent"` → `16`). A token that
 * fails to parse leaves the original value untouched.
 */
export interface BinderEvent {
  id: number;
  ts: number;
  dur: number;
  name: string;
  cat: string;
  callid: number;
  args: Record<string, string | number>;
}

interface BinderRow {
  id: number | null;
  ts: number | null;
  dur: number | null;
  name: string | null;
  cat: string | null;
  callid: number | null;
  arg_key: number | null;
  arg_datatype: number | null;
  arg_value: number | null;
  arg_key_text: string | null;
  arg_value_text: string | null;
}

const SELECT_BINDER_EVENTS = `SELECT c.id AS id, c.ts AS ts, c.dur AS dur,
       c.name AS name, c.cat AS cat, c.callid AS callid, a.key AS arg_key,
       a.datatype AS arg_datatype, a.value AS arg_value,
       kd.data AS arg_key_text, vd.data AS arg_value_text
FROM callstack c
LEFT JOIN args a ON c.argsetid = a.argset
LEFT JOIN data_dict kd ON a.key = kd.id
LEFT JOIN data_dict vd ON a.value = vd.id AND a.datatype = 1
WHERE c.name LIKE '%binder%'`;

function parseCode(value: string | number): string | number {
  const text = String(value).trim();
  const first = text.split(/\s+/)[0] ?? '';
  if (!first.startsWith('0x')) return value;
  const parsed = Number.parseInt(first, 16);
  return Number.isNaN(parsed) ? value : parsed;
}

/**
 * Typed accessor over binder events stored in `callstack`.
 *
 * Events are the `callstack` rows whose `name` contains `binder`, with their
 * `args` rows joined through `callstack.argsetid = args.argset`. Ordering is
 * `id`; `args` within one event follow `args.id`, so a repeated key resolves
 * to its last row deterministically. `callstack`, `args` and `data_dict` are
 * core trace_streamer tables, so no `hasTable()` guard is used.
 */
export class BinderQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All binder events, ordered by `callstack.id`. */
  events(): BinderEvent[] {
    const rows = this.db.query<BinderRow>(
      `${SELECT_BINDER_EVENTS}
ORDER BY c.id, a.id`,
    );

    const events = new Map<number, BinderEvent>();
    for (const row of rows) {
      const id = num(row.id);
      let event = events.get(id);
      if (!event) {
        event = {
          id,
          ts: num(row.ts),
          dur: num(row.dur),
          name: str(row.name),
          cat: str(row.cat),
          callid: num(row.callid),
          args: {},
        };
        events.set(id, event);
      }
      if (row.arg_key == null || row.arg_key_text == null) continue;
      const key = str(row.arg_key_text);
      const value: string | number =
        row.arg_datatype === 1 && row.arg_value_text != null
          ? str(row.arg_value_text)
          : num(row.arg_value);
      event.args[key] = key === 'code' ? parseCode(value) : value;
    }
    return [...events.values()];
  }
}
