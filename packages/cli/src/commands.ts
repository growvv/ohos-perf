import type { CapabilityState, HiprofilerPluginName } from '@ohos-perf/core';
import { doctorReport, safeMessage, type DoctorDeps } from './doctor';

/**
 * The pure CLI layer.
 *
 * Every function here takes its dependencies and arguments, and returns what
 * the process should write and exit with. Nothing in this module touches
 * `process`: `index.ts` owns that, which is what makes these rules testable
 * without spawning a subprocess.
 */

/** Re-exported so `index.ts` gets its one error formatter from the CLI layer. */
export { safeMessage };

/** Everything the CLI writes or exits with, so tests can assert without a subprocess. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The narrow view of the capability probe that `caps` needs. */
export interface CapsReport {
  hdcOk: boolean;
  hdcError?: string;
  /**
   * Set when hdc is present but the device probe failed. Distinguishes
   * "we could not ask" from "we asked and the answer was empty".
   *
   * Invariant: `probeError` is set only when the probe failed, and in that case
   * `capabilities` is empty — a failed probe has no matrix. `realDeps()`
   * upholds this; injected fakes must too, or human and `--json` output will
   * disagree (human mode reports the error, JSON reports the phantom matrix).
   */
  probeError?: string;
  capabilities: CapabilityState[];
}

/**
 * The narrow view of an analysis result the CLI renders.
 *
 * Structural rather than `AnalyzeResult` so the formatting rules stay
 * independent of core's full metric/evidence shape (and so a fake is cheap).
 */
export interface AnalyzeOutput {
  metrics: ReadonlyArray<{
    id: string;
    value: number | string;
    unit: string;
    fidelity: string;
  }>;
  evidence: ReadonlyArray<{ kind: string }>;
}

/** The arguments `collect` forwards to the IO layer. */
export interface CollectRequest {
  app: string;
  durationMs: number;
  out: string;
  procfs?: boolean;
  coldStart?: string;
  /** Capture through hiprofiler; an empty object selects Device's default. */
  hiprofiler?: { plugins?: readonly HiprofilerPluginName[] };
}

/** What a successful `collect` returns to the renderer. */
export interface CollectOutput {
  sceneDir: string;
  device: { id: string; kind: string };
}

/** Everything the commands touch, injected so the module performs no IO itself. */
export interface CliDeps {
  doctor: DoctorDeps;
  /** Resolve the capability matrix (used by `caps`). */
  capsReport(): Promise<CapsReport>;
  /** Analyze a scene directory. Throws on any failure; the caller maps it to exit 1. */
  analyze(sceneDir: string, app?: string): Promise<AnalyzeOutput>;
  /** Capture a scene. Throws on any failure; the caller maps it to exit 1. */
  collect(req: CollectRequest): Promise<CollectOutput>;
  /** Package version, for `--version` and the help banner. */
  version: string;
}

/** Mark/collector/fidelity line shared by `doctor` and `caps` human output. */
function formatCapability(state: CapabilityState, idWidth: number, collectorWidth: number): string {
  const mark = state.available ? '✓' : '✗';
  const collector = state.collector ?? '—';
  const line = `${mark} ${state.id.padEnd(idWidth)}  ${collector.padEnd(collectorWidth)}  ${state.fidelity}`;
  return state.reason === undefined ? line : `${line}  ${state.reason}`;
}

/** Human-readable capability list, or the "nothing probed" line. */
export function formatCapabilities(states: CapabilityState[]): string {
  if (states.length === 0) return 'no capabilities (no device probed)\n';
  const idWidth = Math.max(...states.map((s) => s.id.length));
  const collectorWidth = Math.max(...states.map((s) => (s.collector ?? '—').length));
  return states.map((state) => formatCapability(state, idWidth, collectorWidth) + '\n').join('');
}

/**
 * A toolchain-missing error lists every searched path on one enormous line.
 * Human output keeps the diagnosis and drops the list; `--json` keeps it all.
 */
function firstLine(text: string): { text: string; truncated: boolean } {
  const [first] = text.split('\n');
  const marker = ' Searched paths:';
  const at = first.indexOf(marker);
  if (at !== -1) return { text: first.slice(0, at), truncated: true };
  // A multi-line error without a path list is still truncated, but the
  // "--json" hint would be a lie: there is nothing extra to see.
  return { text: first, truncated: false };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Check the toolchain.
 *
 * Exit 1 **only** when hdc is unavailable. A missing device or degraded
 * capabilities are environmental states, not a broken install.
 */
export async function runDoctor(deps: CliDeps, opts: { json?: boolean }): Promise<CliResult> {
  const report = await doctorReport(deps.doctor);
  const exitCode = report.hdc.ok ? 0 : 1;

  if (opts.json) return { stdout: json(report), stderr: '', exitCode };

  let stdout = '';
  if (report.hdc.ok) {
    stdout += `hdc      ok  ${report.hdc.path}\n`;
  } else {
    const hdc = firstLine(report.hdc.error ?? 'unknown error');
    const hint = hdc.truncated ? '  (use --json for the full search path list)' : '';
    stdout += `hdc      FAIL  ${hdc.text}${hint}\n`;
  }
  if (report.streamer.ok) {
    stdout += `streamer ok  ${report.streamer.path} (${report.streamer.version})\n`;
  } else {
    const streamer = firstLine(report.streamer.error ?? 'unknown error');
    const hint = streamer.truncated ? '  (use --json for the full search path list)' : '';
    stdout += `streamer FAIL  ${streamer.text}${hint}\n`;
  }
  if (report.probeError !== undefined) {
    // Same event as `caps`' "capabilities unavailable: …", same verdict
    // source. "none attached" would be a lie when the probe actually ran.
    stdout += `device   probe failed: ${report.probeError}\n`;
  } else if (report.device === undefined) {
    stdout += 'device   none attached\n';
  } else {
    stdout += `device   ${report.device.id} (${report.device.kind}, ${report.device.abi})\n`;
  }
  // A failed probe has no matrix to print; the "no device probed" line would be false.
  stdout += report.probeError !== undefined ? '' : formatCapabilities(report.capabilities);

  return { stdout, stderr: '', exitCode };
}

/**
 * Print the capability matrix.
 *
 * A missing hdc is the only failure, and it writes to stderr with an empty
 * stdout so a `--json` consumer never receives half an array.
 */
export async function runCaps(deps: CliDeps, opts: { json?: boolean }): Promise<CliResult> {
  const report = await deps.capsReport();
  if (!report.hdcOk) {
    return { stdout: '', stderr: `hdc unavailable: ${report.hdcError}\n`, exitCode: 1 };
  }
  let stdout: string;
  if (opts.json) {
    // The machine contract stays a bare array; `probeError` is human-only.
    stdout = json(report.capabilities);
  } else if (report.probeError !== undefined) {
    // A failed probe is not "no capabilities": say what actually happened.
    stdout = `capabilities unavailable: ${report.probeError}\n`;
  } else {
    stdout = formatCapabilities(report.capabilities);
  }
  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * Analyze a scene.
 *
 * Any failure (missing scene, unreadable database, converter error) is exit 1
 * with an empty stdout: partial JSON would be worse than none.
 */
export async function runAnalyze(
  deps: CliDeps,
  sceneDir: string,
  opts: { json?: boolean; app?: string },
): Promise<CliResult> {
  try {
    const result = await deps.analyze(sceneDir, opts.app);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    const metrics = result.metrics
      .map((metric) => `${metric.id}  ${metric.value} ${metric.unit} (${metric.fidelity})\n`)
      .join('');
    const jank = result.evidence.filter((item) => item.kind === 'jank').length;
    const summary = `evidence  ${result.evidence.length} items (jank: ${jank})\n`;
    return { stdout: metrics + summary, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 };
  }
}

/**
 * Capture a scene.
 *
 * As with `analyze`, any failure is exit 1 with an empty stdout: a half-written
 * JSON document would be worse than none. `--json` reports the absolute scene
 * directory and the device identity the capture used.
 */
export async function runCollect(
  deps: CliDeps,
  req: CollectRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.collect(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    return { stdout: `scene  ${result.sceneDir}\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 };
  }
}

export type { DoctorDeps };
