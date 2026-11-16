import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc, HdcResult } from '../transport/hdc';
import type { Collector } from './types';

/** One refresh-rate bucket from `RefreshRateCounts`, cumulative since boot. */
export interface FpsBucket {
  readonly refreshRate: number;
  readonly count: number;
}

/** One window's cumulative hitch counters since the window was created. */
export interface WindowHitches {
  readonly windowId: string;
  readonly over16_67: number;
  readonly over33: number;
  readonly over66: number;
}

/** One point-in-time read of the RenderService counters. */
export interface HidumperSnapshot {
  /** Host `Date.now()` when the snapshot was taken. */
  readonly ts: number;
  readonly fpsCounts: FpsBucket[];
  readonly hitches: WindowHitches[];
}

/**
 * Two snapshots `intervalMs` apart.
 *
 * The counters are cumulative, so a single snapshot says nothing about the
 * capture window; only the delta between a pair does.
 */
export interface HidumperCapture {
  readonly version: 1;
  readonly intervalMs: number;
  readonly samples: [HidumperSnapshot, HidumperSnapshot];
}

/** Node's setTimeout clamps anything larger to 1 ms (32-bit signed limit). */
const MAX_TIMEOUT_MS = 2_147_483_647;

const MIN_INTERVAL_MS = 100;

/** The service name is interpolated into the command, so it must be a bare token. */
const SERVICE_PATTERN = /^[A-Za-z0-9_.]+$/;

const SERVICE = 'RenderService';

/**
 * Build one `hidumper` command. The service name is interpolated into a shell
 * command, so it is validated here rather than trusted; the argument is a
 * fixed literal from this module.
 */
function hidumperCommand(service: string, arg: string): string {
  if (!SERVICE_PATTERN.test(service)) {
    throw new OhosPerfError(
      `service name must match ${String(SERVICE_PATTERN)} (got ${JSON.stringify(service)})`,
      { code: 'HIDUMPER_BAD_SERVICE' },
    );
  }
  return `hidumper -s ${service} -a '${arg}'`;
}

/**
 * The two measured commands, verbatim. The single quotes around the argument
 * are part of the device command, not shell quoting on this side.
 */
export const FPS_COMMAND = hidumperCommand(SERVICE, 'fpsCount');
export const HITCH_COMMAND = hidumperCommand(SERVICE, 'hitchs');

/** The header that marks a real `RefreshRateCounts` block. */
const FPS_HEADER = '-- RefreshRateCounts:';
const FPS_LINE = /^Refresh Rate:(\d+), Count:(\d+);\s*$/gm;

/** One window record's header, e.g. `window [] Id[6343666696194]:`. */
const HITCH_WINDOW = /^\s*window \[\] Id\[(\d+)\]:\s*$/gm;
const HITCH_16_67 = /^\s*more than 16\.67 ms\s+(\d+)\s*$/m;
const HITCH_33 = /^\s*more than 33 ms\s+(\d+)\s*$/m;
const HITCH_66 = /^\s*more than 66 ms\s+(\d+)\s*$/m;

/**
 * Parse the `RefreshRateCounts` block.
 *
 * The block is located by its header so a lookalike line elsewhere in the
 * dump cannot be mistaken for it; the parse then runs to the end of the text
 * because the block has no terminator. `[]` means "no block", which the
 * collector treats as a parse failure rather than an empty histogram.
 */
export function parseFpsCounts(text: string): FpsBucket[] {
  const header = text.indexOf(FPS_HEADER);
  if (header < 0) return [];
  const block = text.slice(header + FPS_HEADER.length);
  return [...block.matchAll(FPS_LINE)].map((match) => ({
    refreshRate: Number(match[1]),
    count: Number(match[2]),
  }));
}

/**
 * Parse every `window [] Id[...]` hitch record.
 *
 * A record runs from its header to the next header (or the end of the text);
 * each of the three thresholds is looked up inside that slice. A missing
 * threshold line is an error, not a zero: `more than 33 ms` disappearing means
 * the dump format changed, and reporting 0 would be a fabricated measurement.
 */
export function parseHitches(text: string): WindowHitches[] {
  const headers = [...text.matchAll(HITCH_WINDOW)];
  return headers.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const next = headers[index + 1];
    const block = text.slice(start, next?.index ?? text.length);
    const count = (pattern: RegExp, label: string): number => {
      const found = block.match(pattern);
      if (found === null) {
        throw new OhosPerfError(
          `hitch record for window ${match[1]} has no "${label}" line`,
          { code: 'HIDUMPER_PARSE_FAILED' },
        );
      }
      return Number(found[1]);
    };
    return {
      windowId: match[1],
      over16_67: count(HITCH_16_67, 'more than 16.67 ms'),
      over33: count(HITCH_33, 'more than 33 ms'),
      over66: count(HITCH_66, 'more than 66 ms'),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFpsBucket(value: unknown): value is FpsBucket {
  return isRecord(value) && isNumber(value.refreshRate) && isNumber(value.count);
}

function isWindowHitches(value: unknown): value is WindowHitches {
  return (
    isRecord(value) &&
    typeof value.windowId === 'string' &&
    isNumber(value.over16_67) &&
    isNumber(value.over33) &&
    isNumber(value.over66)
  );
}

function isSnapshot(value: unknown): value is HidumperSnapshot {
  return (
    isRecord(value) &&
    isNumber(value.ts) &&
    Array.isArray(value.fpsCounts) &&
    value.fpsCounts.every(isFpsBucket) &&
    Array.isArray(value.hitches) &&
    value.hitches.every(isWindowHitches)
  );
}

function isCapture(value: unknown): value is HidumperCapture {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Number.isSafeInteger(value.intervalMs) &&
    (value.intervalMs as number) >= MIN_INTERVAL_MS &&
    Array.isArray(value.samples) &&
    value.samples.length === 2 &&
    value.samples.every(isSnapshot)
  );
}

/**
 * Read a `hidumper.json` capture.
 *
 * A missing file is not an error — the scene may simply not have a hidumper
 * capture. Anything malformed (invalid JSON, a different version, a sample
 * array that is not exactly two snapshots) yields `undefined` rather than a
 * half-trusted capture: a one-snapshot capture has no delta to measure.
 */
export function readHidumperCapture(path: string): HidumperCapture | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return isCapture(parsed) ? parsed : undefined;
}

/**
 * `durationMs` must be finite and in `(0, 2^31 - 1]`, mirroring the procfs
 * and hitrace gates: above the 32-bit setTimeout limit Node clamps the timer
 * to 1 ms, so the pair of snapshots would straddle no window at all.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HIDUMPER_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_TIMEOUT_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_TIMEOUT_MS} ms (the 32-bit setTimeout limit)` +
        ` (got ${String(durationMs)})`,
      { code: 'HIDUMPER_BAD_DURATION' },
    );
  }
}

function assertInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new OhosPerfError(
      `intervalMs must be an integer of at least ${MIN_INTERVAL_MS} ms` +
        ` (got ${String(intervalMs)})`,
      { code: 'HIDUMPER_BAD_INTERVAL' },
    );
  }
}

/** Device output excerpt for an error message; both streams are diagnostics. */
function detail(result: HdcResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, 5).join(' | ');
  return lines.length > 5 ? `${shown} | ... (${lines.length - 5} more lines)` : shown;
}

function isShellFailure(err: unknown): err is OhosPerfError {
  return err instanceof OhosPerfError && err.code === 'HDC_SHELL_FAILED';
}

function removeStaleCapture(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one device command, turning any device-level failure into a
 * `HIDUMPER_PARSE_FAILED` that quotes the command and its output.
 */
async function shell(hdc: Hdc, target: string, command: string): Promise<string> {
  let result: HdcResult;
  try {
    result = await hdc.shell(target, command);
  } catch (err) {
    if (!isShellFailure(err)) throw err;
    throw new OhosPerfError(`${command} failed: ${err.message}`, {
      code: 'HIDUMPER_PARSE_FAILED',
      cause: err,
    });
  }
  if (result.code !== 0) {
    throw new OhosPerfError(`${command} exited ${result.code} (${detail(result)})`, {
      code: 'HIDUMPER_PARSE_FAILED',
    });
  }
  return result.stdout;
}

/**
 * Sample the RenderService counters twice, `intervalMs` apart.
 *
 * Both commands run in each snapshot: the refresh-rate histogram is the only
 * source of live FPS on a device without frame timings, and the hitch
 * counters are the only source of over-budget frames. The pair is what makes
 * either number a measurement of the capture window rather than a lifetime
 * total.
 *
 * Every argument is validated before the first device call. A previous
 * capture is removed after validation and before the first snapshot, so a
 * failed capture leaves no artifact behind. Both snapshots must parse: a
 * missing `RefreshRateCounts` block is a format change, not an idle device
 * (an idle device still prints every bucket with an unchanged count), so it
 * fails with `HIDUMPER_PARSE_FAILED`.
 */
export class HidumperCollector implements Collector {
  readonly id = 'hidumper';
  readonly provides: CapabilityId[] = ['render.fps_live', 'render.hitch'];

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  private async snapshot(hdc: Hdc, target: string): Promise<HidumperSnapshot> {
    // The timestamp is taken before the commands so it brackets the start of
    // the read, matching the procfs collector's convention.
    const ts = this.now();
    const fpsText = await shell(hdc, target, FPS_COMMAND);
    const hitchText = await shell(hdc, target, HITCH_COMMAND);
    const fpsCounts = parseFpsCounts(fpsText);
    if (fpsCounts.length === 0) {
      throw new OhosPerfError(
        `${FPS_COMMAND} printed no "${FPS_HEADER}" block; the RenderService` +
          ' fpsCount format may have changed',
        { code: 'HIDUMPER_PARSE_FAILED' },
      );
    }
    return { ts, fpsCounts, hitches: parseHitches(hitchText) };
  }

  async collect(
    hdc: Hdc,
    target: string,
    opts: { durationMs: number; intervalMs?: number },
    layout: SceneLayout,
  ): Promise<HidumperCapture> {
    const intervalMs = opts.intervalMs ?? opts.durationMs;
    assertDuration(opts.durationMs);
    assertInterval(intervalMs);

    removeStaleCapture(layout.hidumperFile);

    const first = await this.snapshot(hdc, target);
    await this.sleep(intervalMs);
    const second = await this.snapshot(hdc, target);

    const capture: HidumperCapture = {
      version: 1,
      intervalMs,
      samples: [first, second],
    };
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.hidumperFile, `${JSON.stringify(capture, null, 2)}\n`);
    return capture;
  }
}
