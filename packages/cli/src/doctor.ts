import type { CapabilityState } from '@ohos-perf/core';

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
  connectDevice(): Promise<DeviceLike>;
}

/**
 * Result of a toolchain/device check.
 *
 * `device` is absent when no device could be probed; `capabilities` is then
 * empty. That is not a toolchain failure: the caller decides the exit code
 * from `hdc.ok` alone (see the `doctor` command), because "no device attached"
 * is an environmental state, while "hdc is not installed" is not.
 */
export interface DoctorReport {
  hdc: { ok: boolean; path?: string; error?: string };
  streamer: { ok: boolean; path?: string; version?: string; error?: string };
  device?: { id: string; kind: string; abi: string };
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
 */
export function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '<unprintable error>';
  }
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
export async function doctorReport(deps: DoctorDeps): Promise<DoctorReport> {
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
  // cannot be read is not reported at all, because `capabilities: []` already
  // means "nothing was probed" and the report has no error field for it.
  let device: DoctorReport['device'];
  let capabilities: CapabilityState[] = [];
  try {
    const connected = await deps.connectDevice();
    const matrix = await connected.capabilities();
    device = { id: connected.id, kind: connected.kind, abi: connected.abi };
    capabilities = [...matrix.all()].sort(byId);
  } catch {
    device = undefined;
    capabilities = [];
  }

  return { hdc, streamer, device, capabilities };
}
