import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BinderQuery,
  CallstackQuery,
  CapabilityMatrix,
  EmulatorClient,
  EmulatorLifecycle,
  FrameQuery,
  Hdc,
  InstantQuery,
  MemMeasureQuery,
  OhosPerfError,
  PerfQuery,
  ProcessQuery,
  SchedQuery,
  StartupQuery,
  Streamer,
  ThreadQuery,
  ThreadStateQuery,
  connect,
  createSceneLayout,
  deviceExplorationHost,
  explore,
  decodePng,
  defaultAnalyzers,
  ingestScene,
  lookupQuery,
  queryDefinitions,
  readHidumperCapture,
  readProcfsSamples,
  readHilogText,
  parseHilogText,
  analyzeHap,
  buildReport,
  buildTrend,
  compareResults,
  compareSceneDirs,
  UI_DIFF_FILES,
  renderEvidenceCsv,
  renderMetricsCsv,
  renderReportHtml,
  renderReportJson,
  renderReportXlsx,
  renderSummaryJson,
  renderBundle,
  renderTrendHtml,
  renderTrendJson,
  trendRunFromReport,
  renderFlamegraphHtml,
  renderFlamegraphSvg,
  FLAMEGRAPH_FILES,
  hapSection,
  analyzeBinaries,
  extractBinaries,
  httpAgentModel,
  readAgentConfig,
  runAgent,
  recoverSymbols,
  measureNaming,
  readSceneMetadata,
  readUiTree,
  resolveAppIdentity,
  ScenarioRunner,
  resolveQueryLimit,
  runAnalyzerSections,
  runNamedQuery,
  summarizeReport,
  unknownQueryError,
  type AnalyzerRun,
  type AppIdentity,
  type AnalyzeResult,
  type CapabilityId,
  type CapabilityState,
  type Gesture,
  type GestureResult,
  type NamedQueryInfo,
  type HidumperCapture,
  type HilogLine,
  type ProcfsSample,
  type TimeRange,
  type FoldedStack,
  type RgbaImage,
  type UiNode,
  type ExplorationClock,
  type AgentModel,
  type Scene,
  type SceneLayout,
  type SceneMetadata,
  type ReportModel,
} from '@ohos-perf/core';
import {
  safeMessage, type CliDeps, type DoctorDeps, type EmulatorDeps, type EmulatorTargetOptions,
} from './commands';

const here = dirname(fileURLToPath(import.meta.url));

/** The manifest that `packageVersion()` reads, resolved relative to this module. */
export const manifestPath = join(here, '../package.json');

/**
 * Read the version from the package manifest so it cannot drift.
 *
 * `here` is `src/` when tests run from source and `dist/` after bundling;
 * `package.json` sits one level above both, so `../package.json` is correct
 * in either case and does not depend on the cwd the CLI is invoked from.
 *
 * `path` is injectable only so a test can point at a manifest with a
 * different version and prove this function actually reads a file.
 */
export function packageVersion(path: string = manifestPath): string {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    // An empty or whitespace-only version is metadata we do not have: printing
    // it would make `--version` emit a blank line and still exit 0.
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return version === '' ? '0.0.0' : version;
  } catch {
    // A missing or malformed manifest must not make the CLI unusable:
    // the version is metadata, and `--help`/`doctor` still work without it.
    return '0.0.0';
  }
}

/** The pieces of production wiring that tests need to replace. */
export interface RealDepsOverrides {
  /** hdc locator, used by both `doctor` and the `caps` gate. */
  hdc?: { resolvePath(): Promise<string> };
  /** Device probe, shared by `doctor` and `caps`; receives the explicit target. */
  connectDevice?: (target?: string) => Promise<{
    id: string;
    kind: string;
    abi: string;
    capabilities(): Promise<{ all(): CapabilityState[] }>;
  }>;
  /** Scene ingestion; replaced in tests to observe the layout without a converter. */
  ingest?: (streamer: Streamer, layout: SceneLayout) => Promise<Scene>;
  /** Device used by `collect`; replaced in tests to avoid a real capture. */
  collectDevice?: (target?: string) => Promise<{
    id: string;
    kind: string;
    collect(opts: unknown): Promise<{ ingest(): Promise<Scene> }>;
  }>;
  /** Device used by `gesture`; replaced in tests to avoid touching a device. */
  gestureDevice?: (target?: string) => Promise<{
    id: string;
    gesture(g: Gesture): Promise<GestureResult>;
  }>;
  /** Device used by `explore`; replaced in tests to avoid touching a device. */
  exploreDevice?: (target?: string) => Promise<{
    id: string;
    kind: string;
    uiTree(): Promise<readonly UiNode[]>;
    gesture(g: Gesture): Promise<GestureResult>;
  }>;
  /** Clock for `explore`'s settle loop; replaced in tests so no test sleeps. */
  exploreClock?: ExplorationClock;
  /**
   * The model client `agent` drives the app with. Replaced in tests so no test
   * opens a socket; the real one is built from the environment at call time.
   */
  agentModel?: (name?: string) => AgentModel;
  /** Device used by `agent`; replaced in tests to avoid touching a device. */
  agentDevice?: (target?: string) => Promise<{
    id: string;
    kind: string;
    uiTree(): Promise<readonly UiNode[]>;
    gesture(g: Gesture): Promise<GestureResult>;
  }>;
}

/** At most this many bytes are shown to a model; a long body is truncated. */
const HEX_DUMP_LIMIT = 512;

/** A function body as hex words, one instruction per line, for a model prompt. */
function hexDump(bytes: Uint8Array): string {
  if (bytes.length === 0) return '(the symbol points outside .text, so no bytes are available)';
  const lines: string[] = [];
  for (let at = 0; at + 4 <= Math.min(bytes.length, HEX_DUMP_LIMIT); at += 4) {
    const word = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
    lines.push(`+${at.toString(16).padStart(4, '0')}  ${word.toString(16).padStart(8, '0')}`);
  }
  if (bytes.length > HEX_DUMP_LIMIT) lines.push(`(${bytes.length - HEX_DUMP_LIMIT} more bytes)`);
  return lines.join('\n');
}

/** The empty probe an offline capability state carries (no device was asked). */
const OFFLINE_PROBE = (): CapabilityState['probe'] =>
  ({ command: '', stdout: '', stderr: '', code: 0 });

/** An available state in the offline matrix, with the exact probe shape. */
function offlineState(
  id: CapabilityId,
  collector: 'hitrace' | 'procfs' | 'hiperf' | 'hidumper' | 'uitest' | 'hiprofiler' | 'hilog',
): CapabilityState {
  return {
    id,
    available: true,
    collector,
    fidelity: 'exact',
    probe: OFFLINE_PROBE(),
  };
}

/**
 * The tables each analyzer actually reads without a `hasTable` guard.
 *
 * A capability declared for a trace that lacks one of these tables turns a
 * degradation into a crash, and a crash is not the documented answer to
 * missing input: the engine's whole point is that an unsupported signal
 * becomes a `degraded` proxy. So a capability is available only when every
 * table behind it is present. `procfs.jsonl` is a scene artifact, not a table
 * (see {@link offlineCapabilities}).
 */
/**
 * The scene artifacts an offline analysis can read, already parsed and already
 * gated on `scene.json`'s `capture.collectors`.
 *
 * They are not database tables, so the matrix cannot discover them from
 * `sqlite_master`; the caller passes what it read, and a capability is claimed
 * only when the artifact actually yielded data.
 */
export interface SceneArtifacts {
  /** Valid `/proc` samples; empty when the capture did not sample memory. */
  procfsSamples?: readonly unknown[];
  /** A parsed `hidumper.json` (exactly two snapshots); absent when unreadable. */
  hidumper?: HidumperCapture;
  /** Flattened UI nodes; absent when the scene carried no trusted `ui.json`. */
  uiTree?: readonly unknown[];
  /** A decoded `screenshot.png`; absent when the scene carried none. */
  screenshot?: RgbaImage;
  /** Parsed log rows; absent when the scene carried no trusted `hilog.log`. */
  hilog?: readonly unknown[];
}

const TABLE_RULES: ReadonlyArray<{
  id: CapabilityId;
  collector: 'hitrace' | 'procfs' | 'hiperf' | 'hidumper' | 'uitest' | 'hiprofiler' | 'hilog';
  /** Every listed table must be present. */
  tables?: readonly string[];
  /**
   * One of these table families must be present. Two collectors satisfy
   * `mem.native_hook`: the memory plugin (`process_measure*`) and the
   * nativehook plugin (`native_hook*`), so requiring a single family would
   * leave the analyzer unreachable through one of its own captures.
   */
  anyOf?: ReadonlyArray<readonly string[]>;
  /**
   * The rule's tables must live in the perf database, and the first must hold
   * at least one row: an empty `perf_sample` means no samples were ever
   * recorded, which is not a capability.
   */
  perf?: true;
}> = [
  { id: 'trace.frames', collector: 'hitrace', tables: ['frame_slice', 'process'] },
  { id: 'trace.sched', collector: 'hitrace', tables: ['sched_slice', 'instant'] },
  { id: 'trace.binder', collector: 'hitrace', tables: ['callstack', 'args', 'data_dict', 'process', 'thread', 'trace_range'] },
  { id: 'trace.thread_state', collector: 'hitrace', tables: ['thread_state', 'thread', 'process'] },
  // GC and component-build events are callstack rows scoped through thread and
  // process; without either join the analyzers would crash rather than degrade.
  { id: 'trace.ark', collector: 'hitrace', tables: ['callstack', 'thread', 'process'] },
  // VSync groups are `frame_slice` rows attributed through `process`; a trace
  // with one and not the other cannot scope the cadence to the app.
  { id: 'render.vsync', collector: 'hitrace', tables: ['frame_slice', 'process'] },
  // Scene artifacts, not tables: `procfs.jsonl`, `hidumper.json` and `ui.json`
  // are satisfied by the parsed artifact the caller passes in.
  { id: 'mem.procfs', collector: 'procfs', tables: ['procfs.jsonl'] },
  { id: 'render.fps_live', collector: 'hidumper', tables: ['hidumper.json'] },
  { id: 'ui.tree', collector: 'uitest', tables: ['ui.json'] },
  { id: 'ui.capture', collector: 'uitest', tables: ['screenshot.png'] },
  { id: 'hilog.stream', collector: 'hilog', tables: ['hilog.log'] },
  { id: 'perf.samples', collector: 'hiperf', tables: ['perf_sample'], perf: true },
  // `mem.native_hook` is the design's hiprofiler-memory row, and two plugins
  // feed it. The memory plugin's `process_measure` tables back `mem-measure`;
  // the nativehook plugin's `native_hook*` tables back `native-memory`. A
  // scene carries one family or the other, so requiring the memory tables
  // alone would degrade `native-memory` on the very capture
  // `--plugins nativehook` produces. Either family satisfies the row; the
  // analyzers that need a specific one degrade on their own with a reason
  // naming the missing input. An ftrace-only scene offers neither.
  {
    id: 'mem.native_hook',
    collector: 'hiprofiler',
    anyOf: [
      ['process_measure', 'process_measure_filter'],
      ['native_hook'],
    ],
  },
];

/** Whether one rule's table name is satisfied by the scene's artifacts. */
function artifactPresent(name: string, artifacts: SceneArtifacts): boolean {
  switch (name) {
    case 'procfs.jsonl':
      return (artifacts.procfsSamples?.length ?? 0) > 0;
    case 'hidumper.json':
      return artifacts.hidumper !== undefined;
    case 'ui.json':
      return (artifacts.uiTree?.length ?? 0) > 0;
    case 'screenshot.png':
      return artifacts.screenshot !== undefined;
    case 'hilog.log':
      return (artifacts.hilog?.length ?? 0) > 0;
    default:
      return false;
  }
}

/** Table names in the rules that are scene artifacts rather than DB tables. */
const ARTIFACT_NAMES = new Set([
  'procfs.jsonl', 'hidumper.json', 'ui.json', 'screenshot.png', 'hilog.log',
]);

/**
 * Build the offline capability matrix from what the scene actually contains.
 *
 * A CLI `analyze` has no device to probe, but the engine still needs to decide
 * which analyzers may run. Deriving availability from the trace database and
 * the scene's artifacts means a scene that carries them gets the analyzers,
 * while one that does not leaves the capability **absent** from the matrix:
 * `satisfies()` reports it as `capability not probed` and the engine emits a
 * degraded proxy instead of a fabricated zero.
 *
 * `procfs.jsonl`, `hidumper.json` and `ui.json` are artifacts, not database
 * tables, and are available only when the caller's parsed copy yields data.
 * The caller applies the scene.json gate first (absent file → trust it;
 * present but unreadable or not listing the collector → empty), so the file is
 * parsed once and a capability cannot be claimed for a capture that did not
 * produce it.
 */
export function offlineCapabilities(
  db: CapabilityMatrixDb,
  artifacts: SceneArtifacts,
  perfDb?: CapabilityMatrixDb,
): CapabilityMatrix {
  const tablesOf = (target: CapabilityMatrixDb): Set<string> => new Set(
    target.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name),
  );
  const tables = tablesOf(db);
  const perfTables = perfDb === undefined ? new Set<string>() : tablesOf(perfDb);

  const states: CapabilityState[] = [];
  for (const rule of TABLE_RULES) {
    const source = rule.perf === true ? perfTables : tables;
    const has = (name: string): boolean =>
      ARTIFACT_NAMES.has(name) ? artifactPresent(name, artifacts) : source.has(name);
    const present =
      rule.anyOf === undefined
        ? (rule.tables ?? []).every(has)
        : rule.anyOf.some((family) => family.every(has));
    if (!present) continue;
    // A table that exists but holds no rows is an empty capture, not a
    // capability: `perf_sample` is only real when at least one sample landed.
    if (rule.perf === true && perfDb !== undefined) {
      const first = rule.tables![0];
      if (perfDb.query(`SELECT 1 FROM ${first} LIMIT 1`).length === 0) continue;
    }
    states.push(offlineState(rule.id, rule.collector));
  }
  return new CapabilityMatrix(states);
}

/** The minimal database surface the offline matrix needs. */
export interface CapabilityMatrixDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** Everything opening a scene yields for an offline analysis or query. */
interface OpenedScene {
  scene: Scene;
  layout: SceneLayout;
  metadata?: SceneMetadata;
  samples: ProcfsSample[];
  app: AppIdentity;
  caps: CapabilityMatrix;
  /** The scene's flattened UI tree, when it carried a `ui.json`. */
  uiTree?: readonly UiNode[];
  /** The scene's decoded screenshot, when it carried a readable `screenshot.png`. */
  screenshot?: RgbaImage;
  /**
   * Why a `screenshot.png` that exists could not be decoded. Kept so the `ui`
   * analyzer reports the decoder's message instead of claiming no capture.
   */
  screenshotError?: string;
  /** The scene's render counters, when it carried a trusted `hidumper.json`. */
  hidumper?: HidumperCapture;
  /**
   * The scene's parsed log rows, when it carried a trusted `hilog.log`.
   * Parsing needs the capture year, which only `scene.json` supplies, so a
   * hand-built scene without metadata reads its lines as unparsed raw rows
   * rather than guessing a year.
   */
  hilog?: readonly HilogLine[];
  /**
   * The scene's raw `redundant_file.txt`, when it carried one. HapRay's
   * cold-start redundant-file I/O reads this file; nothing here produces it
   * yet, so it is read when present and its absence is a named `no_data`.
   */
  redundantFile?: string;
  /**
   * The scene's raw `coverageReport.json`, when it carried one. Written by an
   * instrumented build and the external `bjc` toolchain; this package reads it
   * and never produces it.
   */
  coverage?: string;
}

/** True when `path` exists and is a directory (a scene, not an `analyze --json` file). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The analysis context an opened offline scene yields. */
function analyzeContext(opened: OpenedScene) {
  const db = opened.scene.traceDb;
  return {
    db,
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    threads: new ThreadQuery(db),
    sched: new SchedQuery(db),
    instant: new InstantQuery(db),
    threadStates: new ThreadStateQuery(db),
    callstacks: new CallstackQuery(db),
    // A hiperf capture lives in its own converted database; the trace
    // database has no perf_* tables, so reading them from `db` would
    // silently report no samples.
    perf: new PerfQuery(opened.scene.perfDb ?? db),
    binder: new BinderQuery(db),
    startup: new StartupQuery(db),
    // memory-plugin writes an .htrace that converts into trace.db, so the
    // tables are in `db`, not in the separate perf database.
    memMeasure: new MemMeasureQuery(db),
    ...(opened.samples.length > 0 ? { procfs: opened.samples } : {}),
    ...(opened.uiTree === undefined ? {} : { ui: opened.uiTree }),
    ...(opened.screenshot === undefined ? {} : { screenshot: opened.screenshot }),
    ...(opened.screenshotError === undefined ? {} : { screenshotError: opened.screenshotError }),
    ...(opened.hidumper === undefined ? {} : { hidumper: opened.hidumper }),
    ...(opened.hilog === undefined ? {} : { hilog: [...opened.hilog] }),
    ...(opened.redundantFile === undefined ? {} : { redundantFile: opened.redundantFile }),
    ...(opened.coverage === undefined ? {} : { coverage: opened.coverage }),
    ...(opened.metadata !== undefined ? { metadata: opened.metadata } : {}),
    app: opened.app,
    // The whole database: a CLI run has no capture window to honour.
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER } as TimeRange,
    caps: opened.caps,
    deviceId: 'offline',
  };
}

/**
 * The window the report describes.
 *
 * `trace_range` is the trace's own claim about its span. When the table is
 * absent (a hand-built fixture), the report says "the whole capture" rather
 * than inventing a span; the renderers recognize `MAX_SAFE_INTEGER` for that.
 */
function sceneWindow(opened: OpenedScene): TimeRange {
  try {
    const rows = opened.scene.traceDb.query<{ start_ts: number | null; end_ts: number | null }>(
      'SELECT MIN(start_ts) AS start_ts, MAX(end_ts) AS end_ts FROM trace_range',
    );
    const row = rows[0];
    if (
      row !== undefined &&
      typeof row.start_ts === 'number' &&
      typeof row.end_ts === 'number' &&
      row.end_ts > row.start_ts
    ) {
      return { startNs: row.start_ts, endNs: row.end_ts };
    }
  } catch {
    // No trace_range: fall through to the whole-database marker.
  }
  return { startNs: 0, endNs: Number.MAX_SAFE_INTEGER };
}

/**
 * The inputs the flamegraph page needs that are not part of an analysis.
 *
 * Read while the scene is open, because the perf database is closed with it:
 * the folded stacks are the drawing's whole data set, and
 * `symbolizationRequested` is the scene's own statement about whether a
 * symbolizer was ever offered them.
 */
interface FlamegraphInputs {
  readonly stacks: FoldedStack[];
  /** `null` when the scene did not record whether symbolization was asked for. */
  readonly symbolizationRequested: boolean | null;
}

/** A section-aware analysis plus the scenario fields a report needs. */
interface DetailedAnalysis {
  run: AnalyzerRun;
  app: AppIdentity;
  device: string;
  window: TimeRange;
  startedAtNs?: number;
  /** The scene's screenshot dimensions, when it carried a readable one. */
  screenshot?: { width: number; height: number };
  /** The screenshot's source path, when it carried a readable one. */
  screenshotFile?: string;
  /** Present only when the caller asked for it and the scene had samples. */
  flamegraph?: FlamegraphInputs;
}

/**
 * Fold the scene's perf stacks, and read the scene's symbol-state claim.
 *
 * The thread set is derived exactly as `perfThreadIds` does for a query — the
 * app's pids, deduplicated — so the drawing covers the same threads the
 * `symbols` analyzer measured. A scene with no perf database, or one whose
 * samples are empty, yields no stacks and therefore no drawing.
 */
function flamegraphInputs(opened: OpenedScene): FlamegraphInputs {
  const perf = new PerfQuery(opened.scene.perfDb ?? opened.scene.traceDb);
  const threadIds = [...new Set(perf.threads([...opened.app.pids]).map((t) => t.threadId))]
    .sort((a, b) => a - b);
  const stacks = perf.foldedStacks(threadIds, { startNs: 0, endNs: Number.MAX_SAFE_INTEGER });

  // `capture.hiperf.symbolized` is written by `collect --so-dir`; a scene
  // captured before that field existed has no answer, which is not a "no".
  const hiperf = (opened.metadata?.capture as { hiperf?: { symbolized?: unknown } } | undefined)
    ?.hiperf;
  const symbolizationRequested =
    typeof hiperf?.symbolized === 'boolean' ? hiperf.symbolized : null;
  return { stacks, symbolizationRequested };
}

/**
 * Run every analyzer over one scene directory and keep the scenario metadata.
 *
 * Shared by `analyze`, `compare` and `report`, so a baseline directory and a
 * current directory are measured by exactly the same code. The caller owns
 * nothing: the scene is opened and closed here.
 *
 * `flamegraph` is opt-in: only `report` writes the artifact, and folding every
 * stack is work the other commands would pay for no output.
 */
async function analyzeSceneDetailed(
  open: (sceneDir: string, app?: string) => Promise<OpenedScene>,
  sceneDir: string,
  app?: string,
  options: { flamegraph?: boolean } = {},
): Promise<DetailedAnalysis> {
  const opened = await open(sceneDir, app);
  try {
    const run = await runAnalyzerSections(defaultAnalyzers(), analyzeContext(opened));
    return {
      run,
      app: opened.app,
      device: opened.metadata?.deviceId ?? 'offline',
      window: sceneWindow(opened),
      ...(opened.metadata?.startedAtNs === undefined
        ? {}
        : { startedAtNs: opened.metadata.startedAtNs }),
      ...(opened.screenshot === undefined
        ? {}
        : {
            screenshot: { width: opened.screenshot.width, height: opened.screenshot.height },
            screenshotFile: opened.layout.screenshotFile,
          }),
      ...(options.flamegraph === true
        ? { flamegraph: flamegraphInputs(opened) }
        : {}),
    };
  } finally {
    // Windows keeps the file handle open otherwise, so a second analysis of
    // the same scene would fail.
    opened.scene.close();
  }
}

/** The merged result alone, for `analyze` and `compare`. */
async function analyzeScene(
  open: (sceneDir: string, app?: string) => Promise<OpenedScene>,
  sceneDir: string,
  app?: string,
): Promise<AnalyzeResult> {
  return (await analyzeSceneDetailed(open, sceneDir, app)).run.result;
}

/**
 * Read an `analyze --json` document.
 *
 * Only the two arrays the comparison reads are validated; a file that has
 * them but no other field is accepted, because `analyze --json` is the
 * contract and anything else is an input this command did not produce.
 */
function readAnalysisFile(path: string): AnalyzeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new OhosPerfError(
      `cannot read analysis ${path}: ${safeMessage(err)}`,
      { code: 'COMPARE_BAD_INPUT', cause: err },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { metrics?: unknown }).metrics) ||
    !Array.isArray((parsed as { evidence?: unknown }).evidence)
  ) {
    throw new OhosPerfError(
      `analysis ${path} has no metrics/evidence arrays;` +
        ' pass a scene directory or the output of `ohos-perf analyze --json`',
      { code: 'COMPARE_BAD_INPUT' },
    );
  }
  return parsed as AnalyzeResult;
}

/**
 * Production wiring for {@link CliDeps}.
 *
 * This is the only place the CLI knows about real IO. In particular
 * `analyze` resolves the scene directory here, not in `commands.ts`:
 * normalizing a user path is a filesystem concern, and keeping it here lets
 * the rule be pinned by testing this object.
 */
export function realDeps(
  version: string = packageVersion(),
  overrides: RealDepsOverrides = {},
): CliDeps {
  const resolveHdc = (): Promise<string> => (overrides.hdc ?? new Hdc()).resolvePath();
  // No cast: `Device` structurally satisfies `DeviceLike`, so a future
  // signature change in core shows up here instead of being hidden.
  // A named target is passed straight to `connect()`, which is the one place
  // that decides what "connected" means. Without one, `connect()` picks the
  // first connected target — right for a single-device host, wrong when a
  // phone and an emulator are both attached, which is why `--target` exists.
  const connectDevice: DoctorDeps['connectDevice'] = overrides.connectDevice ??
    ((target) => connect(target === undefined ? {} : { target }));
  const ingest = overrides.ingest ?? ingestScene;
  const collectDevice = overrides.collectDevice ??
    ((target) => connect(target === undefined ? {} : { target }));
  const gestureDevice = overrides.gestureDevice ??
    ((target) => connect(target === undefined ? {} : { target }));
  const exploreDevice = overrides.exploreDevice ??
    ((target) => connect(target === undefined ? {} : { target }));
  const agentDevice = overrides.agentDevice ?? exploreDevice;
  /**
   * The model client, built per invocation.
   *
   * No client is bundled and no endpoint is guessed: an unconfigured host gets
   * a refusal naming the variables to set, rather than a request to a host the
   * user never named. A named `--model` overrides the configured name.
   */
  const agentModel = overrides.agentModel ?? ((name?: string): AgentModel => {
    const config = readAgentConfig(process.env);
    if (config === undefined) {
      throw new OhosPerfError(
        'no model endpoint is configured; set OHOS_PERF_AGENT_BASE_URL and' +
          ' OHOS_PERF_AGENT_API_KEY (or GLM_BASE_URL and GLM_API_KEY),' +
          ' and optionally OHOS_PERF_AGENT_MODEL (or GLM_MODEL)',
        { code: 'AGENT_BAD_CONFIG' },
      );
    }
    return httpAgentModel({
      ...config,
      ...(name === undefined ? {} : { model: name }),
      fetch: (url, init) => fetch(url, init),
    });
  });

  const doctor: DoctorDeps = {
    resolveHdc,
    async resolveStreamer() {
      const streamer = new Streamer();
      return { path: await streamer.resolvePath(), version: await streamer.version() };
    },
    connectDevice,
  };

  /**
   * A client for one invocation's target options.
   *
   * Built per call, not once: `realDeps()` must perform no IO, and the client
   * only touches the filesystem when it resolves the binary. Undefined fields
   * are omitted rather than passed as `undefined`, so the core's discovery
   * defaults apply.
   */
  const emulatorClient = (o: EmulatorTargetOptions): EmulatorClient =>
    new EmulatorClient({
      ...(o.emulatorPath === undefined ? {} : { emulatorPath: o.emulatorPath }),
      ...(o.instancePath === undefined ? {} : { instancePath: o.instancePath }),
      ...(o.imageRoot === undefined ? {} : { imageRoot: o.imageRoot }),
    });

  const emulator: EmulatorDeps = {
    list: (o) => new EmulatorLifecycle({ client: emulatorClient(o) }).list(),
    start: (name, o) => new EmulatorLifecycle({ client: emulatorClient(o) })
      .start(name, o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    stop: (name, o) => new EmulatorLifecycle({ client: emulatorClient(o) }).stop(name),
    create: (req) => new EmulatorLifecycle({ client: emulatorClient(req) }).create(req),
  };

  /**
   * Open a scene and resolve everything both `analyze` and `query` need.
   *
   * The caller owns the returned `scene` and must close it. On a failure
   * before that point the helper closes it itself, so a half-opened scene
   * never leaks a Windows file handle.
   */
  const openOfflineScene = async (sceneDir: string, app?: string): Promise<OpenedScene> => {
    // `createSceneLayout` joins onto the argument, so a relative path or a
    // shell-style `/c/...` must be normalized against the current drive
    // before it is handed over.
    const layout = createSceneLayout(resolve(sceneDir));
    const scene = await ingest(new Streamer(), layout);
    try {
      const db = scene.traceDb;
      const processes = new ProcessQuery(db);
      const hasMetadataFile = existsSync(layout.metadataFile);
      const metadata = hasMetadataFile ? readSceneMetadata(layout) : undefined;
      // A scene written by Device.collect always has scene.json, and its
      // `capture.collectors` is the authority on which collectors actually
      // ran. Re-collecting into the same directory without --procfs can leave
      // a stale procfs.jsonl; ignoring it prevents `mem.*` exact metrics for
      // a capture that never sampled memory.
      //
      // Only a genuinely ABSENT scene.json means a legacy hand-built scene
      // whose procfs.jsonl we may trust. A file that exists but cannot be
      // read (malformed JSON, wrong version, missing required fields) is an
      // untrustworthy descriptor: treat it as "no procfs" rather than
      // fabricating exact mem.* from a possibly stale capture.
      //
      // The same rule governs every scene artifact: `hidumper.json` and
      // `ui.json` are just as stale-able as `procfs.jsonl`.
      const declared = (collector: string): boolean => !hasMetadataFile ||
        (metadata !== undefined &&
          (metadata.capture?.collectors.includes(collector) ?? false));
      const samples = declared('procfs')
        ? readProcfsSamples(layout.procfsFile)
        : [];
      const hidumper = declared('hidumper')
        ? readHidumperCapture(layout.hidumperFile)
        : undefined;
      // A UI dump is a scene artifact, not a table: the query layer receives
      // the flattened rows, and a scene without one simply has no tree.
      const uiTree = declared('uitest') ? readUiTree(layout.uiFile) : undefined;
      // The screenshot is decoded here, not in the analyzer: a decode failure
      // is a reason the UI section reports, never a crash that loses the rest
      // of the analysis. An absent file is simply no capture.
      const screenshotFile = declared('screenshot') ? layout.screenshotFile : undefined;
      let screenshot: RgbaImage | undefined;
      let screenshotError: string | undefined;
      if (screenshotFile !== undefined && existsSync(screenshotFile)) {
        try {
          screenshot = decodePng(new Uint8Array(readFileSync(screenshotFile)));
        } catch (err) {
          screenshotError = safeMessage(err);
        }
      }
      // The log is captured raw and parsed here, not at capture time, so a
      // parser change is a re-analysis. The year is the capture's, which only
      // scene.json knows; a hand-built scene without one reads raw rows.
      const hilogText = declared('hilog') ? readHilogText(layout) : undefined;
      // Not gated on `declared()`: the file is not a collector artifact, so a
      // scene either carries one or it does not.
      const redundantFile = existsSync(layout.redundantFile)
        ? readFileSync(layout.redundantFile, 'utf8')
        : undefined;
      // Same rule: a supplied report is not a collector artifact, so it is
      // read when present rather than gated on a declared capture.
      const coverage = existsSync(layout.coverageFile)
        ? readFileSync(layout.coverageFile, 'utf8')
        : undefined;
      const hilog = hilogText === undefined
        ? undefined
        : parseHilogText(hilogText, {
            ...(metadata?.capture === undefined
              ? {}
              : { year: new Date(metadata.capture.startedAtMs).getUTCFullYear() }),
            captureNs: (metadata?.capture?.startedAtMs ?? 0) * 1e6,
          });
      // `collect` writes scene.json precisely so a later `analyze` does not
      // need to be told the app again; a scene whose descriptor names the app
      // must not be analyzed as `unknown`. An explicit --app always wins.
      // resolveAppIdentity stays the single pid-resolution path: only when the
      // descriptor's name resolves to no process do we fall back to the pids
      // recorded at capture time (deduplicated and sorted for byte-stability).
      let appIdentity: AppIdentity;
      if (app !== undefined) {
        appIdentity = resolveAppIdentity(processes, app);
      } else if (metadata !== undefined) {
        const resolved = resolveAppIdentity(processes, metadata.app.packageName);
        appIdentity =
          resolved.pids.length === 0 && metadata.pids.length > 0
            ? {
                packageName: metadata.app.packageName,
                pids: [...new Set(metadata.pids)].sort((a, b) => a - b),
                processNames:
                  metadata.app.processNames.length > 0
                    ? [...metadata.app.processNames]
                    : [metadata.app.packageName],
              }
            : resolved;
      } else {
        appIdentity = resolveAppIdentity(processes, 'unknown');
      }
      return {
        scene,
        layout,
        ...(metadata !== undefined ? { metadata } : {}),
        samples,
        app: appIdentity,
        caps: offlineCapabilities(
          db,
          {
            procfsSamples: samples,
            ...(hidumper === undefined ? {} : { hidumper }),
            ...(uiTree === undefined ? {} : { uiTree }),
            ...(screenshot === undefined ? {} : { screenshot }),
            ...(hilog === undefined ? {} : { hilog }),
            ...(redundantFile === undefined ? {} : { redundantFile }),
          },
          scene.perfDb,
        ),
        ...(uiTree === undefined ? {} : { uiTree }),
        ...(screenshot === undefined ? {} : { screenshot }),
        ...(screenshotError === undefined ? {} : { screenshotError }),
        ...(hidumper === undefined ? {} : { hidumper }),
        ...(hilog === undefined ? {} : { hilog }),
        ...(redundantFile === undefined ? {} : { redundantFile }),
        ...(coverage === undefined ? {} : { coverage }),
      };
    } catch (err) {
      scene.close();
      throw err;
    }
  };

  return {
    doctor,
    version,
    emulator,

    async gesture(req) {
      const device = await gestureDevice(req.target);
      return device.gesture(req.gesture);
    },

    async capsReport(target) {
      try {
        await resolveHdc();
      } catch (err) {
        return { hdcOk: false, hdcError: safeMessage(err), capabilities: [] };
      }
      try {
        const device = await connectDevice(target);
        const matrix = await device.capabilities();
        return { hdcOk: true, capabilities: matrix.all() };
      } catch (err) {
        // Toolchain present, device unusable: environmental, not a toolchain
        // failure — but the caller must be able to tell this apart from a
        // device that genuinely reported zero capabilities.
        return { hdcOk: true, probeError: safeMessage(err), capabilities: [] };
      }
    },

    analyze: (sceneDir, app) => analyzeScene(openOfflineScene, sceneDir, app),

    async query(req) {
      // Validate the name, arguments and limit before touching the
      // filesystem: a typo must not depend on the scene being readable.
      const definition = lookupQuery(req.name);
      if (definition === undefined) throw unknownQueryError(req.name);
      const args = req.args ?? {};
      definition.parseArgs(args);
      const limit = resolveQueryLimit(req.limit);

      const opened = await openOfflineScene(req.sceneDir, req.app);
      try {
        return runNamedQuery(
          {
            db: opened.scene.traceDb,
            // A `--hiperf` scene keeps perf_sample/perf_thread in perf.db;
            // omitting this made every frame.load.* query return [] on device.
            ...(opened.scene.perfDb === undefined ? {} : { perfDb: opened.scene.perfDb }),
            app: opened.app,
            caps: opened.caps,
            ...(opened.uiTree === undefined ? {} : { uiTree: opened.uiTree }),
            ...(opened.hilog === undefined ? {} : { hilog: opened.hilog }),
          },
          req.name,
          args,
          { limit },
        );
      } finally {
        opened.scene.close();
      }
    },

    async compare(req) {
      // Validate both inputs before opening either scene: a bad path must not
      // depend on the other input being readable.
      const load = async (input: string): Promise<AnalyzeResult> =>
        (await isDirectory(input)
          ? analyzeScene(openOfflineScene, input)
          : readAnalysisFile(input));
      const [baseline, current] = await Promise.all([load(req.baseline), load(req.current)]);
      return compareResults(baseline, current);
    },

    async uiCompare(req) {
      const diff = await compareSceneDirs(req.a, req.b, { outDir: req.outDir });
      return {
        outDir: resolve(req.outDir),
        files: [...UI_DIFF_FILES],
        tree: diff.tree === null
          ? null
          : {
              added: diff.tree.added.length,
              removed: diff.tree.removed.length,
              changed: diff.tree.changed.length,
              unchanged: diff.tree.unchanged,
            },
        image: diff.image === null
          ? null
          : {
              hamming: diff.image.hamming,
              similarity: diff.image.similarity,
              changedRatio: diff.image.changedRatio,
              tolerance: diff.image.tolerance,
            },
        regions: diff.regions.length,
        animations: diff.animations.length,
        pixelOnly: diff.pixelOnly.length,
        unmeasuredRegions: diff.unmeasuredRegions.length,
        degraded: [...diff.degraded],
      };
    },

    async report(req) {
      // Analyze the scene first: a scene that cannot be read or analyzed must
      // fail before the baseline is touched, and nothing is written until the
      // whole model exists — a half-written bundle is worse than none.
      // The flamegraph inputs are read while the scene is still open.
      const detailed = await analyzeSceneDetailed(
        openOfflineScene, req.sceneDir, req.app, { flamegraph: true },
      );
      let comparison;
      if (req.baseline !== undefined) {
        const baseline = await (await isDirectory(req.baseline)
          ? analyzeScene(openOfflineScene, req.baseline)
          : readAnalysisFile(req.baseline));
        comparison = compareResults(baseline, detailed.run.result);
      }

      const model = buildReport({
        generator: { name: '@ohos-perf/core', version },
        app: detailed.app,
        device: detailed.device,
        window: detailed.window,
        ...(detailed.startedAtNs === undefined ? {} : { startedAtNs: detailed.startedAtNs }),
        sections: detailed.run.sections,
        ...(comparison === undefined ? {} : { comparison }),
        ...(detailed.screenshot === undefined ? {} : { screenshot: detailed.screenshot }),
      });

      const artifacts: Array<[string, string | Uint8Array]> = [
        ['report.html', renderReportHtml(model)],
        ['report.json', renderReportJson(model)],
        ['summary.json', renderSummaryJson(summarizeReport(model))],
        ['metrics.csv', renderMetricsCsv(model)],
        ['evidence.csv', renderEvidenceCsv(model)],
        ['report.xlsx', renderReportXlsx(model)],
      ];

      // A scene with samples gets the drawing too; a scene without them gets
      // no file rather than an empty canvas a reader could mistake for a
      // capture in which nothing ran.
      const flamegraph = detailed.flamegraph;
      if (flamegraph !== undefined && flamegraph.stacks.length > 0) {
        const share = model.sections
          .find((section) => section.id === 'symbols')
          ?.metrics.find((metric) => metric.id === 'symbol.unresolved.share')?.value;
        artifacts.push(
          ['flamegraph.svg', renderFlamegraphSvg(flamegraph.stacks)],
          ['flamegraph.html', renderFlamegraphHtml({
            stacks: flamegraph.stacks,
            app: detailed.app.packageName,
            window: detailed.window,
            unresolvedShare: typeof share === 'number' ? share : null,
            symbolizationRequested: flamegraph.symbolizationRequested,
          })],
        );
      }

      const outDir = resolve(req.outDir);
      await mkdir(outDir, { recursive: true });
      for (const [name, content] of artifacts) {
        await writeFile(join(outDir, name), content);
      }
      const files = artifacts.map(([name]) => name);
      // The HTML references `assets/screenshot.png`; the file is copied only
      // when the scene had one, so the page never links to a missing image.
      if (detailed.screenshotFile !== undefined && detailed.screenshot !== undefined) {
        await mkdir(join(outDir, 'assets'), { recursive: true });
        await copyFile(detailed.screenshotFile, join(outDir, 'assets', 'screenshot.png'));
        files.push('assets/screenshot.png');
      }

      return {
        outDir,
        files,
        sections: {
          total: model.sections.length,
          measured: model.totals.measured,
          degraded: model.totals.degraded,
        },
        metrics: model.totals.metrics,
        evidence: model.totals.evidence,
        bySeverity: { ...model.totals.bySeverity },
        ...(model.comparison === undefined
          ? {}
          : { comparison: { ...model.comparison.totals } }),
      };
    },

    async render(req) {
      // A saved bundle is `report.json`; a directory is accepted because it is
      // the path a caller has in their scrollback. The scene is never opened:
      // the point of a re-render is that it does not depend on today's
      // analyzers, or on the capture still being on disk.
      const file = req.report.endsWith('.json') ? req.report : join(req.report, 'report.json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new OhosPerfError(
          `cannot read report ${file}: ${safeMessage(err)}`,
          { code: 'RENDER_BAD_INPUT', cause: err },
        );
      }
      const model = parsed as ReportModel;
      if (!Array.isArray(model.sections) || model.scenario === undefined || model.totals === undefined) {
        throw new OhosPerfError(
          `${file} is not a report document (no sections, scenario or totals block)`,
          { code: 'RENDER_BAD_INPUT' },
        );
      }

      const outDir = resolve(req.outDir);
      const artifacts = renderBundle({ model });
      await mkdir(outDir, { recursive: true });
      for (const [name, content] of artifacts) {
        await writeFile(join(outDir, name), content);
      }
      const files = artifacts.map(([name]) => name);

      // The page links `assets/screenshot.png` whenever the model says one was
      // captured. That file is a copy, not a value, so it is not in the model:
      // the source bundle's copy is carried across when it exists, and a
      // bundle without one renders the page it always did — no `<img>`, so
      // nothing points at a file that is not there.
      const sourceAsset = join(dirname(file), 'assets', 'screenshot.png');
      if (model.scenario.screenshot !== undefined && existsSync(sourceAsset)) {
        await mkdir(join(outDir, 'assets'), { recursive: true });
        await copyFile(sourceAsset, join(outDir, 'assets', 'screenshot.png'));
        files.push('assets/screenshot.png');
      }

      return {
        outDir,
        files,
        sections: model.sections.length,
        metrics: model.totals.metrics,
        evidence: model.totals.evidence,
      };
    },

    async trend(req) {
      // A saved report is `report.json`; a directory is accepted when it is
      // the bundle `report` wrote, because that is the path a caller has in
      // their terminal scrollback. Nothing is analyzed here — the runs are
      // already measured, and re-analyzing them would make the trend depend on
      // today's code rather than on what each run measured.
      const runs = req.reports.map((report) => {
        const file = report.path.endsWith('.json') ? report.path : join(report.path, 'report.json');
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
          throw new OhosPerfError(
            `cannot read report ${file}: ${safeMessage(err)}`,
            { code: 'TREND_BAD_INPUT', cause: err },
          );
        }
        const model = parsed as ReportModel;
        if (!Array.isArray(model.sections) || model.scenario === undefined) {
          throw new OhosPerfError(
            `${file} is not a report document (no sections or scenario block)`,
            { code: 'TREND_BAD_INPUT' },
          );
        }
        return trendRunFromReport(report.label ?? report.path, model);
      });

      const trend = buildTrend(runs);
      const outDir = resolve(req.outDir);
      const artifacts: Array<[string, string]> = [
        ['trend.html', renderTrendHtml(trend)],
        ['trend.json', renderTrendJson(trend)],
      ];
      await mkdir(outDir, { recursive: true });
      for (const [name, content] of artifacts) {
        await writeFile(join(outDir, name), content);
      }

      const count = (status: 'improved' | 'regressed' | 'unchanged'): number =>
        trend.series.filter((series) => series.status === status).length;
      // A series nobody measured has no verdict because it has no values —
      // a different statement from a measured metric with no known direction,
      // and conflating them overstates how much was compared.
      const unmeasured = trend.series.filter((series) => series.measured === 0).length;
      const verdictless = trend.series.filter(
        (series) => series.status === undefined && series.measured > 0,
      ).length;
      return {
        outDir,
        files: artifacts.map(([name]) => name),
        runs: trend.runs.map((run) => ({
          label: run.label,
          app: run.app,
          device: run.device,
          ...(run.startedAtNs === undefined ? {} : { startedAtNs: run.startedAtNs }),
          metrics: run.metrics.length,
        })),
        orderedBy: trend.orderedBy,
        series: trend.series.length,
        improved: count('improved'),
        regressed: count('regressed'),
        unchanged: count('unchanged'),
        verdictless,
        unmeasured,
      };
    },

    async hap(req) {
      // The whole package is read into memory: the archive is a document, not
      // an extraction, so nothing is written outside `--out`.
      const analysis = analyzeHap(readFileSync(req.packagePath), basename(req.packagePath));
      // One row, offline by construction: a package on disk needs no device
      // probe, so this is the only place the `static.hap` capability is ever
      // reported available.
      const capabilities: CapabilityState[] = [{
        id: 'static.hap',
        available: true,
        collector: 'offline',
        fidelity: 'exact',
        probe: { command: '', stdout: '', stderr: '', code: 0 },
      }];
      if (req.outDir === undefined) return { analysis, capabilities };

      // One section, rendered by the same report model as a captured scene, so
      // the page carries the same shape a reader already knows. The scenario
      // block names the package, and the window is the archive's own `{0, 0}`.
      const model = buildReport({
        generator: { name: '@ohos-perf/core', version },
        app: {
          packageName: analysis.package.bundleName === ''
            ? analysis.package.name
            : analysis.package.bundleName,
          pids: [],
          processNames: [],
        },
        device: 'offline',
        window: { startNs: 0, endNs: 0 },
        sections: [hapSection(analysis)],
      });
      const artifacts: Array<[string, string]> = [
        ['hap.json', JSON.stringify(analysis, null, 2) + '\n'],
        ['hap.html', renderReportHtml(model)],
      ];
      const outDir = resolve(req.outDir);
      await mkdir(outDir, { recursive: true });
      for (const [name, content] of artifacts) {
        await writeFile(join(outDir, name), content);
      }
      return { analysis, capabilities, outDir, artifacts: artifacts.map(([name]) => name) };
    },

    async opt(req) {
      // The whole package is read into memory; extraction is a read, not a
      // write, so nothing lands on disk.
      const bytes = readFileSync(req.packagePath);
      const name = basename(req.packagePath);
      const analysis = analyzeBinaries(extractBinaries({ path: name, bytes }), name);
      // Offline by construction, like `hap`: a file on disk needs no probe.
      const capabilities: CapabilityState[] = [{
        id: 'static.hap',
        available: true,
        collector: 'offline',
        fidelity: 'exact',
        probe: { command: '', stdout: '', stderr: '', code: 0 },
      }];
      return { analysis, capabilities };
    },

    tools() {
      return queryDefinitions().map((definition) => ({
        name: definition.name,
        description: definition.description,
        args: definition.args,
        returns: definition.returns,
      }));
    },

    async explore(req) {
      const device = await exploreDevice(req.target);
      const host = deviceExplorationHost(device, {
        ...(req.settleMs === undefined ? {} : { settleMs: req.settleMs }),
        ...(overrides.exploreClock === undefined ? {} : { clock: overrides.exploreClock }),
      });
      const result = await explore(host, {
        maxSteps: req.maxSteps,
        strategy: req.strategy,
        ...(req.seed === undefined ? {} : { seed: req.seed }),
      });
      return {
        app: req.app,
        device: { id: device.id, kind: device.kind },
        strategy: result.strategy,
        ...(result.seed === undefined ? {} : { seed: result.seed }),
        steps: result.steps.length,
        navigated: result.steps.filter((step) => step.outcome === 'navigated').length,
        noChange: result.steps.filter((step) => step.outcome === 'no_change').length,
        statesReached: result.statesReached,
        exhausted: result.exhausted,
        // First-reach order: the sequence of hashes as the walk saw them, which
        // is what a reader follows to see where it went.
        screens: [...new Set([...(result.steps[0] === undefined ? [] : [result.steps[0].before]),
          ...result.steps.map((step) => step.after)])],
      };
    },

    async agent(req) {
      // The model is resolved before the device: an unconfigured endpoint is a
      // setup mistake, and failing on it should not spend a device connection.
      const model = agentModel(req.model);
      const device = await agentDevice(req.target);
      const transcript = await runAgent(device, model, {
        task: req.task,
        app: req.app,
        maxSteps: req.maxSteps,
        ...(req.allowIrreversible === true ? { allowIrreversible: true } : {}),
      });
      return { transcript, device: { id: device.id, kind: device.kind } };
    },

    async symbols(req) {
      const bytes = readFileSync(req.library);
      const library = basename(req.library);
      let result;
      try {
        result = recoverSymbols(bytes, req.addresses);
      } catch (err) {
        // A refusal names the file: the caller passed a path, and "not an ELF"
        // alone does not say which one they have to look at.
        throw new OhosPerfError(`${library}: ${(err as Error).message}`, { cause: err });
      }
      if (req.measure !== true) return { library, ...result };
      // The model is resolved only when asked for: naming is the optional
      // half, and a caller recovering recorded names needs no endpoint.
      const model = agentModel(req.model);
      const naming = await measureNaming(bytes, async (question) => {
        const counts = Object.entries(question.counts)
          .filter(([name, value]) => name !== 'total' && value > 0)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(' ');
        // The body's bytes are the evidence: the model is naming a function
        // from its instruction mix, which is what the ELF can offer without a
        // disassembler. It is never shown the name it is being scored against.
        const request = {
          task:
            `Name the function at 0x${question.start.toString(16)} in ${library}` +
            ` (${question.size} bytes; instruction mix: ${counts || 'none'}).`,
          app: library,
          step: 0,
          maxSteps: 1,
          screen: hexDump(question.body),
          history: [],
        };
        const decision = await model.decide(request);
        // The answer is the name; a model that answers with an action has not
        // named anything, and its reason is the closest thing to a name.
        return 'done' in decision ? decision.reason : decision.reason;
      });
      return { library, ...result, naming };
    },

    async run(req) {
      // Reading and validating the document happened in the command layer;
      // this is the first place a device is resolved, so an invalid scenario
      // never reaches one.
      const device = await connect(req.target === undefined ? {} : { target: req.target });
      const runner = new ScenarioRunner(device, {
        outDir: resolve(req.outDir),
        ...(req.rounds === undefined ? {} : { rounds: req.rounds }),
        ...(req.only === undefined ? {} : { only: req.only }),
        ...(req.keepGoing === true ? { keepGoing: true } : {}),
      });
      return runner.run(req.scenario);
    },

    async collect(req) {
      const sceneDir = resolve(req.out);
      const device = await collectDevice(req.target);
      const session = await device.collect({
        app: req.app,
        durationMs: req.durationMs,
        sceneRoot: sceneDir,
        ...(req.procfs === true ? { procfs: true } : {}),
        ...(req.coldStart !== undefined ? { coldStart: { ability: req.coldStart } } : {}),
        ...(req.hiprofiler === undefined
          ? {}
          : {
              hiprofiler:
                req.hiprofiler.plugins === undefined
                  ? {}
                  : { plugins: req.hiprofiler.plugins },
            }),
        ...(req.hiperf === undefined ? {} : { hiperf: req.hiperf }),
        ...(req.soDir === undefined ? {} : { soDir: req.soDir }),
        ...(req.hidumper === true ? { hidumper: true } : {}),
        ...(req.uitest === true ? { uitest: true } : {}),
        ...(req.screenshot === true ? { screenshot: true } : {}),
        ...(req.hilog === true ? { hilog: true } : {}),
        ...(req.jsheap === true ? { jsheap: true } : {}),
      });
      const scene = await session.ingest();
      try {
        // scene.json is the authority on what ran: the collectors list and the
        // capture counts come from the same descriptor a later analyze reads.
        // A count of 0 is a capture that saw nothing, and it is reported as
        // such — never dropped, never inferred from a missing file.
        const layout = createSceneLayout(sceneDir);
        const meta = readSceneMetadata(layout);
        return {
          sceneDir,
          device: { id: device.id, kind: device.kind },
          collectors: meta?.capture?.collectors ?? [],
          ...(meta?.capture?.hiperf === undefined
            ? {}
            : {
                hiperf: {
                  samples: meta.capture.hiperf.samples,
                  ...(meta.capture.hiperf.symbolized === undefined
                    ? {}
                    : { symbolized: meta.capture.hiperf.symbolized }),
                },
              }),
          ...(req.soDir === undefined ? {} : { soDir: resolve(req.soDir) }),
          ...(meta?.capture?.hidumper === undefined
            ? {}
            : { hidumper: { frames: meta.capture.hidumper.frames } }),
          ...(meta?.capture?.uitest === undefined
            ? {}
            : { ui: { nodes: meta.capture.uitest.nodes } }),
          ...(meta?.capture?.screenshot === undefined
            ? {}
            : {
                screenshot: {
                  width: meta.capture.screenshot.width,
                  height: meta.capture.screenshot.height,
                },
              }),
          ...(meta?.capture?.hilog === undefined
            ? {}
            : { hilog: { lines: meta.capture.hilog.lines } }),
        };
      } finally {
        scene.close();
      }
    },
  };
}
