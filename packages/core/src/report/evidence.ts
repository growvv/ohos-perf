import { createHash } from 'node:crypto';
import type { TimeRange } from '../types';

export type EvidenceKind =
  | 'no_data'
  | 'jank'
  | 'frame_load'
  | 'empty_frame'
  | 'vsync_anomaly'
  | 'fps_baseline'
  | 'degraded_capability'
  | 'fault_pattern'
  | 'binder_hotspot'
  | 'thread_redundancy'
  | 'memory_growth'
  | 'native_memory'
  | 'gc_pressure'
  | 'rs_skip'
  | 'startup';

/**
 * A follow-up query an agent can issue to drill into an evidence item.
 *
 * `estRows` lets the agent judge the cost of the call before making it.
 */
export interface DrillDownHandle {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** One-line description of the result shape. */
  returns: string;
  estRows?: number;
}

export interface Evidence {
  /** Stable, deterministic id derived from kind, subject, and window. */
  id: string;
  kind: EvidenceKind;
  severity: 'info' | 'warn' | 'critical';
  subject: { process: string; thread?: string; frameNo?: number; pid?: number };
  window: TimeRange;
  signals: Record<string, number | string>;
  explain: string;
  drillDown: DrillDownHandle[];
}

/**
 * Hashes the identity-bearing fields in a fixed order.
 *
 * The string is built explicitly rather than via `JSON.stringify` of an object
 * so the id does not depend on key construction order. Fields are joined with
 * `|`; `subject.process` is required and may not contain a `|`-ambiguous shape
 * that could collide with an optional field boundary only if the caller uses
 * `|` inside a name — accepted, since process/thread names in traces do not.
 *
 * `key` is an optional caller-supplied discriminator, appended only when
 * present. It exists for evidence items that share every identity-bearing
 * field but describe different causes — notably one `degraded_capability`
 * item per skipped analyzer in the same window. Omitting it keeps every
 * pre-existing id byte-identical.
 */
function evidenceId(input: Omit<Evidence, 'id'>, key?: string): string {
  const { kind, subject, window } = input;
  const material = [
    kind,
    subject.process,
    subject.thread ?? '',
    subject.frameNo ?? '',
    subject.pid ?? '',
    window.startNs,
    window.endNs,
  ].join('|');
  const hashMaterial = key === undefined ? material : `${material}|${key}`;
  return createHash('sha1').update(hashMaterial).digest('hex').slice(0, 12);
}

/**
 * Builds an {@link Evidence} item with a stable id.
 *
 * Nothing else is defaulted and nothing is sorted: the caller's `drillDown`
 * order is meaningful (it is the order to try the drill-downs in). Returns a
 * new object; the input is never mutated.
 *
 * An optional `key` participates in the id hash but is not copied to the
 * returned object, so it can separate otherwise identical evidence items
 * without changing the `Evidence` shape.
 */
export function evidence(input: Omit<Evidence, 'id'> & { key?: string }): Evidence {
  const { key, ...rest } = input;
  return { ...rest, id: evidenceId(rest, key) };
}
