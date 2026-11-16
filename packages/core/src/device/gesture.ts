/**
 * UI gesture injection.
 *
 * `uitest uiInput` is the device-side injector. Measured on the Mate 60
 * (OpenHarmony 7.0.0.111) over plain `hdc shell`:
 *
 * - a successful injection prints `No Error` on stdout;
 * - the host exit code is **always 0**, even when the tool refuses the
 *   gesture and exits 1 inside the device shell — so the marker is the only
 *   proof of acceptance;
 * - a swipe velocity outside 200..40000 prints a warning and silently uses
 *   the default, so the request would not be what actually happened.
 *
 * The driver therefore validates everything it can before the shell call and
 * quotes text as one shell argument. Every text value is single-quoted;
 * control characters are rejected because they are not typable and would
 * smuggle separators into the command line.
 */

import { OhosPerfError } from '../errors';
import type { Hdc, HdcResult } from '../transport/hdc';

/** The marker `uitest uiInput` prints when it accepted the injection. */
const ACCEPTED_MARKER = 'No Error';

/** Measured range from `uitest uiInput help`; outside it the tool substitutes. */
const VELOCITY_MIN = 200;
const VELOCITY_MAX = 40_000;

/** Key names the tool documents by name; numeric codes are also accepted. */
const KEY_NAMES = /^(?:Back|Home|Power)$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type Gesture =
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | {
      readonly action: 'swipe';
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly velocity?: number;
    }
  | { readonly action: 'key'; readonly key: string | number }
  | { readonly action: 'inputText'; readonly x: number; readonly y: number; readonly text: string }
  | { readonly action: 'text'; readonly text: string };

export interface GestureResult {
  /** The gesture as performed, echoed for logs and JSON consumers. */
  readonly gesture: Gesture;
  /** The tool's stdout, trimmed (`No Error`, or a warning plus `No Error`). */
  readonly output: string;
}

function badGesture(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: 'UITEST_BAD_GESTURE' });
}

function assertPosition(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw badGesture(`gesture ${field} must be a non-negative integer (got ${String(value)})`);
  }
}

function assertVelocity(velocity: number): void {
  if (!Number.isSafeInteger(velocity) || velocity < VELOCITY_MIN || velocity > VELOCITY_MAX) {
    throw badGesture(
      `gesture velocity must be an integer from ${VELOCITY_MIN} to ${VELOCITY_MAX}` +
        ` (got ${String(velocity)})`,
    );
  }
}

function assertKey(key: string | number): void {
  if (typeof key === 'number') {
    if (Number.isSafeInteger(key) && key > 0) return;
  } else if (KEY_NAMES.test(key)) {
    return;
  }
  throw badGesture(
    `gesture key must be Back, Home, Power or a positive key code (got ${JSON.stringify(key)})`,
  );
}

function assertText(text: string): void {
  if (text === '') throw badGesture('gesture text must not be empty');
  if (CONTROL_CHARS.test(text)) {
    throw badGesture('gesture text must not contain control characters');
  }
}

/** Quote one text argument for the device shell. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Device output excerpt for an error message; both streams are diagnostics. */
function detail(result: { stdout: string; stderr: string }): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, 5).join(' | ');
  return lines.length > 5 ? `${shown} | ... (${lines.length - 5} more lines)` : shown;
}

/** Build the shell command for one gesture, validating it first. */
function commandOf(gesture: Gesture): string {
  switch (gesture.action) {
    case 'click':
      assertPosition('x', gesture.x);
      assertPosition('y', gesture.y);
      return `uitest uiInput click ${gesture.x} ${gesture.y}`;
    case 'swipe': {
      assertPosition('fromX', gesture.fromX);
      assertPosition('fromY', gesture.fromY);
      assertPosition('toX', gesture.toX);
      assertPosition('toY', gesture.toY);
      if (gesture.velocity !== undefined) assertVelocity(gesture.velocity);
      const velocity = gesture.velocity === undefined ? '' : ` ${gesture.velocity}`;
      return `uitest uiInput swipe ${gesture.fromX} ${gesture.fromY}` +
        ` ${gesture.toX} ${gesture.toY}${velocity}`;
    }
    case 'key':
      assertKey(gesture.key);
      return `uitest uiInput keyEvent ${gesture.key}`;
    case 'inputText':
      assertPosition('x', gesture.x);
      assertPosition('y', gesture.y);
      assertText(gesture.text);
      return `uitest uiInput inputText ${gesture.x} ${gesture.y} ${quote(gesture.text)}`;
    case 'text':
      assertText(gesture.text);
      return `uitest uiInput text ${quote(gesture.text)}`;
  }
}

/**
 * Inject gestures through `uitest uiInput`.
 *
 * `perform` takes the transport method it needs rather than the whole `Hdc`,
 * so a caller (Device) can hand in the shared transport and a test can hand in
 * a three-line fake.
 */
export class GestureDriver {
  async perform(
    hdc: Pick<Hdc, 'shell'>,
    target: string,
    gesture: Gesture,
  ): Promise<GestureResult> {
    const command = commandOf(gesture);

    let result: HdcResult;
    try {
      result = await hdc.shell(target, command);
    } catch (err) {
      if (err instanceof OhosPerfError && err.code === 'HDC_SHELL_FAILED') {
        throw new OhosPerfError(`uitest uiInput ${gesture.action} failed: ${err.message}`, {
          code: 'UITEST_INPUT_FAILED',
          cause: err,
        });
      }
      throw err;
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    if (!combined.includes(ACCEPTED_MARKER)) {
      throw new OhosPerfError(
        `uitest uiInput ${gesture.action} did not report "${ACCEPTED_MARKER}"` +
          ` (exit ${result.code}: ${detail(result)})`,
        { code: 'UITEST_INPUT_FAILED' },
      );
    }

    return {
      gesture,
      output: result.stdout.trim() === '' ? result.stderr.trim() : result.stdout.trim(),
    };
  }
}
