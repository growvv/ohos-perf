import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BinderQuery,
  CallstackQuery,
  CapabilityMatrix,
  FrameQuery,
  Hdc,
  InstantQuery,
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
  defaultAnalyzers,
  ingestScene,
  lookupQuery,
  queryDefinitions,
  readProcfsSamples,
  compareResults,
  readSceneMetadata,
  readUiTree,
  resolveAppIdentity,
  resolveQueryLimit,
  runAnalyzers,
  runNamedQuery,
  unknownQueryError,
  type AppIdentity,
  type AnalyzeResult,
  type CapabilityId,
  type CapabilityState,
  type NamedQueryInfo,
  type ProcfsSample,
  type UiNode,
  type Scene,
  type SceneLayout,
  type SceneMetadata,
} from '@ohos-perf/core';
import { safeMessage, type CliDeps, type DoctorDeps } from './commands';

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
  /** Device probe, shared by `doctor` and `caps`. */
  connectDevice?: () => Promise<{
    id: string;
    kind: string;
    abi: string;
    capabilities(): Promise<{ all(): CapabilityState[] }>;
  }>;
  /** Scene ingestion; replaced in tests to observe the layout without a converter. */
  ingest?: (streamer: Streamer, layout: SceneLayout) => Promise<Scene>;
  /** Device used by `collect`; replaced in tests to avoid a real capture. */
  collectDevice?: () => Promise<{
    id: string;
    kind: string;
    collect(opts: unknown): Promise<{ ingest(): Promise<Scene> }>;
  }>;
}

/** The empty probe an offline capability state carries (no device was asked). */
const OFFLINE_PROBE = (): CapabilityState['probe'] =>
  ({ command: '', stdout: '', stderr: '', code: 0 });

/** An available state in the offline matrix, with the exact probe shape. */
function offlineState(
  id: CapabilityId,
  collector: 'hitrace' | 'procfs' | 'hiperf',
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
const TABLE_RULES: ReadonlyArray<{
  id: CapabilityId;
  collector: 'hitrace' | 'procfs' | 'hiperf';
  tables: readonly string[];
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
  { id: 'mem.procfs', collector: 'procfs', tables: ['procfs.jsonl'] },
  { id: 'perf.samples', collector: 'hiperf', tables: ['perf_sample'], perf: true },
];

/**
 * Build the offline capability matrix from what the scene actually contains.
 *
 * A CLI `analyze` has no device to probe, but the engine still needs to decide
 * which analyzers may run. Deriving availability from the trace database (and
 * `procfs.jsonl`) means a scene that carries the tables gets the analyzers,
 * while one that does not leaves the capability **absent** from the matrix:
 * `satisfies()` reports it as `capability not probed` and the engine emits a
 * degraded proxy instead of a fabricated zero.
 *
 * `procfs.jsonl` is special: it is a scene artifact, not a database table, and
 * is available only when the file yields at least one valid sample. The caller
 * passes the samples it already read — after applying the scene.json gate
 * (absent file → trust it; present but unreadable or not listing `procfs` →
 * empty) — so the file is parsed once and `mem.procfs` cannot be claimed for a
 * capture that did not sample memory.
 */
export function offlineCapabilities(
  db: CapabilityMatrixDb,
  procfsSamples: readonly unknown[],
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
    const present = rule.tables.every((name) =>
      name === 'procfs.jsonl' ? procfsSamples.length > 0 : source.has(name),
    );
    if (!present) continue;
    // A table that exists but holds no rows is an empty capture, not a
    // capability: `perf_sample` is only real when at least one sample landed.
    if (rule.perf === true && perfDb !== undefined) {
      const first = rule.tables[0];
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
}

/** True when `path` exists and is a directory (a scene, not an `analyze --json` file). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Run every analyzer over one scene directory.
 *
 * Shared by `analyze` and `compare`, so a baseline directory and a current
 * directory are measured by exactly the same code. The caller owns nothing:
 * the scene is opened and closed here.
 */
async function analyzeScene(
  open: (sceneDir: string, app?: string) => Promise<OpenedScene>,
  sceneDir: string,
  app?: string,
): Promise<AnalyzeResult> {
  const opened = await open(sceneDir, app);
  try {
    const db = opened.scene.traceDb;
    const context = {
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
      ...(opened.samples.length > 0 ? { procfs: opened.samples } : {}),
      ...(opened.metadata !== undefined ? { metadata: opened.metadata } : {}),
      app: opened.app,
      // The whole database: a CLI run has no capture window to honour.
      window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
      caps: opened.caps,
      deviceId: 'offline',
    };
    return await runAnalyzers(defaultAnalyzers(), context);
  } finally {
    // Windows keeps the file handle open otherwise, so a second analysis of
    // the same scene would fail.
    opened.scene.close();
  }
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
  const connectDevice: DoctorDeps['connectDevice'] =
    overrides.connectDevice ?? (() => connect());
  const ingest = overrides.ingest ?? ingestScene;
  const collectDevice = overrides.collectDevice ?? (() => connect());

  const doctor: DoctorDeps = {
    resolveHdc,
    async resolveStreamer() {
      const streamer = new Streamer();
      return { path: await streamer.resolvePath(), version: await streamer.version() };
    },
    connectDevice,
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
      const procfsDeclared = !hasMetadataFile ||
        (metadata !== undefined &&
          (metadata.capture?.collectors.includes('procfs') ?? false));
      const samples = procfsDeclared
        ? readProcfsSamples(layout.procfsFile)
        : [];
      // A UI dump is a scene artifact, not a table: the query layer receives
      // the flattened rows, and a scene without one simply has no tree.
      const uiTree = readUiTree(layout.uiFile);
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
        caps: offlineCapabilities(db, samples, scene.perfDb),
        ...(uiTree === undefined ? {} : { uiTree }),
      };
    } catch (err) {
      scene.close();
      throw err;
    }
  };

  return {
    doctor,
    version,

    async capsReport() {
      try {
        await resolveHdc();
      } catch (err) {
        return { hdcOk: false, hdcError: safeMessage(err), capabilities: [] };
      }
      try {
        const device = await connectDevice();
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
            app: opened.app,
            caps: opened.caps,
            ...(opened.uiTree === undefined ? {} : { uiTree: opened.uiTree }),
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

    tools() {
      return queryDefinitions().map((definition) => ({
        name: definition.name,
        description: definition.description,
        args: definition.args,
        returns: definition.returns,
      }));
    },

    async collect(req) {
      const sceneDir = resolve(req.out);
      const device = await collectDevice();
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
        ...(req.hidumper === true ? { hidumper: true } : {}),
        ...(req.uitest === true ? { uitest: true } : {}),
      });
      const scene = await session.ingest();
      try {
        // scene.json is the authority on what ran: the collectors list and the
        // capture summary come from the same descriptor a later analyze reads.
        const layout = createSceneLayout(sceneDir);
        const meta = readSceneMetadata(layout);
        const nodes = readUiTree(layout.uiFile)?.length;
        return {
          sceneDir,
          device: { id: device.id, kind: device.kind },
          collectors: meta?.capture?.collectors ?? [],
          ...(meta?.capture?.hiperf === undefined
            ? {}
            : { hiperf: { samples: meta.capture.hiperf.samples } }),
          ...(nodes === undefined ? {} : { ui: { nodes } }),
        };
      } finally {
        scene.close();
      }
    },
  };
}
