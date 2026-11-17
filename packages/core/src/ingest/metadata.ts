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
export interface SceneStepRef {
  /** 1-based round within a scenario run. */
  readonly round: number;
  /** 0-based position of the step in the scenario's `steps` array. */
  readonly index: number;
  readonly id: string;
}

export interface SceneMetadata {
  version: 1;
  app: { packageName: string; processNames: string[] };
  pids: number[];
  deviceId: string;
  startedAtNs?: number;
  /**
   * Present only when the scene was captured by a scenario step. A scene
   * copied out of a run therefore still says which step produced it, without
   * needing the run's `steps.json` beside it.
   */
  step?: SceneStepRef;
  capture?: {
    startedAtMs: number;
    durationMs: number;
    collectors: string[];
    /**
     * Present only when a hiperf capture ran. `samples` may be 0: an idle app
     * yields no samples, which is a real capture, not a missing one.
     */
    hiperf?: {
      samples: number;
      /**
       * Present only when the capture passed a symbol directory. `true` means
       * symbolization was *requested* — the converter was given `--So_dir` —
       * not that every frame came back named; a directory missing the app's
       * libraries still leaves addresses. Absent means the scene did not
       * record the attempt, which is not the same as "no".
       */
      symbolized?: boolean;
    };
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
    /**
     * Present only when a screenshot capture ran. `bytes` is the size of
     * `screenshot.png`; a capture that produced a zero-byte or undecodable file
     * is a failure, so the counts here are always positive.
     */
    screenshot?: { width: number; height: number; bytes: number };
    /**
     * Present only when a hilog capture ran. `lines` may be 0 only if the
     * collector succeeded on an empty stream, which it treats as a failure;
     * the field records the count the collector reported.
     */
    hilog?: { lines: number };
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
  key: 'samples' | 'frames' | 'nodes' | 'lines',
): value is Record<typeof key, number> {
  return isRecord(value) && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0;
}

/**
 * A hiperf descriptor is a non-negative sample count, plus an optional
 * `symbolized` boolean. A present-but-non-boolean value makes the whole
 * descriptor untrustworthy: the reader would otherwise have to guess whether
 * a string `"true"` meant the capture was symbolized.
 */
function isHiperfRecord(
  value: unknown,
): value is { samples: number; symbolized?: boolean } {
  return (
    isCountRecord(value, 'samples') &&
    ((value as { symbolized?: unknown }).symbolized === undefined ||
      typeof (value as { symbolized?: unknown }).symbolized === 'boolean')
  );
}

/**
 * A screenshot descriptor is three positive integers: an image with no pixels
 * or no bytes is not one the collector can produce, so it is untrustworthy.
 */
function isScreenshotRecord(
  value: unknown,
): value is { width: number; height: number; bytes: number } {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.width) && (value.width as number) > 0 &&
    Number.isSafeInteger(value.height) && (value.height as number) > 0 &&
    Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0
  );
}

function isCapture(value: unknown): value is NonNullable<SceneMetadata['capture']> {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startedAtMs) &&
    isFiniteNumber(value.durationMs) &&
    isStringArray(value.collectors) &&
    (value.hiperf === undefined || isHiperfRecord(value.hiperf)) &&
    (value.hidumper === undefined || isCountRecord(value.hidumper, 'frames')) &&
    (value.uitest === undefined || isCountRecord(value.uitest, 'nodes')) &&
    (value.screenshot === undefined || isScreenshotRecord(value.screenshot)) &&
    (value.hilog === undefined || isCountRecord(value.hilog, 'lines'))
  );
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => isFiniteNumber(entry));
}

/**
 * A step reference is 1-based in `round` and 0-based in `index`: a round 0 or
 * a negative index describes no position, so the descriptor is untrustworthy.
 */
function isStepRef(value: unknown): value is SceneStepRef {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.round) && (value.round as number) >= 1 &&
    Number.isSafeInteger(value.index) && (value.index as number) >= 0 &&
    typeof value.id === 'string' && value.id !== ''
  );
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
  if (parsed.step !== undefined && !isStepRef(parsed.step)) {
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
        : {
            hiperf: {
              samples: parsed.capture.hiperf.samples,
              ...(parsed.capture.hiperf.symbolized === undefined
                ? {}
                : { symbolized: parsed.capture.hiperf.symbolized }),
            },
          }),
      ...(parsed.capture.hidumper === undefined
        ? {}
        : { hidumper: { frames: parsed.capture.hidumper.frames } }),
      ...(parsed.capture.uitest === undefined
        ? {}
        : { uitest: { nodes: parsed.capture.uitest.nodes } }),
      ...(parsed.capture.screenshot === undefined
        ? {}
        : {
            screenshot: {
              width: parsed.capture.screenshot.width,
              height: parsed.capture.screenshot.height,
              bytes: parsed.capture.screenshot.bytes,
            },
          }),
      ...(parsed.capture.hilog === undefined
        ? {}
        : { hilog: { lines: parsed.capture.hilog.lines } }),
    };
  }
  if (isFiniteNumber(parsed.startedAtNs) && parsed.startedAtNs > 0) {
    metadata.startedAtNs = parsed.startedAtNs;
  }
  if (isStepRef(parsed.step)) {
    metadata.step = { round: parsed.step.round, index: parsed.step.index, id: parsed.step.id };
  }
  return metadata;
}
