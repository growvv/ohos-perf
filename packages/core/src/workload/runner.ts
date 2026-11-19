/**
 * Running an external workload plan against a device.
 *
 * The phase order is the point. `setup` runs before the capture so the screen
 * is in the state worth measuring; `measured` runs *inside* the window, so the
 * work the symptom complains about is in the trace; `verify` runs after, and
 * its failure is reported without invalidating the capture.
 *
 * The runner owns the same three facts as the scenario runner — what happened,
 * when, and what the device said — and nothing else. Analysis is a later
 * command over the scene this writes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gesture, GestureResult } from '../device/gesture';
import { OhosPerfError } from '../errors';
import { readSceneMetadata, writeSceneMetadata } from '../ingest/metadata';
import { createSceneLayout } from '../ingest/scene';
import type { SceneStepRef } from '../ingest/metadata';
import type { UiNode } from '../query/ui';
import type { WorkloadAction, WorkloadPlan, WorkloadSelector } from './plan';
import { describeWorkloadAction } from './plan';

/** The device surface the runner needs. `Device` satisfies it structurally. */
export interface WorkloadDevice {
  readonly id: string;
  readonly kind: string;
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  gesture(g: Gesture): Promise<GestureResult>;
  collect(opts: {
    app: string;
    durationMs: number;
    sceneRoot: string;
    step?: SceneStepRef;
  }): Promise<{ ingest(): Promise<{ close(): void }> }>;
  uiTree(): Promise<readonly UiNode[]>;
}

/** One action's recorded outcome. */
export interface WorkloadActionOutcome {
  readonly op: WorkloadAction['op'];
  readonly description: string;
  readonly ok: boolean;
  readonly atMs: number;
  readonly output?: string;
  readonly error?: string;
}

/** One phase's outcomes, named by the plan's own vocabulary. */
export interface WorkloadPhaseResult {
  readonly actions: readonly WorkloadActionOutcome[];
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly error?: string;
}

export interface WorkloadRunResult {
  readonly plan: string;
  readonly description: string;
  readonly app: string;
  readonly ability: string;
  readonly device: { id: string; kind: string };
  /** The requested capture window. */
  readonly durationMs: number;
  /** How long `measured` took, when it ran. */
  readonly measuredMs?: number;
  readonly status: 'ok' | 'failed';
  readonly sceneDir?: string;
  /**
   * The implicit stop-then-launch before `setup`.
   *
   * The published plans do not launch the app: the harness that runs them
   * does (`stop` then `launch`, then `setup`). A plan's first `wait` is often
   * for a screen that only exists inside the app, so without this the run
   * starts on the home screen and fails at its own first assertion.
   */
  readonly launch: WorkloadPhaseResult;
  readonly setup: WorkloadPhaseResult;
  readonly measured: WorkloadPhaseResult;
  readonly verify: WorkloadPhaseResult;
  readonly pids: readonly number[];
  readonly startedAtMs: number;
  readonly error?: string;
}

export interface WorkloadRunOptions {
  readonly outDir: string;
  readonly durationMs: number;
  /** Injected clock, for tests. */
  readonly now?: () => number;
  /** Injected sleep, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 250;
const DEFAULT_TIMEOUT_S = 15;
const DEFAULT_SWIPE_INTERVAL_S = 0.4;
/**
 * The velocity the reference driver passes as `swipe`'s fifth argument.
 *
 * It is not a duration: `uitest uiInput swipe` interprets the number as a
 * velocity, and without it the device picks its own. Measured on the emulator
 * on 2026-11-19: 5.15 s per swipe without the argument against 3.21 s with
 * it, which is enough to push a 12-swipe plan past its own 60 s window.
 */
const SWIPE_VELOCITY = 1000;
/** A phase that did not run: absent outcomes, and nothing to report. */
const EMPTY_PHASE: WorkloadPhaseResult = Object.freeze({
  actions: [], ok: true, elapsedMs: 0,
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The node's bounds as a rect, or a refusal naming the node. */
function rectOf(node: UiNode): { left: number; top: number; right: number; bottom: number } {
  const rect = node.boundsRect;
  if (rect === undefined || rect.right <= rect.left || rect.bottom <= rect.top) {
    throw new OhosPerfError(
      `UI node has no usable bounds (${JSON.stringify(node.bounds)})`,
      { code: 'WORKLOAD_BAD_BOUNDS' },
    );
  }
  return rect;
}

function centerOf(node: UiNode): { x: number; y: number } {
  const rect = rectOf(node);
  return { x: Math.floor((rect.left + rect.right) / 2), y: Math.floor((rect.top + rect.bottom) / 2) };
}

/**
 * The node attribute a selector field names.
 *
 * `hint` and `visible` live in the dump's attribute map rather than the
 * flattened node; the rest are first-class fields.
 */
function attributeOf(node: UiNode, field: keyof WorkloadSelector): string {
  switch (field) {
    case 'text':
      return node.text;
    case 'id':
      return node.id;
    case 'type':
      return node.type;
    case 'hint':
      return node.attributes?.hint ?? '';
    case 'bounds':
      return node.bounds;
    case 'enabled':
      // The published driver matches `str(node.get('enabled', ''))`, so an
      // attribute the dump never carried compares as the empty string. The
      // flattened `enabled` flag reads `false` for both "absent" and
      // "explicitly false", and only the second is a value the dump stated.
      return node.attributes?.enabled ?? '';
    default:
      return '';
  }
}

/**
 * Each node's effective `bundleName`, inherited from its nearest ancestor that
 * carries one — the published driver's `UI.nodes(layout, inherited_bundle)`.
 *
 * `flattenUiTree` is pre-order, so the nodes before a node at depth *d* hold
 * every ancestor at depth < *d*; a stack indexed by depth is enough. An
 * unmarked node in the launcher's window belongs to the launcher, not to
 * whichever app the plan names.
 */
function inheritedBundles(nodes: readonly UiNode[]): string[] {
  const stack: string[] = [];
  const bundles: string[] = [];
  for (const node of nodes) {
    stack.length = Math.min(stack.length, node.depth);
    const inherited = node.bundleName !== ''
      ? node.bundleName
      : (node.depth > 0 ? stack[node.depth - 1] ?? '' : '');
    stack[node.depth] = inherited;
    bundles.push(inherited);
  }
  return bundles;
}

function matches(value: string, expected: string, mode: WorkloadSelector['match']): boolean {
  if (mode === 'exact') return value === expected;
  if (mode === 'regex') {
    try {
      return new RegExp(expected).test(value);
    } catch {
      // A regex the plan cannot compile matched nothing; the plan's own
      // validator cannot check JavaScript syntax from a JSON string.
      return false;
    }
  }
  return value.includes(expected);
}

/** The fields a selector actually compares (everything but `match`/`index`). */
const FIELDS = ['text', 'id', 'type', 'hint', 'bounds', 'enabled'] as const;

/**
 * Execute one workload plan, capturing the `measured` phase.
 *
 * A setup failure stops before the capture starts and leaves no scene. A
 * measured failure still finishes the capture: the trace is a record of what
 * happened, and a reader diagnosing a failed workload is better served by the
 * trace than by its absence. A verify failure is reported in the record and
 * marks the run failed, but the scene stands.
 */
export class WorkloadRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly device: WorkloadDevice,
    private readonly options: WorkloadRunOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
  }

  async run(plan: WorkloadPlan, planPath = ''): Promise<WorkloadRunResult> {
    const startedAtMs = this.now();
    this.bundle = plan.bundle;
    this.ability = plan.ability;
    // The harness's own preamble, before the plan's first phase. A plan that
    // starts with `stop` or `launch` already says this, and repeating it is
    // two device commands that change nothing; a plan that starts with `wait`
    // depends on it.
    const launch = await this.phase([
      { op: 'stop' },
      { op: 'launch' },
    ]);
    const setup = launch.ok ? await this.phase(plan.setup) : EMPTY_PHASE;
    let measured: WorkloadPhaseResult = {
      actions: [], ok: true, elapsedMs: 0,
    };
    let verify: WorkloadPhaseResult = { actions: [], ok: true, elapsedMs: 0 };
    let sceneDir: string | undefined;
    let pids: number[] = [];
    let failure: string | undefined = launch.ok ? undefined : launch.error;
    failure ??= setup.ok ? undefined : setup.error;

    if (failure === undefined) {
      mkdirSync(this.options.outDir, { recursive: true });
      const ref: SceneStepRef = { id: 'measured', index: 0, round: 1 };
      const session = await this.device.collect({
        app: plan.bundle,
        durationMs: this.options.durationMs,
        sceneRoot: this.options.outDir,
        step: ref,
      });
      const ingest = session.ingest();
      measured = await this.phase(plan.measured);
      // The app is launched inside the window, so its pid only exists now;
      // record it beside the scene rather than pretending the capture start
      // could know it.
      pids = await this.resolvePids(plan.bundle);
      try {
        const scene = await ingest;
        scene.close();
        sceneDir = this.options.outDir;
        // The capture resolves pids before the window starts, and the plan
        // launches the app inside it: a pid found only afterwards is still the
        // app's pid, and recording it is what lets the analyzer attribute the
        // trace's rows. Rewritten only on a successful capture, so a failed
        // run never edits the previous scene's descriptor.
        this.recordPids(pids);
      } catch (err) {
        failure ??= `capture failed: ${message(err)}`;
      }
      failure ??= measured.error;
      if (measured.elapsedMs > this.options.durationMs) {
        failure ??=
          `workload took ${(measured.elapsedMs / 1000).toFixed(2)}s,` +
          ` exceeding the ${(this.options.durationMs / 1000).toFixed(2)}s capture window`;
      }
      verify = await this.phase(plan.verify);
      failure ??= verify.error;
    }

    const result: WorkloadRunResult = {
      plan: planPath,
      description: plan.description,
      app: plan.bundle,
      ability: plan.ability,
      device: { id: this.device.id, kind: this.device.kind },
      durationMs: this.options.durationMs,
      ...(measured.elapsedMs === 0 ? {} : { measuredMs: measured.elapsedMs }),
      status: failure === undefined ? 'ok' : 'failed',
      ...(sceneDir === undefined ? {} : { sceneDir }),
      launch,
      setup,
      measured,
      verify,
      pids,
      startedAtMs,
      ...(failure === undefined ? {} : { error: failure }),
    };
    // A setup failure never started a capture, so the directory may not
    // exist; the record is still written, because the run happened.
    mkdirSync(this.options.outDir, { recursive: true });
    writeFileSync(join(this.options.outDir, 'workload.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  /**
   * Merge the pids resolved after the window into the scene descriptor.
   *
   * The capture wrote its own `scene.json` with the pids it could resolve
   * before the window (often none, because the plan launches the app inside
   * it). This rewrites that field only, and only when it adds something: an
   * unreadable descriptor is left alone rather than replaced by a partial one.
   */
  private recordPids(pids: readonly number[]): void {
    if (pids.length === 0) return;
    const layout = createSceneLayout(this.options.outDir);
    const meta = readSceneMetadata(layout);
    if (meta === undefined) return;
    const merged = [...new Set([...meta.pids, ...pids])];
    if (merged.length === meta.pids.length) return;
    writeSceneMetadata(layout, { ...meta, pids: merged });
  }

  private async resolvePids(app: string): Promise<number[]> {
    try {
      const result = await this.device.shell(`pidof ${app}`);
      return [...new Set(
        result.stdout
          .split(/\s+/)
          .filter((token) => /^\d+$/.test(token))
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      )];
    } catch {
      return [];
    }
  }

  private async phase(actions: readonly WorkloadAction[]): Promise<WorkloadPhaseResult> {
    const started = this.now();
    const outcomes: WorkloadActionOutcome[] = [];
    let failure: string | undefined;
    for (const action of actions) {
      const atMs = this.now();
      try {
        const output = await this.perform(action);
        outcomes.push({
          op: action.op,
          description: describeWorkloadAction(action),
          ok: true,
          atMs,
          ...(output === undefined ? {} : { output }),
        });
      } catch (err) {
        const error = message(err);
        outcomes.push({
          op: action.op,
          description: describeWorkloadAction(action),
          ok: false,
          atMs,
          error,
        });
        failure = error;
        break;
      }
    }
    return {
      actions: outcomes,
      ok: failure === undefined,
      elapsedMs: this.now() - started,
      ...(failure === undefined ? {} : { error: failure }),
    };
  }

  private async perform(action: WorkloadAction): Promise<string | undefined> {
    switch (action.op) {
      case 'launch': {
        const flags = action.flags === undefined ? '' : ` -f ${action.flags}`;
        const result = await this.device.shell(`aa start -a ${this.ability} -b ${this.bundle}${flags}`);
        if (result.code !== 0) {
          throw new OhosPerfError(
            `aa start failed (exit ${result.code})`, { code: 'WORKLOAD_LAUNCH_FAILED' },
          );
        }
        return 'started';
      }
      case 'stop': {
        const result = await this.device.shell(`aa force-stop ${this.bundle}`);
        if (result.code !== 0) {
          throw new OhosPerfError(
            `aa force-stop failed (exit ${result.code})`, { code: 'WORKLOAD_STOP_FAILED' },
          );
        }
        return 'stopped';
      }
      case 'tap': {
        const node = await this.find(action.selector, DEFAULT_TIMEOUT_S * 1000);
        const { x, y } = centerOf(node);
        await this.device.gesture({ action: 'click', x, y });
        return `clicked ${x},${y}`;
      }
      case 'input':
        return this.input(action.selector, action.value, action.cleared_text ?? '');
      case 'type_keys':
        return this.typeKeys(action.selector, action.value, action.interval_ms ?? 0);
      case 'wait': {
        const timeout = (action.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000;
        const node = await this.find(action.selector, timeout);
        return `found ${node.type}`;
      }
      case 'pause':
        await this.sleep(Math.round(action.seconds * 1000));
        return undefined;
      case 'key':
        await this.device.gesture({ action: 'key', key: action.key });
        return undefined;
      case 'point': {
        const bounds = await this.screenBounds();
        const x = Math.round(bounds.right * action.x);
        const y = Math.round(bounds.bottom * action.y);
        await this.device.gesture({ action: 'click', x, y });
        return `clicked ${x},${y}`;
      }
      case 'swipe': {
        const bounds = await this.screenBounds();
        const x = Math.round(bounds.right * 0.5);
        let from = Math.round(bounds.bottom * 0.78);
        let to = Math.round(bounds.bottom * 0.3);
        if ((action.direction ?? 'up') === 'down') [from, to] = [to, from];
        for (let index = 0; index < (action.count ?? 1); index++) {
          await this.device.gesture({
            action: 'swipe', fromX: x, fromY: from, toX: x, toY: to,
            velocity: SWIPE_VELOCITY,
          });
          await this.sleep(Math.round((action.interval_s ?? DEFAULT_SWIPE_INTERVAL_S) * 1000));
        }
        return `swiped x${action.count ?? 1}`;
      }
      case 'scroll_to':
        return this.scrollTo(action.selector, action.max_swipes ?? 20);
      case 'repeat': {
        for (let index = 0; index < action.count; index++) {
          for (const nested of action.actions) await this.perform(nested);
        }
        return `repeated x${action.count}`;
      }
    }
  }

  /** The plan's app names, bound for the duration of one run. */
  private bundle = '';
  private ability = '';

  /** Run `actions` with the plan's app names bound (entry point uses this). */
  private async input(selector: WorkloadSelector, value: string, cleared: string): Promise<string> {
    let node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
    if (node.text !== '') {
      const { x, y } = centerOf(node);
      await this.device.gesture({ action: 'click', x, y });
      await this.shellChecked('uitest uiInput keyEvent 2072 2017');
      await this.shellChecked('uitest uiInput keyEvent 2055');
      node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
      if (node.text !== cleared) {
        throw new OhosPerfError(
          `input did not clear the previous value: expected ${JSON.stringify(cleared)},` +
            ` found ${JSON.stringify(node.text)}`,
          { code: 'WORKLOAD_INPUT_NOT_CLEARED' },
        );
      }
    }
    if (value !== '') {
      const { x, y } = centerOf(node);
      await this.device.gesture({ action: 'inputText', x, y, text: value });
    }
    node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
    if (node.text !== value) {
      throw new OhosPerfError(
        `input value does not match: expected ${JSON.stringify(value)},` +
          ` found ${JSON.stringify(node.text)}`,
        { code: 'WORKLOAD_INPUT_MISMATCH' },
      );
    }
    return `text ${JSON.stringify(value)}`;
  }

  private async typeKeys(selector: WorkloadSelector, value: string, intervalMs: number): Promise<string> {
    let node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
    if (node.text !== '') {
      const { x, y } = centerOf(node);
      await this.device.gesture({ action: 'click', x, y });
      await this.shellChecked('uitest uiInput keyEvent 2072 2017');
      await this.shellChecked('uitest uiInput keyEvent 2055');
      node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
      if (node.text !== '') {
        throw new OhosPerfError(
          `type_keys did not clear the previous value: found ${JSON.stringify(node.text)}`,
          { code: 'WORKLOAD_INPUT_NOT_CLEARED' },
        );
      }
    }
    for (const character of value) {
      const { x, y } = centerOf(await this.find(selector, DEFAULT_TIMEOUT_S * 1000));
      await this.device.gesture({ action: 'inputText', x, y, text: character });
      if (intervalMs > 0) await this.sleep(intervalMs);
    }
    node = await this.find(selector, DEFAULT_TIMEOUT_S * 1000);
    if (node.text !== value) {
      throw new OhosPerfError(
        `typed value does not match: expected ${JSON.stringify(value)},` +
          ` found ${JSON.stringify(node.text)}`,
        { code: 'WORKLOAD_INPUT_MISMATCH' },
      );
    }
    return `typed ${JSON.stringify(value)}`;
  }

  private async scrollTo(selector: WorkloadSelector, maxSwipes: number): Promise<string> {
    const bounds = await this.screenBounds();
    const x = Math.round(bounds.right * 0.5);
    const from = Math.round(bounds.bottom * 0.78);
    const to = Math.round(bounds.bottom * 0.3);
    for (let attempt = 0; attempt <= maxSwipes; attempt++) {
      const node = await this.tryFind(selector);
      if (node !== undefined && centerOf(node).y <= Math.round(bounds.bottom * 0.85)) {
        return 'reached';
      }
      if (attempt === maxSwipes) break;
      await this.device.gesture({
        action: 'swipe', fromX: x, fromY: from, toX: x, toY: to,
        velocity: SWIPE_VELOCITY,
      });
      await this.sleep(DEFAULT_SWIPE_INTERVAL_S * 1000);
    }
    throw new OhosPerfError(
      `scroll target not reached: ${describeSelector(selector)}`,
      { code: 'WORKLOAD_SCROLL_UNREACHED' },
    );
  }

  /** The screen's own bounds, from the dump's root node. */
  private async screenBounds(): Promise<{ right: number; bottom: number }> {
    const nodes = await this.device.uiTree();
    if (nodes.length === 0) {
      throw new OhosPerfError('the UI dump is empty', { code: 'WORKLOAD_NO_UI' });
    }
    const root = nodes.find((node) => node.depth === 0) ?? nodes[0]!;
    const rect = rectOf(root);
    return { right: rect.right, bottom: rect.bottom };
  }

  /** Poll for a match, or throw when the timeout expires. */
  private async find(selector: WorkloadSelector, timeoutMs: number): Promise<UiNode> {
    const deadline = this.now() + timeoutMs;
    let nodes: readonly UiNode[] = [];
    for (;;) {
      nodes = await this.device.uiTree();
      const matches = this.matching(nodes, selector);
      const index = selector.index ?? 0;
      if (matches.length > index) return matches[index]!;
      if (this.now() >= deadline) {
        throw new OhosPerfError(
          `UI target not found: ${describeSelector(selector)}` +
            ` (${matches.length} of ${nodes.length} nodes matched)`,
          { code: 'WORKLOAD_TARGET_NOT_FOUND' },
        );
      }
      await this.sleep(POLL_MS);
    }
  }

  private async tryFind(selector: WorkloadSelector): Promise<UiNode | undefined> {
    const nodes = await this.device.uiTree();
    return this.matching(nodes, selector)[selector.index ?? 0];
  }

  private matching(nodes: readonly UiNode[], selector: WorkloadSelector): UiNode[] {
    const mode = selector.match ?? 'substring';
    const fields = FIELDS.filter((field) => selector[field] !== undefined);
    const bundles = inheritedBundles(nodes);
    return nodes.filter((node, position) => {
      // The published driver skips a node only when the dump spells
      // `visible="false"` or `enabled="false"`. A node whose dump carries no
      // `enabled` at all is not disabled by that rule — the device still taps
      // it — and requiring the attribute to be present dropped real targets.
      if (node.attributes?.visible === 'false' || node.attributes?.enabled === 'false') {
        return false;
      }
      const bundle = bundles[position] ?? '';
      if (this.bundle !== '' && bundle !== '' && bundle !== this.bundle) {
        return false;
      }
      return fields.every((field) =>
        matches(attributeOf(node, field), selector[field]!, mode));
    });
  }

  /** Run one shell command and require `uitest`'s accepted marker. */
  private async shellChecked(command: string): Promise<void> {
    const result = await this.device.shell(command);
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!combined.includes('No Error')) {
      throw new OhosPerfError(
        `${command.split(' ').slice(0, 3).join(' ')} did not report "No Error"` +
          ` (exit ${result.code})`,
        { code: 'WORKLOAD_SHELL_REFUSED' },
      );
    }
  }
}

function describeSelector(selector: WorkloadSelector): string {
  return FIELDS
    .filter((field) => selector[field] !== undefined)
    .map((field) => `${field}=${JSON.stringify(selector[field])}`)
    .join(', ');
}
