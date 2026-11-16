import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HilogCollector, readHilogText } from '../src/collectors/hilog';
import { createSceneLayout } from '../src/ingest/scene';
import type { Hdc } from '../src/transport/hdc';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-hilog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOG =
  '11-17 05:12:33.412  4999  5010 I A00000/com.demo/Image: hello\n' +
  '11-17 05:12:34.000  4999  5010 E A00000/com.demo: boom\n';

/** A structural Hdc fake with the one streaming method the collector uses. */
function fakeHdc(result: { stdout: string; stderr: string; code: number | null }): {
  hdc: Hdc;
  calls: Array<{ command: string; durationMs: number }>;
} {
  const calls: Array<{ command: string; durationMs: number }> = [];
  const hdc = {
    async shellFor(_target: string, command: string, durationMs: number) {
      calls.push({ command, durationMs });
      return result;
    },
  } as unknown as Hdc;
  return { hdc, calls };
}

describe('HilogCollector', () => {
  it('writes the streamed log to hilog.log and counts its lines', async () => {
    const { hdc, calls } = fakeHdc({ stdout: LOG, stderr: '', code: null });
    const layout = createSceneLayout(dir);
    const out = await new HilogCollector().collect(hdc, 'emu', { durationMs: 250 }, layout);

    expect(calls).toEqual([{ command: 'hilog', durationMs: 250 }]);
    expect(readFileSync(layout.hilogFile, 'utf8')).toBe(LOG);
    expect(out.lines).toBe(2);
  });

  it('throws HILOG_NO_OUTPUT when the device printed nothing', async () => {
    const { hdc } = fakeHdc({ stdout: '   \n', stderr: '', code: 0 });
    await expect(
      new HilogCollector().collect(hdc, 'emu', { durationMs: 10 }, createSceneLayout(dir)),
    ).rejects.toMatchObject({ code: 'HILOG_NO_OUTPUT' });
  });

  it('names the device stderr when the stream failed', async () => {
    const { hdc } = fakeHdc({ stdout: '', stderr: 'hilog: permission denied', code: 1 });
    await expect(
      new HilogCollector().collect(hdc, 'emu', { durationMs: 10 }, createSceneLayout(dir)),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects a bad duration before touching the device', async () => {
    const { hdc, calls } = fakeHdc({ stdout: LOG, stderr: '', code: null });
    await expect(
      new HilogCollector().collect(hdc, 'emu', { durationMs: 0 }, createSceneLayout(dir)),
    ).rejects.toMatchObject({ code: 'HILOG_BAD_DURATION' });
    expect(calls).toEqual([]);
  });

  it('removes a stale log before capturing', async () => {
    const layout = createSceneLayout(dir);
    writeFileSync(layout.hilogFile, 'stale from an earlier run\n');
    const { hdc } = fakeHdc({ stdout: '', stderr: '', code: 0 });
    await expect(
      new HilogCollector().collect(hdc, 'emu', { durationMs: 10 }, layout),
    ).rejects.toMatchObject({ code: 'HILOG_NO_OUTPUT' });
    expect(existsSync(layout.hilogFile)).toBe(false);
  });
});

describe('readHilogText', () => {
  it('returns undefined when the scene has no log', () => {
    expect(readHilogText(createSceneLayout(dir))).toBeUndefined();
  });

  it('returns the file text', () => {
    const layout = createSceneLayout(dir);
    writeFileSync(layout.hilogFile, LOG);
    expect(readHilogText(layout)).toBe(LOG);
  });
});
