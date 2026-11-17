/**
 * The model-guided exploration turn (HapRay parity row 38).
 *
 * HapRay's `llm_strategy.py` annotates a screenshot with red boxes, asks a
 * vision model which numbered element to tap, and then trusts the answer: an
 * index past the end of the list silently clicks element 0, an unparseable
 * answer clicks the first element, and a failed call clicks the first button.
 * The model also decides `scroll` / `back` / `stop`, and a second model call
 * per stack entry decides whether the screen counts as a new page.
 *
 * This is the same decision, made checkable:
 *
 * - **The offer is the screen.** The elements in the prompt are exactly the
 *   elements the walk found in the dump it just took. An answer names an index
 *   into that list; the chooser maps it back to the identity the walk records,
 *   and an index outside the list is a refusal naming both numbers. There is no
 *   silent fallback to element 0.
 * - **The turn is text.** The tree already carries the labels and the bounds;
 *   sending rendered nodes costs fewer tokens than a screenshot and has no
 *   annotation step whose failure mode is "the boxes are in the wrong place".
 * - **The model cannot invent a gesture.** It chooses among `tap` (an offered
 *   element), `scroll`, `back` and `stop`. It never supplies coordinates, so
 *   the worst a hostile answer can do is pick a bad node the walk already
 *   considered — and irreversible ones are not offered at all.
 * - **No state comparator is needed.** HapRay asks a model "same page?" on
 *   every transition. The answer to that is `hashPageShape`, computed from the
 *   tree: same structure, different data (or a scroll) is the same page. The
 *   walk measures it and rewinds its trail; no second model call, no guess.
 */

import { renderTree } from './agent';
import type { ChatModel } from './agent-client';
import type {
  ExplorationChoiceContext,
  ExplorationChooser,
  ExplorationStep,
  ScrollDirection,
} from './explore';

/** How many recent steps the prompt shows; enough to avoid repeats. */
const HISTORY_LIMIT = 8;

/** How much of an unparseable answer a refusal quotes. */
const EXCERPT_CHARS = 200;

/** One element offered to the model, with its position in the offer. */
export interface StrategyElement {
  readonly index: number;
  readonly type: string;
  readonly text: string;
  readonly bounds: string;
  readonly depth: number;
}

/** Everything one exploration prompt contains. */
export interface StrategyTurn {
  /** The bundle the walk must stay inside, when one was named. */
  readonly app?: string;
  /** Zero-based index of the step being decided. */
  readonly step: number;
  readonly maxSteps: number;
  /** The current screen, as `renderTree` renders it. */
  readonly screen: string;
  readonly elements: readonly StrategyElement[];
  /** Recent steps, oldest first, as one line each. */
  readonly history: readonly string[];
  readonly canScroll: boolean;
  readonly canBack: boolean;
}

/** What a model may answer. */
export type StrategyAnswer =
  | { readonly action: 'tap'; readonly element: number; readonly reason: string }
  | { readonly action: 'scroll'; readonly direction: ScrollDirection; readonly reason: string }
  | { readonly action: 'back'; readonly reason: string }
  | { readonly action: 'stop'; readonly reason: string };

/** An answer that could not be read, with what was wrong. */
export interface StrategyRefusal {
  readonly action: 'refused';
  readonly detail: string;
}

function refusal(detail: string): StrategyRefusal {
  return { action: 'refused', detail };
}

/**
 * The prompt for one exploration step.
 *
 * Deterministic: the same turn renders to the same string. The answer formats
 * are written out literally because a model that invents an action name fails
 * far from the answer that caused it, and only the actions the screen allows
 * are listed — asking for an action the walk will refuse wastes a turn.
 */
export function explorationPrompt(turn: StrategyTurn): string {
  const elements = turn.elements.length === 0
    ? '(no element is left to choose on this screen)'
    : turn.elements
        .map(
          (element) =>
            `${element.index}. ${element.type} ${JSON.stringify(oneLine(element.text))}`
            + ` bounds=${element.bounds} depth=${element.depth}`,
        )
        .join('\n');
  const history = turn.history.length === 0 ? '(no steps yet)' : turn.history.join('\n');
  const actions = [
    'tap',
    ...(turn.canScroll ? ['scroll'] : []),
    ...(turn.canBack ? ['back'] : []),
    'stop',
  ];
  const formats = [
    '  {"action": "tap", "element": 0, "reason": "why this element"}',
    ...(turn.canScroll
      ? ['  {"action": "scroll", "direction": "up", "reason": "why"}']
      : []),
    ...(turn.canBack ? ['  {"action": "back", "reason": "why"}'] : []),
    '  {"action": "stop", "reason": "why"}',
  ];

  return [
    `You are exploring the OHOS app ${turn.app ?? '(the app on screen)'}` +
      ' to reach as many distinct pages as possible.',
    `Step ${turn.step + 1} of ${turn.maxSteps}.`,
    '',
    'The current screen, one node per line:',
    turn.screen,
    '',
    'Elements you may choose, with their index:',
    elements,
    '',
    'Steps so far:',
    history,
    '',
    `Available actions: ${actions.join(', ')}.`,
    'Answer with one JSON object and nothing else:',
    ...formats,
    'An element index that was not offered is refused.',
  ].join('\n');
}

/** One field on one line, so a label with a newline cannot break the prompt. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Strip a markdown fence a model added around its JSON. */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match === null ? text : match[1]!;
}

/** The action names the walk understands. */
const ACTIONS = new Set(['tap', 'scroll', 'back', 'stop']);

/**
 * Read a model's answer.
 *
 * The answer is data from outside the package, so every field is checked. A
 * content problem becomes a refusal, not a thrown error: a confused model
 * should cost one step, not the walk. Transport failures are the caller's
 * (the chooser does not catch them) because an unreachable endpoint is a
 * configuration problem and continuing would hide it.
 */
export function parseStrategyAnswer(content: string): StrategyAnswer | StrategyRefusal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(content.trim()));
  } catch {
    return refusal(
      `the model's answer is not JSON: ${JSON.stringify(content.slice(0, EXCERPT_CHARS))}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refusal('the model\'s answer is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const action = record['action'];
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    return refusal(
      `the model's answer must have an "action" of tap, scroll, back or stop` +
        ` (got ${JSON.stringify(action)})`,
    );
  }
  const reason = typeof record['reason'] === 'string' ? record['reason'] : '';

  switch (action) {
    case 'tap': {
      const element = record['element'];
      if (typeof element !== 'number' || !Number.isSafeInteger(element) || element < 0) {
        return refusal(
          `the model's "element" must be a non-negative integer (got ${JSON.stringify(element)})`,
        );
      }
      return { action: 'tap', element, reason };
    }
    case 'scroll': {
      const direction = record['direction'];
      if (direction !== 'up' && direction !== 'down') {
        return refusal(
          `the model's scroll "direction" must be up or down (got ${JSON.stringify(direction)})`,
        );
      }
      return { action: 'scroll', direction, reason };
    }
    case 'back':
      return { action: 'back', reason };
    default:
      return { action: 'stop', reason };
  }
}

/** A walk context as the prompt's turn. */
function strategyTurn(context: ExplorationChoiceContext): StrategyTurn {
  return {
    ...(context.app === undefined ? {} : { app: context.app }),
    step: context.step,
    maxSteps: context.maxSteps,
    screen: renderTree(context.screen),
    elements: context.candidates.map((candidate, index) => ({
      index,
      type: candidate.type,
      text: candidate.text,
      bounds: candidate.bounds,
      depth: candidate.depth,
    })),
    history: context.history.slice(-HISTORY_LIMIT).map(historyLine),
    canScroll: context.canScroll,
    canBack: context.canBack,
  };
}

/** One earlier step as a line the model can act on. */
function historyLine(step: ExplorationStep): string {
  const what = step.kind === 'tap' ? `tap ${step.nodeId ?? '(unknown)'}` : step.kind;
  const why = step.reason === undefined ? '' : ` — ${step.reason}`;
  return `${step.index + 1}. ${what} → ${step.outcome}${why}`;
}

/**
 * A chooser over one model client.
 *
 * The index is mapped to the identity the walk offered, and every answer the
 * walk cannot honour becomes a `refusal` — the walk records it and lets the
 * deterministic order decide. The prompt and parser are one pair here for the
 * same reason the GUI agent's are: a prompt asks for what its parser reads.
 */
export function llmChooser(model: ChatModel): ExplorationChooser {
  return async (context) => {
    const answer = parseStrategyAnswer(
      await model.complete(explorationPrompt(strategyTurn(context))),
    );
    if (answer.action === 'refused') return { kind: 'refusal', detail: answer.detail };

    switch (answer.action) {
      case 'tap': {
        const candidate = context.candidates[answer.element];
        if (candidate === undefined) {
          return {
            kind: 'refusal',
            detail:
              `the model chose element ${answer.element}, but`
              + ` ${context.candidates.length} element(s) were offered`,
          };
        }
        return { kind: 'tap', identity: candidate.identity, reason: answer.reason };
      }
      case 'scroll':
        if (!context.canScroll) {
          return {
            kind: 'refusal',
            detail:
              'the model asked to scroll, but this screen has no scrollable node'
              + ' left to swipe',
          };
        }
        return { kind: 'scroll', direction: answer.direction, reason: answer.reason };
      case 'back':
        if (!context.canBack) {
          return {
            kind: 'refusal',
            detail:
              'the model asked to go back, but the walk has no earlier page to'
              + ' return to',
          };
        }
        return { kind: 'back', reason: answer.reason };
      default:
        return { kind: 'stop', reason: answer.reason };
    }
  };
}
