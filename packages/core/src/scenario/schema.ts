/**
 * Declarative scenario documents.
 *
 * A scenario is data, not code: ordered steps, each with a setup phase that
 * runs before the capture, an action phase that runs inside it, and a cleanup
 * phase that runs after. This module is the whole trust boundary — every
 * field is checked here, before a device is touched, and an unknown key is an
 * error rather than a silently ignored typo.
 *
 * The validator is hand-written on purpose. A schema library would be the
 * first runtime dependency in `@ohos-perf/core`, and the property that makes
 * this file worth reading — every rejection names the JSON path that caused
 * it — is the one a generic validator reports least clearly.
 */

import { OhosPerfError } from '../errors';
import { HIPROFILER_PLUGIN_NAMES, type HiprofilerPluginName } from '../device/device';

/** One thing a step does. `wait` and `marker` touch no device. */
export type ScenarioAction =
  | { readonly kind: 'launch'; readonly ability: string }
  | { readonly kind: 'forceStop' }
  | { readonly kind: 'click'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'swipe';
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly velocity?: number;
    }
  | { readonly kind: 'key'; readonly key: string | number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'inputText'; readonly x: number; readonly y: number; readonly text: string }
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'marker'; readonly name: string };

/** The collectors a step may ask for, by the name `Device.collect` understands. */
export const COLLECTOR_NAMES = [
  'hitrace',
  'hiprofiler',
  'procfs',
  'hiperf',
  'hidumper',
  'uitest',
  'hilog',
] as const;
export type CollectorName = (typeof COLLECTOR_NAMES)[number];

export interface StepCapture {
  readonly durationMs: number;
  readonly collectors: readonly CollectorName[];
  readonly hiprofiler?: { readonly plugins: readonly HiprofilerPluginName[] };
  readonly hiperf?: { readonly frequency?: number };
}

export interface ScenarioStep {
  readonly id: string;
  readonly name: string;
  readonly setup: readonly ScenarioAction[];
  readonly actions: readonly ScenarioAction[];
  readonly cleanup: readonly ScenarioAction[];
  readonly capture: StepCapture;
}

export interface Scenario {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  readonly app: string;
  readonly rounds: number;
  readonly steps: readonly ScenarioStep[];
}

/** A step id becomes a directory name, so it is restricted to a safe slug. */
const STEP_ID = /^[a-z][a-z0-9_-]*$/;
/** Names interpolated into a device shell command (app, ability). */
const BARE_NAME = /^[A-Za-z0-9_.]+$/;
/**
 * A marker is a label recorded in `steps.json`, never a shell token, so it
 * may carry the hyphen a human would write (`image-requested`). It still has
 * to be a single unambiguous token for a reader and a log line.
 */
const MARKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** hilog/uitest text is quoted by the gesture driver; control characters are not. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Node's setTimeout (and every collector's duration gate) clamp above this. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const VELOCITY_MIN = 200;
const VELOCITY_MAX = 40_000;

function bad(message: string, code: string): OhosPerfError {
  return new OhosPerfError(`invalid scenario: ${message}`, { code });
}

function inputError(message: string): OhosPerfError {
  return bad(message, 'SCENARIO_BAD_INPUT');
}

function stepError(path: string, message: string): OhosPerfError {
  return bad(`${path}: ${message}`, 'SCENARIO_BAD_STEP');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One object's fields, with an exact key set.
 *
 * `allowed` is exhaustive: a key the document does not name is reported with
 * its own path, because `"duratonMs"` taking a default is exactly the silent
 * failure this validator exists to prevent.
 */
function fields(
  value: unknown,
  path: string,
  allowed: readonly string[],
  error: (path: string, message: string) => OhosPerfError,
): Record<string, unknown> {
  if (!isRecord(value)) throw error(path, 'expected an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw error(`${path}.${key}`, `unknown key ${JSON.stringify(key)};` +
        ` expected one of ${allowed.join(', ')}`);
    }
  }
  return value;
}

function requiredString(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): string {
  if (typeof value !== 'string' || value === '') {
    throw error(path, 'expected a non-empty string');
  }
  return value;
}

function bareName(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): string {
  const text = requiredString(value, path, error);
  if (!BARE_NAME.test(text)) {
    throw error(path, `expected a bare name matching ${String(BARE_NAME)},` +
      ` got ${JSON.stringify(text)}`);
  }
  return text;
}

function positiveInt(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw error(path, `expected a positive whole number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonNegativeInt(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw error(path, `expected a non-negative whole number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function gestureText(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): string {
  const text = requiredString(value, path, error);
  if (CONTROL_CHARS.test(text)) {
    throw error(path, 'expected no control characters');
  }
  return text;
}

/** The keys each action kind accepts; anything else is a typo in that kind. */
const ACTION_KEYS: Readonly<Record<ScenarioAction['kind'], readonly string[]>> = {
  launch: ['kind', 'ability'],
  forceStop: ['kind'],
  click: ['kind', 'x', 'y'],
  swipe: ['kind', 'fromX', 'fromY', 'toX', 'toY', 'velocity'],
  key: ['kind', 'key'],
  text: ['kind', 'text'],
  inputText: ['kind', 'x', 'y', 'text'],
  wait: ['kind', 'ms'],
  marker: ['kind', 'name'],
};

function parseAction(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): ScenarioAction {
  if (!isRecord(value)) throw error(path, 'expected an object');
  const kind = value.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(ACTION_KEYS, kind)) {
    throw error(`${path}.kind`, `expected one of ${Object.keys(ACTION_KEYS).join(', ')},` +
      ` got ${JSON.stringify(kind)}`);
  }
  const keys = ACTION_KEYS[kind as ScenarioAction['kind']];
  const action = fields(value, path, keys, error);
  const at = (key: string): string => `${path}.${key}`;
  switch (kind as ScenarioAction['kind']) {
    case 'launch':
      return { kind: 'launch', ability: bareName(action.ability, at('ability'), error) };
    case 'forceStop':
      return { kind: 'forceStop' };
    case 'click':
      return {
        kind: 'click',
        x: nonNegativeInt(action.x, at('x'), error),
        y: nonNegativeInt(action.y, at('y'), error),
      };
    case 'swipe': {
      const velocity = action.velocity;
      if (velocity !== undefined) {
        if (
          typeof velocity !== 'number' ||
          !Number.isSafeInteger(velocity) ||
          velocity < VELOCITY_MIN ||
          velocity > VELOCITY_MAX
        ) {
          throw error(at('velocity'), `expected a whole number from ${VELOCITY_MIN}` +
            ` to ${VELOCITY_MAX}, got ${JSON.stringify(velocity)}`);
        }
      }
      return {
        kind: 'swipe',
        fromX: nonNegativeInt(action.fromX, at('fromX'), error),
        fromY: nonNegativeInt(action.fromY, at('fromY'), error),
        toX: nonNegativeInt(action.toX, at('toX'), error),
        toY: nonNegativeInt(action.toY, at('toY'), error),
        ...(velocity === undefined ? {} : { velocity }),
      };
    }
    case 'key': {
      const key = action.key;
      if (key === 'Back' || key === 'Home' || key === 'Power') {
        return { kind: 'key', key };
      }
      if (typeof key === 'number' && Number.isSafeInteger(key) && key > 0) {
        return { kind: 'key', key };
      }
      throw error(at('key'), 'expected Back, Home, Power or a positive key code,' +
        ` got ${JSON.stringify(key)}`);
    }
    case 'text':
      return { kind: 'text', text: gestureText(action.text, at('text'), error) };
    case 'inputText':
      return {
        kind: 'inputText',
        x: nonNegativeInt(action.x, at('x'), error),
        y: nonNegativeInt(action.y, at('y'), error),
        text: gestureText(action.text, at('text'), error),
      };
    case 'wait':
      return { kind: 'wait', ms: nonNegativeInt(action.ms, at('ms'), error) };
    case 'marker': {
      const name = requiredString(action.name, at('name'), error);
      if (!MARKER_NAME.test(name)) {
        throw error(at('name'), `expected a label matching ${String(MARKER_NAME)},` +
          ` got ${JSON.stringify(name)}`);
      }
      return { kind: 'marker', name };
    }
  }
}

function parseActions(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): readonly ScenarioAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw error(path, 'expected an array of actions');
  return value.map((entry, index) => parseAction(entry, `${path}[${index}]`, error));
}

function parseCollectors(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): readonly CollectorName[] {
  if (value === undefined) return ['hitrace'];
  if (!Array.isArray(value)) throw error(path, 'expected an array of collector names');
  if (value.length === 0) {
    throw error(path, 'a capture needs at least one collector');
  }
  const collectors: CollectorName[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== 'string' || !(COLLECTOR_NAMES as readonly string[]).includes(entry)) {
      throw error(at, `expected one of ${COLLECTOR_NAMES.join(', ')}, got ${JSON.stringify(entry)}`);
    }
    const name = entry as CollectorName;
    if (collectors.includes(name)) {
      throw error(at, `duplicate collector ${JSON.stringify(name)}`);
    }
    collectors.push(name);
  });
  return collectors;
}

function parseCapture(
  value: unknown,
  path: string,
  error: (path: string, message: string) => OhosPerfError,
): StepCapture {
  const capture = fields(
    value,
    path,
    ['durationMs', 'collectors', 'hiprofiler', 'hiperf'],
    error,
  );
  const durationMs = positiveInt(capture.durationMs, `${path}.durationMs`, error);
  if (durationMs > MAX_TIMEOUT_MS) {
    throw error(`${path}.durationMs`, `must not exceed ${MAX_TIMEOUT_MS} ms` +
      ` (the 32-bit setTimeout limit); larger values are silently clamped to 1 ms`);
  }
  const collectors = parseCollectors(capture.collectors, `${path}.collectors`, error);
  const hasHiprofiler = collectors.includes('hiprofiler');
  const hasHiperf = collectors.includes('hiperf');
  // `Device.collect` takes one trace collector: hiprofiler replaces hitrace.
  // Accepting both would silently drop one, so the second one named is the
  // error's subject.
  if (hasHiprofiler && collectors.includes('hitrace')) {
    const index = collectors.indexOf('hiprofiler');
    throw error(`${path}.collectors[${index}]`, 'hiprofiler replaces hitrace;' +
      ' list one or the other');
  }

  let hiprofiler: StepCapture['hiprofiler'];
  if (capture.hiprofiler !== undefined) {
    const at = `${path}.hiprofiler`;
    if (!hasHiprofiler) {
      throw error(at, 'requires "hiprofiler" in collectors');
    }
    const block = fields(capture.hiprofiler, at, ['plugins'], error);
    if (block.plugins === undefined) {
      throw error(`${at}.plugins`, 'expected an array of plugin names' +
        ` (omit the hiprofiler block to use ftrace)`);
    }
    if (!Array.isArray(block.plugins) || block.plugins.length === 0) {
      throw error(`${at}.plugins`, 'expected at least one plugin name');
    }
    const plugins: HiprofilerPluginName[] = [];
    block.plugins.forEach((entry, index) => {
      const pluginPath = `${at}.plugins[${index}]`;
      if (
        typeof entry !== 'string' ||
        !(HIPROFILER_PLUGIN_NAMES as readonly string[]).includes(entry)
      ) {
        throw error(pluginPath, `expected one of ${HIPROFILER_PLUGIN_NAMES.join(', ')},` +
          ` got ${JSON.stringify(entry)}`);
      }
      const name = entry as HiprofilerPluginName;
      if (plugins.includes(name)) {
        throw error(pluginPath, `duplicate plugin ${JSON.stringify(name)}`);
      }
      plugins.push(name);
    });
    hiprofiler = { plugins };
  }

  let hiperf: StepCapture['hiperf'];
  if (capture.hiperf !== undefined) {
    const at = `${path}.hiperf`;
    if (!hasHiperf) throw error(at, 'requires "hiperf" in collectors');
    const block = fields(capture.hiperf, at, ['frequency'], error);
    const frequency = block.frequency;
    if (frequency !== undefined && (typeof frequency !== 'number' ||
        !Number.isSafeInteger(frequency) || frequency <= 0)) {
      throw error(`${at}.frequency`, 'expected a positive whole number of Hz,' +
        ` got ${JSON.stringify(frequency)}`);
    }
    hiperf = frequency === undefined ? {} : { frequency };
  }

  return {
    durationMs,
    collectors,
    ...(hiprofiler === undefined ? {} : { hiprofiler }),
    ...(hiperf === undefined ? {} : { hiperf }),
  };
}

function parseStep(
  value: unknown,
  path: string,
  seen: Set<string>,
): ScenarioStep {
  const step = fields(
    value,
    path,
    ['id', 'name', 'setup', 'actions', 'cleanup', 'capture'],
    stepError,
  );
  const idPath = `${path}.id`;
  const id = requiredString(step.id, idPath, stepError);
  if (!STEP_ID.test(id)) {
    throw stepError(idPath, `expected a directory-safe slug matching ${String(STEP_ID)},` +
      ` got ${JSON.stringify(id)}`);
  }
  if (seen.has(id)) throw stepError(idPath, `duplicate step id ${JSON.stringify(id)}`);
  seen.add(id);

  const name = step.name === undefined
    ? id
    : requiredString(step.name, `${path}.name`, stepError);

  return {
    id,
    name,
    setup: parseActions(step.setup, `${path}.setup`, stepError),
    actions: parseActions(step.actions, `${path}.actions`, stepError),
    cleanup: parseActions(step.cleanup, `${path}.cleanup`, stepError),
    capture: parseCapture(step.capture, `${path}.capture`, stepError),
  };
}

/**
 * Parse and validate a scenario document.
 *
 * Throws `OhosPerfError` with code `SCENARIO_BAD_INPUT` for a document-level
 * problem (invalid JSON, wrong version, unknown key, missing field) and
 * `SCENARIO_BAD_STEP` for one inside a step. Both name the JSON path.
 */
export function parseScenario(text: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new OhosPerfError(
      `invalid scenario: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { code: 'SCENARIO_BAD_INPUT', cause: err },
    );
  }
  if (!isRecord(parsed)) {
    throw inputError('expected a JSON object at the document root');
  }

  const doc = fields(
    parsed,
    '',
    ['version', 'name', 'description', 'app', 'rounds', 'steps'],
    (path, message) => inputError(path === '' ? message : `${path.slice(1)}: ${message}`),
  );
  // `fields` with an empty path yields keys like `.version`; normalize so the
  // document root reads naturally (`unknown key "extra"`) and nested paths
  // keep their dotted form (`steps[0].id`).
  if (doc.version !== 1) {
    throw inputError(`version: expected 1, got ${JSON.stringify(doc.version)}`);
  }
  const name = requiredString(doc.name, 'name', inputError);
  const app = bareName(doc.app, 'app', inputError);
  const rounds = doc.rounds === undefined ? 1 : positiveInt(doc.rounds, 'rounds', inputError);
  if (doc.description !== undefined && typeof doc.description !== 'string') {
    throw inputError('description: expected a string');
  }

  if (!Array.isArray(doc.steps)) {
    throw inputError('steps: expected a non-empty array of steps');
  }
  if (doc.steps.length === 0) {
    throw inputError('steps: expected at least one step');
  }
  const seen = new Set<string>();
  const steps = doc.steps.map((entry, index) => parseStep(entry, `steps[${index}]`, seen));

  return {
    version: 1,
    name,
    ...(doc.description === undefined ? {} : { description: doc.description }),
    app,
    rounds,
    steps,
  };
}
