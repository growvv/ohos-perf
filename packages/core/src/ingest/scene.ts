import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../db/driver';
import { IngestError } from '../errors';
import type { Streamer } from './streamer';

/**
 * Artifact paths of one captured scene. The file names are fixed: a scene
 * directory is self-describing and later stages locate `trace.htrace` /
 * `trace.db` / `procfs.jsonl` / `scene.json` without being told.
 */
export interface SceneLayout {
  root: string;
  traceFile: string;
  perfFile?: string;
  traceDb: string;
  perfDb?: string;
  procfsFile: string;
  /** `hidumper.json` from a RenderService counter capture. */
  hidumperFile: string;
  /** `ui.json` from a `uitest dumpLayout` capture. */
  uiFile: string;
  metadataFile: string;
}

export function createSceneLayout(root: string): SceneLayout {
  return {
    root,
    traceFile: join(root, 'trace.htrace'),
    perfFile: join(root, 'perf.data'),
    traceDb: join(root, 'trace.db'),
    perfDb: join(root, 'perf.db'),
    procfsFile: join(root, 'procfs.jsonl'),
    hidumperFile: join(root, 'hidumper.json'),
    uiFile: join(root, 'ui.json'),
    metadataFile: join(root, 'scene.json'),
  };
}

/**
 * A queryable scene: the root directory plus open handles on its databases.
 *
 * `traceDb` is always present; `perfDb` exists only when the scene carried a
 * `perf.data` (a hiperf capture), which converts into the same schema family
 * and holds `perf_sample` / `perf_callchain` / `perf_thread` / `perf_files`.
 * Both handles are owned by the scene and closed by `close()`.
 */
export class Scene {
  readonly dir: string;
  readonly traceDb: QueryHandle;
  readonly perfDb?: QueryHandle;

  constructor(layout: SceneLayout, db: QueryHandle, perfDb?: QueryHandle) {
    this.dir = layout.root;
    this.traceDb = db;
    this.perfDb = perfDb;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    return this.traceDb.query<T>(sql, params);
  }

  /** Idempotent; the underlying handles are idempotent too. */
  close(): void {
    this.traceDb.close();
    this.perfDb?.close();
  }
}

/**
 * Open a scene, converting the trace file first when needed.
 *
 * The database is the durable artifact, so an existing `traceDb` is opened as
 * is and the (expensive) converter is never invoked. Conversion is only
 * attempted when a trace file is present; with neither file there is nothing
 * to ingest and the error names the path that was expected.
 */
export async function ingestScene(streamer: Streamer, layout: SceneLayout): Promise<Scene> {
  if (!existsSync(layout.traceDb)) {
    if (!existsSync(layout.traceFile)) {
      throw new IngestError(
        `Nothing to ingest: trace file not found at ${layout.traceFile}` +
          ` (and no converted database at ${layout.traceDb})`,
        '',
        'SCENE_NO_INPUT',
      );
    }
    // Only now, on the write path, may the scene directory be created.
    mkdirSync(layout.root, { recursive: true });
    await streamer.convert(layout.traceFile, layout.traceDb);
  }

  // A scene may carry a perf capture beside the trace. It converts the same
  // way and opens as a second handle; a scene without perf.data simply has
  // none, and the perf capability stays absent from the offline matrix.
  const perfDb = await openPerfDb(streamer, layout);
  return new Scene(layout, openDb(layout.traceDb), perfDb);
}

/**
 * Convert and open `perf.data` when the scene carries one.
 *
 * Mirrors the trace path: an existing `perf.db` is opened as is, conversion
 * only runs when `perf.data` exists, and a scene with neither yields
 * `undefined`. The caller owns the returned handle.
 */
async function openPerfDb(
  streamer: Streamer,
  layout: SceneLayout,
): Promise<QueryHandle | undefined> {
  if (layout.perfDb === undefined) return undefined;
  if (!existsSync(layout.perfDb)) {
    if (layout.perfFile === undefined || !existsSync(layout.perfFile)) return undefined;
    mkdirSync(layout.root, { recursive: true });
    await streamer.convert(layout.perfFile, layout.perfDb);
  }
  return openDb(layout.perfDb);
}
