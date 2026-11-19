/**
 * External workload plans: the `*.workload.json` shape HapRay's testcases use.
 *
 * A plan is data, not code. It names the app, says what to do to reach the
 * state worth measuring (`setup`), what to do while the trace runs
 * (`measured`), and what must be on screen afterwards (`verify`). The same
 * three phases exist in a scenario step; the vocabulary here is the one an
 * external harness publishes, so a benchmark's own plans run unchanged.
 *
 * Every field is validated before a device is touched. The plan arrives from
 * outside this project and the device shell is a command language: `bundle`
 * and `ability` are interpolated into `aa` commands, so they are restricted to
 * the bare-name form, and every other string is either compared against a
 * dump or quoted by the gesture driver.
 */

import { OhosPerfError } from '../errors';

/** How a selector compares a node attribute. */
export type WorkloadMatch = 'substring' | 'exact' | 'regex';

/**
 * One UI target, as the external plan spells it.
 *
 * `text`, `id`, `type`, `hint`, `bounds` and `enabled` are compared as
 * strings, like the reference driver does: the dump's attributes are strings,
 * and a typed comparison would disagree with the tool that produced them.
 * `index` picks among matches; `match` applies to every field.
 */
export interface WorkloadSelector {
  readonly text?: string;
  readonly id?: string;
  readonly type?: string;
  readonly hint?: string;
  readonly bounds?: string;
  readonly enabled?: string;
  readonly match?: WorkloadMatch;
  readonly index?: number;
}

/** One plan action. `repeat` nests, so the union is recursive. */
export type WorkloadAction =
  | { readonly op: 'launch'; readonly flags?: number }
  | { readonly op: 'stop' }
  | { readonly op: 'tap'; readonly selector: WorkloadSelector }
  | {
      readonly op: 'input';
      readonly selector: WorkloadSelector;
      readonly value: string;
      /** The input's text when the plan expects it to be cleared first. */
      readonly cleared_text?: string;
    }
  | {
      readonly op: 'type_keys';
      readonly selector: WorkloadSelector;
      readonly value: string;
      readonly interval_ms?: number;
    }
  | { readonly op: 'wait'; readonly selector: WorkloadSelector; readonly timeout_s?: number }
  | { readonly op: 'pause'; readonly seconds: number }
  | { readonly op: 'key'; readonly key: string | number }
  | { readonly op: 'point'; readonly x: number; readonly y: number }
  | {
      readonly op: 'swipe';
      readonly direction?: 'up' | 'down';
      readonly count?: number;
      readonly interval_s?: number;
    }
  | {
      readonly op: 'scroll_to';
      readonly selector: WorkloadSelector;
      readonly max_swipes?: number;
    }
  | { readonly op: 'repeat'; readonly count: number; readonly actions: readonly WorkloadAction[] };

export interface WorkloadPlan {
  readonly bundle: string;
  readonly ability: string;
  readonly description: string;
  readonly setup: readonly WorkloadAction[];
  readonly measured: readonly WorkloadAction[];
  readonly verify: readonly WorkloadAction[];
}

/** `aa` interpolates these names into one shell command each. */
const BARE_NAME = /^[A-Za-z0-9_.]+$/;
/** The reference driver's `key` vocabulary: three names and key codes. */
const KEY = /^(Back|Home|Power|\d+)$/;
/** Node attribute names a selector may compare. `match` and `index` are not attributes. */
const SELECTOR_FIELDS = ['text', 'id', 'type', 'hint', 'bounds', 'enabled'] as const;
const MATCH_MODES: readonly WorkloadMatch[] = ['substring', 'exact', 'regex'];

/**
 * A short value in an error message.
 *
 * A regex plan can carry a long pattern; quoting the whole thing buries the
 * JSON path that says where to look.
 */
function show(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > 60 ? `${text.slice(0, 57)}...` : String(text);
}

function bad(path: string, message: string): never {
  throw new OhosPerfError(`workload ${path}: ${message}`, { code: 'WORKLOAD_BAD_PLAN' });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      bad(path, `unknown key ${JSON.stringify(key)}`);
    }
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') bad(path, 'expected a non-empty string');
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function number(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bad(path, 'expected a finite number');
  }
  if (value < min || value > max) bad(path, `expected a number between ${min} and ${max}`);
  return value;
}

function optionalNumber(
  value: unknown, path: string, min: number, max: number,
): number | undefined {
  return value === undefined ? undefined : number(value, path, min, max);
}

function bareName(value: unknown, path: string): string {
  const name = text(value, path);
  if (!BARE_NAME.test(name)) {
    bad(path, `expected a bare name (letters, digits, '.', '_'), got ${show(name)}`);
  }
  return name;
}

function selector(value: unknown, path: string): WorkloadSelector {
  const object = record(value, path);
  allowedKeys(object, [...SELECTOR_FIELDS, 'match', 'index'], path);
  const match = object.match;
  if (match !== undefined && !MATCH_MODES.includes(match as WorkloadMatch)) {
    bad(`${path}.match`, `expected one of ${MATCH_MODES.join(', ')}, got ${show(match)}`);
  }
  const parsed: {
    -readonly [K in keyof WorkloadSelector]: WorkloadSelector[K];
  } = {};
  for (const field of SELECTOR_FIELDS) {
    const fieldValue = optionalText(object[field], `${path}.${field}`);
    if (fieldValue !== undefined) parsed[field] = fieldValue;
  }
  if (match !== undefined) parsed.match = match as WorkloadMatch;
  const index = optionalNumber(object.index, `${path}.index`, 0, 10_000);
  if (index !== undefined) {
    if (!Number.isInteger(index)) bad(`${path}.index`, 'expected a whole number');
    parsed.index = index;
  }
  if (Object.keys(parsed).filter((key) => key !== 'match' && key !== 'index').length === 0) {
    bad(path, 'expected at least one of text, id, type, hint, bounds, enabled');
  }
  return parsed;
}

function action(value: unknown, path: string): WorkloadAction {
  const object = record(value, path);
  const op = object.op;
  if (typeof op !== 'string') bad(`${path}.op`, 'expected an action name');

  switch (op) {
    case 'launch': {
      allowedKeys(object, ['op', 'flags'], path);
      const flags = optionalNumber(object.flags, `${path}.flags`, 0, 0xffff_ffff);
      if (flags !== undefined && !Number.isInteger(flags)) {
        bad(`${path}.flags`, 'expected a whole number');
      }
      return flags === undefined ? { op } : { op, flags };
    }
    case 'stop':
      allowedKeys(object, ['op'], path);
      return { op };
    case 'tap':
      allowedKeys(object, ['op', 'selector'], path);
      return { op, selector: selector(object.selector, `${path}.selector`) };
    case 'input': {
      allowedKeys(object, ['op', 'selector', 'value', 'cleared_text'], path);
      const cleared = object.cleared_text;
      if (cleared !== undefined && typeof cleared !== 'string') {
        bad(`${path}.cleared_text`, 'expected a string');
      }
      return {
        op,
        selector: selector(object.selector, `${path}.selector`),
        value: text(object.value, `${path}.value`),
        ...(cleared === undefined ? {} : { cleared_text: cleared }),
      };
    }
    case 'type_keys': {
      allowedKeys(object, ['op', 'selector', 'value', 'interval_ms'], path);
      // The published driver's `type_keys` is a `uinput -K` burst: it accepts
      // `[a-z]{1,100}`, an interval in 1..15000, and defaults the interval to
      // 50. A value outside that is a plan error here, before a device is
      // resolved, rather than a device command that cannot work.
      const burst = text(object.value, `${path}.value`);
      if (!/^[a-z]{1,100}$/.test(burst)) {
        bad(`${path}.value`, 'type_keys expects 1-100 lowercase letters (a-z)');
      }
      const interval = optionalNumber(object.interval_ms, `${path}.interval_ms`, 1, 15_000);
      if (interval !== undefined && !Number.isInteger(interval)) {
        bad(`${path}.interval_ms`, 'expected a whole number');
      }
      return {
        op,
        selector: selector(object.selector, `${path}.selector`),
        value: burst,
        interval_ms: interval ?? 50,
      };
    }
    case 'wait': {
      allowedKeys(object, ['op', 'selector', 'timeout_s'], path);
      const timeout = optionalNumber(object.timeout_s, `${path}.timeout_s`, 0, 3600);
      return {
        op,
        selector: selector(object.selector, `${path}.selector`),
        ...(timeout === undefined ? {} : { timeout_s: timeout }),
      };
    }
    case 'pause':
      allowedKeys(object, ['op', 'seconds'], path);
      return { op, seconds: number(object.seconds, `${path}.seconds`, 0, 3600) };
    case 'key': {
      allowedKeys(object, ['op', 'key'], path);
      const key = object.key;
      if (typeof key === 'number') {
        if (!Number.isSafeInteger(key) || key <= 0) bad(`${path}.key`, 'expected a positive key code');
        return { op, key };
      }
      if (typeof key !== 'string' || !KEY.test(key)) {
        bad(`${path}.key`, `expected Back, Home, Power or a key code, got ${show(key)}`);
      }
      return { op, key };
    }
    case 'point': {
      allowedKeys(object, ['op', 'x', 'y'], path);
      return {
        op,
        x: number(object.x, `${path}.x`, 0, 1),
        y: number(object.y, `${path}.y`, 0, 1),
      };
    }
    case 'swipe': {
      allowedKeys(object, ['op', 'direction', 'count', 'interval_s'], path);
      const direction = object.direction;
      if (direction !== undefined && direction !== 'up' && direction !== 'down') {
        bad(`${path}.direction`, `expected up or down, got ${show(direction)}`);
      }
      const count = optionalNumber(object.count, `${path}.count`, 0, 1000);
      if (count !== undefined && !Number.isInteger(count)) {
        bad(`${path}.count`, 'expected a whole number');
      }
      const interval = optionalNumber(object.interval_s, `${path}.interval_s`, 0, 3600);
      return {
        op,
        ...(direction === undefined ? {} : { direction }),
        ...(count === undefined ? {} : { count }),
        ...(interval === undefined ? {} : { interval_s: interval }),
      };
    }
    case 'scroll_to': {
      allowedKeys(object, ['op', 'selector', 'max_swipes'], path);
      const max = optionalNumber(object.max_swipes, `${path}.max_swipes`, 0, 1000);
      if (max !== undefined && !Number.isInteger(max)) {
        bad(`${path}.max_swipes`, 'expected a whole number');
      }
      return {
        op,
        selector: selector(object.selector, `${path}.selector`),
        ...(max === undefined ? {} : { max_swipes: max }),
      };
    }
    case 'repeat': {
      allowedKeys(object, ['op', 'count', 'actions'], path);
      const count = number(object.count, `${path}.count`, 1, 1000);
      if (!Number.isInteger(count)) bad(`${path}.count`, 'expected a whole number');
      return { op, count, actions: actions(object.actions, `${path}.actions`) };
    }
    default:
      bad(`${path}.op`, `unsupported action ${JSON.stringify(op)}`);
  }
}

function actions(value: unknown, path: string): WorkloadAction[] {
  if (!Array.isArray(value)) bad(path, 'expected an array of actions');
  return value.map((item, index) => action(item, `${path}[${index}]`));
}

/**
 * Parse one plan document.
 *
 * `duration_s` is accepted and returned as-is: some published plans carry the
 * capture window beside the steps, and a caller may use it when it has no
 * `--duration`. The runner always takes its window from the caller, because a
 * plan that names its own is a suggestion and the capture is a measurement.
 */
export function parseWorkloadPlan(value: unknown): WorkloadPlan & { readonly duration_s?: number } {
  const object = record(value, 'plan');
  allowedKeys(object, ['bundle', 'ability', 'description', 'setup', 'measured', 'verify', 'duration_s'], 'plan');
  const duration = optionalNumber(object.duration_s, 'plan.duration_s', 0, 86_400);
  return {
    bundle: bareName(object.bundle, 'plan.bundle'),
    ability: bareName(object.ability, 'plan.ability'),
    description: typeof object.description === 'string' ? object.description : '',
    setup: object.setup === undefined ? [] : actions(object.setup, 'plan.setup'),
    measured: actions(object.measured, 'plan.measured'),
    verify: object.verify === undefined ? [] : actions(object.verify, 'plan.verify'),
    ...(duration === undefined ? {} : { duration_s: duration }),
  };
}

/** One action, in words a run record can print. */
export function describeWorkloadAction(action: WorkloadAction): string {
  switch (action.op) {
    case 'launch':
      return action.flags === undefined ? 'launch' : `launch flags=${action.flags}`;
    case 'stop':
      return 'stop';
    case 'tap':
      return `tap ${describeSelector(action.selector)}`;
    case 'input':
      return `input ${describeSelector(action.selector)} = ${JSON.stringify(action.value)}`;
    case 'type_keys':
      return `type_keys ${describeSelector(action.selector)} = ${JSON.stringify(action.value)}`;
    case 'wait':
      return `wait ${describeSelector(action.selector)}`;
    case 'pause':
      return `pause ${action.seconds}s`;
    case 'key':
      return `key ${String(action.key)}`;
    case 'point':
      return `point ${action.x},${action.y}`;
    case 'swipe':
      return `swipe ${action.direction ?? 'up'} x${action.count ?? 1}`;
    case 'scroll_to':
      return `scroll_to ${describeSelector(action.selector)}`;
    case 'repeat':
      return `repeat x${action.count}`;
  }
}

function describeSelector(selector: WorkloadSelector): string {
  const fields = SELECTOR_FIELDS
    .filter((field) => selector[field] !== undefined)
    .map((field) => `${field}=${JSON.stringify(selector[field])}`);
  return fields.join(', ');
}
