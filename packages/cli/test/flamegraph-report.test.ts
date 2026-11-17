import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { realDeps } from '../src/deps';

/*
 * `report` on a scene that carries perf samples writes the offline flamegraph
 * beside the six document artifacts. The scene here is the minimal trace
 * fixture `report-deps.test.ts` uses, plus a `perf.db` with two stacks.
 *
 * The sample-less fixture in `report-deps.test.ts` is the regression test for
 * the other half of the rule: no samples, no flamegraph, and no failure.
 */

const SIX = [
  'report.html', 'report.json', 'summary.json',
  'metrics.csv', 'evidence.csv', 'report.xlsx',
];

const APP = 'com.demo';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `trace.db`: one process (pid 4999) and two frame slices, as in `report-deps`. */
function createTraceDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  db.exec(`INSERT INTO frame_slice VALUES
    (0, 1000, 0, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 0),
    (1, 2000, 1, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 1)`);
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  db.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 1, 1, 2, 0)`);
  db.close();
}

/**
 * `perf.db`: thread 500 of pid 4999, two callchains weighted 5 and 3.
 *
 * Chain 10 is `main;dladdr`, chain 11 is `main;dlopen`. The symbols resolve
 * exactly through `perf_files.serial_id`, as a real capture's do.
 */
function createPerfDb(path: string, samples = true): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT, thread_name TEXT)`);
  db.exec(`INSERT INTO perf_thread VALUES (0, 500, 4999, 'main')`);
  db.exec(`CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT, thread_id INT,
    event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT, thread_state TEXT)`);
  if (samples) {
    db.exec(`INSERT INTO perf_sample VALUES
      (0, 10, 1000, 500, 5, 1, 1000, 0, 'S'),
      (1, 11, 1100, 500, 3, 1, 1100, 0, 'S')`);
  }
  db.exec(`CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT, ip INT,
    vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
    source_file_id INT, line_number INT)`);
  db.exec(`INSERT INTO perf_callchain VALUES
    (0, 10, 1, 0, 0, 0, 1, 0, 900, 0, 0),
    (1, 10, 0, 0, 0, 0, 2, 1, 901, 0, 0),
    (2, 11, 1, 0, 0, 0, 1, 0, 900, 0, 0),
    (3, 11, 0, 0, 0, 0, 2, 2, 902, 0, 0)`);
  db.exec(`CREATE TABLE perf_files(id INT, file_id INT, serial_id INT, symbol TEXT, path TEXT)`);
  db.exec(`INSERT INTO perf_files VALUES
    (0, 1, 0, 'main', '/system/bin/app_process'),
    (1, 2, 1, 'dladdr', '/system/lib/ld-musl.so'),
    (2, 2, 2, 'dlopen', '/system/lib/ld-musl.so')`);
  db.exec(`CREATE TABLE data_dict(id INT, data TEXT)`);
  db.exec(`INSERT INTO data_dict VALUES (900, 'main'), (901, 'dladdr'), (902, 'dlopen')`);
  db.close();
}

function scene(withSamples = true): { root: string; sceneDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-flamegraph-'));
  roots.push(root);
  const sceneDir = join(root, 'scene');
  mkdirSync(sceneDir);
  createTraceDb(join(sceneDir, 'trace.db'));
  createPerfDb(join(sceneDir, 'perf.db'), withSamples);
  return { root, sceneDir };
}

describe('realDeps().report — flamegraph', () => {
  it('writes both artifacts after the six documents when the scene has samples', async () => {
    const { root, sceneDir } = scene();
    const outDir = join(root, 'out');
    const result = await realDeps('0.11.0').report({ sceneDir, outDir, app: APP });

    expect(result.files).toEqual([...SIX, 'flamegraph.svg', 'flamegraph.html']);
    for (const file of ['flamegraph.svg', 'flamegraph.html']) {
      expect(existsSync(join(outDir, file)), file).toBe(true);
    }
  });

  it('draws the captured frames and stays inert', async () => {
    const { root, sceneDir } = scene();
    const outDir = join(root, 'out');
    await realDeps('0.11.0').report({ sceneDir, outDir, app: APP });

    const svg = readFileSync(join(outDir, 'flamegraph.svg'), 'utf8');
    expect(svg).toContain('dladdr');
    expect(svg).toContain('dlopen');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('href=');

    const html = readFileSync(join(outDir, 'flamegraph.html'), 'utf8');
    expect(html).toContain('com.demo');
    expect(html).not.toContain('<script');
  });

  it('writes neither file, and does not fail, when perf carries no samples', async () => {
    const { root, sceneDir } = scene(false);
    const outDir = join(root, 'out');
    const result = await realDeps('0.11.0').report({ sceneDir, outDir, app: APP });

    expect(result.files).toEqual(SIX);
    expect(existsSync(join(outDir, 'flamegraph.svg'))).toBe(false);
    expect(existsSync(join(outDir, 'flamegraph.html'))).toBe(false);
  });

  it('produces byte-identical flamegraph artifacts on two runs', async () => {
    const { root, sceneDir } = scene();
    const out1 = join(root, 'out1');
    const out2 = join(root, 'out2');
    await realDeps('0.11.0').report({ sceneDir, outDir: out1, app: APP });
    await realDeps('0.11.0').report({ sceneDir, outDir: out2, app: APP });

    for (const file of ['flamegraph.svg', 'flamegraph.html']) {
      expect(readFileSync(join(out2, file))).toEqual(readFileSync(join(out1, file)));
    }
  });
});
