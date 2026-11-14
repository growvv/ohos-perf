import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CapabilityMatrix,
  FrameAnalyzer,
  FrameQuery,
  Hdc,
  ProcessQuery,
  Streamer,
  connect,
  createSceneLayout,
  ingestScene,
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
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
  return pkg.version;
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
      } catch {
        // Toolchain present, no usable device: environmental, not a failure.
        return { hdcOk: true, capabilities: [] };
      }
    },

    async analyze(sceneDir, app) {
      // `createSceneLayout` joins onto the argument, so a relative path or a
      // shell-style `/c/...` must be normalized against the current drive
      // before it is handed over.
      const layout = createSceneLayout(resolve(sceneDir));
      const scene = await ingest(new Streamer(), layout);
      try {
        return await new FrameAnalyzer().run({
          frames: new FrameQuery(scene.traceDb),
          processes: new ProcessQuery(scene.traceDb),
          app: { packageName: app ?? 'unknown', pids: [], processNames: [] },
          // The whole database: a CLI run has no capture window to honour.
          window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
          // Offline analysis probes no device; the analyzer does not consult
          // caps (the caller gates on `requires`), so this only fills the shape.
          caps: new CapabilityMatrix([
            {
              id: 'trace.frames',
              available: true,
              collector: 'hitrace',
              fidelity: 'exact',
              probe: { command: '', stdout: '', stderr: '', code: 0 },
            },
          ]),
          deviceId: 'offline',
        });
      } finally {
        // Windows keeps the file handle open otherwise, so a second analysis
        // of the same scene would fail.
        scene.close();
      }
    },
  };
}
