/**
 * Device probe.
 *
 * One pass of read-only shell commands whose parsed output feeds the capability
 * matrix. The command set and its order are fixed so a recorded session (see
 * `test/fixtures/probe-*.txt`) reproduces the exact same snapshot as a live
 * device.
 *
 * Everything here is pure parsing over captured stdout: no assumptions about
 * which device class is attached. The only device-class judgement is
 * {@link DeviceIdentity.isEmulator}, derived from the product identity itself.
 */

import type { CapabilityInputs, ProbeResult } from './capability';

/** Minimal shell surface the probe needs. `Hdc` and test fixtures both satisfy it. */
export interface ProbeRunner {
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface DeviceIdentity {
  abi: string;
  productName: string;
  softwareVersion: string;
  osFullName: string;
  deviceType: string;
  isEmulator: boolean;
}

/**
 * Everything the probe learned in one pass.
 *
 * Structurally a {@link CapabilityInputs} plus the human-facing identity, so it
 * can be handed to `buildMatrix()` without translation.
 */
export interface ProbeSnapshot extends CapabilityInputs {
  identity: DeviceIdentity;
}

const PARAM_ABI = 'param get const.product.cpu.abilist';
const PARAM_PRODUCT_NAME = 'param get const.product.name';
const PARAM_SOFTWARE_VERSION = 'param get const.product.software.version';
const PARAM_OS_FULLNAME = 'param get const.ohos.fullname';
const PARAM_DEVICE_TYPE = 'param get const.product.devicetype';

const BINARIES = [
  'hiprofiler_cmd', 'hiperf', 'hitrace', 'hidumper', 'uitest', 'bjc_cov',
] as const;

const CMD_LIST_HW = 'hiperf list hw';
const CMD_LIST = 'hiperf list';
const CMD_HIPROFILER_LIST = 'hiprofiler_cmd --list';

/** Fixed order: five params, six `which`, the hiprofiler list, then hiperf. */
const COMMANDS: readonly string[] = [
  PARAM_ABI,
  PARAM_PRODUCT_NAME,
  PARAM_SOFTWARE_VERSION,
  PARAM_OS_FULLNAME,
  PARAM_DEVICE_TYPE,
  ...BINARIES.map((binary) => `which ${binary}`),
  CMD_HIPROFILER_LIST,
  CMD_LIST_HW,
  CMD_LIST,
];

const HW_HEADER = 'Supported events for hardware:';
const SW_HEADER = 'Supported events for software:';
const UNSUPPORTED_PREFIX = 'event not support';

/**
 * A `which` result is "absent" when it is empty, contains `MISSING` (the
 * convention used by the probe script), or contains `No such file`.
 */
export function parseBinaries(whichOutputs: Record<string, string>): Record<string, boolean> {
  const binaries: Record<string, boolean> = {};
  for (const [name, output] of Object.entries(whichOutputs)) {
    const text = output.trim();
    binaries[name] = text !== '' && !text.includes('MISSING') && !text.includes('No such file');
  }
  return binaries;
}

/**
 * Split `hiperf list` / `hiperf list hw` output into hardware and software
 * events.
 *
 * Measured format (HarmonyOS 7.0 and 6.1):
 *
 * ```
 * event not support hw-cpu-cycles      <- appears BEFORE the section; ignored
 * Supported events for hardware:       <- header at column 0
 * \thw-cpu-cycles                       <- event lines are tab-indented
 * \thw-instructions
 * Supported events for software:
 * \tsw-cpu-clock
 * ```
 *
 * Lines are trimmed before classification. `event not support ...` lines are
 * never members of a section. Any other section (tracepoint, raw, cache) is
 * ignored: only hw/sw are reported. A header with no events yields `[]`, so an
 * emulator with no PMU is a normal result rather than an error.
 */
export function parseHiperfEvents(listOutput: string): { hw: string[]; sw: string[] } {
  const hw: string[] = [];
  const sw: string[] = [];
  let section: string[] | undefined;

  for (const raw of listOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith(UNSUPPORTED_PREFIX)) continue;

    if (line === HW_HEADER) {
      section = hw;
      continue;
    }
    if (line === SW_HEADER) {
      section = sw;
      continue;
    }
    // A different section header (tracepoint, raw, cache) ends the current one.
    // Any other colon-bearing line is descriptive text, not an event name.
    if (line.includes(':')) {
      section = undefined;
      continue;
    }

    if (section !== undefined) section.push(line);
  }

  return { hw, sw };
}

/** The daemon answers this, and nothing else, when it has not been started. */
const SERVICE_NOT_STARTED = 'Service not started';
const PLUGIN_NAME = /^\s*name:\s*"([^"]+)"/;

/**
 * Parse `hiprofiler_cmd --list`.
 *
 * Measured format on the Mate 60 (HarmonyOS 7.0.0.111), after the daemon is
 * running:
 *
 * ```
 * support plugin list:
 * capabilities {
 *   path: "libgpudataplugin.z.so"
 *   name: "gpu-plugin"
 * }
 * ```
 *
 * The service reports `Service not started` while no daemon is running — the
 * probe deliberately does not start one (starting is a device mutation), so
 * `undefined` means "unknown", not "no plugins". An unparseable response is
 * treated the same way rather than claiming every plugin is absent.
 */
export function parseHiprofilerPlugins(output: string): string[] | undefined {
  if (output.includes(SERVICE_NOT_STARTED)) return undefined;
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = PLUGIN_NAME.exec(line);
    if (match !== null && !names.includes(match[1])) names.push(match[1]);
  }
  return names.length === 0 ? undefined : names;
}

function readParam(probes: Record<string, ProbeResult>, command: string): string {
  return probes[command].stdout.trim();
}

function isEmulator(productName: string, softwareVersion: string): boolean {
  return productName === 'emulator' || softwareVersion.startsWith('emulator');
}

export async function runProbe(runner: ProbeRunner): Promise<ProbeSnapshot> {
  const probes: Record<string, ProbeResult> = {};
  for (const command of COMMANDS) {
    const { stdout, stderr, code } = await runner.shell(command);
    probes[command] = { command, stdout, stderr, code };
  }

  const productName = readParam(probes, PARAM_PRODUCT_NAME);
  const softwareVersion = readParam(probes, PARAM_SOFTWARE_VERSION);

  const identity: DeviceIdentity = {
    abi: readParam(probes, PARAM_ABI),
    productName,
    softwareVersion,
    osFullName: readParam(probes, PARAM_OS_FULLNAME),
    deviceType: readParam(probes, PARAM_DEVICE_TYPE),
    isEmulator: isEmulator(productName, softwareVersion),
  };

  const whichOutputs: Record<string, string> = {};
  for (const binary of BINARIES) {
    whichOutputs[binary] = probes[`which ${binary}`].stdout;
  }

  const full = parseHiperfEvents(probes[CMD_LIST].stdout);
  const hwOnly = parseHiperfEvents(probes[CMD_LIST_HW].stdout);
  const hiprofilerPlugins = parseHiprofilerPlugins(probes[CMD_HIPROFILER_LIST].stdout);

  return {
    // Flattened copies keep the snapshot assignable to `CapabilityInputs`
    // without a translation step; `identity` carries the full record.
    abi: identity.abi,
    isEmulator: identity.isEmulator,
    identity,
    binaries: parseBinaries(whichOutputs),
    // `hiperf list hw` is the measured, direct evidence for the PMU capability
    // (`perf.pmu` reports it in the matrix); the full listing backstops it.
    hiperfHwEvents: hwOnly.hw.length > 0 ? hwOnly.hw : full.hw,
    hiperfSwEvents: full.sw,
    // Only present when the daemon was already running; see the parser.
    ...(hiprofilerPlugins === undefined ? {} : { hiprofilerPlugins }),
    probes,
  };
}
