import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenshotCollector, DEVICE_SCREENSHOT_PATH } from '../src/collectors/screenshot';
import { createSceneLayout, type SceneLayout } from '../src/ingest/scene';
import { OhosPerfError } from '../src/errors';
import { encodePng, type RgbaImage } from '../src/image/png';
import type { Hdc } from '../src/transport/hdc';

const SAVED = `ScreenCap saved to ${DEVICE_SCREENSHOT_PATH}\n`;

/** A 2x1 PNG: the smallest image that still proves the dimensions are read. */
const IMAGE: RgbaImage = {
  width: 2,
  height: 1,
  data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
};
const PNG = encodePng(IMAGE);

describe('ScreenshotCollector', () => {
  let dir: string;
  let layout: SceneLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohosperf-screen-'));
    layout = createSceneLayout(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function fakeHdc(opts: {
    output?: string;
    code?: number;
    bytes?: number;
    payload?: Uint8Array;
    throwOnCap?: Error;
  } = {}): { hdc: Hdc; calls: string[]; recvTo: string[] } {
    const calls: string[] = [];
    const recvTo: string[] = [];
    const bytes = opts.bytes ?? PNG.length;
    const hdc = {
      async shell(_target: string, cmd: string) {
        calls.push(cmd);
        if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.startsWith('ls -l')) {
          return {
            stdout: bytes === 0
              ? `ls: ${DEVICE_SCREENSHOT_PATH}: No such file or directory`
              : `-rw-r--r-- 1 shell shell ${bytes} ${DEVICE_SCREENSHOT_PATH}`,
            stderr: '',
            code: bytes === 0 ? 1 : 0,
          };
        }
        if (opts.throwOnCap !== undefined) throw opts.throwOnCap;
        return { stdout: opts.output ?? SAVED, stderr: '', code: opts.code ?? 0 };
      },
      async recv(_target: string, _from: string, to: string) {
        recvTo.push(to);
        writeFileSync(to, opts.payload ?? PNG);
      },
    };
    return { hdc: hdc as unknown as Hdc, calls, recvTo };
  }

  it('captures, transfers and reports the image dimensions', async () => {
    const { hdc, calls, recvTo } = fakeHdc();
    const result = await new ScreenshotCollector().collect(hdc, 'dev', {}, layout);

    expect(calls[0]).toBe(`rm -f ${DEVICE_SCREENSHOT_PATH}`);
    expect(calls[1]).toBe(`uitest screenCap -p ${DEVICE_SCREENSHOT_PATH}`);
    expect(calls[2]).toBe(`ls -l ${DEVICE_SCREENSHOT_PATH}`);
    expect(recvTo).toEqual([layout.screenshotFile]);
    expect(result).toEqual({ width: 2, height: 1, bytes: PNG.length });
    expect(existsSync(layout.screenshotFile)).toBe(true);
    expect([...readFileSync(layout.screenshotFile)]).toEqual([...PNG]);
  });

  it('requires the ScreenCap marker', async () => {
    const { hdc, recvTo } = fakeHdc({ output: 'error: ability manager refused\n' });
    const err = await new ScreenshotCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('SCREENSHOT_FAILED');
    expect(recvTo).toEqual([]);
    expect(existsSync(layout.screenshotFile)).toBe(false);
  });

  it('fails when the device produced no file', async () => {
    const { hdc } = fakeHdc({ bytes: 0 });
    const err = await new ScreenshotCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('SCREENSHOT_NO_OUTPUT');
  });

  it('rejects a payload that is not a PNG and removes it', async () => {
    const { hdc } = fakeHdc({ payload: new Uint8Array([1, 2, 3, 4]) });
    const err = await new ScreenshotCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('SCREENSHOT_BAD_PNG');
    expect(existsSync(layout.screenshotFile)).toBe(false);
  });

  it('wraps a transport failure in a typed error', async () => {
    const { hdc } = fakeHdc({
      throwOnCap: new OhosPerfError('device offline', { code: 'HDC_SHELL_FAILED' }),
    });
    const err = await new ScreenshotCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).message).toMatch(/screenCap failed/);
    expect((err as OhosPerfError).message).toMatch(/device offline/);
  });
});
