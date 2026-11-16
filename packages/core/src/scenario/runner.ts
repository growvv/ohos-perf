/**
 * The scenario runner: ordered steps, one capture window each.
 *
 * The shape that matters is the phase order. `setup` runs before the capture
 * so the state you want to measure is already on screen; `actions` run
 * *inside* the window so the gesture that causes the work is in the trace;
 * `cleanup` runs after, always. HapRay's DSL parses setup and cleanup and
 * never executes them — executing all three is why this exists.
 *
 * Nothing here analyzes. A step directory is a scene, so `ohos-perf analyze`,
 * `report` and `query` apply to it unchanged.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Gesture, GestureResult } from '../device/gesture';
import type { HiprofilerPluginName } from '../device/device';
import { OhosPerfError } from '../errors';
import type { SceneStepRef } from '../ingest/metadata';
import { executeAction } from './actions';
import type { Scenario, ScenarioAction, ScenarioStep } from './schema';

/** One action's outcome, as `steps.json` records it. */
export interface ActionOutcome {
  readonly action: ScenarioAction;
  /** Device uptime in ns, read immediately before the action; absent when the read failed. */
  readonly atNs?: number;
  /** Host clock at the action, ms. */
  readonly atMs: number;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

export interface RunStepResult {
  readonly round: number;
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly status: 'ok' | 'failed';
  /** Present only when a scene exists on disk. */
  readonly sceneDir?: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly actions: readonly ActionOutcome[];
  readonly error?: string;
}

export interface RunResult {
  readonly scenario: string;
  readonly app: string;
  readonly device: { id: string; kind: string };
  readonly rounds: number;
  readonly status: 'completed' | 'failed';
  readonly steps: readonly RunStepResult[];
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly pids: { pids: readonly number[]; processNames: readonly string[] };
  /** Absent when the device would not report one. Never a fabricated `0.0.0`. */
  readonly appVersion?: string;
}

/** The collect request one step turns into. Mirrors `Device.collect`. */
export interface RunnerCollectOptions {
  app: string;
  durationMs: number;
  sceneRoot: string;
  step: SceneStepRef;
  procfs?: boolean;
  hiprofiler?: { plugins: readonly HiprofilerPluginName[] };
  hiperf?: { frequency?: number };
  hidumper?: boolean;
  uitest?: boolean;
  hilog?: boolean;
}

/** The device surface the runner needs. `Device` satisfies it structurally. */
export interface RunnerDevice {
  readonly id: string;
  readonly kind: string;
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  gesture(g: Gesture): Promise<GestureResult>;
  collect(opts: RunnerCollectOptions): Promise<{ ingest(): Promise<{ close(): void }> }>;
}

export interface RunOptions {
  readonly outDir: string;
  /** Overrides the scenario's own `rounds` when set. */
  readonly rounds?: number;
  /** Step ids to run; order in the scenario wins. */
  readonly only?: readonly string[];
  /** Continue after a failed step instead of stopping. */
  readonly keepGoing?: boolean;
  /** Injected clock, for tests. */
  readonly now?: () => number;
}

/** Read device uptime in ns, the clock base trace `ts` uses. */
async function readUptimeNs(device: RunnerDevice): Promise<number | undefined> {
  try {
    const result = await device.shell('cat /proc/uptime');
    if (result.code !== 0) return undefined;
    const first = result.stdout.trim().split(/\s+/)[0];
    if (first === undefined || first === '') return undefined;
    const seconds = Number(first);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1_000_000_000);
  } catch {
    // A failed read is not a step failure: the action still happened, it just
    // has no device-clock instant. Omit the field rather than writing a
    // fabricated zero, which would address the trace origin.
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `pids.json` document: what was asked for, and what the device said. */
async function resolvePids(
  device: RunnerDevice,
  app: string,
): Promise<RunResult['pids']> {
  let pids: number[] = [];
  try {
    const result = await device.shell(`pidof ${app}`);
    pids = result.stdout
      .split(/\s+/)
      .filter((token) => /^\d+$/.test(token))
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    // An app that is not running is a state, not a run failure.
  }
  return { pids: [...new Set(pids)], processNames: [app] };
}

/** The app's version, from `bm dump -n`. Absent when the device will not say. */
async function resolveAppVersion(
  device: RunnerDevice,
  app: string,
): Promise<string | undefined> {
  try {
    const result = await device.shell(`bm dump -n ${app}`);
    if (result.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const version = (parsed as { versionName?: unknown }).versionName;
    return typeof version === 'string' && version !== '' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The `Device.collect` request one step describes. */
function collectOptions(
  step: ScenarioStep,
  app: string,
  sceneRoot: string,
  ref: SceneStepRef,
): RunnerCollectOptions {
  const { capture } = step;
  const has = (name: string): boolean =>
    (capture.collectors as readonly string[]).includes(name);
  return {
    app,
    durationMs: capture.durationMs,
    sceneRoot,
    step: ref,
    ...(has('procfs') ? { procfs: true } : {}),
    ...(capture.hiprofiler === undefined ? {} : { hiprofiler: capture.hiprofiler }),
    ...(capture.hiperf === undefined ? {} : { hiperf: capture.hiperf }),
    ...(has('hidumper') ? { hidumper: true } : {}),
    ...(has('uitest') ? { uitest: true } : {}),
    ...(has('hilog') ? { hilog: true } : {}),
  };
}

/**
 * Run a scenario: every selected (round, step) pair, one scene each.
 *
 * The returned result is what `steps.json` records; the files are written
 * before returning, on the success and the failure path alike, so a run that
 * stopped at step 2 still says what step 1 produced.
 */
export class ScenarioRunner {
  private readonly device: RunnerDevice;
  private readonly opts: RunOptions;
  private readonly now: () => number;

  constructor(device: RunnerDevice, opts: RunOptions) {
    this.device = device;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async run(scenario: Scenario): Promise<RunResult> {
    const steps = this.selectedSteps(scenario);
    const rounds = this.opts.rounds ?? scenario.rounds;
    if (!Number.isSafeInteger(rounds) || rounds <= 0) {
      throw new OhosPerfError(
        `invalid --rounds ${String(this.opts.rounds)}: expected a positive whole number`,
        { code: 'SCENARIO_BAD_INPUT' },
      );
    }

    const startedAtMs = this.now();
    const [pids, appVersion] = await Promise.all([
      resolvePids(this.device, scenario.app),
      resolveAppVersion(this.device, scenario.app),
    ]);

    const results: RunStepResult[] = [];
    let stopped = false;
    for (let round = 1; round <= rounds; round += 1) {
      for (const [index, step] of scenario.steps.entries()) {
        if (!steps.includes(step)) continue;
        const result = await this.runStep(scenario, step, { round, index });
        results.push(result);
        if (result.status === 'failed' && this.opts.keepGoing !== true) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }

    const result: RunResult = {
      scenario: scenario.name,
      app: scenario.app,
      device: { id: this.device.id, kind: this.device.kind },
      rounds,
      status: results.some((entry) => entry.status === 'failed') ? 'failed' : 'completed',
      steps: results,
      startedAtMs,
      durationMs: this.now() - startedAtMs,
      pids,
      ...(appVersion === undefined ? {} : { appVersion }),
    };
    writeRunFiles(this.opts.outDir, result);
    return result;
  }

  /**
   * The steps to run, in scenario order.
   *
   * `--only` is a filter, not an ordering: typing `scroll,open` still runs
   * `open` first, because a step may depend on the state a previous one left.
   */
  private selectedSteps(scenario: Scenario): readonly ScenarioStep[] {
    const only = this.opts.only;
    if (only === undefined || only.length === 0) return scenario.steps;
    const known = new Set(scenario.steps.map((step) => step.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new OhosPerfError(
        `unknown step ${JSON.stringify(unknown[0])} in --only;` +
          ` the scenario has ${scenario.steps.map((step) => step.id).join(', ')}`,
        { code: 'SCENARIO_BAD_INPUT' },
      );
    }
    const wanted = new Set(only);
    return scenario.steps.filter((step) => wanted.has(step.id));
  }

  private async runStep(
    scenario: Scenario,
    step: ScenarioStep,
    position: { round: number; index: number },
  ): Promise<RunStepResult> {
    const startedAtMs = this.now();
    const ref: SceneStepRef = { round: position.round, index: position.index, id: step.id };
    const sceneRoot = join(this.opts.outDir, step.id, `round-${position.round}`);
    const actions: ActionOutcome[] = [];
    let failure: string | undefined;
    let sceneDir: string | undefined;

    // Setup runs before the capture: a failure here means no capture starts,
    // so there is no scene and none is named.
    for (const action of step.setup) {
      const outcome = await this.perform(scenario.app, action);
      actions.push(outcome);
      if (!outcome.ok) {
        failure ??= outcome.error;
        break;
      }
    }

    if (failure === undefined) {
      mkdirSync(sceneRoot, { recursive: true });
      const session = await this.device.collect(
        collectOptions(step, scenario.app, sceneRoot, ref),
      );
      // Start the capture, then run the actions while it is in flight. The
      // promise is held (not awaited) so the actions overlap the window; it
      // is awaited below and its rejection is captured, never unhandled.
      const ingest = session.ingest();

      for (const action of step.actions) {
        const outcome = await this.perform(scenario.app, action);
        actions.push(outcome);
        if (!outcome.ok) {
          failure ??= outcome.error;
          break;
        }
      }

      try {
        const scene = await ingest;
        scene.close();
        sceneDir = sceneRoot;
      } catch (err) {
        // A capture that produced no scene must not name one: an empty
        // directory would send a reader to a scene that does not exist.
        failure ??= message(err);
      }
    }

    // Cleanup runs always — a failed action can leave the app in a state the
    // next step should not inherit. Its failure marks the step failed only
    // when nothing else already did, so it never masks the first error.
    for (const action of step.cleanup) {
      const outcome = await this.perform(scenario.app, action);
      actions.push(outcome);
      if (!outcome.ok) failure ??= outcome.error;
    }

    return {
      round: position.round,
      index: position.index,
      id: step.id,
      name: step.name,
      status: failure === undefined ? 'ok' : 'failed',
      ...(sceneDir === undefined ? {} : { sceneDir }),
      startedAtMs,
      durationMs: this.now() - startedAtMs,
      actions,
      ...(failure === undefined ? {} : { error: failure }),
    };
  }

  /**
   * Perform one action and record it; never throws.
   *
   * A `marker` is recorded here, not executed: it is an annotation with a
   * device-uptime instant — the thing that lets a later query line a tap up
   * with a trace row — and there is no trace event behind it. Recording it in
   * the runner is what keeps "it happened" in the same place as "when".
   */
  private async perform(app: string, action: ScenarioAction): Promise<ActionOutcome> {
    const atNs = await readUptimeNs(this.device);
    const atMs = this.now();
    if (action.kind === 'marker') {
      return {
        action,
        ...(atNs === undefined ? {} : { atNs }),
        atMs,
        ok: true,
      };
    }
    try {
      const result = await executeAction(this.device, app, action);
      return {
        action,
        ...(atNs === undefined ? {} : { atNs }),
        atMs,
        ok: true,
        ...(result.output === undefined || result.output === ''
          ? {}
          : { output: result.output }),
      };
    } catch (err) {
      return {
        action,
        ...(atNs === undefined ? {} : { atNs }),
        atMs,
        ok: false,
        error: message(err),
      };
    }
  }
}

/** `testInfo.json`: the run as a whole. */
function testInfoOf(result: RunResult) {
  return {
    version: 1,
    scenario: result.scenario,
    app: {
      packageName: result.app,
      ...(result.appVersion === undefined ? {} : { version: result.appVersion }),
    },
    device: result.device,
    startedAtMs: result.startedAtMs,
    durationMs: result.durationMs,
    rounds: result.rounds,
    steps: result.steps.length,
    status: result.status,
  };
}

/**
 * Write `testInfo.json`, `steps.json` and `pids.json` into a run directory.
 *
 * Pretty-printed with two spaces and one trailing newline, like `scene.json`,
 * so a run is diff-friendly and byte-stable apart from its clock fields.
 */
export function writeRunFiles(outDir: string, result: RunResult): void {
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  write('testInfo.json', testInfoOf(result));
  write('steps.json', { version: 1, steps: result.steps });
  write('pids.json', result.pids);
}
