import { readFileSync, unlinkSync } from 'node:fs';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import { decodePng } from '../image/png';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc, HdcResult } from '../transport/hdc';
import { parseSize } from './hitrace';
import type { Collector } from './types';

/** Fixed device-side path; removed before and after every capture. */
export const DEVICE_SCREENSHOT_PATH = '/data/local/tmp/ohosperf_screen.png';

/** The marker `uitest screenCap` prints on success. */
const SAVED_MARKER = 'ScreenCap saved to';

const DEFAULT_TIMEOUT_MS = 10_000;

/** What a successful capture produced, for `scene.json`. */
export interface ScreenshotCapture {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new OhosPerfError(
      `timeoutMs must be an integer of at least 1 (got ${String(timeoutMs)})`,
      { code: 'SCREENSHOT_BAD_TIMEOUT' },
    );
  }
}

/** Device output excerpt for an error message; both streams are diagnostics. */
function detail(result: HdcResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, 5).join(' | ');
  return lines.length > 5 ? `${shown} | ... (${lines.length - 5} more lines)` : shown;
}

function isShellFailure(err: unknown): err is OhosPerfError {
  return err instanceof OhosPerfError && err.code === 'HDC_SHELL_FAILED';
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
}

/**
 * Capture a screenshot into `screenshot.png`.
 *
 * `uitest screenCap -p <path>` writes the PNG on the device and prints
 * `ScreenCap saved to <path>`. The marker is required for the same reason the
 * UI dump requires its own: hdc exits 0 even when the device tool refuses, so
 * an exit code proves nothing.
 *
 * The order mirrors the other collectors — remove the fixed device path, run,
 * require the marker, require a non-empty file, `recv`, then verify. The
 * verification here is a full decode: a truncated transfer is the failure this
 * collector exists to catch, and a PNG whose dimensions cannot be read is not a
 * screenshot. A failed capture never leaves `screenshot.png` behind, so a later
 * analysis cannot mistake the previous screen for this capture's.
 */
export class ScreenshotCollector implements Collector {
  readonly id = 'screenshot';
  readonly provides: CapabilityId[] = ['ui.capture'];

  async collect(
    hdc: Hdc,
    target: string,
    opts: { timeoutMs?: number },
    layout: SceneLayout,
  ): Promise<ScreenshotCapture> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimeout(timeoutMs);

    removeFile(layout.screenshotFile);
    await hdc.shell(target, `rm -f ${DEVICE_SCREENSHOT_PATH}`);

    let capture: HdcResult;
    try {
      capture = await hdc.shell(target, `uitest screenCap -p ${DEVICE_SCREENSHOT_PATH}`);
    } catch (err) {
      if (!isShellFailure(err)) throw err;
      throw new OhosPerfError(`uitest screenCap failed: ${err.message}`, {
        code: 'SCREENSHOT_FAILED',
        cause: err,
      });
    }
    const output = `${capture.stdout}\n${capture.stderr}`;
    if (capture.code !== 0 || !output.includes(SAVED_MARKER)) {
      throw new OhosPerfError(
        `uitest screenCap did not report "${SAVED_MARKER}"` +
          ` (exit ${capture.code}: ${detail(capture)})`,
        { code: 'SCREENSHOT_FAILED' },
      );
    }

    const listing = await hdc.shell(target, `ls -l ${DEVICE_SCREENSHOT_PATH}`);
    const size = parseSize(listing.stdout, DEVICE_SCREENSHOT_PATH);
    if (size === undefined || size <= 0) {
      throw new OhosPerfError(
        `uitest produced no screenshot at ${DEVICE_SCREENSHOT_PATH}` +
          ` (${size === undefined ? 'file not found' : 'file is empty'});` +
          ` ls -l output: ${detail(listing)}`,
        { code: 'SCREENSHOT_NO_OUTPUT' },
      );
    }

    await hdc.recv(target, DEVICE_SCREENSHOT_PATH, layout.screenshotFile);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(layout.screenshotFile));
    } catch (err) {
      throw new OhosPerfError(
        `the screenshot transfer wrote nothing at ${layout.screenshotFile}`,
        { code: 'SCREENSHOT_NO_OUTPUT', cause: err },
      );
    }
    try {
      const image = decodePng(bytes);
      return { width: image.width, height: image.height, bytes: bytes.length };
    } catch (err) {
      removeFile(layout.screenshotFile);
      throw new OhosPerfError(
        `the screenshot at ${layout.screenshotFile} is not a readable PNG:` +
          ` ${(err as Error).message}`,
        { code: 'SCREENSHOT_BAD_PNG', cause: err },
      );
    }
  }
}
