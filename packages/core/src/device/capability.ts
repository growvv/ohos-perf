/**
 * Capability model.
 *
 * A metric is only meaningful when the device can actually produce it. This
 * module turns raw probe output into an explicit {@link CapabilityMatrix}:
 * every capability carries an availability verdict, the collector that serves
 * it, a fidelity marker, and — when unavailable — the concrete reason plus the
 * probe output that produced the verdict. Callers never have to infer "empty
 * result" from "unsupported device".
 */

export type CapabilityId =
  | 'trace.frames' | 'trace.sched' | 'trace.binder' | 'trace.thread_state'
  | 'perf.samples' | 'perf.pmu'
  | 'mem.procfs' | 'mem.native_hook' | 'mem.gpu'
  | 'render.fps_live' | 'render.hitch' | 'render.vsync'
  | 'ui.tree' | 'ui.gesture'
  | 'power.xpower' | 'net.io' | 'disk.io' | 'js.heap' | 'coverage'
  | 'startup.app_startup';

/**
 * How directly a capability measures the thing it claims to measure.
 *
 * `proxy` is used when the same metric is derived from a different signal on a
 * different device class — notably live FPS from the refresh-rate counter on an
 * emulator versus per-frame timings on a real device.
 */
export type Fidelity = 'exact' | 'approximate' | 'proxy';

/** The command that was run to decide availability, and what it returned. */
export interface ProbeResult {
  command: string;
  stdout: string;
  stderr: string;
  code: number;
}

export interface CapabilityState {
  id: CapabilityId;
  available: boolean;
  collector?: string;
  fidelity: Fidelity;
  reason?: string;
  probe: ProbeResult;
}

/** Inputs gathered by the device probe (Task 4). */
export interface CapabilityInputs {
  abi: string;
  isEmulator: boolean;
  binaries: Record<string, boolean>;
  hiperfHwEvents: string[];
  hiperfSwEvents: string[];
  /**
   * Plugins the hiprofiler daemon offers, when it was running during the probe.
   * `undefined` means the list is unknown (`Service not started`), and the
   * binary-based verdict is kept.
   */
  hiprofilerPlugins?: string[];
  probes: Record<string, ProbeResult>;
}

const EMPTY_PROBE = (): ProbeResult => ({ command: '', stdout: '', stderr: '', code: 0 });

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byId(a: CapabilityState, b: CapabilityState): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function ownEntry(
  probes: Record<string, ProbeResult>,
  key: string,
): ProbeResult | undefined {
  return Object.prototype.hasOwnProperty.call(probes, key) ? probes[key] : undefined;
}

/**
 * Probe keys may be either the short binary name (`hitrace`) or the command
 * that was actually run (`which hitrace`). Both are accepted so callers can
 * pass either hand-written test fixtures or a real probe snapshot.
 *
 * When a rule names the command that produced its verdict (e.g. `perf.pmu`
 * comes from `hiperf list hw`, not from `which hiperf`), that command wins:
 * the probe must show the evidence the verdict was actually based on.
 */
function probeFor(
  probes: Record<string, ProbeResult>,
  binary: string | undefined,
  command: string | undefined,
  commandFirst: boolean,
): ProbeResult {
  const fromCommand = command === undefined ? undefined : ownEntry(probes, command);
  const fromBinary =
    binary === undefined
      ? undefined
      : ownEntry(probes, binary) ?? ownEntry(probes, `which ${binary}`);

  const ordered = commandFirst
    ? [fromCommand, fromBinary]
    : [fromBinary, fromCommand];
  return ordered.find((entry) => entry !== undefined) ?? EMPTY_PROBE();
}

interface Rule {
  id: CapabilityId;
  collector: string;
  /** Binary whose presence gates availability. Omitted for always-on rows. */
  binary?: string;
  /** Command to report in the probe when no binary applies. */
  probeCommand?: string;
  /** Prefer `probeCommand`'s output over the binary's `which` output. */
  probeFromCommand?: boolean;
  /**
   * hiprofiler plugin that must appear in `hiprofiler_cmd --list`. Ignored
   * when the plugin list is unknown: the binary gate is then the only verdict.
   */
  plugin?: string;
  /** Overrides the default `<binary> not present on device` reason. */
  missingReason?: (binary: string) => string;
  /** Extra availability condition evaluated after the binary gate. */
  available?: (input: CapabilityInputs) => boolean;
  /** Overrides the fixed reason when `available` returns false. */
  unavailableReason?: string;
  /** Fidelity depends on the device class (fps_live on emulators). */
  fidelity?: (input: CapabilityInputs) => Fidelity;
}

const HIPROFILER_MISSING = 'hiprofiler not present on device (hiprofiler_cmd missing)';
const NO_HW_PMU_EVENTS = 'no hardware PMU events reported by hiperf list hw';

/** The probe command that lists hiprofiler's plugins. */
const HIPROFILER_LIST = 'hiprofiler_cmd --list';

function hiprofiler(id: CapabilityId, plugin?: string): Rule {
  return {
    id,
    collector: 'hiprofiler',
    binary: 'hiprofiler_cmd',
    missingReason: () => HIPROFILER_MISSING,
    ...(plugin === undefined ? {} : { plugin }),
  };
}

const RULES: Rule[] = [
  { id: 'trace.frames', collector: 'hitrace', binary: 'hitrace' },
  { id: 'trace.sched', collector: 'hitrace', binary: 'hitrace' },
  { id: 'trace.binder', collector: 'hitrace', binary: 'hitrace' },
  { id: 'trace.thread_state', collector: 'hitrace', binary: 'hitrace' },
  { id: 'render.vsync', collector: 'hitrace', binary: 'hitrace' },

  { id: 'perf.samples', collector: 'hiperf', binary: 'hiperf' },
  {
    id: 'perf.pmu',
    collector: 'hiperf',
    binary: 'hiperf',
    probeCommand: 'hiperf list hw',
    probeFromCommand: true,
    available: (input) => input.hiperfHwEvents.length > 0,
    unavailableReason: NO_HW_PMU_EVENTS,
  },

  // /proc is readable through the shell on every device, emulator included.
  { id: 'mem.procfs', collector: 'procfs', probeCommand: 'cat /proc/self/stat' },

  // Plugin names as measured by `hiprofiler_cmd --list` on the Mate 60.
  // `coverage` has no known plugin, so it keeps the binary-only verdict.
  hiprofiler('mem.native_hook', 'nativehook'),
  hiprofiler('mem.gpu', 'gpu-plugin'),
  hiprofiler('power.xpower', 'xpower-plugin'),
  hiprofiler('net.io', 'network-plugin'),
  hiprofiler('disk.io', 'diskio-plugin'),
  // The device can run memory-plugin, but that says nothing about heap data:
  // nothing in this package consumes the js_heap_* tables, so the row stays in
  // the matrix (a dropped row reads as "not probed") and reports why.
  {
    id: 'js.heap',
    collector: 'hiprofiler',
    binary: 'hiprofiler_cmd',
    missingReason: () => HIPROFILER_MISSING,
    available: () => false,
    unavailableReason: 'no analyzer in this package consumes js_heap_* tables',
  },
  hiprofiler('coverage'),
  hiprofiler('startup.app_startup', 'ftrace-plugin'),

  {
    id: 'render.fps_live',
    collector: 'hidumper',
    binary: 'hidumper',
    // Emulator FPS comes from the refresh-rate counter (hidumper fpsCount), not
    // per-frame timings, so it is a proxy for frame timing.
    fidelity: (input) => (input.isEmulator ? 'proxy' : 'exact'),
  },
  { id: 'render.hitch', collector: 'hidumper', binary: 'hidumper' },

  { id: 'ui.tree', collector: 'uitest', binary: 'uitest' },
  { id: 'ui.gesture', collector: 'uitest', binary: 'uitest' },
];

function resolveState(rule: Rule, input: CapabilityInputs): CapabilityState {
  const hasBinary = rule.binary === undefined ? true : input.binaries[rule.binary] === true;
  const extraAvailable = rule.available === undefined ? true : rule.available(input);
  const plugin = rule.plugin;
  const pluginList = plugin === undefined ? undefined : input.hiprofilerPlugins;
  const pluginOffered =
    plugin === undefined || pluginList === undefined || pluginList.includes(plugin);
  const available = hasBinary && extraAvailable && pluginOffered;
  const fidelity = rule.fidelity === undefined ? 'exact' : rule.fidelity(input);
  // The verdict cites whichever gate actually decided it: the plugin list when
  // it is known, otherwise the binary check that stood in for it.
  const citeList = plugin !== undefined && pluginList !== undefined;
  const probe = probeFor(
    input.probes,
    rule.binary,
    citeList ? HIPROFILER_LIST : rule.probeCommand,
    citeList || rule.probeFromCommand === true,
  );

  if (available) {
    return { id: rule.id, available: true, collector: rule.collector, fidelity, probe };
  }

  let reason: string;
  if (!hasBinary) {
    reason =
      rule.missingReason === undefined
        ? `${rule.binary} not present on device`
        : rule.missingReason(rule.binary as string);
  } else if (!pluginOffered) {
    reason = `hiprofiler plugin ${String(plugin)} is not offered by the device's daemon`;
  } else {
    reason = rule.unavailableReason ?? 'capability unavailable on this device';
  }

  return { id: rule.id, available: false, fidelity, reason, probe };
}

/** Build the full matrix from a probe snapshot. Every rule yields one state. */
export function buildMatrix(input: CapabilityInputs): CapabilityMatrix {
  return new CapabilityMatrix(RULES.map((rule) => resolveState(rule, input)));
}

export class CapabilityMatrix {
  private readonly states: Map<CapabilityId, CapabilityState>;

  constructor(states: CapabilityState[]) {
    this.states = new Map(states.map((state) => [state.id, state]));
  }

  /** True only when the capability exists *and* is usable on this device. */
  has(id: CapabilityId): boolean {
    return this.states.get(id)?.available === true;
  }

  get(id: CapabilityId): CapabilityState | undefined {
    return this.states.get(id);
  }

  /** All known states, sorted by id lexicographically. */
  all(): CapabilityState[] {
    return [...this.states.values()].sort(byId);
  }

  /**
   * Check that every required capability is available.
   *
   * Capabilities that were never probed are reported as missing with a
   * synthesized state (`reason: 'capability not probed'`) rather than being
   * silently ignored. The stored matrix is never mutated.
   */
  satisfies(required: CapabilityId[]): { ok: boolean; missing: CapabilityState[] } {
    const seen = new Set<CapabilityId>();
    const missing: CapabilityState[] = [];

    for (const id of required) {
      if (seen.has(id)) continue;
      seen.add(id);

      const state = this.states.get(id);
      if (state === undefined) {
        missing.push({
          id,
          available: false,
          fidelity: 'exact',
          reason: 'capability not probed',
          probe: EMPTY_PROBE(),
        });
      } else if (!state.available) {
        missing.push(state);
      }
    }

    missing.sort(byId);
    return { ok: missing.length === 0, missing };
  }
}
