/**
 * Executing one scenario action against a device.
 *
 * The split with the runner is deliberate: this module performs exactly one
 * action and throws when it fails, while the runner owns the record — when it
 * happened, whether the step survived it, and what the trace says. That keeps
 * "did it work" in one place and "what do we remember about it" in another.
 *
 * Quoting lives in `GestureDriver`, not here: it already knows that the device
 * shell needs `'…'` and that a quote inside a text argument must be escaped.
 * Quoting again here would send the quote characters to the device.
 */

import type { Gesture, GestureResult } from '../device/gesture';
import { OhosPerfError } from '../errors';
import type { ScenarioAction } from './schema';

/** The device surface actions need. `Device` satisfies it structurally. */
export interface ActionDevice {
  readonly id: string;
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  gesture(g: Gesture): Promise<GestureResult>;
}

/** A diagnostic excerpt from a failed device command; either stream counts. */
function detail(result: { stdout: string; stderr: string }): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? '(no output)' : lines.join('; ');
}

/** Run `aa` and fail the action on a non-zero exit. */
async function runAa(
  device: ActionDevice,
  cmd: string,
): Promise<{ output: string }> {
  const result = await device.shell(cmd);
  if (result.code !== 0) {
    throw new OhosPerfError(
      `${cmd.split(' ').slice(0, 2).join(' ')} failed (exit ${result.code}):` +
        ` ${detail(result)}`,
      { code: 'SCENARIO_ACTION_FAILED' },
    );
  }
  return { output: result.stdout.trim() };
}

function toGesture(action: ScenarioAction): Gesture | undefined {
  switch (action.kind) {
    case 'click':
      return { action: 'click', x: action.x, y: action.y };
    case 'swipe':
      return {
        action: 'swipe',
        fromX: action.fromX,
        fromY: action.fromY,
        toX: action.toX,
        toY: action.toY,
        ...(action.velocity === undefined ? {} : { velocity: action.velocity }),
      };
    case 'key':
      return { action: 'key', key: action.key };
    case 'text':
      return { action: 'text', text: action.text };
    case 'inputText':
      return { action: 'inputText', x: action.x, y: action.y, text: action.text };
    default:
      return undefined;
  }
}

/**
 * Perform one action and return what the device said.
 *
 * `launch` and `forceStop` use the scenario's app; a `wait` sleeps without a
 * device call. A `marker` is refused here — the runner records markers with a
 * device-uptime instant, and having two layers able to "execute" one would
 * let them disagree about whether it happened.
 */
export async function executeAction(
  device: ActionDevice,
  app: string,
  action: ScenarioAction,
): Promise<{ output?: string }> {
  switch (action.kind) {
    case 'launch':
      return runAa(device, `aa start -a ${action.ability} -b ${app}`);
    case 'forceStop':
      return runAa(device, `aa force-stop ${app}`);
    case 'wait':
      await new Promise<void>((resolve) => setTimeout(resolve, action.ms));
      return {};
    case 'marker':
      throw new OhosPerfError(
        `marker ${JSON.stringify(action.name)} is recorded by the scenario runner,` +
          ' not executed as an action',
        { code: 'SCENARIO_BAD_ACTION' },
      );
    default: {
      const gesture = toGesture(action);
      if (gesture === undefined) {
        // Unreachable for a validated scenario; a caller passing a hand-built
        // action gets a named error rather than a silent no-op.
        throw new OhosPerfError(
          `unknown scenario action ${JSON.stringify((action as { kind?: unknown }).kind)}`,
          { code: 'SCENARIO_BAD_ACTION' },
        );
      }
      const result = await device.gesture(gesture);
      return { output: result.output };
    }
  }
}
