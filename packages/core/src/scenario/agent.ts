/**
 * The model-driven UI agent (HapRay parity row 5).
 *
 * HapRay's `gui-agent` wraps the external `phone_agent` package: the model is
 * shown a screenshot, answers with one action, and says `finished` when it
 * believes the task is done. Three things make that unusable as a measurement
 * tool, and each is fixed here rather than reproduced.
 *
 * 1. **`finished` is taken on faith.** A model that taps a button which does
 *    nothing and then declares success is recorded as a success. Here a
 *    completion claim carries an expectation, the expectation is evaluated
 *    against a fresh dump, and a claim the screen contradicts is recorded as
 *    `unverified` — a failure with the clause that failed named.
 * 2. **The safety rule is mostly in the prompt.** HapRay adds one sentence to
 *    the task prompt — avoid login, payment, ordering, transfer, posting — and
 *    that is the only layer that applies to every gesture. `phone_agent` does
 *    ship a `confirmation_callback`, but it fires only when the model itself
 *    labels the tap (`do(action="Tap", element=[x,y], message="重要操作")`), so
 *    a plain `Tap` is performed with no check; it covers `Tap` alone, leaving
 *    long press, double tap, swipe and text entry unguarded; and HapRay passes
 *    no callback, so the default is a blocking `input()` that raises `EOFError`
 *    in a batch run and is recorded as a failed step with the run continuing.
 *    Here the guard reads the node the tap lands on and refuses the gesture
 *    outright. An irreversible action stops the run: a model that reached for
 *    a payment button has lost the thread of the task, and asking it again
 *    spends steps on the one thing that must not happen.
 * 3. **The log cannot be replayed.** HapRay records `{action, thinking,
 *    message}` as prose, so two runs of the same task are two unrelated logs.
 *    Here every step records the gesture and the screen hash either side of
 *    it, so {@link replayAgent} can walk the same path on another build
 *    without a model, and stop at the first screen that is not the recorded
 *    one.
 *
 * The model is injected, never bundled: {@link AgentModel} is one method, so a
 * caller supplies whatever client it has, and the loop is tested without a
 * network or a device.
 */

import type { Gesture, GestureResult } from '../device/gesture';
import { OhosPerfError } from '../errors';
import type { UiNode } from '../query/ui';
import { parseBounds } from '../query/ui';
import { hashTree } from './explore';
import { evaluateExpectation } from './runner';
import { parseExpectation, type StepExpectation } from './schema';

/** The device surface the loop needs. `Device` satisfies it structurally. */
export interface AgentDevice {
  readonly id: string;
  /** A fresh flattened dump, as `Device.uiTree` returns. */
  uiTree(): Promise<readonly UiNode[]>;
  gesture(g: Gesture): Promise<GestureResult>;
}

/** What the model answers: one gesture, or a claim that the task is done. */
export type AgentDecision =
  | { readonly action: Gesture; readonly reason: string }
  | { readonly done: true; readonly reason: string; readonly expect?: StepExpectation };

/** One earlier step, as the model sees it when deciding the next. */
export interface AgentHistoryEntry {
  readonly step: number;
  readonly status: AgentStepStatus;
  readonly reason: string;
  /** What the step did, as `describeDecision` renders it. */
  readonly did?: string;
  readonly detail?: string;
}

/** Everything a model is shown. A client renders this into its own prompt. */
export interface AgentTurn {
  readonly task: string;
  readonly app: string;
  /** Zero-based index of the step being decided. */
  readonly step: number;
  readonly maxSteps: number;
  /** The current screen, one line per node. */
  readonly screen: string;
  /** The steps already taken, oldest first. */
  readonly history: readonly AgentHistoryEntry[];
}

/** The injected client. One method, so any endpoint fits. */
export interface AgentModel {
  decide(request: AgentTurn): Promise<AgentDecision>;
}

/**
 * How a step ended.
 *
 * `acted` is a gesture the device accepted, `failed` one it rejected,
 * `refused` one the guard stopped before it reached the device, `verified` a
 * completion claim the screen confirmed, and `unverified` one it did not.
 */
export type AgentStepStatus = 'acted' | 'failed' | 'refused' | 'verified' | 'unverified';

export interface AgentStep {
  readonly index: number;
  readonly status: AgentStepStatus;
  readonly reason: string;
  /** The gesture performed or attempted; absent for a refusal or a claim. */
  readonly action?: Gesture;
  /** Why the step ended that way, when the status alone does not say. */
  readonly detail?: string;
  /** The screen hash before the step. */
  readonly before: string;
  /** The screen hash after it; equal to `before` when nothing moved. */
  readonly after: string;
  readonly navigated: boolean;
}

export type AgentStatus = 'completed' | 'unverified' | 'refused' | 'exhausted';

/** A run, complete enough to replay and to compare against another run. */
export interface AgentTranscript {
  readonly version: 1;
  readonly task: string;
  readonly app: string;
  readonly steps: readonly AgentStep[];
  readonly status: AgentStatus;
  /** Distinct screen hashes reached, including the one it started on. */
  readonly statesReached: number;
}

export type AgentResult = AgentTranscript;

export interface AgentOptions {
  readonly task: string;
  readonly app: string;
  /** Hard cap on model turns. HapRay's default is 50. */
  readonly maxSteps: number;
  /** Let the guard's refusals through. Off by default. */
  readonly allowIrreversible?: boolean;
}

/** One irreversible action the guard recognises. */
export interface IrreversiblePattern {
  readonly pattern: RegExp;
  /** Why the action is refused; the text a refusal records. */
  readonly why: string;
  /** A label that matches `pattern`, so a test can prove the row is live. */
  readonly sample: string;
}

/**
 * The actions the guard refuses.
 *
 * Each pattern names an act, not a topic: `Payment settings` is a screen a
 * walk may legitimately open, while `立即支付` is money leaving an account.
 * Matching on a bare substring would block the settings page a task needs.
 */
export const IRREVERSIBLE_PATTERNS: readonly IrreversiblePattern[] = [
  {
    pattern: /\bpay\b|\bpay now\b|立即支付|确认支付|去支付|立即购买/i,
    why: 'payment is irreversible',
    sample: '立即支付',
  },
  {
    pattern: /\b(?:confirm order|place order|submit order|buy now)\b|提交订单|确认下单/i,
    why: 'placing an order is irreversible',
    sample: 'Confirm order',
  },
  {
    pattern: /\btransfer\b|\bsend money\b|\bremit\b|转账/i,
    why: 'a transfer moves money and cannot be undone',
    sample: 'Transfer',
  },
  {
    pattern: /\b(?:log ?in|sign ?in|register|sign ?up)\b|登录|注册/i,
    why: 'signing in changes the account state',
    sample: 'Log in',
  },
  {
    pattern: /\b(?:delete|unsubscribe|publish|post|share)\b|删除|注销|发布/i,
    why: 'the action destroys or publishes content',
    sample: 'Delete',
  },
];

/**
 * The labels a node is recognised by: its text and its id.
 *
 * Both are checked, because the two disagree in the common case — a button
 * labelled `立即支付` may have the id `btn_confirm`, and a button with no text
 * at all is often called `pay_button`. An id's separators are read as spaces,
 * so `pay_button` is the word `pay` followed by another word rather than one
 * long token that a `\b` boundary never ends.
 */
function labelsOf(node: UiNode): string[] {
  const labels = [node.text.trim(), node.id.replace(/[_-]+/g, ' ').trim()];
  return labels.filter((label) => label !== '');
}

/** Why tapping this node is irreversible, or `undefined` when it is safe. */
export function irreversibleReason(node: UiNode): string | undefined {
  for (const label of labelsOf(node)) {
    for (const entry of IRREVERSIBLE_PATTERNS) {
      if (entry.pattern.test(label)) return entry.why;
    }
  }
  return undefined;
}

/** One line naming what a decision does, for a transcript or a history entry. */
export function describeDecision(decision: AgentDecision): string {
  if ('done' in decision) return 'done';
  const action = decision.action;
  switch (action.action) {
    case 'click':
      return `click at (${action.x}, ${action.y})`;
    case 'swipe':
      return `swipe (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY})`;
    case 'key':
      return `key ${String(action.key)}`;
    case 'inputText':
      return `type ${JSON.stringify(action.text)} at (${action.x}, ${action.y})`;
    case 'text':
      return `type ${JSON.stringify(action.text)}`;
  }
}

/** Keep a node's text on one line, so the screen stays one line per node. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
}

/**
 * Render a dump for a model prompt: one line per node, in tree order.
 *
 * The fields are the ones a decision is made from — what it says, what it is,
 * what it is called, where it is, and whether it can be tapped. A node that
 * cannot be tapped is marked so the model does not spend a step on it, which
 * is the single most common wasted turn in HapRay's runs.
 */
export function renderTree(tree: readonly UiNode[]): string {
  if (tree.length === 0) {
    return '(the screen is empty: no nodes were dumped)';
  }
  return tree
    .map((node) => {
      const parts = [
        `${'  '.repeat(Math.max(0, node.depth - 1))}${node.type}`,
        node.text.trim() === '' ? '' : JSON.stringify(oneLine(node.text)),
        node.id === '' ? '' : `id=${node.id}`,
        node.bounds,
        node.clickable ? 'clickable' : 'unclickable',
      ];
      if (!node.enabled) parts.push('disabled');
      if (node.scrollable) parts.push('scrollable');
      return parts.filter((part) => part !== '').join(' ');
    })
    .join('\n');
}

function badInput(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: 'SCENARIO_BAD_INPUT' });
}

function assertOptions(options: AgentOptions): void {
  if (options.task.trim() === '') {
    throw badInput('agent task must not be empty');
  }
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) {
    throw badInput(
      `agent maxSteps must be a positive integer (got ${String(options.maxSteps)})`,
    );
  }
}

/** Reject a model answer that is neither an action nor a completion. */
function assertDecision(decision: unknown, step: number): AgentDecision {
  if (typeof decision !== 'object' || decision === null) {
    throw badInput(`agent step ${step}: the model returned no decision`);
  }
  const record = decision as Record<string, unknown>;
  const hasAction = record['action'] !== undefined;
  const hasDone = record['done'] === true;
  if (hasAction === hasDone) {
    throw badInput(
      `agent step ${step}: the model must answer with exactly one of an action or done`,
    );
  }
  return decision as AgentDecision;
}

/**
 * The prompt for one decision.
 *
 * A plain string, not a message list: whatever client a caller brings turns
 * this into its own request shape. It states the answer format literally
 * because a model that invents a gesture name fails far from the answer that
 * caused it, and it shows the history because a model that cannot see its own
 * steps repeats them.
 */
export function agentPrompt(request: AgentTurn): string {
  const history = request.history.length === 0
    ? '(no steps yet)'
    : request.history
        .map((entry) => {
          const did = entry.did === undefined ? entry.status : `${entry.did} — ${entry.status}`;
          const detail = entry.detail === undefined ? '' : ` (${entry.detail})`;
          return `  ${entry.step + 1}. ${did}: ${entry.reason}${detail}`;
        })
        .join('\n');

  return [
    `You are driving the app ${request.app} on an OHOS device to complete a task.`,
    `Task: ${request.task}`,
    '',
    `Step ${request.step + 1} of ${request.maxSteps}.`,
    '',
    'The current screen, one node per line:',
    request.screen,
    '',
    'Steps so far:',
    history,
    '',
    'Answer with one JSON object and nothing else. To act:',
    '  {"action": {"action": "click", "x": 540, "y": 1170}, "reason": "why"}',
    'Allowed gestures: click, swipe, key, inputText, text.',
    'To finish, include the expectation that proves the task is done:',
    '  {"done": true, "reason": "why", "expect": {"present": [{"selector": {"kind": "text", "text": "Done"}}]}}',
    'A done answer without an expectation is recorded as unverified, not as success.',
    'Do not tap payment, ordering, transfer, sign-in, delete or publish actions.',
  ].join('\n');
}

/** The gesture names the device accepts; anything else is a refusal. */
const GESTURE_NAMES = new Set(['click', 'swipe', 'key', 'inputText', 'text']);

function parseGesture(value: unknown): Gesture {
  if (typeof value !== 'object' || value === null) {
    throw badInput('the answer\'s "action" must be a gesture object');
  }
  const record = value as Record<string, unknown>;
  const name = record['action'];
  if (typeof name !== 'string' || !GESTURE_NAMES.has(name)) {
    throw badInput(
      `the answer's gesture must be one of ${[...GESTURE_NAMES].join(', ')}` +
        ` (got ${JSON.stringify(name)})`,
    );
  }
  // The rest is checked by the gesture driver, which owns those rules; this
  // only guarantees the discriminant is one the driver can switch on.
  return value as Gesture;
}

/** Strip a markdown fence a model added around its JSON. */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match === null ? text : match[1]!;
}

/**
 * Read a model's answer.
 *
 * The answer is data from outside this package, so every field is checked
 * here: an unknown gesture name, a malformed expectation, or an object that is
 * both an action and a completion is a refusal naming what was wrong. A
 * refusal now beats a confusing failure inside the gesture driver or the
 * expectation evaluator, where the cause is no longer visible.
 */
export function parseDecision(text: string): AgentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    throw badInput(
      `the model's answer is not JSON: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }

  const decision = assertDecision(parsed, 0);
  const record = parsed as Record<string, unknown>;
  const reason = typeof record['reason'] === 'string' ? record['reason'] : '';

  if ('done' in decision) {
    const expect = record['expect'] === undefined
      ? undefined
      : parseExpectation(record['expect'], 'expect');
    return { done: true, reason, ...(expect === undefined ? {} : { expect }) };
  }
  return { action: parseGesture(record['action']), reason };
}

/** The node a tap lands on: the smallest containing node, clickable first. */
function targetOf(tree: readonly UiNode[], x: number, y: number): UiNode | undefined {
  const containing = tree.filter((node) => {
    // A dump may omit `boundsRect`; the string is the source it is parsed from,
    // and skipping those nodes would let an irreversible target through.
    const rect = node.boundsRect ?? parseBounds(node.bounds);
    if (rect === undefined) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
  const area = (node: UiNode): number => {
    const rect = node.boundsRect ?? parseBounds(node.bounds)!;
    return (rect.right - rect.left) * (rect.bottom - rect.top);
  };
  return containing
    .slice()
    .sort((a, b) => Number(b.clickable) - Number(a.clickable) || area(a) - area(b))[0];
}

type BoundsRect = NonNullable<UiNode['boundsRect']>;

function rectOf(node: UiNode): BoundsRect | undefined {
  return node.boundsRect ?? parseBounds(node.bounds);
}

/** Axis-aligned gap between a point and a rect; zero when the point is inside. */
function gapTo(rect: BoundsRect, x: number, y: number): number {
  return Math.max(rect.left - x, 0, x - rect.right, rect.top - y, 0, y - rect.bottom);
}

function containsRect(outer: BoundsRect, inner: BoundsRect): boolean {
  return outer.left <= inner.left && outer.top <= inner.top
    && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

/**
 * How far from an irreversible control a tap may land and still be refused.
 *
 * A tap is aimed at a control, not at a pixel: a model reading a rendered tree
 * rounds, and a person's finger is larger than one. The margin is small enough
 * that a neighbouring control is never swallowed — see {@link nearMissOf}.
 */
const NEAR_MISS_PX = 24;

/**
 * The irreversible control a tap lands *near* rather than on.
 *
 * Measured on 2026-11-17 against a real model: given a checkout screen whose
 * only control was "Pay now" at `[0,1800][1080,1950]`, one model answered
 * `click {x:540, y:1965}` — 15 px below the button, on the screen's padding.
 * A device's hit region usually includes some of that padding, so strict
 * containment waves the tap through.
 *
 * A tap that lands on a *different* clickable control is left alone: the model
 * then aimed at that control, and refusing would block the navigation the task
 * needs. The exception is an ancestor — a tap on a card's padding next to the
 * card's own delete button is still a tap near that button.
 */
function nearMissOf(
  tree: readonly UiNode[],
  x: number,
  y: number,
  landedOn: UiNode | undefined,
): { node: UiNode; gap: number } | undefined {
  let best: { node: UiNode; gap: number } | undefined;
  for (const node of tree) {
    if (irreversibleReason(node) === undefined) continue;
    const rect = rectOf(node);
    if (rect === undefined) continue;
    const gap = gapTo(rect, x, y);
    if (gap > NEAR_MISS_PX) continue;
    if (landedOn !== undefined && landedOn !== node && landedOn.clickable) {
      const landing = rectOf(landedOn);
      if (landing === undefined || !containsRect(landing, rect)) continue;
    }
    if (best === undefined || gap < best.gap) best = { node, gap };
  }
  return best;
}

/**
 * Why a tap at this point must be refused, or `undefined` when it may proceed.
 *
 * The landed-on node decides first, so an ordinary control is never second-
 * guessed; only a tap that misses every irreversible label is checked for a
 * near miss.
 */
function refusalFor(
  tree: readonly UiNode[],
  x: number,
  y: number,
  landedOn: UiNode | undefined,
): string | undefined {
  const direct = landedOn === undefined ? undefined : irreversibleReason(landedOn);
  if (direct !== undefined) return direct;
  const near = nearMissOf(tree, x, y, landedOn);
  return near === undefined ? undefined : irreversibleReason(near.node);
}

/** The failing clauses of an expectation, in the author's terms. */
function unmetExpectation(
  expect: StepExpectation,
  tree: readonly UiNode[],
  app: string,
): string | undefined {
  const outcomes = evaluateExpectation(expect, tree, app);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) return undefined;
  return failed
    .map((outcome) => outcome.detail === undefined
      ? outcome.label
      : `${outcome.label}: ${outcome.detail}`)
    .join('; ');
}

/**
 * Run the loop until the model's claim is verified, the guard refuses, or the
 * step budget runs out.
 *
 * The order of checks matters: an irreversible target is refused *before* the
 * gesture reaches the device, and a completion claim is evaluated against the
 * screen the model was shown rather than a fresh one — the model has to be
 * judged on what it saw.
 */
export async function runAgent(
  device: AgentDevice,
  model: AgentModel,
  options: AgentOptions,
): Promise<AgentResult> {
  assertOptions(options);

  const steps: AgentStep[] = [];
  const history: AgentHistoryEntry[] = [];
  const states = new Set<string>();
  let status: AgentStatus = 'exhausted';

  for (let index = 0; index < options.maxSteps; index += 1) {
    const tree = await device.uiTree();
    const before = hashTree(tree);
    states.add(before);

    const decision = assertDecision(
      await model.decide({
        task: options.task,
        app: options.app,
        step: index,
        maxSteps: options.maxSteps,
        screen: renderTree(tree),
        history: [...history],
      }),
      index,
    );

    if ('done' in decision) {
      if (decision.expect === undefined) {
        status = 'unverified';
        steps.push({
          index, status: 'unverified', reason: decision.reason,
          detail: 'the model claimed done with no expectation, so the screen proves nothing',
          before, after: before, navigated: false,
        });
        break;
      }
      const unmet = unmetExpectation(decision.expect, tree, options.app);
      if (unmet === undefined) {
        status = 'completed';
        steps.push({
          index, status: 'verified', reason: decision.reason,
          before, after: before, navigated: false,
        });
        break;
      }
      status = 'unverified';
      steps.push({
        index, status: 'unverified', reason: decision.reason,
        detail: unmet, before, after: before, navigated: false,
      });
      break;
    }

    const gesture = decision.action;
    // A click and a text entry both land on a node, so both are guarded. A
    // swipe or a key press is not aimed at one.
    const point = gesture.action === 'click' || gesture.action === 'inputText'
      ? { x: gesture.x, y: gesture.y }
      : undefined;
    const target = point === undefined ? undefined : targetOf(tree, point.x, point.y);
    const refused = point === undefined ? undefined : refusalFor(tree, point.x, point.y, target);
    if (refused !== undefined && options.allowIrreversible !== true) {
      status = 'refused';
      steps.push({
        index, status: 'refused', reason: decision.reason, action: gesture,
        detail: refused, before, after: before, navigated: false,
      });
      break;
    }

    let failure: string | undefined;
    try {
      await device.gesture(gesture);
    } catch (err) {
      failure = (err as Error).message;
    }

    const nextTree = await device.uiTree();
    const after = hashTree(nextTree);
    states.add(after);

    const step: AgentStep = {
      index,
      status: failure === undefined ? 'acted' : 'failed',
      reason: decision.reason,
      action: gesture,
      ...(failure === undefined ? {} : { detail: failure }),
      before,
      after,
      navigated: after !== before,
    };
    steps.push(step);
    history.push({
      step: index,
      status: step.status,
      reason: decision.reason,
      did: describeDecision(decision),
      ...(failure === undefined ? {} : { detail: failure }),
    });
  }

  return {
    version: 1,
    task: options.task,
    app: options.app,
    steps,
    status,
    statesReached: states.size,
  };
}

/** What a replay did. */
export interface ReplayResult {
  /** Steps whose gesture reached the device. */
  readonly performed: number;
  /** Steps skipped because they never touched the device. */
  readonly skipped: number;
  /** The step whose recorded screen did not match; absent when it matched. */
  readonly divergedAt?: number;
}

/**
 * Walk a recorded transcript again, without a model.
 *
 * The recorded gesture is a coordinate, so it only means what it meant on the
 * screen it was recorded against. Each step re-dumps, compares the hash to the
 * recorded `before`, and stops at the first mismatch: continuing would send
 * taps into whatever the new build put in those places.
 *
 * A step with no gesture (a refusal, or a completion claim) is skipped: it
 * never touched the device, so there is nothing to replay.
 */
export async function replayAgent(
  device: AgentDevice,
  transcript: AgentTranscript,
): Promise<ReplayResult> {
  let performed = 0;
  let skipped = 0;

  for (const step of transcript.steps) {
    if (step.action === undefined) {
      skipped += 1;
      continue;
    }
    const tree = await device.uiTree();
    if (hashTree(tree) !== step.before) {
      return { performed, skipped, divergedAt: step.index };
    }
    await device.gesture(step.action);
    performed += 1;
  }

  return { performed, skipped };
}
