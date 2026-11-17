import { existsSync, readFileSync, statSync } from 'node:fs';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc, HdcResult } from '../transport/hdc';
import type { Collector } from './types';

/**
 * JS heap snapshot capture (HapRay parity row 20).
 *
 * `hidumper --mem-jsheap <pid> -T <pid>` asks the app to write a
 * `.heapsnapshot` into its own leak directory, which takes up to 30 s for a
 * real app. The newest snapshot is then pulled into `jsheap.heapsnapshot`.
 *
 * Capture only: neither HapRay's Python pipeline nor this package analyzes the
 * snapshot. It is an opaque artifact a person opens in DevEco Studio. That is
 * the whole capability — and it is why the analyzer set has no consumer for
 * `js_heap_*`: there is nothing to analyze without a snapshot parser, and a
 * parser for a format only the IDE writes is not a measurement this package
 * can vouch for.
 *
 * The device-side leak directory is per-app and its name is not stable across
 * builds, so the collector asks the device for the newest `.heapsnapshot`
 * rather than guessing a path.
 */

/** Where HarmonyOS writes heap snapshots, relative to the app's data dir. */
const DEVICE_SNAPSHOT_DIR = '/data/app/el2/100/base';

/** How long the device gets to write the snapshot (HapRay waits 30 s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How often to look for the file while the device is writing it. */
const POLL_MS = 1_000;

/** What a successful capture produced, for `scene.json`. */
export interface JsheapCapture {
  readonly bytes: number;
  /** The device-side path the snapshot was pulled from. */
  readonly devicePath: string;
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new OhosPerfError(
      `timeoutMs must be an integer of at least 1 (got ${String(timeoutMs)})`,
      { code: 'JSHEAP_BAD_TIMEOUT' },
    );
  }
}

/** Device output excerpt for an error message; both streams are diagnostics. */
function detail(result: HdcResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? '(no output)' : lines.slice(0, 5).join(' | ');
}

/**
 * The newest `.heapsnapshot` under the app's data directory, or `undefined`.
 *
 * `find` is given a bounded depth: a heap snapshot is written under the app's
 * files directory, and an unbounded search of `/data/app` would take minutes
 * on a device with many installed apps.
 */
function findNewestSnapshot(hdc: Hdc, target: string, app: string): Promise<string | undefined> {
  return hdc
    .shell(
      target,
      `find ${DEVICE_SNAPSHOT_DIR}/${app} -maxdepth 6 -name '*.heapsnapshot'` +
        ' -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1',
    )
    .then((result) => {
      const line = result.stdout.trim();
      if (line === '') return undefined;
      const space = line.indexOf(' ');
      return space === -1 ? line : line.slice(space + 1).trim();
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture a JS heap snapshot into `jsheap.heapsnapshot`.
 *
 * A device that refuses `--mem-jsheap` — the usual reason is an app that is
 * not debug-signed — is a typed refusal carrying the device's own message,
 * never an empty file. The same applies to a command that succeeds but writes
 * nothing: the wait is bounded by `timeoutMs` and its expiry names what was
 * looked for.
 */
export class JsheapCollector implements Collector {
  readonly id = 'jsheap';
  readonly provides: CapabilityId[] = ['js.heap'];

  async collect(
    hdc: Hdc,
    target: string,
    opts: { app: string; timeoutMs?: number },
    layout: SceneLayout,
  ): Promise<JsheapCapture> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimeout(timeoutMs);
    if (opts.app === '') {
      throw new OhosPerfError(
        'a JS heap snapshot needs the app package name to locate its data directory',
        { code: 'JSHEAP_NO_APP' },
      );
    }

    const pid = await hdc.shell(target, `pidof ${opts.app}`);
    const pidText = pid.stdout.trim().split(/\s+/)[0] ?? '';
    if (pid.code !== 0 || !/^\d+$/.test(pidText)) {
      throw new OhosPerfError(
        `${opts.app} is not running, so there is no heap to snapshot` +
          ` (pidof: ${detail(pid)})`,
        { code: 'JSHEAP_NO_PID' },
      );
    }

    const dump = await hdc.shell(target, `hidumper --mem-jsheap ${pidText} -T ${pidText}`);
    if (dump.code !== 0) {
      throw new OhosPerfError(
        `hidumper --mem-jsheap ${pidText} failed (exit ${dump.code}: ${detail(dump)});` +
          ' the app must be debug-signed or profilerable',
        { code: 'JSHEAP_UNSUPPORTED' },
      );
    }

    // The write is asynchronous on the device: poll until the file appears or
    // the deadline passes. A snapshot that never appears is the failure mode
    // this loop exists to make visible rather than to hang on.
    const deadline = Date.now() + timeoutMs;
    let devicePath: string | undefined;
    for (;;) {
      devicePath = await findNewestSnapshot(hdc, target, opts.app);
      if (devicePath !== undefined) break;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }
    if (devicePath === undefined) {
      throw new OhosPerfError(
        `no .heapsnapshot appeared under ${DEVICE_SNAPSHOT_DIR}/${opts.app}` +
          ` within ${timeoutMs} ms of a successful hidumper; the device may need` +
          ' more time, or the app may refuse to write one',
        { code: 'JSHEAP_NO_OUTPUT' },
      );
    }

    await hdc.recv(target, devicePath, layout.jsheapFile);
    if (!existsSync(layout.jsheapFile)) {
      throw new OhosPerfError(
        `the heap snapshot transfer wrote nothing at ${layout.jsheapFile}`,
        { code: 'JSHEAP_NO_OUTPUT' },
      );
    }
    const bytes = statSync(layout.jsheapFile).size;
    if (bytes === 0) {
      throw new OhosPerfError(
        `the heap snapshot at ${layout.jsheapFile} is empty`,
        { code: 'JSHEAP_NO_OUTPUT' },
      );
    }
    return { bytes, devicePath };
  }
}

/** The snapshot's bytes, for a caller that wants to hash or inspect it. */
export function readJsheapSnapshot(layout: SceneLayout): Uint8Array | undefined {
  if (!existsSync(layout.jsheapFile)) return undefined;
  return new Uint8Array(readFileSync(layout.jsheapFile));
}
