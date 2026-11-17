import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Scene,
  createSceneLayout,
  ingestScene,
  type SceneLayout,
} from '../src/ingest/scene';
import type { Streamer } from '../src/ingest/streamer';
import { IngestError } from '../src/errors';

const FRAME_SLICE_DDL =
  'CREATE TABLE frame_slice(id INT, ts INT, flag INT)';

/** A stand-in for the real trace_streamer binary; no DevEco needed. */
function fakeStreamer(write = true): { streamer: Streamer; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const streamer = {
    async convert(input: string, output: string): Promise<void> {
      calls.push([input, output]);
      if (!write) return;
      const db = new DatabaseSync(output);
      db.exec(FRAME_SLICE_DDL);
      db.exec('INSERT INTO frame_slice VALUES (0, 1, 0)');
      db.close();
    },
  } as unknown as Streamer;
  return { streamer, calls };
}

function createDb(path: string, ts = 42): void {
  const db = new DatabaseSync(path);
  db.exec(FRAME_SLICE_DDL);
  db.exec(`INSERT INTO frame_slice VALUES (0, ${ts}, 0)`);
  db.close();
}

let dirs: string[];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ohosperf-scene-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('createSceneLayout', () => {
  it('derives every artifact path from root', () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    expect(l).toEqual({
      root: dir,
      traceFile: join(dir, 'trace.htrace'),
      perfFile: join(dir, 'perf.data'),
      traceDb: join(dir, 'trace.db'),
      perfDb: join(dir, 'perf.db'),
      procfsFile: join(dir, 'procfs.jsonl'),
      hidumperFile: join(dir, 'hidumper.json'),
      hilogFile: join(dir, 'hilog.log'),
      hilogJsonlFile: join(dir, 'hilog.jsonl'),
      redundantFile: join(dir, 'redundant_file.txt'),
      coverageFile: join(dir, 'coverageReport.json'),
      jsheapFile: join(dir, 'jsheap.heapsnapshot'),
      uiFile: join(dir, 'ui.json'),
      screenshotFile: join(dir, 'screenshot.png'),
      metadataFile: join(dir, 'scene.json'),
    });
  });

  it('uses the fixed file names Task 12 and Task 16 rely on', () => {
    const l = createSceneLayout('/scenes/run-1');
    expect(l.traceFile).toBe(join('/scenes/run-1', 'trace.htrace'));
    expect(l.traceDb).toBe(join('/scenes/run-1', 'trace.db'));
  });

  it('places the procfs capture next to the trace', () => {
    expect(createSceneLayout('/x').procfsFile).toBe(join('/x', 'procfs.jsonl'));
  });

  it('places the scene metadata next to the trace', () => {
    expect(createSceneLayout('/x').metadataFile).toBe(join('/x', 'scene.json'));
  });
});

describe('ingestScene', () => {
  it('converts trace file then opens db', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    const { streamer, calls } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 1 }]);
    expect(calls).toEqual([[l.traceFile, l.traceDb]]);
    scene.close();
  });

  it('skips conversion when the database already exists', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    createDb(l.traceDb, 7);
    const { streamer, calls } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    expect(calls).toEqual([]);
    expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 7 }]);
    scene.close();
  });

  it('does not touch the database when only the trace file is missing and a db exists', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    createDb(l.traceDb, 5);
    const { streamer, calls } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    expect(calls).toEqual([]);
    expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 5 }]);
    scene.close();
  });

  it('fails clearly when neither trace file nor database exists', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    const { streamer, calls } = fakeStreamer();

    const err = await ingestScene(streamer, l).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).message).toContain(l.traceFile);
    expect(calls).toEqual([]);
  });

  it('creates the scene directory only when it is about to write', async () => {
    const parent = makeDir();
    const root = join(parent, 'scene');
    const traceFile = join(parent, 'capture.htrace');
    writeFileSync(traceFile, 'fake');
    const layout: SceneLayout = {
      root,
      traceFile,
      traceDb: join(root, 'trace.db'),
      redundantFile: join(root, 'redundant_file.txt'),
      jsheapFile: join(root, 'jsheap.heapsnapshot'),
      procfsFile: join(root, 'procfs.jsonl'),
      hidumperFile: join(root, 'hidumper.json'),
      hilogFile: join(root, 'hilog.log'),
      hilogJsonlFile: join(root, 'hilog.jsonl'),
      uiFile: join(root, 'ui.json'),
      screenshotFile: join(root, 'screenshot.png'),
      metadataFile: join(root, 'scene.json'),
    };
    const { streamer, calls } = fakeStreamer();

    expect(existsSync(root)).toBe(false);
    const scene = await ingestScene(streamer, layout);
    expect(existsSync(root)).toBe(true);
    expect(calls).toEqual([[traceFile, layout.traceDb]]);
    scene.close();
  });

  it('converts perf.data into perf.db and opens both handles', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    writeFileSync(l.perfFile!, 'perf');
    const converted: string[] = [];
    const streamer = {
      async convert(_input: string, output: string): Promise<void> {
        converted.push(output);
        const db = new DatabaseSync(output);
        if (output === l.perfDb) {
          db.exec('CREATE TABLE perf_sample(id INT)');
          db.exec('INSERT INTO perf_sample VALUES (0)');
        } else {
          db.exec(FRAME_SLICE_DDL);
        }
        db.close();
      },
    } as unknown as Streamer;

    const scene = await ingestScene(streamer, l);
    try {
      expect(converted).toEqual([l.traceDb, l.perfDb]);
      expect(scene.perfDb).toBeDefined();
      expect(scene.perfDb!.query('SELECT COUNT(*) AS n FROM perf_sample')).toEqual([{ n: 1 }]);
    } finally {
      scene.close();
    }
  });

  it('leaves perfDb undefined when the scene has no perf.data', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    const { streamer } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    try {
      expect(scene.perfDb).toBeUndefined();
    } finally {
      scene.close();
    }
  });

  it('does not create the scene directory on the read-only path', async () => {
    const parent = makeDir();
    const root = join(parent, 'never-created');
    const dbPath = join(parent, 'existing.db');
    createDb(dbPath, 9);
    const layout: SceneLayout = {
      root,
      traceFile: join(root, 'trace.htrace'),
      traceDb: dbPath,
      redundantFile: join(root, 'redundant_file.txt'),
      jsheapFile: join(root, 'jsheap.heapsnapshot'),
      procfsFile: join(root, 'procfs.jsonl'),
      hidumperFile: join(root, 'hidumper.json'),
      hilogFile: join(root, 'hilog.log'),
      hilogJsonlFile: join(root, 'hilog.jsonl'),
      uiFile: join(root, 'ui.json'),
      screenshotFile: join(root, 'screenshot.png'),
      metadataFile: join(root, 'scene.json'),
    };
    const { streamer, calls } = fakeStreamer();

    const scene = await ingestScene(streamer, layout);
    expect(calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 9 }]);
    scene.close();
  });
});

describe('Scene', () => {
  it('exposes the root directory and delegates query with params', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    const { streamer } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    expect(scene.dir).toBe(dir);
    expect(scene.traceDb.path).toBe(l.traceDb);
    expect(
      scene.query<{ ts: number }>('SELECT ts FROM frame_slice WHERE id = ?', [0]),
    ).toEqual([{ ts: 1 }]);
    scene.close();
  });

  it('constructs directly from a layout and an open handle', () => {
    const dir = makeDir();
    const dbPath = join(dir, 'direct.db');
    createDb(dbPath, 3);
    const layout = createSceneLayout(dir);
    const handle = {
      path: dbPath,
      query: <T,>() => [{ ts: 3 }] as unknown as T[],
      close: () => {},
    };
    const scene = new Scene(layout, handle);
    expect(scene.dir).toBe(dir);
    expect(scene.query<{ ts: number }>('SELECT 1')).toEqual([{ ts: 3 }]);
    scene.close();
  });

  it('closes idempotently', async () => {
    const dir = makeDir();
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    const { streamer } = fakeStreamer();

    const scene = await ingestScene(streamer, l);
    scene.close();
    expect(() => scene.close()).not.toThrow();
  });
});
