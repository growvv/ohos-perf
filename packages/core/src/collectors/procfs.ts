import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc, HdcResult } from '../transport/hdc';
import type { Collector } from './types';

/** `/proc/<pid>/status` fields this collector needs, already in bytes. */
export interface ProcfsStatus {
  vmRssBytes: number;
  vmHwmBytes: number;
  threads: number;
}

/**
 * `/proc/<pid>/smaps_rollup` fields this collector needs.
 *
 * Every kB-valued field is converted to bytes, so all three `*Bytes` names
 * describe their unit.
 */
export interface SmapsRollup {
  pssBytes: number;
  privateDirtyBytes: number;
  swapPssBytes: number;
}

/** One timed sample of a process's memory/thread state. */
export interface ProcfsSample {
  /** Host clock (`now()`) at the start of the attempt. */
  ts: number;
  pid: number;
  status: ProcfsStatus;
  /** Absent when `smaps_rollup` could not be read or parsed. */
  smaps?: SmapsRollup;
}

/** Node's setTimeout clamps anything larger to 1 ms (32-bit signed limit). */
const MAX_TIMEOUT_MS = 2_147_483_647;

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 100;

/** The app name is interpolated into `pidof <app>`, so it must be a bare name. */
const APP_PATTERN = /^[A-Za-z0-9_.]+$/;

/**
 * Anchored line matches: `/proc/<pid>/status` and `smaps_rollup` also contain
 * lookalike keys (`VmRSSHigh`, `Pss_Anon`, `SwapPss_*`), which an unanchored
 * search would confuse for the fields this collector needs.
 */
const STATUS_FIELDS = /^(VmRSS|VmHWM|Threads):\s+(\d+)(?:\s+kB)?$/gm;
const SMAPS_FIELDS = /^(Pss|Private_Dirty|SwapPss):\s+(\d+)(?:\s+kB)?$/gm;

function parseFields(text: string, pattern: RegExp): Map<string, number> {
  const values = new Map<string, number>();
  for (const match of text.matchAll(pattern)) {
    values.set(match[1], Number(match[2]));
  }
  return values;
}

/**
 * Parse a `/proc/<pid>/status` excerpt. All three fields are required; a
 * process that has already exited often leaves a truncated file, and a sample
 * with a zeroed RSS would be worse than no sample.
 */
export function parseProcfsStatus(text: string): ProcfsStatus | undefined {
  const values = parseFields(text, STATUS_FIELDS);
  const vmRssKb = values.get('VmRSS');
  const vmHwmKb = values.get('VmHWM');
  const threads = values.get('Threads');
  if (vmRssKb === undefined || vmHwmKb === undefined || threads === undefined) {
    return undefined;
  }
  return {
    vmRssBytes: vmRssKb * 1024,
    vmHwmBytes: vmHwmKb * 1024,
    threads,
  };
}

/** Parse a `/proc/<pid>/smaps_rollup` excerpt; all three fields are required. */
export function parseSmapsRollup(text: string): SmapsRollup | undefined {
  const values = parseFields(text, SMAPS_FIELDS);
  const pssKb = values.get('Pss');
  const privateDirtyKb = values.get('Private_Dirty');
  const swapPssKb = values.get('SwapPss');
  if (pssKb === undefined || privateDirtyKb === undefined || swapPssKb === undefined) {
    return undefined;
  }
  return {
    pssBytes: pssKb * 1024,
    privateDirtyBytes: privateDirtyKb * 1024,
    swapPssBytes: swapPssKb * 1024,
  };
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcfsStatus(value: unknown): value is ProcfsStatus {
  return (
    isRecord(value) &&
    isNumber(value.vmRssBytes) &&
    isNumber(value.vmHwmBytes) &&
    isNumber(value.threads)
  );
}

function isSmapsRollup(value: unknown): value is SmapsRollup {
  return (
    isRecord(value) &&
    isNumber(value.pssBytes) &&
    isNumber(value.privateDirtyBytes) &&
    isNumber(value.swapPssBytes)
  );
}

function isProcfsSample(value: unknown): value is ProcfsSample {
  return (
    isRecord(value) &&
    isNumber(value.ts) &&
    isNumber(value.pid) &&
    isProcfsStatus(value.status) &&
    (value.smaps === undefined || isSmapsRollup(value.smaps))
  );
}

/**
 * Write samples as JSONL, one `JSON.stringify(sample)` per line, in sample
 * order. The parent directory is created when needed. An empty list writes an
 * empty file (no trailing newline).
 */
export function writeProcfsSamples(path: string, samples: ProcfsSample[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, samples.map((sample) => `${JSON.stringify(sample)}\n`).join(''));
}

/**
 * Read a JSONL capture. A missing file is not an error (the scene may simply
 * not have a procfs capture); blank lines, malformed JSON and lines that do
 * not carry the full numeric shape are skipped rather than failing the whole
 * read.
 */
export function readProcfsSamples(path: string): ProcfsSample[] {
  if (!existsSync(path)) return [];
  const samples: ProcfsSample[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isProcfsSample(parsed)) samples.push(parsed);
  }
  return samples;
}

function assertApp(app: string): void {
  if (!APP_PATTERN.test(app)) {
    throw new OhosPerfError(
      `app must be a bare application name matching ${String(APP_PATTERN)}` +
        ` (got ${JSON.stringify(app)})`,
      { code: 'PROCFS_BAD_APP' },
    );
  }
}

/**
 * `durationMs` must be finite and in `(0, 2^31 - 1]`. Mirrors the hitrace
 * duration gate: above the 32-bit setTimeout limit Node clamps the timer to
 * 1 ms, so a long capture would silently end almost immediately.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'PROCFS_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_TIMEOUT_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_TIMEOUT_MS} ms (the 32-bit setTimeout limit);` +
        ` larger values are silently clamped to 1 ms (got ${String(durationMs)})`,
      { code: 'PROCFS_BAD_DURATION' },
    );
  }
}

function assertInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new OhosPerfError(
      `intervalMs must be an integer of at least ${MIN_INTERVAL_MS} ms` +
        ` (got ${String(intervalMs)})`,
      { code: 'PROCFS_BAD_INTERVAL' },
    );
  }
}

/** How many device-output lines an error message may quote. */
const DETAIL_MAX_LINES = 5;

/** Device output excerpt; both streams are diagnostics on this device. */
function detail(result: HdcResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
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
 * `Hdc.shell` reports a nonzero device exit (or a `[Fail]` line on stdout) by
 * throwing `HDC_SHELL_FAILED`, not by returning `code !== 0`. Both forms are
 * handled: structural fakes return the code, the real transport throws.
 */
function isShellFailure(err: unknown): err is OhosPerfError {
  return err instanceof OhosPerfError && err.code === 'HDC_SHELL_FAILED';
}

/**
 * Remove a previous run's capture after validation, before `pidof`, so a
 * capture that produces no samples leaves no JSONL behind.
 */
function removeStaleCapture(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
}

/**
 * Resolve the app's pid with `pidof`. The first positive integer on the first
 * non-empty stdout line wins: an app with several processes prints several
 * pids, and the first is the one whose `/proc` entry the capture follows.
 *
 * Transport errors propagate untouched; a device-level failure — including
 * the `HDC_SHELL_FAILED` that `Hdc.shell` throws for a nonzero exit — becomes
 * `PROCFS_NO_PID` with the raw output or the transport's message, because "the
 * app is not running" and "pidof is missing" must both reach the caller.
 */
async function resolvePid(hdc: Hdc, target: string, app: string): Promise<number> {
  let result: HdcResult;
  try {
    result = await hdc.shell(target, `pidof ${app}`);
  } catch (err) {
    if (!isShellFailure(err)) throw err;
    throw new OhosPerfError(`pidof ${app} failed; no pid resolved (${err.message})`, {
      code: 'PROCFS_NO_PID',
      cause: err,
    });
  }
  const raw =
    `stdout ${JSON.stringify(result.stdout)}, ` +
    `stderr ${JSON.stringify(result.stderr)}, exit code ${result.code}`;

  if (result.code !== 0) {
    throw new OhosPerfError(`pidof ${app} failed; no pid resolved (${raw})`, {
      code: 'PROCFS_NO_PID',
    });
  }

  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  const pid =
    firstLine === undefined
      ? undefined
      : [...firstLine.matchAll(/\d+/g)].map((match) => Number(match[0])).find((n) => n > 0);

  if (pid === undefined) {
    throw new OhosPerfError(`pidof ${app} returned no positive pid (${raw})`, {
      code: 'PROCFS_NO_PID',
    });
  }
  return pid;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sample a running app's `/proc` entries for `durationMs`.
 *
 * This is an additional data source for the memory analyzer, not a HapRay
 * port. Each attempt reads `status` first; a nonzero exit or unparsable
 * `status` skips that attempt (the app may still be starting). A failed or
 * unparsable `smaps_rollup` only omits the optional `smaps` field, so a kernel
 * without that file still yields RSS samples. `Hdc.shell` throws
 * `HDC_SHELL_FAILED` for a nonzero device exit; those errors follow the same
 * skip/omit rules, while every other transport error propagates.
 *
 * The loop runs immediately, then sleeps `intervalMs` while
 * `ts + intervalMs <= deadline`, where `deadline` is the first attempt's
 * `now() + durationMs`. `now()` is consumed once per attempt (before the cat
 * commands) and that reading is both the sample's `ts` and the value used for
 * the stop decision, so timestamps and attempt count cannot drift apart.
 *
 * Any existing `layout.procfsFile` is removed after validation, before `pidof`
 * and the first attempt. On success the fresh samples are written before
 * returning; with zero successful samples the capture throws
 * `PROCFS_NO_SAMPLES` (carrying the last device/parse error) and leaves no
 * file, so a previous run's data is never mistaken for this run's.
 */
export class ProcfsCollector implements Collector {
  readonly id = 'procfs';
  readonly provides: CapabilityId[] = ['mem.procfs'];

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async collect(
    hdc: Hdc,
    target: string,
    opts: { app: string; durationMs: number; intervalMs?: number },
    layout: SceneLayout,
  ): Promise<ProcfsSample[]> {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    assertApp(opts.app);
    assertDuration(opts.durationMs);
    assertInterval(intervalMs);

    removeStaleCapture(layout.procfsFile);

    const pid = await resolvePid(hdc, target, opts.app);

    const samples: ProcfsSample[] = [];
    let lastError: string | undefined;

    let ts = this.now();
    const deadline = ts + opts.durationMs;

    for (;;) {
      let status: ProcfsStatus | undefined;

      try {
        const statusResult = await hdc.shell(target, `cat /proc/${pid}/status`);
        if (statusResult.code !== 0) {
          lastError =
            `cat /proc/${pid}/status exited ${statusResult.code}` +
            ` (${detail(statusResult)})`;
        } else {
          status = parseProcfsStatus(statusResult.stdout);
          if (status === undefined) {
            lastError =
              `cat /proc/${pid}/status did not contain VmRSS, VmHWM and Threads` +
              ` (${detail(statusResult)})`;
          }
        }
      } catch (err) {
        if (!isShellFailure(err)) throw err;
        lastError = `cat /proc/${pid}/status failed: ${err.message}`;
      }

      if (status !== undefined) {
        const sample: ProcfsSample = { ts, pid, status };
        try {
          const smapsResult = await hdc.shell(target, `cat /proc/${pid}/smaps_rollup`);
          if (smapsResult.code === 0) {
            const smaps = parseSmapsRollup(smapsResult.stdout);
            if (smaps !== undefined) sample.smaps = smaps;
          }
        } catch (err) {
          if (!isShellFailure(err)) throw err;
          // A kernel without smaps_rollup still yields the RSS sample.
        }
        samples.push(sample);
      }

      if (ts + intervalMs > deadline) break;
      await this.sleep(intervalMs);
      ts = this.now();
    }

    if (samples.length === 0) {
      throw new OhosPerfError(
        `procfs collected no samples for ${opts.app} (pid ${pid}) over` +
          ` ${opts.durationMs} ms; last error: ${lastError ?? '(no output)'}`,
        { code: 'PROCFS_NO_SAMPLES' },
      );
    }

    writeProcfsSamples(layout.procfsFile, samples);
    return samples;
  }
}
