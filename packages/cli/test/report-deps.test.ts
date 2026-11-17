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

describe('realDeps().trend', () => {
  /** Two report bundles from the same scene, so the runs are comparable. */
  async function bundles(root: string): Promise<{ a: string; b: string }> {
    const a = join(root, 'run-a');
    const b = join(root, 'run-b');
    const deps = realDeps('0.4.0');
    await deps.report({ sceneDir: join(root, 'scene'), outDir: a });
    await deps.report({ sceneDir: join(root, 'scene'), outDir: b });
    return { a, b };
  }

  it('reads two saved bundles and writes trend.html and trend.json', async () => {
    const { root } = scene();
    const { a, b } = await bundles(root);
    const outDir = join(root, 'trend');

    const result = await realDeps('0.4.0').trend({
      reports: [{ label: 'v1', path: a }, { label: 'v2', path: b }],
      outDir,
    });

    expect(result.files).toEqual(['trend.html', 'trend.json']);
    expect(result.runs.map((run) => run.label)).toEqual(['v1', 'v2']);
    expect(result.series).toBeGreaterThan(0);
    expect(readFileSync(join(outDir, 'trend.html'), 'utf8')).toContain('frame.count');
    const trend = JSON.parse(readFileSync(join(outDir, 'trend.json'), 'utf8'));
    expect(trend.runs).toHaveLength(2);
  });

  it('accepts the report.json path as well as the bundle directory', async () => {
    const { root } = scene();
    const { a, b } = await bundles(root);
    const result = await realDeps('0.4.0').trend({
      reports: [{ path: join(a, 'report.json') }, { path: join(b, 'report.json') }],
      outDir: join(root, 'trend2'),
    });
    // An unnamed run is labelled by the path it was read from.
    expect(result.runs[0].label).toBe(join(a, 'report.json'));
  });

  it('refuses a path that is not a report document', async () => {
    const { root } = scene();
    const { a } = await bundles(root);
    const bogus = join(root, 'bogus.json');
    writeFileSync(bogus, '{"metrics":[],"evidence":[]}');

    await expect(
      realDeps('0.4.0').trend({
        reports: [{ path: a }, { path: bogus }],
        outDir: join(root, 'trend3'),
      }),
    ).rejects.toThrow(/not a report document/);
    expect(existsSync(join(root, 'trend3'))).toBe(false);
  });

  it('refuses a missing report before writing anything', async () => {
    const { root } = scene();
    const { a } = await bundles(root);
    await expect(
      realDeps('0.4.0').trend({
        reports: [{ path: a }, { path: join(root, 'absent') }],
        outDir: join(root, 'trend4'),
      }),
    ).rejects.toThrow(/cannot read report/);
    expect(existsSync(join(root, 'trend4'))).toBe(false);
  });
});

describe('realDeps().render', () => {
  it('re-renders a saved bundle byte for byte, without the scene', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.4.0');
    const saved = join(root, 'saved');
    await deps.report({ sceneDir, outDir: saved });

    // Move the scene away: a re-render must not need it.
    rmSync(sceneDir, { recursive: true, force: true });

    const outDir = join(root, 'again');
    const result = await deps.render({ report: saved, outDir });

    expect(result.files).toEqual(FILES);
    for (const file of ['report.html', 'report.json', 'summary.json', 'metrics.csv', 'evidence.csv']) {
      expect(readFileSync(join(outDir, file))).toEqual(readFileSync(join(saved, file)));
    }
    expect(readFileSync(join(outDir, 'report.xlsx'))).toEqual(readFileSync(join(saved, 'report.xlsx')));
  });

  it('carries the bundle screenshot across, so the page never links a missing image', async () => {
    // A saved bundle with a screenshot has `assets/screenshot.png` and a page
    // that points at it. Re-rendering the page from the model would reproduce
    // the <img> — the copy has to come too, or the page renders a broken icon.
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
    const deps = realDeps('0.9.0');
    const saved = join(root, 'shot-bundle');
    await deps.report({ sceneDir, outDir: saved });
    rmSync(sceneDir, { recursive: true, force: true });

    const outDir = join(root, 'shot-again');
    const result = await deps.render({ report: saved, outDir });

    expect(result.files).toContain('assets/screenshot.png');
    expect(readFileSync(join(outDir, 'assets', 'screenshot.png')))
      .toEqual(readFileSync(join(saved, 'assets', 'screenshot.png')));
    expect(readFileSync(join(outDir, 'report.html'), 'utf8'))
      .toContain('<img src="assets/screenshot.png"');
  });

  it('accepts the report.json path directly', async () => {
    const { root, sceneDir } = scene();
    const deps = realDeps('0.4.0');
    const saved = join(root, 'saved2');
    await deps.report({ sceneDir, outDir: saved });

    const result = await deps.render({
      report: join(saved, 'report.json'),
      outDir: join(root, 'again2'),
    });
    expect(result.files).toEqual(FILES);
  });

  it('refuses a document that is not a report', async () => {
    const { root } = scene();
    const bogus = join(root, 'bogus.json');
    writeFileSync(bogus, '{"metrics":[],"evidence":[]}');
    await expect(
      realDeps('0.4.0').render({ report: bogus, outDir: join(root, 'x') }),
    ).rejects.toThrow(/not a report document/);
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  it('refuses a missing report before writing anything', async () => {
    const { root } = scene();
    await expect(
      realDeps('0.4.0').render({ report: join(root, 'absent'), outDir: join(root, 'y') }),
    ).rejects.toThrow(/cannot read report/);
    expect(existsSync(join(root, 'y'))).toBe(false);
  });
});
