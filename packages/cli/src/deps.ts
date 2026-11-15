import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BinderQuery,
  CallstackQuery,
  CapabilityMatrix,
  FrameQuery,
  Hdc,
  InstantQuery,
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
  readProcfsSamples,
  readSceneMetadata,
  resolveAppIdentity,
  runAnalyzers,
  type CapabilityId,
  type CapabilityState,
  type Scene,
  type SceneLayout,
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
function offlineState(id: CapabilityId, collector: 'hitrace' | 'procfs'): CapabilityState {
  return {
    id,
    available: true,
    collector,
    fidelity: 'exact',
    probe: OFFLINE_PROBE(),
  };
}

/** Names of the core trace tables an offline capability depends on. */
const TABLE_RULES: ReadonlyArray<{
  id: CapabilityId;
  collector: 'hitrace' | 'procfs';
  tables: readonly string[];
}> = [
  { id: 'trace.frames', collector: 'hitrace', tables: ['frame_slice'] },
  { id: 'trace.sched', collector: 'hitrace', tables: ['sched_slice', 'instant'] },
  { id: 'trace.binder', collector: 'hitrace', tables: ['callstack'] },
  { id: 'trace.thread_state', collector: 'hitrace', tables: ['thread_state'] },
  { id: 'startup.app_startup', collector: 'hitrace', tables: ['app_startup'] },
  { id: 'mem.procfs', collector: 'procfs', tables: ['procfs.jsonl'] },
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
): CapabilityMatrix {
  const tables = new Set(
    db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name),
  );

  const states: CapabilityState[] = [];
  for (const rule of TABLE_RULES) {
    const present = rule.tables.every((name) =>
      name === 'procfs.jsonl' ? procfsSamples.length > 0 : tables.has(name),
    );
    if (present) states.push(offlineState(rule.id, rule.collector));
  }
  return new CapabilityMatrix(states);
}

/** The minimal database surface the offline matrix needs. */
export interface CapabilityMatrixDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
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

    async analyze(sceneDir, app) {
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
        const context = {
          db,
          frames: new FrameQuery(db),
          processes,
          threads: new ThreadQuery(db),
          sched: new SchedQuery(db),
          instant: new InstantQuery(db),
          threadStates: new ThreadStateQuery(db),
          callstacks: new CallstackQuery(db),
          perf: new PerfQuery(db),
          binder: new BinderQuery(db),
          startup: new StartupQuery(db),
          ...(samples.length > 0 ? { procfs: samples } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          app: resolveAppIdentity(processes, app ?? 'unknown'),
          // The whole database: a CLI run has no capture window to honour.
          window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
          caps: offlineCapabilities(db, samples),
          deviceId: 'offline',
        };
        return await runAnalyzers(defaultAnalyzers(), context);
      } finally {
        // Windows keeps the file handle open otherwise, so a second analysis
        // of the same scene would fail.
        scene.close();
      }
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
      });
      const scene = await session.ingest();
      try {
        return { sceneDir, device: { id: device.id, kind: device.kind } };
      } finally {
        scene.close();
      }
    },
  };
}
