// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { metric, type Metric } from '../report/metric';
import { resolveAppIpids } from './context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * ArkUI component reuse from `H:CustomNode:Build*` callstack events.
 *
 * Ported from `hapray/analyze/component_reusable_analyzer.py`. Every
 * `H:CustomNode:BuildItem [Name]...` row is one component build; every
 * `H:CustomNode:BuildRecycle Name` row is one build served from the recycle
 * pool. The analyzer reports the busiest component's numbers.
 *
 * ## Two HapRay quirks preserved on purpose
 *
 * 1. **`total_builds` is the busiest component's build count, not the sum
 *    across components** — 4, not 7, on the seven-row fixture. Renaming it to
 *    something clearer would break parity; the doc comment and the metric ids
 *    (`components.builds.count` beside `components.top.name`) carry the
 *    meaning instead.
 * 2. **The ratio is rounded with Python's `round(x, 2)`**, which is half-even
 *    on the exact binary value, not `Math.round(x * 100) / 100`. The two differ
 *    at real values (`0.125` → `0.12`, not `0.13`), so `round2HalfEven` below
 *    reproduces Python rather than approximating it.
 *
 * ## Scoping, and where it diverges from HapRay
 *
 * HapRay queries `callstack` with no process filter, so its payload is
 * device-wide. This port scopes to the app's ipids **when the trace identifies
 * them**, because attributing another process's builds to the app is the same
 * mistake `MemoryMeasureAnalyzer` guards against. The parity fixture has no
 * `process`/`thread` tables, so `resolveAppIpids` yields `[]` and the
 * computation is unscoped — which is why parity holds there. The scoped
 * behaviour has its own test and no parity claim.
 *
 * A recycle row with no name token becomes `Unknown`; HapRay raises
 * `IndexError` there (its handler catches only `sqlite3.Error`, so the whole
 * analysis would fail). Reporting `Unknown` is a deliberate divergence.
 */

/** HapRay's build-item pattern; group 1 is the component name. */
const BUILD_ITEM_PATTERN = /^H:CustomNode:BuildItem\s*\[([^\]]*)\]/;
/** The recycle prefix, matched before the space-separated fallback. */
const RECYCLE_PREFIX = 'H:CustomNode:BuildRecycle';
/** HapRay's query predicate: both build kinds start with this. */
const BUILD_LIKE = '%H:CustomNode:Build%';

/** HapRay's payload shape: the busiest component plus per-component counts. */
export interface ComponentReuse {
  max_component: string;
  /** The max component's build count, not the total across components. */
  total_builds: number;
  /** The max component's recycled builds. */
  recycled_builds: number;
  /** `round2HalfEven(recycled_builds / total_builds)`, or 0 when nothing built. */
  reusability_ratio: number;
  /** `[builds, recycled]` per component, in first-seen order. */
  details: Record<string, [number, number]>;
}

interface BuildRow {
  name: string | null;
}

/**
 * Python's `round(value, 2)` for a non-negative double.
 *
 * Python rounds the **exact decimal value of the double** to two places,
 * breaking exact ties toward the even digit. `Math.round(value * 100) / 100`
 * is half-up and also rounds the already-rounded product, so it disagrees at
 * `0.125` (→ `0.13`) and agrees only by luck elsewhere.
 *
 * The decomposition below is exact: a finite double is `mantissa × 2^exponent`
 * with an integer mantissa, so the scaled value is a rational whose rounding
 * can be decided with integers alone.
 */
export function round2HalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0;
  const { mantissa, exponent } = decompose(Math.abs(value));

  const scaled = mantissa * 100n;
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = scaled << BigInt(exponent);
  } else {
    const denominator = 1n << BigInt(-exponent);
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const doubled = remainder * 2n;
    if (doubled > denominator) rounded = quotient + 1n;
    else if (doubled < denominator) rounded = quotient;
    // Exact tie: pick the even neighbour, as Python does.
    else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  }

  const result = Number(rounded) / 100;
  return negative ? -result : result;
}

/** `|value|` as `mantissa × 2^exponent`, exactly, for a finite non-zero double. */
function decompose(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const exponentBits = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (exponentBits === 0) return { mantissa, exponent: -1074 };
  mantissa |= 1n << 52n;
  return { mantissa, exponent: exponentBits - 1075 };
}

/** HapRay's `_extract_component_name`, with its crash turned into `Unknown`. */
function componentName(name: string): string {
  const match = BUILD_ITEM_PATTERN.exec(name);
  if (match) return match[1];
  if (name.startsWith(RECYCLE_PREFIX)) {
    const token = name.split(' ')[1];
    return token === undefined ? 'Unknown' : token;
  }
  return 'Unknown';
}

/**
 * Counts builds and recycles per component and picks the busiest one.
 *
 * `ipids` must already be resolved. An empty list means "no app to scope to"
 * and matches every process, which is what makes the parity fixture
 * reproducible; a non-empty list restricts to `callstack` rows whose
 * `thread.id` belongs to one of those ipids. **The analyzer never passes an
 * empty list** — it degrades first, because a device-wide answer labelled as
 * the app's is worse than no answer. This function keeps the unscoped mode
 * because the parity golden needs it. Ties for the busiest component
 * resolve to the first one seen (rows are read `ORDER BY ts, id`), matching
 * HapRay's strict `>`.
 */
export function computeComponentReuse(
  db: QueryHandle,
  opts: { ipids: readonly number[] },
): ComponentReuse {
  const scope = opts.ipids.length === 0
    ? ''
    : ` AND callid IN (SELECT id FROM thread WHERE ipid IN (${opts.ipids.map(() => '?').join(', ')}))`;
  const rows = db.query<BuildRow>(
    `SELECT name FROM callstack WHERE name LIKE ?${scope} ORDER BY ts, id`,
    [BUILD_LIKE, ...opts.ipids],
  );

  // A `Map` keeps insertion order, which is what HapRay's dict does, so the
  // first strict maximum wins and `details` serialises in first-seen order.
  const counts = new Map<string, [number, number]>();
  for (const row of rows) {
    const name = row.name ?? '';
    const component = componentName(name);
    const entry = counts.get(component);
    if (entry === undefined) counts.set(component, [1, name.startsWith(RECYCLE_PREFIX) ? 1 : 0]);
    else {
      entry[0] += 1;
      if (name.startsWith(RECYCLE_PREFIX)) entry[1] += 1;
    }
  }

  let maxComponent = '';
  let totalBuilds = 0;
  let recycledBuilds = 0;
  for (const [component, [builds, recycled]] of counts) {
    if (builds > totalBuilds) {
      maxComponent = component;
      totalBuilds = builds;
      recycledBuilds = recycled;
    }
  }

  return {
    max_component: maxComponent,
    total_builds: totalBuilds,
    recycled_builds: recycledBuilds,
    reusability_ratio: totalBuilds > 0 ? round2HalfEven(recycledBuilds / totalBuilds) : 0,
    details: Object.fromEntries(counts),
  };
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Emits the four `components.*` metrics and no evidence.
 *
 * There is no evidence kind for component reuse: a busy component is not a
 * fault, and HapRay reports it as a table rather than an issue. The reuse rate
 * and the top name are omitted when nothing was built, so a consumer never
 * reads a fabricated 0% as "the app reused nothing".
 */
export class ComponentReuseAnalyzer implements Analyzer {
  readonly id = 'components';
  readonly requires: CapabilityId[] = ['trace.ark'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return {
        metrics: [
          metric({
            id: 'components.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: {
              reason: 'the trace database handle is not available',
              fallback: 'no component measurement',
            },
            provenance: { collector: 'hitrace', device: ctx.deviceId },
          }),
        ],
        evidence: [],
      };
    }

    const ipids = resolveAppIpids(ctx.processes, ctx.app.pids);
    // `computeComponentReuse` reads `[]` as "match every process", which is
    // what keeps the parity fixture reproducible. The analyzer must not pass
    // that through: an unnamed or absent app would report another process's
    // builds as this app's, labelled `exact`.
    if (ipids.length === 0) {
      return {
        metrics: [
          metric({
            id: 'components.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: {
              reason:
                'no app process was identified in this trace, so component builds ' +
                'cannot be attributed',
              fallback: 'no component measurement',
            },
            provenance: { collector: 'hitrace', device: ctx.deviceId },
          }),
        ],
        evidence: [],
      };
    }
    const result = computeComponentReuse(ctx.db, { ipids });
    const prov = {
      collector: 'hitrace',
      table: 'callstack',
      rows: result.total_builds,
      device: ctx.deviceId,
    };

    const metrics: Metric[] = [
      metric({
        id: 'components.builds.count',
        value: result.total_builds,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'components.recycled.count',
        value: result.recycled_builds,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];
    if (result.total_builds > 0) {
      metrics.push(
        metric({
          id: 'components.reuse.rate',
          value: round2HalfEven(result.reusability_ratio * 100),
          unit: '%',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
        metric({
          id: 'components.top.name',
          value: result.max_component,
          unit: 'none',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
      );
    }

    metrics.sort(byMetricId);
    return { metrics, evidence: [] };
  }
}
