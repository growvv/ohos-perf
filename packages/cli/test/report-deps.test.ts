import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodePng } from '@ohos-perf/core';
import { realDeps } from '../src/deps';

/**
 * Minimal trace database the analyzer can query; the same fixture `deps.test`
 * uses for `analyze`, kept local so this file is independent of its edits.
 */
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
  db.close();
}

const FILES = [
  'report.html', 'report.json', 'summary.json',
  'metrics.csv', 'evidence.csv', 'report.xlsx',
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp root holding `scene/trace.db`. */
function scene(): { root: string; sceneDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-report-'));
  roots.push(root);
  mkdirSync(join(root, 'scene'));
  createTraceDb(join(root, 'scene', 'trace.db'));
  return { root, sceneDir: join(root, 'scene') };
}

describe('realDeps().report', () => {
  it('writes the six artifacts and reruns byte-identically', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.4.0');
    const out1 = join(root, 'out1');
    const out2 = join(root, 'out2');

    const first = await deps.report({ sceneDir, outDir: out1 });
    expect(first.files).toEqual(FILES);
    for (const file of FILES) expect(existsSync(join(out1, file))).toBe(true);

    const second = await deps.report({ sceneDir, outDir: out2 });
    expect(second.files).toEqual(FILES);
    for (const file of FILES) {
      expect(readFileSync(join(out2, file))).toEqual(readFileSync(join(out1, file)));
    }
  });

  it('writes one CSV row per metric in the report model', async () => {
    const { root, sceneDir } = scene();
    const outDir = join(root, 'out');
    const result = await realDeps('0.4.0').report({ sceneDir, outDir });

    const model = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as {
      totals: { metrics: number };
      sections: Array<{ id: string; metrics: unknown[] }>;
    };
    const csv = readFileSync(join(outDir, 'metrics.csv'), 'utf8').trimEnd().split('\n');

    expect(model.totals.metrics).toBeGreaterThan(0);
    expect(csv).toHaveLength(model.totals.metrics + 1);
    expect(result.metrics).toBe(model.totals.metrics);
    // The minimal fixture cannot satisfy most capabilities, so the report must
    // label those sections degraded rather than dropping them.
    expect(result.sections.degraded).toBeGreaterThan(0);
    expect(model.sections.some((section) => section.metrics.length > 0)).toBe(true);
  });

  it('adds a typed comparison and the Compare sheet with --baseline', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.4.0');

    const plain = join(root, 'plain');
    await deps.report({ sceneDir, outDir: plain });

    const baseline = join(root, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(await deps.analyze(sceneDir)));

    const outDir = join(root, 'compared');
    const result = await deps.report({ sceneDir, outDir, baseline });
    expect(result.comparison).toBeDefined();

    const model = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as {
      comparison?: { totals: Record<string, number> };
    };
    expect(model.comparison?.totals).toEqual(result.comparison);
    expect(readFileSync(join(outDir, 'report.xlsx'))).not.toEqual(
      readFileSync(join(plain, 'report.xlsx')),
    );
  });

  it('copies the scene screenshot into assets/ and links it from the HTML', async () => {
    const { root, sceneDir } = scene();
    writeFileSync(join(sceneDir, 'screenshot.png'), encodePng({
      width: 5, height: 3, data: new Uint8Array(5 * 3 * 4).fill(90),
    }));
    writeFileSync(join(sceneDir, 'scene.json'), JSON.stringify({
      version: 1,
      app: { packageName: 'com.demo', processNames: ['com.demo'] },
      pids: [], deviceId: 't1',
      capture: {
        startedAtMs: 1, durationMs: 2, collectors: ['hitrace', 'screenshot'],
        screenshot: { width: 5, height: 3, bytes: 100 },
      },
    }));

    const outDir = join(root, 'with-shot');
    const result = await realDeps('0.9.0').report({ sceneDir, outDir });

    expect(result.files).toContain('assets/screenshot.png');
    expect(existsSync(join(outDir, 'assets', 'screenshot.png'))).toBe(true);
    expect(readFileSync(join(outDir, 'assets', 'screenshot.png')))
      .toEqual(readFileSync(join(sceneDir, 'screenshot.png')));
    expect(readFileSync(join(outDir, 'report.html'), 'utf8'))
      .toContain('<img src="assets/screenshot.png"');
  });

  it('writes no assets/ and no <img> when the scene has no screenshot', async () => {
    const { root, sceneDir } = scene();
    const outDir = join(root, 'no-shot');
    const result = await realDeps('0.9.0').report({ sceneDir, outDir });

    expect(result.files).toEqual(FILES);
    expect(existsSync(join(outDir, 'assets'))).toBe(false);
    expect(readFileSync(join(outDir, 'report.html'), 'utf8')).not.toContain('<img');
  });

  it('fails before writing anything when the baseline is malformed', async () => {
    const { root, sceneDir } = scene();
    const baseline = join(root, 'bad.json');
    writeFileSync(baseline, '{');

    const outDir = join(root, 'out-bad');
    await expect(
      realDeps('0.4.0').report({ sceneDir, outDir, baseline }),
    ).rejects.toThrow(/cannot read analysis/);
    expect(existsSync(outDir)).toBe(false);
  });
});
