/**
 * Argument parsing for `ohos-perf gesture`.
 *
 * The core validates the same fields again; this layer exists so a bad
 * positional becomes the CLI-wide usage failure (empty stdout, one message on
 * stderr, exit 1) before any device is connected. The velocity range is the
 * device's own measured range: outside it `uitest` silently substitutes its
 * default, so accepting the value would report a gesture that did not happen.
 */

import { OhosPerfError } from '@ohos-perf/core';

const COORDINATE = /^\d+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function parseCoordinate(raw: string, label: string): number {
  const value = Number(raw);
  if (!COORDINATE.test(raw) || !Number.isSafeInteger(value)) {
    throw new OhosPerfError(
      `invalid ${label}: expected a non-negative whole number, got ${JSON.stringify(raw)}`,
      { code: 'UITEST_BAD_GESTURE' },
    );
  }
  return value;
}

export function parseVelocity(raw: string): number {
  const value = Number(raw);
  if (!COORDINATE.test(raw) || !Number.isSafeInteger(value) || value < 200 || value > 40_000) {
    throw new OhosPerfError(
      `invalid --velocity: expected a whole number from 200 to 40000, got ${JSON.stringify(raw)}`,
      { code: 'UITEST_BAD_GESTURE' },
    );
  }
  return value;
}

export function parseKey(raw: string): string | number {
  if (raw === 'Back' || raw === 'Home' || raw === 'Power') return raw;
  const value = Number(raw);
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(value)) return value;
  throw new OhosPerfError(
    `invalid <key>: expected Back, Home, Power or a positive key code, got ${JSON.stringify(raw)}`,
    { code: 'UITEST_BAD_GESTURE' },
  );
}

export function parseText(raw: string): string {
  if (raw === '') {
    throw new OhosPerfError('invalid <text>: expected a non-empty string', { code: 'UITEST_BAD_GESTURE' });
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new OhosPerfError(
      `invalid <text>: expected no control characters, got ${JSON.stringify(raw)}`,
      { code: 'UITEST_BAD_GESTURE' },
    );
  }
  return raw;
}
