import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { parseHiprofilerPlugins } from '../src/device/probe';
import { readSceneMetadata } from '../src/ingest/metadata';
import { createSceneLayout } from '../src/ingest/scene';

/**
 * Real-device acceptance for the hiprofiler collector.
 *
 * The recorded probe below is committed, so the plugin-list assertion runs
 * everywhere. The capture test is skipped unless an hdc target is attached.
 */

const FIXTURE = 'test/fixtures/probe-mate60-hiprofiler.txt';

/** The fixture format used by `probe-*.txt`: `command<TAB>stdout-with-\n`. */
function fixtureStdout(path: string, command: string): string | undefined {
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const [cmd, ...rest] = line.split('\t');
    if (cmd === command) return rest.join('\t').replace(/\\n/g, '\n');
  }
  return undefined;
}

/**
 * Resolve an hdc binary with at least one connected target.
 *
 * The repo's test environment may have no device at all, so every failure
 * (missing binary, timeout, empty target list) means "skip", not "fail".
 */
function attachedHdc(): string | undefined {
  const candidates = [
    process.env.OHOS_PERF_HDC,
    process.platform === 'win32'
      ? 'D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
      : undefined,
    'hdc',
  ].filter((path): path is string => path !== undefined);

  for (const hdc of candidates) {
    try {
      const out = execFileSync(hdc, ['list', 'targets'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const targets = out.split(/\r?\n/).filter((line) => {
        const text = line.trim();
        return text !== '' && !text.includes('[Empty]');
      });
      if (targets.length > 0) return hdc;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const HDC = attachedHdc();

describe('recorded Mate 60 hiprofiler probe', () => {
  it('lists every plugin the collector drives', () => {
    const output = fixtureStdout(FIXTURE, 'hiprofiler_cmd --list');
    expect(output, `missing hiprofiler_cmd --list in ${FIXTURE}`).toBeDefined();
    expect(parseHiprofilerPlugins(output!)).toEqual(
      expect.arrayContaining([
        'ftrace-plugin', 'gpu-plugin', 'xpower-plugin', 'nativehook',
      ]),
    );
  });
});

describe.skipIf(HDC === undefined)('hiprofiler on an attached device', () => {
  it('captures 3 s with the ftrace plugin and converts sched_slice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-device-'));
    const target = process.env.OHOS_PERF_TARGET;
    try {
      const device = await connect({
        ...(HDC === undefined ? {} : { hdcPath: HDC }),
        ...(target === undefined ? {} : { target }),
      });
      // `app` is recorded in scene.json only; ftrace does not filter by it.
      const session = await device.collect({
        app: 'com.example.app',
        durationMs: 3000,
        sceneRoot: root,
        hiprofiler: { plugins: ['ftrace'] },
      });
      const scene = await session.ingest();
      try {
        const rows = scene.traceDb.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM sched_slice',
        );
        expect(rows[0].n).toBeGreaterThan(0);
        const meta = readSceneMetadata(createSceneLayout(root));
        expect(meta?.capture?.collectors).toEqual(['hiprofiler']);
      } finally {
        scene.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);
});
