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
 *
 * Selector actions (P17) need to see the screen, so they take a `dump` in the
 * action context rather than a device method: reading the UI tree is
 * `uitest dumpLayout` plus a file transfer, which the collector owns and the
 * runner knows the path for. Passing a closure keeps `ActionDevice` unchanged,
 * so `Device` still satisfies it structurally.
 */

import type { Gesture, GestureResult } from '../device/gesture';
import { OhosPerfError } from '../errors';
import type { UiNode } from '../query/ui';
import { resolveSelector, type Selector } from './selector';
import type { ScenarioAction } from './schema';

/** The device surface actions need. `Device` satisfies it structurally. */
export interface ActionDevice {
  readonly id: string;
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
  gesture(g: Gesture): Promise<GestureResult>;
}

/**
 * What a selector action needs beyond the device: a fresh look at the screen.
 *
 * Optional so a coordinate-only scenario keeps calling `executeAction` with
 * three arguments; a selector action without one is a typed refusal rather
 * than a crash.
 */
export interface ActionContext {
  readonly dump: () => Promise<readonly UiNode[]>;
}

/** How many swipes a `scrollTo` search may spend before giving up. */
const MAX_SCROLLS = 5;

/**
 * Default travel of a `swipeArea`, as a percentage of the area's extent.
 *
 * 40 because the gesture spans 70% to 30% of the area, the same band the
 * `scrollTo` loop swipes. Starting at 60% of the extent would put the finger
 * on the area's edge, where a gesture is read as a drag of whatever is under
 * it rather than a scroll of the area.
 */
const DEFAULT_DISTANCE = 40;

/** How often a `tap` with `timeoutMs` re-dumps while waiting for its target. */
const POLL_MS = 250;

/** The marker `uitest uiInput` prints when it accepted the injection. */
const ACCEPTED_MARKER = 'No Error';

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

/** The context a selector action requires, or a refusal naming why it is missing. */
function requireDump(context: ActionContext | undefined): () => Promise<readonly UiNode[]> {
  if (context === undefined) {
    throw new OhosPerfError(
      'a selector action needs a UI dump; pass the action context' +
        ' (this action was executed without one)',
      { code: 'SCENARIO_SELECTOR_NO_TREE' },
    );
  }
  return context.dump;
}

/**
 * The point to tap for one selected node.
 *
 * A node whose `bounds` never parsed has no position. Tapping it at (0,0) is
 * the one thing that must not happen: it looks like a working action and
 * quietly taps the corner of the screen. The refusal names the raw string so
 * the reader can see what the dump actually said.
 */
function centreOf(node: UiNode, label: string): { x: number; y: number } {
  const rect = node.boundsRect;
  if (rect === undefined) {
    throw new OhosPerfError(
      `${label}: the selected ${JSON.stringify(node.type)} node has no parseable` +
        ` bounds (got ${JSON.stringify(node.bounds)}); it cannot be tapped`,
      { code: 'SCENARIO_SELECTOR_NO_MATCH' },
    );
  }
  return {
    x: Math.round((rect.left + rect.right) / 2),
    y: Math.round((rect.top + rect.bottom) / 2),
  };
}

/** A stable signature of a tree, for "did the swipe change anything". */
function treeSignature(nodes: readonly UiNode[]): string {
  return nodes.map((node) => `${node.id}|${node.text}|${node.bounds}`).join('\n');
}

/** `resolveSelector`, but a miss is `undefined` rather than a throw. */
function safeResolve(
  nodes: readonly UiNode[],
  selector: Selector,
): UiNode | undefined {
  try {
    return resolveSelector(nodes, selector, 'target');
  } catch {
    return undefined;
  }
}

/**
 * Perform one gesture, failing the action when the device refuses it.
 *
 * `uitest uiInput` exits 0 even when it refuses the gesture, so the marker in
 * its output is the only proof of acceptance — the same rule `GestureDriver`
 * enforces. Checking for the word "error" instead would reject the marker's
 * own `No Error` as a refusal.
 */
async function gestureOrThrow(device: ActionDevice, gesture: Gesture): Promise<void> {
  const result = await device.gesture(gesture);
  if (!result.output.includes(ACCEPTED_MARKER)) {
    throw new OhosPerfError(
      `uitest uiInput ${gesture.action} did not report "${ACCEPTED_MARKER}":` +
        ` ${result.output === '' ? '(no output)' : result.output}`,
      { code: 'SCENARIO_ACTION_FAILED' },
    );
  }
}

/**
 * Find a node, swiping a container when it is not on screen yet.
 *
 * The loop stops early when a swipe leaves the tree unchanged: that is the
 * list's edge, and four more swipes would spend seconds to learn nothing. The
 * refusal reports how many swipes it actually spent, so "5" means the list was
 * still moving and "1" means it never could have contained the target.
 *
 * A container that is not scrollable is a refusal before any swipe, because
 * swiping it would look like a search that found nothing.
 */
async function findWithScroll(
  device: ActionDevice,
  dump: () => Promise<readonly UiNode[]>,
  target: Selector,
  scrollTo: Selector,
  label: string,
): Promise<UiNode> {
  const first = await dump();
  const direct = safeResolve(first, target);
  if (direct !== undefined) return direct;

  const container = resolveSelector(first, scrollTo, 'scrollTo');
  if (!container.scrollable) {
    throw new OhosPerfError(
      `scrollTo: the selected ${JSON.stringify(container.type)} node is not scrollable` +
        '; name the list, not its container',
      { code: 'SCENARIO_SELECTOR_NO_MATCH' },
    );
  }
  const rect = container.boundsRect;
  if (rect === undefined) {
    throw new OhosPerfError(
      'scrollTo: the selected node has no parseable bounds' +
        ` (got ${JSON.stringify(container.bounds)})`,
      { code: 'SCENARIO_SELECTOR_NO_MATCH' },
    );
  }

  const middleX = Math.round((rect.left + rect.right) / 2);
  const fromY = Math.round(rect.top + (rect.bottom - rect.top) * 0.7);
  const toY = Math.round(rect.top + (rect.bottom - rect.top) * 0.3);
  const swipe: Gesture = { action: 'swipe', fromX: middleX, fromY, toX: middleX, toY };

  let previous = treeSignature(first);
  for (let attempt = 1; attempt <= MAX_SCROLLS; attempt += 1) {
    await gestureOrThrow(device, swipe);
    const next = await dump();
    const found = safeResolve(next, target);
    if (found !== undefined) return found;
    const signature = treeSignature(next);
    if (signature === previous) {
      throw new OhosPerfError(
        `${label}: no node matched the selector after ${attempt} ` +
          `swipe${attempt === 1 ? '' : 's'} of the scrollTo container; it stopped` +
          ' changing, so it is at its edge and the target is not in it',
        { code: 'SCENARIO_SELECTOR_NO_MATCH' },
      );
    }
    previous = signature;
  }
  throw new OhosPerfError(
    `${label}: no node matched the selector after ${MAX_SCROLLS} swipes of the` +
      ' scrollTo container; the target may be past its end or on another screen',
    { code: 'SCENARIO_SELECTOR_NO_MATCH' },
  );
}

/**
 * Resolve a tap target, waiting up to `timeoutMs` for it to appear.
 *
 * A screen that animates in needs a moment; a dump taken immediately after the
 * previous action can catch the outgoing screen. Without a timeout the wait is
 * zero and the first dump decides, which is what a scenario that names no
 * timeout asked for.
 */
async function resolveWithWait(
  dump: () => Promise<readonly UiNode[]>,
  target: Selector,
  label: string,
  timeoutMs: number | undefined,
): Promise<UiNode> {
  const deadline = timeoutMs === undefined ? 0 : Date.now() + timeoutMs;
  for (;;) {
    const nodes = await dump();
    const node = safeResolve(nodes, target);
    if (node !== undefined) return node;
    const remaining = deadline - Date.now();
    if (timeoutMs === undefined || remaining <= 0) {
      // Refuse from the dump just read: it is the same screen a second dump
      // would see, and a real dumpLayout + recv costs seconds.
      return resolveSelector(nodes, target, label);
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_MS, remaining)),
    );
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
  context?: ActionContext,
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
    case 'tap': {
      const dump = requireDump(context);
      const node = action.scrollTo === undefined
        ? await resolveWithWait(dump, action.target, 'target', action.timeoutMs)
        : await findWithScroll(device, dump, action.target, action.scrollTo, 'target');
      const point = centreOf(node, 'target');
      const result = await device.gesture({ action: 'click', x: point.x, y: point.y });
      return { output: result.output };
    }
    case 'tapText': {
      const dump = requireDump(context);
      const selector: Selector = { kind: 'text', text: action.text };
      const node = action.scrollTo === undefined
        ? resolveSelector(await dump(), selector, 'text')
        : await findWithScroll(device, dump, selector, action.scrollTo, 'text');
      const point = centreOf(node, 'text');
      const result = await device.gesture({ action: 'click', x: point.x, y: point.y });
      return { output: result.output };
    }
    case 'swipeArea': {
      const dump = requireDump(context);
      const node = resolveSelector(await dump(), action.area, 'area');
      const rect = node.boundsRect;
      if (rect === undefined) {
        throw new OhosPerfError(
          'area: the selected node has no parseable bounds' +
            ` (got ${JSON.stringify(node.bounds)}); it cannot be swiped`,
          { code: 'SCENARIO_SELECTOR_NO_MATCH' },
        );
      }
      const travel = (action.distance ?? DEFAULT_DISTANCE) / 100;
      const result = await device.gesture(swipeInside(rect, action.direction, travel));
      return { output: result.output };
    }
    case 'inputInto': {
      const dump = requireDump(context);
      const node = resolveSelector(await dump(), action.target, 'target');
      const point = centreOf(node, 'target');
      await device.gesture({ action: 'click', x: point.x, y: point.y });
      const result = await device.gesture({
        action: 'inputText',
        x: point.x,
        y: point.y,
        text: action.text,
      });
      return { output: result.output };
    }
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

/**
 * A swipe inside `rect` in `direction`, travelling `travel` of the extent.
 *
 * The gesture is centred in the area and spans `travel` of the relevant
 * extent, so the default (40) runs from 70% to 30% — inside the area, never on
 * its edge. A direction names the finger's movement, matching
 * `uitest uiInput swipe`: `up` scrolls a list towards its end.
 */
function swipeInside(
  rect: { left: number; top: number; right: number; bottom: number },
  direction: 'up' | 'down' | 'left' | 'right',
  travel: number,
): Gesture {
  const midX = Math.round((rect.left + rect.right) / 2);
  const midY = Math.round((rect.top + rect.bottom) / 2);
  const halfX = Math.round(((rect.right - rect.left) * travel) / 2);
  const halfY = Math.round(((rect.bottom - rect.top) * travel) / 2);
  switch (direction) {
    case 'up':
      return { action: 'swipe', fromX: midX, fromY: midY + halfY, toX: midX, toY: midY - halfY };
    case 'down':
      return { action: 'swipe', fromX: midX, fromY: midY - halfY, toX: midX, toY: midY + halfY };
    case 'left':
      return { action: 'swipe', fromX: midX + halfX, fromY: midY, toX: midX - halfX, toY: midY };
    case 'right':
      return { action: 'swipe', fromX: midX - halfX, fromY: midY, toX: midX + halfX, toY: midY };
  }
}
