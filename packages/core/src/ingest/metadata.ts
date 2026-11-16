import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { SceneLayout } from './scene';

/**
 * The human- and machine-readable description of one captured scene.
 *
 * `startedAtNs` is device uptime in nanoseconds (read from `/proc/uptime`), the
 * same clock base as trace `ts` values — never host `Date.now()`. It is the
 * start marker the startup analyzer falls back to when `app_startup` is empty.
 * `capture.startedAtMs` is host wall-clock and exists for humans only.
 */
export interface SceneMetadata {
  version: 1;
  app: { packageName: string; processNames: string[] };
  pids: number[];
  deviceId: string;
  startedAtNs?: number;
  capture?: {
    startedAtMs: number;
    durationMs: number;
    collectors: string[];
    /**
     * Present only when a hiperf capture ran. `samples` may be 0: an idle app
     * yields no samples, which is a real capture, not a missing one.
     */
    hiperf?: { samples: number };
    /**
     * Present only when a hidumper capture ran. `frames` may be 0: a screen
     * that presented nothing is a measurement, not a missing capture.
     */
    hidumper?: { frames: number };
    /**
     * Present only when a uitest capture ran. `nodes` may be 0: a blank screen
     * is a measurement, not a missing capture.
     */
    uitest?: { nodes: number };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isApp(value: unknown): value is SceneMetadata['app'] {
  return (
    isRecord(value) &&
    typeof value.packageName === 'string' &&
    isStringArray(value.processNames)
  );
}

/**
 * A count is a non-negative integer. Fractional or negative counts describe
 * nothing a collector can produce, so the descriptor is untrustworthy.
 */
function isCountRecord(
  value: unknown,
  key: 'samples' | 'frames' | 'nodes',
): value is Record<typeof key, number> {
  return isRecord(value) && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0;
}

function isCapture(value: unknown): value is NonNullable<SceneMetadata['capture']> {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startedAtMs) &&
    isFiniteNumber(value.durationMs) &&
    isStringArray(value.collectors) &&
    (value.hiperf === undefined || isCountRecord(value.hiperf, 'samples')) &&
    (value.hidumper === undefined || isCountRecord(value.hidumper, 'frames')) &&
    (value.uitest === undefined || isCountRecord(value.uitest, 'nodes'))
  );
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => isFiniteNumber(entry));
}

/**
 * Writes `scene.json` next to the other scene artifacts.
 *
 * The scene root is created when needed. The file is pretty-printed with two
 * spaces and ends with one newline so it is diff-friendly and byte-stable.
 */
export function writeSceneMetadata(layout: SceneLayout, meta: SceneMetadata): void {
  mkdirSync(layout.root, { recursive: true });
  writeFileSync(layout.metadataFile, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Reads a scene's `scene.json`, or `undefined` when it cannot be trusted.
 *
 * A missing file, invalid JSON, a non-object document, a `version` other than
 * `1`, or a document missing the required fields all yield `undefined`: a
 * partially valid description would be worse than none. `startedAtNs` is
 * optional, but a non-positive (including zero) or non-finite value is dropped
 * from the result (the file itself is never rewritten) so consumers can treat
 * "no marker" as one case. Uptime 0 addresses the trace origin, not the capture
 * start, so accepting it would only produce a nonsense startup duration.
 */
export function readSceneMetadata(layout: SceneLayout): SceneMetadata | undefined {
  if (!existsSync(layout.metadataFile)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(layout.metadataFile, 'utf8'));
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  if (!isApp(parsed.app) || !isNumberArray(parsed.pids)) return undefined;
  // Only the type is required: an empty device id is unusual but valid, and
  // rejecting it would make `writeSceneMetadata` able to produce a file that
  // `readSceneMetadata` refuses.
  if (typeof parsed.deviceId !== 'string') return undefined;
  if (parsed.capture !== undefined && !isCapture(parsed.capture)) {
    return undefined;
  }

  const metadata: SceneMetadata = {
    version: 1,
    app: {
      packageName: parsed.app.packageName,
      processNames: [...parsed.app.processNames],
    },
    pids: [...parsed.pids],
    deviceId: parsed.deviceId,
  };
  if (parsed.capture !== undefined) {
    metadata.capture = {
      startedAtMs: parsed.capture.startedAtMs,
      durationMs: parsed.capture.durationMs,
      collectors: [...parsed.capture.collectors],
      ...(parsed.capture.hiperf === undefined
        ? {}
        : { hiperf: { samples: parsed.capture.hiperf.samples } }),
      ...(parsed.capture.hidumper === undefined
        ? {}
        : { hidumper: { frames: parsed.capture.hidumper.frames } }),
      ...(parsed.capture.uitest === undefined
        ? {}
        : { uitest: { nodes: parsed.capture.uitest.nodes } }),
    };
  }
  if (isFiniteNumber(parsed.startedAtNs) && parsed.startedAtNs > 0) {
    metadata.startedAtNs = parsed.startedAtNs;
  }
  return metadata;
}
