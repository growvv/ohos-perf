import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import { parseThermalOutput, type ThermalReading, type ThermalUnit } from '../thermal/parse';
import type { Hdc } from '../transport/hdc';

/**
 * The device command, verbatim. The single quotes around `-t` are part of the
 * device command, not shell quoting on this side — the same convention as
 * `FPS_COMMAND`/`HITCH_COMMAND`.
 */
export const THERMAL_COMMAND = "hidumper -s ThermalService -a '-t'";

/** HapRay's default sampling interval (`thermal.interval_seconds: 5`). */
export const DEFAULT_THERMAL_INTERVAL_MS = 5_000;

/** The shortest interval this collector accepts; below it, dumps overlap. */
export const MIN_THERMAL_INTERVAL_MS = 100;

/** Node's setTimeout clamps anything larger to 1 ms (32-bit signed limit). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The smallest timeout a dump is given. HapRay's sampler lets a dump use the
 * rest of the capture window; at the window's endpoint that is zero, and a
 * budget of a few milliseconds kills the dump mid-print. The dump exits on
 * its own after a few tens of milliseconds, so this is a ceiling, not a wait.
 */
const MIN_DUMP_TIMEOUT_MS = 1_000;

/** One sample: the sensor readings and the host-measured elapsed time. */
export interface ThermalRecord {
  readonly elapsedMs: number;
  readonly readings: readonly ThermalReading[];
}

/**
 * A scene's thermal artifact, read back.
 *
 * `invalidLines` is carried rather than swallowed: a truncated or hand-edited
 * file is a fact about the capture, and the analyzer reports it instead of
 * silently analyzing the subset that parsed.
 */
export interface ThermalCapture {
  readonly records: readonly ThermalRecord[];
  readonly invalidLines: number;
}

/** How the sampler reads the clock and waits; injected so tests do not sleep. */
export interface ThermalCollectorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function assertDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a positive integer (got ${String(durationMs)})`,
      { code: 'THERMAL_BAD_DURATION' },
    );
  }
}

function assertInterval(intervalMs: number): void {
  if (
    !Number.isFinite(intervalMs) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_THERMAL_INTERVAL_MS
  ) {
    throw new OhosPerfError(
      `thermal intervalMs must be an integer of at least ${MIN_THERMAL_INTERVAL_MS} ms` +
        ` (got ${String(intervalMs)})`,
      { code: 'THERMAL_BAD_INTERVAL' },
    );
  }
}

/**
 * Sample the device's thermal service into `thermal.jsonl`.
 *
 * The first sample is taken immediately, then one per interval while the
 * capture has at least one full interval left. A capture shorter than the
 * interval therefore gets exactly one sample rather than waiting past its own
 * window for a partial one. Deadlines are absolute (`start + k * interval`)
 * so the time a dump takes does not push later samples off the schedule.
 *
 * A dump must exit 0 to be recorded: `shellFor` resolves a killed process
 * with `code: null` and whatever stdout arrived, and a truncated `310` is not
 * a temperature. Any failed dump fails the capture and writes no artifact. An
 * empty `thermal.jsonl` would make "the service was not there" indistinguishable
 * from "the device was cool", which is the class of ambiguity this package
 * exists to remove.
 */
export class ThermalCollector {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ThermalCollectorDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async collect(
    hdc: Hdc,
    target: string,
    opts: { durationMs: number; intervalMs?: number },
    layout: SceneLayout,
  ): Promise<{ samples: number }> {
    assertDuration(opts.durationMs);
    const intervalMs = opts.intervalMs ?? DEFAULT_THERMAL_INTERVAL_MS;
    assertInterval(intervalMs);

    if (existsSync(layout.thermalFile)) unlinkSync(layout.thermalFile);

    const start = this.now();
    const records: ThermalRecord[] = [];

    // Sample at 0, interval, 2*interval while the deadline is inside the
    // capture window. Sleeping to the deadline rather than for a whole
    // interval after each dump keeps the schedule independent of dump latency.
    for (let offsetMs = 0; offsetMs <= opts.durationMs; offsetMs += intervalMs) {
      const wait = start + offsetMs - this.now();
      if (wait > 0) await this.sleep(wait);
      const elapsedMs = Math.max(0, Math.round(this.now() - start));
      const budget = Math.max(MIN_DUMP_TIMEOUT_MS, opts.durationMs - offsetMs);
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, budget);
      const result = await hdc.shellFor(target, THERMAL_COMMAND, timeoutMs);
      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        throw new OhosPerfError(
          `${THERMAL_COMMAND} failed at ${elapsedMs} ms (exit ${String(result.code)})` +
            (stderr === '' ? '' : `; device stderr: ${stderr.slice(0, 200)}`),
          { code: 'THERMAL_DUMP_FAILED' },
        );
      }
      const readings = parseThermalOutput(result.stdout);
      if (readings.length === 0) {
        const stderr = result.stderr.trim();
        throw new OhosPerfError(
          `${THERMAL_COMMAND} reported no sensor readings at ${elapsedMs} ms` +
            (stderr === '' ? '' : `; device stderr: ${stderr.slice(0, 200)}`),
          { code: 'THERMAL_NO_OUTPUT' },
        );
      }
      records.push({ elapsedMs, readings });
    }

    mkdirSync(layout.root, { recursive: true });
    writeFileSync(
      layout.thermalFile,
      records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
    return { samples: records.length };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const UNITS: ReadonlySet<ThermalUnit> = new Set(['celsius', 'millidegree_celsius']);

function isReading(value: unknown): value is ThermalReading {
  return (
    isRecord(value) &&
    typeof value.sensor === 'string' &&
    value.sensor !== '' &&
    isFiniteNumber(value.raw) &&
    typeof value.unit === 'string' &&
    UNITS.has(value.unit as ThermalUnit) &&
    isFiniteNumber(value.celsius)
  );
}

function isThermalRecord(value: unknown): value is ThermalRecord {
  return (
    isRecord(value) &&
    isFiniteNumber(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    Array.isArray(value.readings) &&
    value.readings.length > 0 &&
    value.readings.every(isReading)
  );
}

/**
 * Read a scene's `thermal.jsonl`.
 *
 * Returns `undefined` when the scene never captured thermal data, so the
 * analyzer can name the absence rather than report a zero. Lines that are not
 * valid records are counted, not thrown: a partially written artifact should
 * still yield the samples that survived, with the damage visible.
 */
export function readThermalRecords(layout: SceneLayout): ThermalCapture | undefined {
  if (!existsSync(layout.thermalFile)) return undefined;

  const records: ThermalRecord[] = [];
  let invalidLines = 0;
  for (const rawLine of readFileSync(layout.thermalFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!isThermalRecord(parsed)) {
      invalidLines += 1;
      continue;
    }
    records.push({
      elapsedMs: parsed.elapsedMs,
      readings: parsed.readings.map((reading) => ({ ...reading })),
    });
  }
  return { records, invalidLines };
}
