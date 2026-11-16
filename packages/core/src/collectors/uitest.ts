import { existsSync, unlinkSync } from 'node:fs';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import { flattenUiTree, readUiTree, type UiNode } from '../query/ui';
import type { Hdc, HdcResult } from '../transport/hdc';
import { parseSize } from './hitrace';
import type { Collector } from './types';

/** Fixed device-side path; removed before and after every dump. */
export const DEVICE_UI_PATH = '/data/local/tmp/ohosperf_ui.json';

/** The marker `uitest dumpLayout` prints on success. */
const SAVED_MARKER = 'DumpLayout saved';

const DEFAULT_TIMEOUT_MS = 10_000;

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new OhosPerfError(
      `timeoutMs must be an integer of at least 1 (got ${String(timeoutMs)})`,
      { code: 'UITEST_BAD_TIMEOUT' },
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
 * Dump the on-screen UI tree and flatten it into `ui.json`.
 *
 * `uitest dumpLayout` writes a JSON document to the device and prints a
 * `DumpLayout saved` marker. The marker is required: hdc exits 0 even when
 * the ability manager refuses the request, so an exit code proves nothing.
 *
 * The order mirrors the other collectors — remove the fixed device path, run,
 * require the marker, require a non-empty file, then `recv`. The local file is
 * only written by the transfer, and it is removed again when the transferred
 * document is not JSON, so a failed dump never leaves a scene artifact that a
 * later analysis would mistake for this capture's screen.
 *
 * The dump is **not** app-filtered: it is the whole screen, including
 * `com.ohos.sceneboard` and the status bar. Callers filter with `ui.get`
 * (`bundleName`), which is why the flattening keeps `bundleName` on every row.
 */
export class UitestCollector implements Collector {
  readonly id = 'uitest';
  readonly provides: CapabilityId[] = ['ui.tree'];

  async collect(
    hdc: Hdc,
    target: string,
    opts: { timeoutMs?: number },
    layout: SceneLayout,
  ): Promise<UiNode[]> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimeout(timeoutMs);

    removeFile(layout.uiFile);
    await hdc.shell(target, `rm -f ${DEVICE_UI_PATH}`);

    let dump: HdcResult;
    try {
      dump = await hdc.shell(target, `uitest dumpLayout -p ${DEVICE_UI_PATH}`);
    } catch (err) {
      if (!isShellFailure(err)) throw err;
      throw new OhosPerfError(`uitest dumpLayout failed: ${err.message}`, {
        code: 'UITEST_DUMP_FAILED',
        cause: err,
      });
    }
    const output = `${dump.stdout}\n${dump.stderr}`;
    if (dump.code !== 0 || !output.includes(SAVED_MARKER)) {
      throw new OhosPerfError(
        `uitest dumpLayout did not report "${SAVED_MARKER}"` +
          ` (exit ${dump.code}: ${detail(dump)})`,
        { code: 'UITEST_DUMP_FAILED' },
      );
    }

    const listing = await hdc.shell(target, `ls -l ${DEVICE_UI_PATH}`);
    const size = parseSize(listing.stdout, DEVICE_UI_PATH);
    if (size === undefined || size <= 0) {
      throw new OhosPerfError(
        `uitest produced no output at ${DEVICE_UI_PATH}` +
          ` (${size === undefined ? 'file not found' : 'file is empty'});` +
          ` ls -l output: ${detail(listing)}`,
        { code: 'UITEST_NO_OUTPUT' },
      );
    }

    await hdc.recv(target, DEVICE_UI_PATH, layout.uiFile);
    const nodes = readUiTree(layout.uiFile);
    if (nodes === undefined) {
      removeFile(layout.uiFile);
      throw new OhosPerfError(
        `the UI tree at ${layout.uiFile} is not valid JSON;` +
          ' the dump was truncated or the device format changed',
        { code: 'UITEST_PARSE_FAILED' },
      );
    }
    return nodes;
  }
}

/** Re-exported so a caller that only needs the flattening can reach it. */
export { flattenUiTree };
