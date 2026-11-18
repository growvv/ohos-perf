import { OhosPerfError, type CapabilityState } from '@ohos-perf/core';

/**
 * The narrow shape `doctor` needs from a connected device.
 *
 * Deliberately not `Device`: the report is about what can be *asked* of a
 * device, and a fake only needs `id`/`kind`/`abi` plus `capabilities()`.
 * Requiring the full class would force every caller and test to build a probe
 * snapshot just to answer "which capabilities are available".
 */
export interface DeviceLike {
  id: string;
  kind: string;
  abi: string;
  capabilities(): Promise<{ all(): CapabilityState[] }>;
}

/** Everything `doctorReport` touches, injected so it performs no IO itself. */
export interface DoctorDeps {
  resolveHdc(): Promise<string>;
  resolveStreamer(): Promise<{ path: string; version: string }>;
  /**
   * `target` is the explicit hdc id from `--target`; omitted, the first
   * connected target is probed. Optional so a fake that ignores it stays
   * valid — a fake cannot verify the flag anyway, which is why the wiring
   * test asserts what `realDeps` receives.
   */
  connectDevice(target?: string): Promise<DeviceLike>;
}

/**
 * Result of a toolchain/device check.
 *
 * `device` is absent when no result could be obtained from the device probe;
 * `capabilities` is then empty, and `probeError` says why. That is not a
 * toolchain failure: the caller decides the exit code from `hdc.ok` alone
 * (see the `doctor` command), because an unreachable device is an
 * environmental state, while "hdc is not installed" is not.
 *
 * `probeError` is set only when the probe actually ran and failed. It cannot
 * distinguish "no device attached" from "the probe threw" — both end in the
 * same catch — so callers must render the message rather than claim the
 * device was never probed (that claim was false for the second case).
 */
export interface DoctorReport {
  hdc: { ok: boolean; path?: string; error?: string };
  streamer: { ok: boolean; path?: string; version?: string; error?: string };
  device?: { id: string; kind: string; abi: string };
  /** Set when hdc is present but the device probe itself failed. */
  probeError?: string;
  capabilities: CapabilityState[];
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byId(a: CapabilityState, b: CapabilityState): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * `String(err)` can itself throw (a rejected non-Error whose `toString` is
 * hostile), and this report's contract is that it never throws.
 *
 * The message alone: a caller that wraps it in its own sentence
 * (`invalid --timeout "0": …`) must not find a refusal code in the middle of
 * that sentence. Use {@link failureLine} for the line the process prints.
 */
export function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '<unprintable error>';
  }
}

/**
 * The one line a failing command prints: a typed error's `code`, then its
 * message.
 *
 * The code is the token a caller branches on and the one the skill tells an
 * agent to report, so a refusal that prints only its message loses it.
 */
export function failureLine(err: unknown): string {
  if (err instanceof OhosPerfError && err.code !== undefined) {
    return `${err.code}: ${safeMessage(err)}`;
  }
  return safeMessage(err);
}

/**
 * The failure as data: the code a caller branches on, and the message it prints.
 *
 * The same two facts {@link failureLine} renders as one line, kept separate so
 * the tool-result envelope can carry them as fields. An untyped throw gets no
 * code — inventing one would make `error.code` a guess rather than a token.
 */
export function errorOf(err: unknown): { code?: string; message: string } {
  return {
    ...(err instanceof OhosPerfError && err.code !== undefined ? { code: err.code } : {}),
    message: safeMessage(err),
  };
}

function message(err: unknown): string {
  return safeMessage(err);
}

/**
 * Check the toolchain and the attached device without ever throwing.
 *
 * Each injected operation runs in its own try/catch: a missing trace_streamer
 * must not hide a working hdc, and a failed device probe must not discard the
 * toolchain verdict. Failures are recorded in `error` fields (or, for the
 * device, by omitting it) so the caller can render a partial report.
 *
 * Capabilities are re-sorted here even though `CapabilityMatrix.all()` sorts:
 * the injected object is structural, so nothing guarantees its `all()` is
 * ordered (D5).
 */
export async function doctorReport(
  deps: DoctorDeps,
  target?: string,
): Promise<DoctorReport> {
  const hdc: DoctorReport['hdc'] = { ok: false };
  try {
    hdc.path = await deps.resolveHdc();
    hdc.ok = true;
  } catch (err) {
    hdc.error = message(err);
  }

  const streamer: DoctorReport['streamer'] = { ok: false };
  try {
    const resolved = await deps.resolveStreamer();
    streamer.path = resolved.path;
    streamer.version = resolved.version;
    streamer.ok = true;
  } catch (err) {
    streamer.error = message(err);
  }

  // The device and its matrix are one probe: a device whose capabilities
  // cannot be read is not reported at all, and the failure is recorded so the
  // caller does not have to pretend no probe ever happened.
  let device: DoctorReport['device'];
  let capabilities: CapabilityState[] = [];
  let probeError: string | undefined;
  try {
    const connected = await deps.connectDevice(target);
    const matrix = await connected.capabilities();
    device = { id: connected.id, kind: connected.kind, abi: connected.abi };
    capabilities = [...matrix.all()].sort(byId);
  } catch (err) {
    device = undefined;
    capabilities = [];
    probeError = safeMessage(err);
  }

  return { hdc, streamer, device, probeError, capabilities };
}
