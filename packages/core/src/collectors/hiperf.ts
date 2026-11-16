/**
 * hiperf collection driver.
 *
 * `hiperf record` is the on-device sampling profiler DevEco Studio and HapRay
 * drive. Measured on the Mate 60 (HarmonyOS 7.0.0.111):
 *
 * - `--app <pkg>` works only for a **debuggable** app; a release app answers
 *   `--app option only support debug application` and exits nonzero.
 * - `-a` (system-wide) needs root, which the shipping devices do not grant.
 * - An app that is not burning CPU yields **zero samples** and still exits 0.
 *   That is a valid capture of an idle app, never a failure — and never a
 *   silent zero: {@link HiperfCapture.samples} carries the count so the caller
 *   can report it.
 * - `-s fp` records frame-pointer call stacks; without it the saved file still
 *   converts, but every callchain is empty.
 *
 * The output is a `perf.data` that `trace_streamer` converts into the same
 * schema family as a trace capture (`perf_sample`, `perf_callchain`,
 * `perf_thread`, `perf_files`), which is why this collector writes
 * `layout.perfFile` and the scene layer converts it.
 */

import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc } from '../transport/hdc';
import type { Collector } from './types';
import { parseSize } from './hitrace';

/** Fixed device-side path; removed before and after every recording. */
export const DEVICE_PERF_PATH = '/data/local/tmp/ohosperf_perf.data';

/** Node's setTimeout 32-bit limit; hiperf accepts up to 10000 s anyway. */
const MAX_DURATION_MS = 2_147_483_647;

const DEFAULT_FREQUENCY = 1000;
const MAX_FREQUENCY = 100_000;

/** The app name is interpolated into the record command, so it must be bare. */
const APP_PATTERN = /^[A-Za-z0-9_.]+$/;
/** Event names are interpolated into `-e`, so they must be bare too. */
const EVENT_PATTERN = /^[a-z0-9-]+$/;

export interface HiperfCollectOptions {
  readonly durationMs: number;
  /** Debuggable app whose processes are sampled (`hiperf record --app`). */
  readonly app: string;
  /** Sampling frequency in Hz; default 1000, range [1, 100000]. */
  readonly frequency?: number;
  /** Events to sample; default `['hw-cpu-cycles']`. Bare names only. */
  readonly events?: readonly string[];
  /** Record frame-pointer call stacks (`-s fp`); default true. */
  readonly callStacks?: boolean;
}

/** What the device reported for one recording. */
export interface HiperfCapture {
  /** `Sample records`. 0 is a valid capture of an idle app, not a failure. */
  readonly samples: number;
  readonly nonSamples: number;
  readonly lost: number;
  /** Size of the transferred `perf.data` in bytes. */
  readonly bytes: number;
}

const SAMPLES_MARKER = /\[ Sample records: (\d+), Non sample records: (\d+) \]/;
const LOST_MARKER = /\[ Sample lost: (\d+), Non sample lost: (\d+) \]/;
const NOT_DEBUGGABLE = 'only support debug application';

/**
 * Parse hiperf's summary lines.
 *
 * Returns `undefined` unless the sample marker is present: an absent marker
 * means the recording never started, and reporting it as a zero-sample capture
 * would turn a failure into "the app was idle".
 */
export function parseHiperfSummary(
  text: string,
): Omit<HiperfCapture, 'bytes'> | undefined {
  const samples = SAMPLES_MARKER.exec(text);
  if (samples === null) return undefined;
  const lost = LOST_MARKER.exec(text);
  return {
    samples: Number(samples[1]),
    nonSamples: Number(samples[2]),
    lost: lost === null ? 0 : Number(lost[1]),
  };
}

function secondsFor(durationMs: number): string {
  // hiperf accepts a float (`-d 1.5`); String() keeps `3000` as `3`, not `3.0`.
  return String(durationMs / 1000);
}

/**
 * The record command. `-f` is always emitted so the effective frequency is
 * visible in the device command line recorded in `scene.json`.
 */
export function hiperfRecordCommand(
  opts: HiperfCollectOptions,
  devicePath: string,
): string {
  const parts = [
    'hiperf record',
    `--app ${opts.app}`,
    `-d ${secondsFor(opts.durationMs)}`,
    `-o ${devicePath}`,
    `-f ${String(opts.frequency ?? DEFAULT_FREQUENCY)}`,
  ];
  if (opts.events !== undefined) parts.push(`-e ${opts.events.join(',')}`);
  if (opts.callStacks !== false) parts.push('-s fp');
  return parts.join(' ');
}

function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HIPERF_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_DURATION_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_DURATION_MS} ms (got ${String(durationMs)})`,
      { code: 'HIPERF_BAD_DURATION' },
    );
  }
}

function assertApp(app: string): void {
  if (!APP_PATTERN.test(app)) {
    throw new OhosPerfError(
      `app must be a bare application name matching ${String(APP_PATTERN)}` +
        ` (got ${JSON.stringify(app)})`,
      { code: 'HIPERF_BAD_APP' },
    );
  }
}

function assertFrequency(frequency: number): void {
  if (!Number.isSafeInteger(frequency) || frequency < 1 || frequency > MAX_FREQUENCY) {
    throw new OhosPerfError(
      `frequency must be an integer in [1, ${MAX_FREQUENCY}] (got ${String(frequency)})`,
      { code: 'HIPERF_BAD_FREQUENCY' },
    );
  }
}

function assertEvents(events: readonly string[]): void {
  if (events.length === 0) {
    throw new OhosPerfError(
      'events must contain at least one event name',
      { code: 'HIPERF_BAD_EVENT' },
    );
  }
  const bad = events.find((event) => !EVENT_PATTERN.test(event));
  if (bad !== undefined) {
    throw new OhosPerfError(
      `event ${JSON.stringify(bad)} is not a bare event name;` +
        ` allowed pattern: ${String(EVENT_PATTERN)}`,
      { code: 'HIPERF_BAD_EVENT' },
    );
  }
}

/** How many device-output lines an error message may quote. */
const DETAIL_MAX_LINES = 5;

function combined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function detail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, DETAIL_MAX_LINES).join(' | ');
  return lines.length > DETAIL_MAX_LINES
    ? `${shown} | ... (${lines.length - DETAIL_MAX_LINES} more lines)`
    : shown;
}

/**
 * Record `perf.data` for a debuggable app into `layout.perfFile`.
 *
 * Every input is validated before the first device call, so a bad duration,
 * app, frequency or event list never costs a recording. The step order mirrors
 * {@link HitraceCollector}: remove the fixed device path, record, require the
 * summary marker, require a non-empty file, then `recv`. Nothing is
 * transferred unless every check passes, so a failed recording can never
 * overwrite a previous scene's `perf.data` with stale bytes.
 *
 * A release app is detected by its own message and reported as
 * `HIPERF_NOT_DEBUGGABLE` rather than as a generic marker failure, because the
 * caller's fix (build a debuggable app) is different from a transport problem.
 */
export class HiperfCollector implements Collector {
  readonly id = 'hiperf';
  readonly provides: CapabilityId[] = ['perf.samples', 'perf.pmu'];

  async collect(
    hdc: Hdc,
    target: string,
    opts: HiperfCollectOptions,
    layout: SceneLayout,
  ): Promise<HiperfCapture> {
    assertDuration(opts.durationMs);
    assertApp(opts.app);
    if (opts.frequency !== undefined) assertFrequency(opts.frequency);
    if (opts.events !== undefined) assertEvents(opts.events);

    const devicePath = DEVICE_PERF_PATH;
    await hdc.shell(target, `rm -f ${devicePath}`);

    const record = await hdc.shell(target, hiperfRecordCommand(opts, devicePath));
    const output = combined(record);
    if (output.includes(NOT_DEBUGGABLE)) {
      throw new OhosPerfError(
        `hiperf cannot profile ${opts.app}: the app is not debuggable` +
          ` (device said: ${detail(output)}); install a debug build to sample it`,
        { code: 'HIPERF_NOT_DEBUGGABLE' },
      );
    }
    const summary = parseHiperfSummary(output);
    if (summary === undefined) {
      throw new OhosPerfError(
        `hiperf record failed: no sample summary in the device output: ${detail(output)}`,
        { code: 'HIPERF_RECORD_FAILED' },
      );
    }

    const listing = await hdc.shell(target, `ls -l ${devicePath}`);
    const size = parseSize(listing.stdout, devicePath);
    if (size === undefined || size <= 0) {
      throw new OhosPerfError(
        `hiperf produced no output at ${devicePath}` +
          ` (${size === undefined ? 'file not found' : 'file is empty'});` +
          ` ls -l output: ${detail(combined(listing))}`,
        { code: 'HIPERF_NO_OUTPUT' },
      );
    }

    await hdc.recv(target, devicePath, layout.perfFile!);
    return { ...summary, bytes: size };
  }
}
