import type { CapabilityId } from '../device/capability';
import type { ThermalCapture } from '../collectors/thermal';
import { maxOf } from '../extremes';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { round2HalfEven } from '../rounding';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * A sensor name made safe for a metric id.
 *
 * The device names sensors freely (`shell_back`, `GPU-0`, `GPU 0`), and metric
 * ids are dotted namespaces. Lowercasing and collapsing every run outside
 * `[a-z0-9]` into one `_` keeps ids readable and stable; the original name
 * stays in the evidence signals, so nothing is lost by the rename.
 */
export function thermalSensorSlug(sensor: string): string {
  const slug = sensor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? 'sensor' : slug;
}

/** The proxy + explanation a caller gets when nothing can be measured. */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  return {
    metrics: [
      metric({
        id: 'thermal.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no thermal measurement' },
        provenance: { collector: 'thermal', device: ctx.deviceId },
        window: ctx.window,
      }),
    ],
    evidence: [
      evidence({
        kind: 'no_data',
        severity: 'info',
        subject: { process: appProcessName(ctx) },
        window: ctx.window,
        signals: {},
        explain: reason,
        drillDown: [],
        key: 'thermal:no-data',
      }),
    ],
  };
}

/** One sensor's values, in the order the samples carried them. */
interface SensorValues {
  readonly sensor: string;
  readonly values: number[];
}

/** Standard median: middle value, or the mean of the middle two. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : round2HalfEven((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Per-sensor temperature statistics from a scene's thermal samples.
 *
 * The analyzer reads `thermal.jsonl` only — the caller parses it into
 * `ctx.thermal` — so a statistics change is a re-analysis, never a re-capture.
 * Sensors are whatever the device reported; none is hard-coded, because the
 * set differs between devices (the Mate 60 has no `modem`, another device
 * does). A sensor missing from a sample contributes nothing to its
 * statistics: neither a zero nor a carried-forward value, both of which would
 * fabricate a reading the device never printed.
 *
 * `requires` is empty on purpose: the scene itself is the evidence of whether
 * thermal was captured, so the analyzer degrades from the artifact (like `ui`
 * and `coverage`) instead of being skipped by the capability matrix. That is
 * also why a capture with zero samples — which the collector refuses to write
 * — is treated as an unusable artifact rather than an idle device.
 */
export class ThermalAnalyzer implements Analyzer {
  readonly id = 'thermal';
  readonly requires: CapabilityId[] = [];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const capture: ThermalCapture | undefined = ctx.thermal;
    if (capture === undefined) {
      return degradedResult(
        ctx,
        'the scene carries no thermal.jsonl; capture with `--thermal` to ' +
          'sample the device\'s thermal sensors',
      );
    }

    const { records } = capture;
    if (records.length === 0) {
      return degradedResult(
        ctx,
        'the scene\'s thermal.jsonl holds no samples' +
          (capture.invalidLines === 0
            ? ''
            : ` (${capture.invalidLines} invalid line${capture.invalidLines === 1 ? '' : 's'})`) +
          '; capture with `--thermal` to record the device\'s thermal sensors',
      );
    }

    // Values per sensor in sample order. A Map keeps first-seen insertion
    // order, but every output below is sorted explicitly, never on this.
    const byName = new Map<string, number[]>();
    for (const record of records) {
      for (const reading of record.readings) {
        const values = byName.get(reading.sensor);
        if (values === undefined) byName.set(reading.sensor, [reading.celsius]);
        else values.push(reading.celsius);
      }
    }
    const sensors: SensorValues[] = [...byName]
      .map(([sensor, values]) => ({ sensor, values }))
      .sort((a, b) => byString(a.sensor, b.sensor));

    // Slugs are assigned in sensor-name order so a collision always resolves
    // the same way; `_2`, `_3` append to the later names.
    const used = new Set<string>();
    const slugOf = new Map<string, string>();
    for (const { sensor } of sensors) {
      const base = thermalSensorSlug(sensor);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}_${n}`;
      used.add(slug);
      slugOf.set(sensor, slug);
    }

    const prov = {
      collector: 'thermal',
      table: 'thermal.jsonl',
      rows: records.length,
      device: ctx.deviceId,
    };
    const first = records[0]!;
    const last = records[records.length - 1]!;

    const metrics: Metric[] = [
      metric({
        id: 'thermal.samples.count',
        value: records.length,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'thermal.sensors.count',
        value: sensors.length,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'thermal.duration.ms',
        value: last.elapsedMs - first.elapsedMs,
        unit: 'ms',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'thermal.records.invalid',
        value: capture.invalidLines,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
    ];
    if (records.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < records.length; i++) {
        deltas.push(records[i]!.elapsedMs - records[i - 1]!.elapsedMs);
      }
      metrics.push(metric({
        id: 'thermal.interval.median.ms',
        value: median(deltas),
        unit: 'ms',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }));
    }

    const process = appProcessName(ctx);
    const items: Evidence[] = sensors.map(({ sensor, values }) => {
      const start = values[0]!;
      const end = values[values.length - 1]!;
      // A reduce, not `Math.max(...values)`: a long thermal capture has one
      // sample per interval, and the spread form overflows V8's argument
      // limit well before a multi-hour soak finishes.
      const peak = maxOf(values);
      const mean = round2HalfEven(values.reduce((sum, value) => sum + value, 0) / values.length);
      const rise = round2HalfEven(end - start);
      const slug = slugOf.get(sensor)!;
      metrics.push(
        metric({
          id: `thermal.${slug}.start.celsius`,
          value: start,
          unit: 'celsius',
          fidelity: 'exact',
          provenance: prov,
          window: ctx.window,
        }),
        metric({
          id: `thermal.${slug}.end.celsius`,
          value: end,
          unit: 'celsius',
          fidelity: 'exact',
          provenance: prov,
          window: ctx.window,
        }),
        metric({
          id: `thermal.${slug}.peak.celsius`,
          value: peak,
          unit: 'celsius',
          fidelity: 'exact',
          provenance: prov,
          window: ctx.window,
        }),
        metric({
          id: `thermal.${slug}.mean.celsius`,
          value: mean,
          unit: 'celsius',
          fidelity: 'exact',
          provenance: prov,
          window: ctx.window,
        }),
        metric({
          id: `thermal.${slug}.rise.celsius`,
          value: rise,
          unit: 'celsius',
          fidelity: 'exact',
          provenance: prov,
          window: ctx.window,
        }),
      );
      return evidence({
        kind: 'thermal',
        // A warming sensor is a fact, not a fault: whether a rise matters
        // depends on the device, the app and the workload, so the analyzer
        // reports the measurement and leaves the judgment to the reader.
        severity: 'info',
        subject: { process },
        window: ctx.window,
        key: `thermal:${sensor}`,
        signals: {
          sensor,
          samples: values.length,
          startCelsius: start,
          endCelsius: end,
          peakCelsius: peak,
          meanCelsius: mean,
          riseCelsius: rise,
        },
        explain:
          `${sensor} rose ${rise} °C over ${values.length} ` +
          `sample${values.length === 1 ? '' : 's'} ` +
          `(${start} → ${end}, peak ${peak})`,
        drillDown: [],
      });
    });

    metrics.sort((a, b) => byString(a.id, b.id));
    items.sort(byEvidenceOrder);
    return { metrics, evidence: items };
  }
}

/** Sort order shared with the engine: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
