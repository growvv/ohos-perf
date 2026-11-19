import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc } from '../transport/hdc';
import type { Collector, TraceCollectOptions } from './types';

/**
 * Default trace categories, matching HapRay `command_templates.py:36-60`.
 * All 25 were confirmed present on the emulator with `hitrace -l`.
 *
 * Frozen because this is published API (Task 14 re-exports it) and
 * `beginCommand` reads it by reference: a caller's `push()` would otherwise
 * change every later capture in the process.
 */
export const HITRACE_DEFAULT_CATEGORIES: readonly string[] = Object.freeze([
  'ability', 'ace', 'app', 'ark', 'binder', 'disk', 'freq', 'graphic', 'idle',
  'irq', 'memreclaim', 'mmc', 'multimodalinput', 'notification', 'ohos',
  'pagecache', 'rpc', 'sched', 'sync', 'window', 'workq', 'zaudio', 'zcamera',
  'zimage', 'zmedia',
]);

/** HapRay's `buffer_size_kb`. */
const DEFAULT_BUFFER_KB = 204800;

/**
 * Fixed device-side path. The directory accumulates files across sessions, so
 * collect() removes this path before recording and re-checks it afterwards.
 */
const DEVICE_TRACE_PATH = '/data/local/tmp/ohosperf_trace.htrace';

/**
 * hitrace's own success markers. hdc exits 0 even when hitrace fails, so these
 * strings — not the exit code — are the success signal.
 */
const BEGIN_MARKER = 'OpenRecording done';
const FINISH_MARKER = 'trace read done';

/**
 * What hitrace says when a recording is already running. Measured on the
 * emulator: a `--trace_begin` left running by an aborted run answers this to
 * every later begin, and only `--trace_finish_nodump` clears it.
 */
const STALE_SESSION_MARKER = 'errorCode(1103)';

/** Node's setTimeout clamps anything larger to 1 ms (32-bit signed limit). */
const MAX_TIMEOUT_MS = 2_147_483_647;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `durationMs` must be a finite number in `(0, 2^31 - 1]`.
 *
 * Silently clamping 0, NaN or a negative value to zero would produce a
 * zero-length capture that later reads as "the UI was static". Above the 32-bit
 * setTimeout limit Node does not wait at all — it clamps the timer to 1 ms and
 * emits `TimeoutOverflowWarning`, so a 30-day capture silently becomes
 * milliseconds and still passes the size check. Rejecting is the only outcome
 * the caller can act on.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HITRACE_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_TIMEOUT_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_TIMEOUT_MS} ms (the 32-bit setTimeout limit);` +
        ` larger values are silently clamped to 1 ms (got ${String(durationMs)})`,
      { code: 'HITRACE_BAD_DURATION' },
    );
  }
}

const CATEGORY_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * An empty or blank category list is not a capture. Measured on device:
 * `hitrace --trace_begin -b N` with no categories prints
 * `error: tag is empty, please add.` **and** `OpenRecording done.`, so every
 * marker check would pass and the result would be an eventless trace.
 *
 * Every name is also interpolated into a device shell command, and the device
 * shell interprets metacharacters (measured: `echo AAA; echo BBB` prints two
 * lines), so names must be bare trace tags.
 */
function assertCategories(categories: readonly string[]): void {
  if (categories.length === 0 || categories.some((c) => c.trim().length === 0)) {
    throw new OhosPerfError(
      'categories must contain at least one non-empty category name' +
        ` (got ${JSON.stringify(categories)})`,
      { code: 'HITRACE_BAD_CATEGORIES' },
    );
  }
  const bad = categories.find((c) => !CATEGORY_PATTERN.test(c));
  if (bad !== undefined) {
    throw new OhosPerfError(
      `category ${JSON.stringify(bad)} is not a bare trace category name; ` +
        `allowed pattern: ${String(CATEGORY_PATTERN)}`,
      { code: 'HITRACE_BAD_CATEGORIES' },
    );
  }
}

/**
 * `bufferKb` is interpolated into the same device shell command, so it must be
 * a positive safe integer. Rejecting before the first hdc call keeps a bad
 * value from becoming an extra shell word (or a silently truncated one).
 */
function assertBufferKb(bufferKb: number): void {
  if (!Number.isSafeInteger(bufferKb) || bufferKb <= 0) {
    throw new OhosPerfError(
      `bufferKb must be a positive safe integer (got ${String(bufferKb)})`,
      { code: 'HITRACE_BAD_BUFFER' },
    );
  }
}

/** stdout and stderr together; hitrace's diagnostics may land on either. */
function combined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** How many device-output lines an error message may quote. */
const DETAIL_MAX_LINES = 5;

/**
 * Device output excerpt for an error message.
 *
 * The interesting line is rarely the first: hitrace's failures look like
 * `hitrace enter, running_state is ...`, an `args:` line, then
 * `error: OpenRecording failed, errorCode(1103)`. Quoting only the first line
 * hides the actual cause, so every non-empty line is included, bounded to
 * {@link DETAIL_MAX_LINES}.
 */
function detail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, DETAIL_MAX_LINES).join(' | ');
  return lines.length > DETAIL_MAX_LINES
    ? `${shown} | ... (${lines.length - DETAIL_MAX_LINES} more lines)`
    : shown;
}

/**
 * The error a begin that never started recording raises.
 *
 * Kept as one function so the single-attempt and retried paths name the same
 * expectation, and so the device's own diagnostics survive into the message.
 */
function beginFailed(deviceOutput: string): OhosPerfError {
  return new OhosPerfError(
    `hitrace begin failed: expected "${BEGIN_MARKER}"; device output: ${detail(deviceOutput)}`,
    { code: 'HITRACE_BEGIN_FAILED' },
  );
}

/**
 * Parse the byte count of `path` from `ls -l` output.
 *
 * A line matches only when its **last** whitespace-separated token is exactly
 * `path`. Substring matching would also accept `/x/trace.htrace.bak` and
 * `/x/trace.htrace2`; the device directory accumulates files, so decoys are
 * realistic and must not be read as this capture's output.
 *
 * Android's toybox and GNU both put the size in the fifth field (after mode,
 * links, owner, group), but scanning from there for the first all-digit token
 * tolerates the date/time columns in either format.
 *
 * Exported for direct unit testing; it is a pure function.
 */
export function parseSize(output: string, path: string): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || tokens[tokens.length - 1] !== path) continue;
    for (let i = 4; i < tokens.length; i++) {
      if (/^\d+$/.test(tokens[i])) return Number(tokens[i]);
    }
  }
  return undefined;
}

export class HitraceCollector implements Collector {
  readonly id = 'hitrace';
  readonly provides: CapabilityId[] = [
    'trace.frames',
    'trace.sched',
    'trace.binder',
    'trace.thread_state',
    'render.vsync',
  ];

  /**
   * `-t` is deliberately absent: measured on the emulator, `--trace_begin -t 2`
   * kept recording for the full 8s host window. `--trace_begin` is long
   * recording mode, where `-t` has no effect; the host times the capture.
   */
  beginCommand(opts: TraceCollectOptions): string {
    const bufferKb = opts.bufferKb ?? DEFAULT_BUFFER_KB;
    const categories: readonly string[] = opts.categories ?? HITRACE_DEFAULT_CATEGORIES;
    assertBufferKb(bufferKb);
    assertCategories(categories);
    return `hitrace --trace_begin -b ${bufferKb} ${categories.join(' ')}`;
  }

  finishCommand(devicePath: string): string {
    return `hitrace --trace_finish -o ${devicePath}`;
  }

  /**
   * Capture one trace to `layout.traceFile`.
   *
   * The step order is load-bearing:
   *   1. remove the fixed device path so a failed capture cannot return a
   *      stale file from an earlier session;
   *   2. begin and require `OpenRecording done` (hdc exit 0 is not enough);
   *   3. wait the host-side duration;
   *   4. finish and require `trace read done`;
   *   5. require the file to exist with size > 0 before transferring;
   *   6. recv (which validates its own `FileTransfer finish` marker).
   *
   * Nothing is transferred unless every check above passes, so a failed or
   * empty capture can never overwrite `layout.traceFile` with stale data.
   *
   * If anything throws after a successful begin but before a successful
   * finish, a best-effort `hitrace --trace_finish_nodump` is issued in a
   * `finally`. Without it a transport failure (hdc throws, target drops) would
   * leave hitrace recording on the device, and every later begin would fail
   * with `errorCode(1103)` until someone stopped it by hand. The stop's own
   * error is swallowed; the original failure is what the caller sees.
   *
   * That stop only covers failures *this* process lives through. A process
   * killed mid-capture leaves the same recording behind with nothing to stop
   * it, so a begin that answers `errorCode(1103)` is treated as a stale
   * session: the collector stops it and retries the same begin once. Two
   * failures in a row raise with both attempts named; any other begin failure
   * is raised without a retry and without stopping a recording that is not
   * there.
   *
   * `opts.durationMs` must be finite and in `(0, 2^31 - 1]`; anything else
   * throws `HITRACE_BAD_DURATION` before the device is touched. `categories`,
   * when supplied, must contain at least one non-empty bare tag name
   * (`/^[A-Za-z0-9_]+$/`), else `HITRACE_BAD_CATEGORIES`. `bufferKb`, when
   * supplied, must be a positive safe integer, else `HITRACE_BAD_BUFFER`.
   * All three checks run before the first device command.
   */
  async collect(
    hdc: Hdc,
    target: string,
    opts: TraceCollectOptions,
    layout: SceneLayout,
  ): Promise<void> {
    assertDuration(opts.durationMs);
    assertCategories(opts.categories ?? HITRACE_DEFAULT_CATEGORIES);
    assertBufferKb(opts.bufferKb ?? DEFAULT_BUFFER_KB);

    const devicePath = DEVICE_TRACE_PATH;

    await hdc.shell(target, `rm -f ${devicePath}`);

    const begin = await hdc.shell(target, this.beginCommand(opts));
    const firstFailure = combined(begin);
    if (!firstFailure.includes(BEGIN_MARKER)) {
      // A long recording left running by an earlier, aborted run is the one
      // begin failure this collector can clear: measured on the emulator, it
      // answers `errorCode(1103)` to every begin until a
      // `--trace_finish_nodump` stops it, and one such session cost every case
      // of a 21-case sweep. Stop it and try the same command once.
      if (!firstFailure.includes(STALE_SESSION_MARKER)) {
        throw beginFailed(firstFailure);
      }
      await this.stopBestEffort(hdc, target);
      const retry = await hdc.shell(target, this.beginCommand(opts));
      if (!combined(retry).includes(BEGIN_MARKER)) {
        // Two failures in a row is not a stale session; retrying again would
        // spend the capture window on a device that cannot record. Both
        // attempts are named, because the second may be a different error.
        throw new OhosPerfError(
          `hitrace begin failed after stopping a stale recording` +
            ` (first: ${detail(firstFailure)}; retry: ${detail(combined(retry))})`,
          { code: 'HITRACE_BEGIN_FAILED' },
        );
      }
    }

    let finished = false;
    try {
      await delay(opts.durationMs);

      const finish = await hdc.shell(target, this.finishCommand(devicePath));
      if (!combined(finish).includes(FINISH_MARKER)) {
        throw new OhosPerfError(
          `hitrace finish failed: expected "${FINISH_MARKER}"; device output: ${detail(combined(finish))}`,
          { code: 'HITRACE_FINISH_FAILED' },
        );
      }
      // Recording is stopped from here on; a later failure must not re-stop.
      finished = true;

      const listing = await hdc.shell(target, `ls -l ${devicePath}`);
      const size = parseSize(listing.stdout, devicePath);
      if (size === undefined || size <= 0) {
        throw new OhosPerfError(
          `hitrace produced no trace output at ${devicePath}` +
            ` (${size === undefined ? 'file not found' : 'file is empty'});` +
            ` ls -l output: ${detail(combined(listing))}`,
          { code: 'HITRACE_NO_OUTPUT' },
        );
      }

      await hdc.recv(target, devicePath, layout.traceFile);
    } finally {
      if (!finished) await this.stopBestEffort(hdc, target);
    }
  }

  /**
   * Stop a recording that is still running. Never throws: this runs while an
   * error is propagating, and replacing that error with a stop failure would
   * hide the actual cause.
   */
  private async stopBestEffort(hdc: Hdc, target: string): Promise<void> {
    try {
      await hdc.shell(target, 'hitrace --trace_finish_nodump');
    } catch {
      // Deliberately swallowed.
    }
  }
}
