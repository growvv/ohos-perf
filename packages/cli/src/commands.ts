import type { CapabilityState } from '@ohos-perf/core';
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

/** Everything the commands touch, injected so the module performs no IO itself. */
export interface CliDeps {
  doctor: DoctorDeps;
  /** Resolve the capability matrix (used by `caps`). */
  capsReport(): Promise<CapsReport>;
  /** Analyze a scene directory. Throws on any failure; the caller maps it to exit 1. */
  analyze(sceneDir: string, app?: string): Promise<AnalyzeOutput>;
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
  return { text: first, truncated: first !== text };
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
  stdout +=
    report.device === undefined
      ? 'device   none attached\n'
      : `device   ${report.device.id} (${report.device.kind}, ${report.device.abi})\n`;
  stdout += formatCapabilities(report.capabilities);

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
  const stdout = opts.json ? json(report.capabilities) : formatCapabilities(report.capabilities);
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

export type { DoctorDeps };
