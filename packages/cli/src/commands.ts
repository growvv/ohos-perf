import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverCases,
  loadCases,
  OhosPerfError,
  parseScenario,
  type BaselineComparison, type CapabilityState, type CreateEmulatorRequest,
  type DeltaStatus,
  type EmulatorInstance, type EmulatorStartResult, type EmulatorStopResult, type Gesture,
  type GestureResult,
  type HapAnalysis,
  type HiprofilerPluginName, type NamedQueryInfo, type NamedQueryResult,
  type RunResult, type Scenario,
} from '@ohos-perf/core';
import { doctorReport, failureLine, safeMessage, type DoctorDeps } from './doctor';

/**
 * The pure CLI layer.
 *
 * Every function here takes its dependencies and arguments, and returns what
 * the process should write and exit with. Nothing in this module touches
 * `process`: `index.ts` owns that, which is what makes these rules testable
 * without spawning a subprocess.
 */

/** Re-exported so `index.ts` gets its one error formatter from the CLI layer. */
export { failureLine, safeMessage };

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
    /** Present when the value is a placeholder; a renderer may say why. */
    degraded?: { reason: string; fallback: string };
  }>;
  /**
   * Only `kind` is rendered, but the implementation returns core's full
   * evidence items. `signals` is admitted here so a caller can read the
   * measurement that produced an item (the tests do) without the renderer
   * depending on it; a fake may still supply just `{ kind }`.
   */
  evidence: ReadonlyArray<{
    kind: string;
    /**
     * Scalars are the common case; a `hilog_match` item carries its sample
     * messages as a list, and the renderer must accept that without a cast.
     */
    signals?: Readonly<Record<string, number | string | readonly string[]>>;
  }>;
}

/** The arguments `collect` forwards to the IO layer. */
export interface CollectRequest {
  /**
   * Application under test. Optional because `hidumper` and `uitest` capture
   * the whole screen; the modes that need a pid are rejected by the action
   * before the IO layer connects to a device.
   */
  app?: string;
  durationMs: number;
  out: string;
  procfs?: boolean;
  coldStart?: string;
  /** Capture through hiprofiler; an empty object selects Device's default. */
  hiprofiler?: { plugins?: readonly HiprofilerPluginName[] };
  /** Also record a hiperf perf.data (requires a debuggable app). */
  hiperf?: { frequency?: number };
  /**
   * Host directory of shared objects the perf conversion symbolizes with.
   * Requires `hiperf`; the core refuses the pair otherwise.
   */
  soDir?: string;
  /** Also sample the RenderService fps/hitch counters. */
  hidumper?: boolean;
  /** Also dump the on-screen UI tree. */
  uitest?: boolean;
  /**
   * Also capture the whole screen into `screenshot.png`. Independent of
   * `uitest`: a screenshot without a tree is a valid capture, and the `ui`
   * analyzer reports which half is missing rather than zeros for both.
   */
  screenshot?: boolean;
  /**
   * Also stream the device log. Device-wide like `hidumper`, so no `--app` is
   * required; the raw log lands in `hilog.log` and is parsed at analysis time.
   */
  hilog?: boolean;
  /**
   * Also dump a JS heap snapshot into `jsheap.heapsnapshot`. Requires `app`:
   * the dump targets one process, so unlike `hilog` there is nothing
   * device-wide to capture without it.
   */
  jsheap?: boolean;
  /**
   * Explicit hdc target id. Without it the first connected target is used,
   * which is wrong on a host with both a phone and an emulator attached —
   * `emulator list --json` prints the id to pass here.
   */
  target?: string;
}

/** What a successful `collect` returns to the renderer. */
export interface CollectOutput {
  sceneDir: string;
  device: { id: string; kind: string };
  /** The collectors that ran, in fixed order, as recorded in scene.json. */
  collectors: string[];
  /** Present only when a hiperf capture ran; `samples: 0` is a valid idle app. */
  hiperf?: { samples: number; symbolized?: boolean };
  /** The symbol directory the perf conversion used, when one was given. */
  soDir?: string;
  /** Present only when a hidumper capture ran; `frames: 0` is a blank screen. */
  hidumper?: { frames: number };
  /** Present only when a uitest capture ran; `nodes: 0` is a blank screen. */
  ui?: { nodes: number };
  /** Present only when a screenshot capture ran; the screen's own dimensions. */
  screenshot?: { width: number; height: number };
  /** Present only when a hilog capture ran; `lines` is what the collector read. */
  hilog?: { lines: number };
}

/** A `run` invocation, with the scenario already read and validated. */
export interface RunRequest {
  /** The parsed document. Reading and validating happen in the command layer. */
  scenario: Scenario;
  /** The path it came from, for error wording and `testInfo.json`'s name. */
  scenarioPath: string;
  outDir: string;
  target?: string;
  rounds?: number;
  only?: readonly string[];
  keepGoing?: boolean;
}

/** What `run` needs from the caller before it can reach `deps.run`. */
export interface RunInput {
  /**
   * A scenario file, or `''` when `casesDir` is given.
   *
   * Two modes rather than two commands: `run` already owns the device, the
   * rounds and the keep-going policy, and a case is just a scenario with an
   * id. Giving each case its own command would duplicate all of that.
   */
  scenarioPath: string;
  outDir: string;
  /** A directory of `*.scenario.json` files to run as one suite. */
  casesDir?: string;
  /** Anchored regex over the case id; only meaningful with `casesDir`. */
  filter?: string;
  target?: string;
  rounds?: number;
  only?: readonly string[];
  keepGoing?: boolean;
}

/** One gesture to inject, on the target that should receive it. */
export interface GestureRequest {
  gesture: Gesture;
  /** Explicit hdc target id; omitted, the first connected target is used. */
  target?: string;
}

/** The arguments `query` forwards to the IO layer. */
export interface QueryRequest {
  sceneDir: string;
  name: string;
  /** Overrides the app named in scene.json. */
  app?: string;
  /** The named query's arguments, already parsed from --args. */
  args?: Record<string, unknown>;
  /** Output row limit; the core validates it. */
  limit?: number;
}

/** A `compare` invocation: two scene directories or two `analyze --json` files. */
export interface CompareRequest {
  baseline: string;
  current: string;
}

/** A `ui-compare` invocation: two scene directories and an output directory. */
export interface UiCompareRequest {
  a: string;
  b: string;
  outDir: string;
}

/** What `ui-compare` wrote and what it found. */
export interface UiCompareOutput {
  outDir: string;
  /** The artifact file names, in their fixed presentation order. */
  files: string[];
  /** Differences per class, plus the matched count. */
  tree: { added: number; removed: number; changed: number; unchanged: number } | null;
  image: {
    hamming: number;
    similarity: number;
    changedRatio: number;
    tolerance: number;
  } | null;
  regions: number;
  /**
   * Animation labels: regions whose pixels *and* tree both changed between the
   * two captures. Empty for a tree-only comparison, which has no pixels.
   */
  animations: number;
  /** Regions whose pixels moved while the tree did not: listed, not labelled. */
  pixelOnly: number;
  /** Regions too small for the dHash grid to say anything about. */
  unmeasuredRegions: number;
  /** Artifacts neither side carried; the comparison is partial when non-empty. */
  degraded: string[];
}

/** A `report` invocation: one scene, one output directory, an optional baseline. */
export interface ReportRequest {
  sceneDir: string;
  outDir: string;
  /** Overrides the app named in scene.json. */
  app?: string;
  /** A scene directory or an `analyze --json` file to compare against. */
  baseline?: string;
}

/** What a successful `report` wrote, and what it found. */
export interface ReportOutput {
  outDir: string;
  /** The artifact file names, in their fixed presentation order. */
  files: string[];
  sections: { total: number; measured: number; degraded: number };
  metrics: number;
  evidence: number;
  bySeverity: { info: number; warn: number; critical: number };
  /** Present only when `--baseline` was given. */
  comparison?: Record<DeltaStatus, number>;
}

/** A `render` invocation: one saved report, one output directory. */
export interface RenderRequest {
  /** A `report.json` file, or the bundle directory that holds one. */
  report: string;
  outDir: string;
}

/** What a successful `render` wrote. */
export interface RenderOutput {
  outDir: string;
  /** The artifact file names, in their fixed presentation order. */
  files: string[];
  sections: number;
  metrics: number;
  evidence: number;
}

/** A `trend` invocation: two or more saved reports and an output directory. */
export interface TrendRequest {
  /**
   * The reports to aggregate. `label` names the run on the x axis; when absent
   * the path is used, so a caller that did not name them still gets a page
   * whose points can be told apart.
   */
  reports: Array<{ label?: string; path: string }>;
  outDir: string;
}

/** What a successful `trend` wrote, and how the runs were ordered. */
export interface TrendOutput {
  outDir: string;
  /** The artifact file names, in their fixed presentation order. */
  files: string[];
  runs: Array<{
    label: string;
    app: string;
    device: string;
    startedAtNs?: number;
    metrics: number;
  }>;
  orderedBy: 'startedAtNs' | 'argument';
  series: number;
  improved: number;
  regressed: number;
  unchanged: number;
  /** Series with a known direction but no two measured points to compare. */
  verdictless: number;
  /** Series no run measured at all; they have no values, not no direction. */
  unmeasured: number;
}

/** A `hap` invocation: one package on disk, an optional output directory. */
export interface HapRequest {
  /** Path to the `.hap` / `.hsp` / `.zip` file. */
  packagePath: string;
  /** When set, `hap.json` and `hap.html` are written here. */
  outDir?: string;
}

/**
 * What a package inspection found.
 *
 * `analysis` is the `HapAnalysis` document `hap.json` carries — the spec's
 * contract for `--json` — so a terminal and a file see the same facts,
 * including the per-file inventory. `capabilities` is the one-row matrix the
 * spec requires: a package on disk needs no device probe, but a consumer that
 * reads capabilities everywhere reads them here too.
 */
export interface HapOutput {
  analysis: HapAnalysis;
  capabilities: CapabilityState[];
  /** Present only when `--out` was given; the directory the caller named. */
  outDir?: string;
  /** Present only when `--out` was given; the artifact names, in order. */
  artifacts?: string[];
}

/**
 * Where the emulator commands look for the binary and its state.
 *
 * Every field is optional so the core applies its own discovery order
 * (explicit path, then `OHOS_PERF_EMULATOR`, then `.emu_config`, then the
 * built-in common paths). Passing an empty object is the common case.
 */
export interface EmulatorTargetOptions {
  emulatorPath?: string;
  instancePath?: string;
  imageRoot?: string;
}

/** The emulator operations the CLI drives, injected so tests never spawn a binary. */
export interface EmulatorDeps {
  list(opts: EmulatorTargetOptions): Promise<EmulatorInstance[]>;
  start(
    name: string,
    opts: EmulatorTargetOptions & { timeoutMs?: number },
  ): Promise<EmulatorStartResult>;
  stop(name: string, opts: EmulatorTargetOptions): Promise<EmulatorStopResult>;
  create(req: CreateEmulatorRequest & EmulatorTargetOptions): Promise<EmulatorInstance>;
}

/** Everything the commands touch, injected so the module performs no IO itself. */
export interface CliDeps {
  doctor: DoctorDeps;
  /**
   * Resolve the capability matrix (used by `caps`).
   *
   * `target` is the explicit hdc id; omitted, the first connected target is
   * probed. It is optional so an existing injected fake stays valid.
   */
  capsReport(target?: string): Promise<CapsReport>;
  /** Analyze a scene directory. Throws on any failure; the caller maps it to exit 1. */
  analyze(sceneDir: string, app?: string): Promise<AnalyzeOutput>;
  /** Capture a scene. Throws on any failure; the caller maps it to exit 1. */
  collect(req: CollectRequest): Promise<CollectOutput>;
  /** Inject one UI gesture. Throws on any failure; the caller maps it to exit 1. */
  gesture(req: GestureRequest): Promise<GestureResult>;
  /** Run one named drill-down query against a scene. */
  query(req: QueryRequest): Promise<NamedQueryResult>;
  /** The named query definitions, for `tools`. */
  tools(): NamedQueryInfo[];
  /** Compare two analyses. Throws on any failure; the caller maps it to exit 1. */
  compare(req: CompareRequest): Promise<BaselineComparison>;
  /** Compare two captures by UI tree and screenshot, writing the diff bundle. */
  uiCompare(req: UiCompareRequest): Promise<UiCompareOutput>;
  /** Analyze a scene and write the report bundle. Throws on any failure. */
  report(req: ReportRequest): Promise<ReportOutput>;
  /** Aggregate two or more saved reports into one trend page. */
  trend(req: TrendRequest): Promise<TrendOutput>;
  /** Re-render a saved bundle from its `report.json`. */
  render(req: RenderRequest): Promise<RenderOutput>;
  /**
   * Inspect a HAP on disk. Throws on any failure; the caller maps it to exit 1.
   *
   * Reads the file, so an unreadable path fails here rather than in the action.
   */
  hap(req: HapRequest): Promise<HapOutput>;
  /** HarmonyOS emulator lifecycle. Throws on any failure; the caller maps it to exit 1. */
  emulator: EmulatorDeps;
  /** Run a scenario. Throws on any failure; the caller maps it to exit 1. */
  run(req: RunRequest): Promise<RunResult>;
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
export async function runDoctor(
  deps: CliDeps,
  opts: { json?: boolean; target?: string },
): Promise<CliResult> {
  const report = await doctorReport(deps.doctor, opts.target);
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
export async function runCaps(
  deps: CliDeps,
  opts: { json?: boolean; target?: string },
): Promise<CliResult> {
  const report = await deps.capsReport(opts.target);
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
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Capture a scene.
 *
 * As with `analyze`, any failure is exit 1 with an empty stdout: a half-written
 * JSON document would be worse than none. `--json` reports the absolute scene
 * directory, the device identity the capture used, which collectors ran and
 * what each captured.
 *
 * The human summary prints one line per fact that exists. `hiperf 0` is printed
 * explicitly: an idle app producing no samples is a real capture and the reader
 * must see the zero rather than infer it from a missing line.
 */
export async function runCollect(
  deps: CliDeps,
  req: CollectRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.collect(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    let stdout = `scene  ${result.sceneDir}\n`;
    if (result.collectors.length > 0) {
      stdout += `collectors  ${result.collectors.join(', ')}\n`;
    }
    const samples = [
      ...(result.hiperf === undefined ? [] : [`hiperf ${result.hiperf.samples}`]),
      ...(result.hidumper === undefined ? [] : [`hidumper ${result.hidumper.frames}`]),
      ...(result.ui === undefined ? [] : [`ui ${result.ui.nodes}`]),
      ...(result.screenshot === undefined
        ? []
        : [`screenshot ${result.screenshot.width}x${result.screenshot.height}`]),
    ];
    if (samples.length > 0) stdout += `samples  ${samples.join(', ')}\n`;
    // A symbolized capture and an unsymbolized one look identical until the
    // frames are read, so the run says which one it produced.
    if (result.soDir !== undefined) stdout += `symbols  ${result.soDir}\n`;
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Human summary of one gesture.
 *
 * "accepted" is backed by the device tool's `No Error` marker, not by the
 * host exit code (measured to be 0 even when the device refuses). It means the
 * injection was accepted, not that a widget reacted.
 */
function gestureSummary(gesture: Gesture): string {
  switch (gesture.action) {
    case 'click':
      return `click ${gesture.x} ${gesture.y}`;
    case 'swipe': {
      const velocity = gesture.velocity === undefined ? '' : ` (velocity ${gesture.velocity})`;
      return `swipe ${gesture.fromX},${gesture.fromY} -> ${gesture.toX},${gesture.toY}${velocity}`;
    }
    case 'key':
      return `key ${gesture.key}`;
    case 'inputText':
      return `input ${gesture.x} ${gesture.y} ${JSON.stringify(gesture.text)}`;
    case 'text':
      return `text ${JSON.stringify(gesture.text)}`;
  }
}

/**
 * Inject one gesture.
 *
 * `--json` emits the core result (`{ gesture, output }`), where `output` is
 * the device tool's own success line. Any failure is exit 1 with an empty
 * stdout, like every other command.
 */
export async function runGesture(
  deps: CliDeps,
  req: GestureRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.gesture(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    return { stdout: `${gestureSummary(req.gesture)} accepted\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Run one named drill-down query.
 *
 * Human output is one summary line (`name  returned/total rows`) followed by
 * one compact JSON row per line; `--json` is the exact API structure. Any
 * failure is exit 1 with an empty stdout, like `analyze` and `collect`.
 */
export async function runQuery(
  deps: CliDeps,
  req: QueryRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.query(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    const summary = `${result.query}  ${result.rows.length}/${result.total} rows` +
      `${result.truncated ? ' (truncated)' : ''}\n`;
    const rows = result.rows.map((row) => JSON.stringify(row) + '\n').join('');
    return { stdout: summary + rows, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/** The statuses in the order the totals line prints them. */
const DELTA_ORDER: readonly DeltaStatus[] = [
  'improved', 'regressed', 'unchanged', 'added', 'removed', 'incomparable',
];

/** `40 -> 30` or `- -> 5`; a missing side is an em dash-free `-`. */
function compareValues(row: BaselineComparison['rows'][number]): string {
  const show = (value: number | string | null): string => (value === null ? '-' : String(value));
  return `${show(row.baseline)} -> ${show(row.current)}`;
}

/**
 * Compare a current analysis against a baseline.
 *
 * Human output is one line per metric plus a totals line, so a reader can see
 * both what changed and how much of the report fell into each bucket. The
 * percentage is omitted when it cannot be computed (a zero baseline, an added
 * or removed metric) rather than printed as `NaN%` or `Infinity%`.
 *
 * `--json` emits the whole {@link BaselineComparison}, which is what an agent
 * consumes. Any failure is exit 1 with an empty stdout, like the other
 * commands: a half-written JSON document is worse than none.
 */
export async function runCompare(
  deps: CliDeps,
  req: CompareRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const comparison = await deps.compare(req);
    if (opts.json) return { stdout: json(comparison), stderr: '', exitCode: 0 };

    const rows = comparison.rows.map((row) => {
      const pct = row.deltaPct === undefined ? '' : `  (${row.deltaPct}%)`;
      return `${row.id}  ${compareValues(row)}${pct}  ${row.status}\n`;
    });
    const totals = DELTA_ORDER.map((status) => `${status} ${comparison.totals[status]}`)
      .join(', ');
    return { stdout: rows.join('') + `totals  ${totals}\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Compare two captures by UI tree and screenshot.
 *
 * Exit 0 whenever the comparison was made, including identical screens: "no
 * differences" is a successful answer, and a caller scripting `ui-compare` in a
 * loop must not read it as a failure. Exit 1 means it could not be made (a
 * missing artifact on one side, a size mismatch, an unreadable PNG).
 *
 * Human output is one line per difference class, then the two image numbers,
 * then the artifacts written. `--json` prints the full `UiDiff`; the files are
 * written either way, because the marked PNGs are the point of the command.
 */
export async function runUiCompare(
  deps: CliDeps,
  req: UiCompareRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.uiCompare(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    const lines: string[] = [];
    if (result.tree === null) {
      lines.push('tree  not compared (no ui.json on either side)\n');
    } else {
      lines.push(
        `tree  ${result.tree.added} added, ${result.tree.removed} removed,` +
          ` ${result.tree.changed} changed, ${result.tree.unchanged} unchanged\n`,
      );
    }
    if (result.image === null) {
      lines.push('image  not compared (no screenshot.png on either side)\n');
    } else {
      lines.push(
        `image  similarity ${result.image.similarity}` +
          ` (hamming ${result.image.hamming}/64),` +
          ` changed ${result.image.changedRatio}` +
          ` at tolerance ${result.image.tolerance}\n`,
      );
    }
    lines.push(`regions  ${result.regions}\n`);
    if (result.image === null) {
      lines.push('animations  not measured (no screenshots on either side)\n');
    } else {
      lines.push(
        `animations  ${result.animations} labelled, ${result.pixelOnly} pixel-only,` +
          ` ${result.unmeasuredRegions} unmeasured\n`,
      );
    }
    for (const line of result.degraded) lines.push(`degraded  ${line}\n`);
    lines.push(`wrote  ${result.files.join(', ')} in ${result.outDir}\n`);
    return { stdout: lines.join(''), stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Analyze a scene and write the report bundle.
 *
 * Human output names the HTML entry point first, then the artifact list, the
 * section counts and the totals. The section line distinguishes measured from
 * degraded sections — a report that silently dropped a section would be worse
 * than one that names it. The comparison line appears only with `--baseline`.
 *
 * `--json` emits the manifest (paths and counts), not the report itself: the
 * report document is `report.json` on disk, and printing it again would
 * double-write a potentially large document.
 */
export async function runReport(
  deps: CliDeps,
  req: ReportRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.report(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    const sections =
      result.sections.degraded === 0
        ? `sections  ${result.sections.total} measured\n`
        : `sections  ${result.sections.measured} measured, ${result.sections.degraded} degraded\n`;
    const comparison =
      result.comparison === undefined
        ? ''
        : `comparison  ${DELTA_ORDER.map(
            (status) => `${status} ${result.comparison![status]}`,
          ).join(', ')}\n`;
    return {
      stdout:
        `report  ${result.outDir}/report.html\n` +
        `artifacts  ${result.files.join(' ')}\n` +
        sections +
        `totals    ${result.metrics} metrics, ${result.evidence} evidence ` +
        `(info ${result.bySeverity.info}, warn ${result.bySeverity.warn}, ` +
        `critical ${result.bySeverity.critical})\n` +
        comparison,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Aggregate saved reports into one trend page.
 *
 * HapRay's multi-version page asks a human to filter by app and version after
 * loading the files, because its page has no model to refuse with. Here the
 * refusal happens before anything is read: fewer than two reports is an
 * invocation error, and the aggregation itself refuses runs from different
 * apps or under a duplicate label.
 *
 * The human line states how the runs were ordered — a reader has to know
 * whether the x axis is time or argument order before reading movement into
 * it — and separates the series that carry a verdict from those that cannot.
 */
export async function runTrend(
  deps: CliDeps,
  req: TrendRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  if (req.reports.length < 2) {
    return {
      stdout: '',
      stderr:
        `trend needs at least two reports; got ${req.reports.length}. ` +
        'A trend of one is a report — use `report` for a single run.\n',
      exitCode: 1,
    };
  }

  try {
    // Name each run before the IO layer sees it: a page whose points are
    // labelled with nothing cannot be read, and the path is the one name the
    // caller certainly supplied.
    const result = await deps.trend({
      ...req,
      reports: req.reports.map((report) => ({
        label: report.label ?? report.path,
        path: report.path,
      })),
    });
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };

    const order =
      result.orderedBy === 'startedAtNs'
        ? 'ordered by capture start time'
        : 'ordered by argument (a run has no capture start time)';
    return {
      stdout:
        `trend  ${result.outDir}/trend.html\n` +
        `artifacts  ${result.files.join(' ')}\n` +
        `runs  ${result.runs.length} (${result.runs.map((run) => run.label).join(', ')})` +
        ` · ${order}\n` +
        `series  ${result.series} metrics · ${result.improved} improved,` +
        ` ${result.regressed} regressed, ${result.unchanged} unchanged,` +
        ` ${result.verdictless} without a known direction,` +
        ` ${result.unmeasured} not measured\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Re-render a saved bundle from its `report.json`.
 *
 * This is HapRay's `update` with the re-analysis removed. HapRay re-runs the
 * whole pipeline, so an old report becomes a function of today's code; here
 * the saved model is the input, so the page a reader saved is the page they
 * get back. The source line says so explicitly — a reader who expected a
 * fresh analysis should see that none happened.
 */
export async function runRender(
  deps: CliDeps,
  req: RenderRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.render(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    return {
      stdout:
        `report  ${result.outDir}/report.html\n` +
        `artifacts  ${result.files.join(' ')}\n` +
        `sections  ${result.sections} · ${result.metrics} metrics · ` +
        `${result.evidence} evidence\n` +
        `source  ${req.report} (re-rendered, not re-analyzed)\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Inspect a HAP on disk, without a device.
 *
 * The path is checked here, before the IO layer sees it: a typo or a `.txt`
 * named `app.hap` is an invocation error, not an analysis failure, and saying
 * so costs no file read. Human output is one line per fact — the package
 * block, the totals, one line per technology naming its rule, the duplicate
 * and oversized counts, and the largest files.
 */
export async function runHap(
  deps: CliDeps,
  req: HapRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  const pathError = packagePathError(req.packagePath);
  if (pathError !== undefined) return { stdout: '', stderr: `${pathError}\n`, exitCode: 1 };

  try {
    const result = await deps.hap(req);
    if (opts.json) {
      // The document `hap.json` writes, plus the capability row. The caller's
      // `outDir` stays out: it belongs to the invocation, not the package.
      return {
        stdout: json({ analysis: result.analysis, capabilities: result.capabilities }),
        stderr: '',
        exitCode: 0,
      };
    }

    const analysis = result.analysis;
    const app = analysis.package;
    const identity = [app.bundleName === '' ? '' : app.bundleName, app.versionName]
      .filter((part) => part !== '')
      .join(' ');
    const version = app.versionCode === 0 ? '' : ` (${app.versionCode})`;
    const label = app.appName === '' ? '' : `  ${app.appName}`;
    let stdout = `package  ${app.name}${identity === '' ? '' : `  ${identity}${version}`}${label}\n`;
    stdout +=
      `files    ${analysis.totals.files}, ${analysis.totals.size} bytes ` +
      `(${analysis.totals.compressedSize} compressed)\n`;
    stdout += analysis.technologies.length === 0
      ? 'tech     none detected\n'
      : analysis.technologies
          .map(
            (entry) =>
              `tech     ${entry.type} (rule ${entry.ruleId})  ` +
              `${entry.files.length} file(s), ${entry.bytes} bytes\n`,
          )
          .join('');
    const wasted = analysis.duplicates.reduce((sum, group) => sum + group.wastedBytes, 0);
    stdout += `duplicates  ${analysis.duplicates.length} group(s), ${wasted} bytes wasted\n`;
    stdout += `oversized  ${analysis.oversized.length} file(s)\n`;
    if (analysis.largest.length > 0) {
      stdout += `largest  ${analysis.largest.map((file) => `${file.path}  ${file.size} bytes`).join('\n         ')}\n`;
    }
    if (result.outDir !== undefined && result.artifacts !== undefined) {
      stdout += `wrote    ${result.artifacts.join(', ')} in ${result.outDir}\n`;
    }
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/** Why a path cannot be a package, or `undefined` when it can. */
function packagePathError(packagePath: string): string | undefined {
  let stats;
  try {
    stats = statSync(packagePath);
  } catch {
    return `no such package: ${packagePath}`;
  }
  if (!stats.isFile()) return `not a file: ${packagePath}`;
  const dot = packagePath.lastIndexOf('.');
  const extension = dot <= 0 ? '' : packagePath.slice(dot + 1).toLowerCase();
  if (extension !== 'hap' && extension !== 'hsp' && extension !== 'zip') {
    return `not a package (expected .hap, .hsp or .zip): ${packagePath}`;
  }
  return undefined;
}

/**
 * Read, validate and run a scenario.
 *
 * Reading and validating happen here, not in `deps.run`, so an invalid
 * document fails without a device being resolved — the property the tests
 * pin by observing that `deps.run` was never called.
 *
 * Human output is one line per step (`ok|failed  <id>  round <n>  <scene>`)
 * plus a summary; the exit code is 1 when any step failed, because a caller
 * scripting this run must not read a failed step as a completed one. A step
 * failure is a result, not an invocation error, so stderr stays empty.
 */
export async function runScenarioCommand(
  deps: CliDeps,
  input: RunInput,
  opts: { json?: boolean },
): Promise<CliResult> {
  if (input.casesDir !== undefined) {
    if (input.scenarioPath !== '') {
      return {
        stdout: '',
        stderr: 'run: give either a scenario file or --cases <dir>, not both\n',
        exitCode: 1,
      };
    }
    return runCases(deps, input, opts);
  }

  let scenario: Scenario;
  try {
    let text: string;
    try {
      text = readFileSync(input.scenarioPath, 'utf8');
    } catch (err) {
      throw new OhosPerfError(
        `cannot read scenario ${input.scenarioPath}: ${safeMessage(err)}`,
        { code: 'SCENARIO_UNREADABLE', cause: err },
      );
    }
    scenario = parseScenario(text);
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}
`, exitCode: 1 };
  }

  try {
    const result = await deps.run({
      scenario,
      scenarioPath: input.scenarioPath,
      outDir: input.outDir,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
      ...(input.only === undefined ? {} : { only: input.only }),
      ...(input.keepGoing === true ? { keepGoing: true } : {}),
    });
    if (opts.json) {
      return {
        stdout: json(result),
        stderr: '',
        exitCode: result.status === 'failed' ? 1 : 0,
      };
    }

    const ok = result.steps.filter((step) => step.status === 'ok').length;
    const failed = result.steps.length - ok;
    const lines = result.steps.map((step) => {
      const scene = step.sceneDir === undefined ? '' : `  ${step.sceneDir}`;
      const error = step.status === 'ok' ? '' : `  ${step.error ?? 'failed'}`;
      return `${step.status === 'ok' ? 'ok    ' : 'failed'}  ${step.id}` +
        `  round ${step.round}${scene}${error}`;
    });
    const summary = failed === 0
      ? `steps ${ok}/${result.steps.length} ok`
      : `steps ${ok}/${result.steps.length} ok, ${failed} failed`;
    return {
      stdout: `${lines.map((line) => `${line}
`).join('')}${summary}
`,
      stderr: '',
      exitCode: result.status === 'failed' ? 1 : 0,
    };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}
`, exitCode: 1 };
  }
}

/** One case's verdict, as `cases.json` records it. */
interface CaseOutcome {
  readonly id: string;
  readonly status: 'ok' | 'failed';
  /**
   * The case's directory, relative to the `--out` the index sits in — the case
   * id, which is also the directory's name. Relative because this is a
   * document: an absolute path would make two identical runs differ by
   * checkout location. Absent when the case never ran.
   */
  readonly outDir?: string;
  readonly error?: string;
  /** The run's own summary, when it ran. */
  readonly steps?: { readonly ok: number; readonly total: number };
}

/** The `cases.json` document: every case in name order, with its verdict. */
interface CasesIndex {
  readonly version: 1;
  readonly cases: readonly CaseOutcome[];
}

/**
 * Run a directory of scenarios as one suite.
 *
 * Each case gets its own run directory under `--out`, so `steps.json` and the
 * scenes stay exactly what a single run produces. The index is written even
 * when a case fails: a suite's most useful artifact is the list of what did
 * and did not pass.
 *
 * A malformed case file fails that case and does not stop the suite — one
 * typo must not hide the other results — and the exit code is 1 when any case
 * failed, which is the only thing a caller has to check.
 */
async function runCases(
  deps: CliDeps,
  input: RunInput,
  opts: { json?: boolean },
): Promise<CliResult> {
  let loads;
  try {
    loads = loadCases(discoverCases(input.casesDir!, input.filter));
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }

  const outcomes: CaseOutcome[] = [];
  for (const load of loads) {
    if (load.scenario === undefined) {
      outcomes.push({
        id: load.id,
        status: 'failed',
        error: load.error ?? 'the case could not be read',
      });
      continue;
    }
    const caseOut = join(input.outDir, load.id);
    try {
      const result = await deps.run({
        scenario: load.scenario,
        scenarioPath: load.path,
        outDir: caseOut,
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
        ...(input.only === undefined ? {} : { only: input.only }),
        ...(input.keepGoing === true ? { keepGoing: true } : {}),
      });
      const ok = result.steps.filter((step) => step.status === 'ok').length;
      outcomes.push({
        id: load.id,
        status: result.status === 'failed' ? 'failed' : 'ok',
        outDir: load.id,
        steps: { ok, total: result.steps.length },
        ...(result.status === 'failed'
          ? { error: firstFailure(result) ?? 'the run reported failure' }
          : {}),
      });
    } catch (err) {
      // A case that could not reach a device at all is that case's failure,
      // not the suite's: the next case may be the one that matters. `outDir`
      // is recorded only when the run got far enough to create it — naming a
      // directory that was never written sends a reader to nothing.
      outcomes.push({
        id: load.id,
        status: 'failed',
        ...(existsSync(caseOut) ? { outDir: load.id } : {}),
        error: safeMessage(err),
      });
    }
  }

  const index: CasesIndex = { version: 1, cases: outcomes };
  try {
    mkdirSync(input.outDir, { recursive: true });
    writeFileSync(join(input.outDir, 'cases.json'), `${JSON.stringify(index, null, 2)}\n`);
  } catch (err) {
    return {
      stdout: '',
      stderr: `cannot write cases.json: ${safeMessage(err)}\n`,
      exitCode: 1,
    };
  }

  const failed = outcomes.filter((entry) => entry.status === 'failed').length;
  const exitCode = failed === 0 ? 0 : 1;
  if (opts.json) {
    return { stdout: `${JSON.stringify(index, null, 2)}\n`, stderr: '', exitCode };
  }

  const lines = outcomes.map((entry) => {
    const steps = entry.steps === undefined
      ? ''
      : `  steps ${entry.steps.ok}/${entry.steps.total} ok`;
    const error = entry.status === 'ok' ? '' : `  ${entry.error ?? 'failed'}`;
    return `${entry.status === 'ok' ? 'ok    ' : 'failed'}  ${entry.id}${steps}${error}`;
  });
  const summary = failed === 0
    ? `cases ${outcomes.length}/${outcomes.length} ok`
    : `cases ${outcomes.length - failed}/${outcomes.length} ok, ${failed} failed`;
  return {
    stdout: `${lines.map((line) => `${line}\n`).join('')}${summary}\n`,
    stderr: '',
    exitCode,
  };
}

/** The first failed step's error, for the case summary. */
function firstFailure(result: RunResult): string | undefined {
  return result.steps.find((step) => step.status === 'failed')?.error;
}

/**
 * List the named queries an agent can call.
 *
 * `--json` emits the same `{ name, description, args, returns }` objects the
 * registry exposes, so a skill adapter can turn them into tool definitions
 * without parsing prose.
 */
export function runTools(deps: CliDeps, opts: { json?: boolean }): CliResult {
  try {
    const tools = deps.tools();
    if (opts.json) return { stdout: json(tools), stderr: '', exitCode: 0 };

    const lines = tools.map((tool) => {
      const args = tool.args
        .map((arg) => (arg.required ? arg.name : `${arg.name}?`))
        .join(', ');
      return `${tool.name}(${args})  -> ${tool.returns}\n  ${tool.description}\n`;
    });
    return { stdout: lines.join(''), stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Narrow an options bag to just the target fields.
 *
 * The runners also carry `json` and `timeoutMs`; spreading the whole bag into
 * `deps.emulator.*` would hand core an object it does not expect, and a fake
 * asserting on what it received would see them. Building the object field by
 * field keeps the seam to exactly {@link EmulatorTargetOptions}.
 */
function targetsOf(opts: EmulatorTargetOptions): EmulatorTargetOptions {
  return {
    ...(opts.instancePath === undefined ? {} : { instancePath: opts.instancePath }),
    ...(opts.imageRoot === undefined ? {} : { imageRoot: opts.imageRoot }),
    ...(opts.emulatorPath === undefined ? {} : { emulatorPath: opts.emulatorPath }),
  };
}

/**
 * List emulator instances.
 *
 * The table pads every column to the widest value it holds, the same way
 * `formatCapabilities` does, so a reader can scan down a column. A missing
 * target is an em dash rather than a blank: "not running" and "running but
 * not attributable" both leave the cell empty, and a blank cell reads as a
 * formatting bug. `--json` emits the core instances verbatim under an
 * `instances` key so a consumer never has to strip a header row.
 */
export async function runEmulatorList(
  deps: CliDeps,
  opts: EmulatorTargetOptions & { json?: boolean },
): Promise<CliResult> {
  try {
    const instances = await deps.emulator.list(targetsOf(opts));
    if (opts.json) return { stdout: json({ instances }), stderr: '', exitCode: 0 };
    if (instances.length === 0) return { stdout: 'no emulator instances\n', stderr: '', exitCode: 0 };

    const rows = instances.map((instance) => [
      instance.name,
      instance.running ? 'yes' : 'no',
      instance.target ?? '—',
      instance.apiVersion ?? '—',
      instance.osVersion ?? '—',
    ]);
    const header = ['NAME', 'RUNNING', 'TARGET', 'API', 'IMAGE'];
    // Widths include the header: a header wider than every value must not be
    // padded away, or the columns stop lining up.
    const widths = header.map((cell, column) =>
      Math.max(cell.length, ...rows.map((row) => row[column].length)));
    const line = (cells: string[]): string =>
      cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd();
    const body = [header, ...rows].map((cells) => line(cells) + '\n').join('');
    return { stdout: body, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Start an emulator instance and wait for it to boot.
 *
 * `alreadyRunning` is reported as such, without a boot time: the wait did not
 * happen, and printing `booted in 0s` would claim a measurement that was never
 * taken.
 */
export async function runEmulatorStart(
  deps: CliDeps,
  name: string,
  opts: EmulatorTargetOptions & { timeoutMs?: number; json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.emulator.start(name, {
      ...targetsOf(opts),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    const line = result.alreadyRunning
      ? `${result.name} was already running on ${result.target}\n`
      : `${result.name} started on ${result.target}` +
        ` (booted in ${Math.round(result.waitedMs / 1000)}s)\n`;
    return { stdout: line, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Stop an emulator instance.
 *
 * A no-op stop is a success: the postcondition the caller asked for holds.
 * The wording still distinguishes it from a stop that actually ran, so a
 * script's log does not suggest a state change that never happened.
 */
export async function runEmulatorStop(
  deps: CliDeps,
  name: string,
  opts: EmulatorTargetOptions & { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.emulator.stop(name, targetsOf(opts));
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    const line = result.wasRunning
      ? `${result.name} stopped\n`
      : `${result.name} was not running\n`;
    return { stdout: line, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

/**
 * Create an emulator instance.
 *
 * The human line names the device type and OS version because the instance
 * name alone does not say what was created, and prints the instance path
 * because that is the directory a later `--instance-path` needs.
 */
export async function runEmulatorCreate(
  deps: CliDeps,
  req: CreateEmulatorRequest & EmulatorTargetOptions,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const instance = await deps.emulator.create(req);
    if (opts.json) return { stdout: json(instance), stderr: '', exitCode: 0 };
    const line = `Created ${instance.name} (${req.deviceType}, ${req.osVersion})` +
      ` at ${instance.instancePath}\n`;
    return { stdout: line, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };
  }
}

export type { DoctorDeps };
