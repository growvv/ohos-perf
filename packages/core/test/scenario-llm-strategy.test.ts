import { describe, it, expect } from 'vitest';
import {
  explorationPrompt,
  llmChooser,
  parseStrategyAnswer,
  type StrategyTurn,
} from '../src/scenario/llm-strategy';
import type { ChatModel } from '../src/scenario/agent-client';
import type { ExplorationChoiceContext, ExplorationStep } from '../src/scenario/explore';
import type { UiNode } from '../src/query/ui';

/*
 * The model-guided exploration turn (HapRay parity row 38).
 *
 * HapRay sends a screenshot with red boxes, asks a vision model which numbered
 * element to tap, and uses the answer unchecked: an index past the end of the
 * list silently clicks element 0. Here the model is offered the
 * elements the walk already found, answers with an index, and every answer is
 * checked against that offer before it can decide a step.
 *
 * The prompt is text, not an annotated screenshot: the tree already carries
 * the labels and the geometry, and a text turn is cheaper to send and easier to
 * assert on than an image.
 */

const node = (overrides: Partial<UiNode> & { id: string }): UiNode => ({
  depth: 1,
  type: 'Button',
  bundleName: 'com.demo',
  abilityName: 'Main',
  text: '',
  bounds: '[0,0][10,10]',
  clickable: true,
  enabled: true,
  scrollable: false,
  children: 0,
  ...overrides,
});

function turn(overrides: Partial<StrategyTurn> = {}): StrategyTurn {
  return {
    app: 'com.demo',
    step: 0,
    maxSteps: 10,
    screen: 'Root\n  Button "Search" [0,0][10,10]',
    elements: [
      { index: 0, type: 'Button', text: 'Search', bounds: '[0,0][10,10]', depth: 2 },
    ],
    history: [],
    canScroll: false,
    canBack: false,
    ...overrides,
  };
}

function step(overrides: Partial<ExplorationStep> = {}): ExplorationStep {
  return {
    index: 0,
    kind: 'tap',
    nodeId: 'search',
    bounds: '[0,0][10,10]',
    before: 'aaaa',
    after: 'bbbb',
    outcome: 'navigated',
    decidedBy: 'strategy',
    ...overrides,
  };
}

function context(overrides: Partial<ExplorationChoiceContext> = {}): ExplorationChoiceContext {
  return {
    app: 'com.demo',
    step: 0,
    maxSteps: 5,
    screen: [node({ id: 'search', text: 'Search' })],
    candidates: [
      { identity: 'search', type: 'Button', text: 'Search', bounds: '[0,0][10,10]', depth: 1 },
    ],
    history: [],
    canScroll: false,
    canBack: false,
    ...overrides,
  };
}

/** A model that records the prompt and answers with one string. */
function stubModel(answer: string): ChatModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
  };
}

describe('explorationPrompt', () => {
  it('names the app, the step budget, the screen and every offered element', () => {
    const prompt = explorationPrompt(turn());
    expect(prompt).toContain('com.demo');
    expect(prompt).toContain('Step 1 of 10');
    expect(prompt).toContain('Button "Search" [0,0][10,10]');
    expect(prompt).toContain('0. Button "Search"');
    expect(prompt).toContain('bounds=[0,0][10,10]');
  });

  it('lists only the actions the screen allows', () => {
    const bare = explorationPrompt(turn());
    expect(bare).toContain('"action": "tap"');
    expect(bare).toContain('"action": "stop"');
    expect(bare).not.toContain('"action": "scroll"');
    expect(bare).not.toContain('"action": "back"');

    const full = explorationPrompt(turn({ canScroll: true, canBack: true }));
    expect(full).toContain('"action": "scroll"');
    expect(full).toContain('"action": "back"');
  });

  it('shows the history oldest first and is deterministic', () => {
    const withHistory = turn({
      history: ['1. tap search → navigated', '2. scroll → updated'],
    });
    expect(explorationPrompt(withHistory)).toContain(
      '1. tap search → navigated\n2. scroll → updated',
    );
    expect(explorationPrompt(withHistory)).toBe(explorationPrompt(withHistory));
  });

  it('says so when there is no element and no history', () => {
    const prompt = explorationPrompt(turn({ elements: [], history: [] }));
    expect(prompt).toContain('(no element is left to choose on this screen)');
    expect(prompt).toContain('(no steps yet)');
  });
});

describe('parseStrategyAnswer', () => {
  it('reads each action from bare or fenced JSON', () => {
    expect(parseStrategyAnswer('{"action":"tap","element":2,"reason":"opens"}'))
      .toEqual({ action: 'tap', element: 2, reason: 'opens' });
    expect(parseStrategyAnswer('```json\n{"action":"scroll","direction":"down","reason":"more"}\n```'))
      .toEqual({ action: 'scroll', direction: 'down', reason: 'more' });
    expect(parseStrategyAnswer('{"action":"back","reason":"leave"}'))
      .toEqual({ action: 'back', reason: 'leave' });
    expect(parseStrategyAnswer('{"action":"stop","reason":"done"}'))
      .toEqual({ action: 'stop', reason: 'done' });
  });

  it('refuses non-JSON, naming an excerpt', () => {
    const answer = parseStrategyAnswer('I would tap the search button');
    expect(answer.action).toBe('refused');
    if (answer.action !== 'refused') return;
    expect(answer.detail).toMatch(/not JSON/);
    expect(answer.detail).toContain('I would tap the search button');
  });

  it('refuses an unknown action, naming the allowed set', () => {
    const answer = parseStrategyAnswer('{"action":"frobnicate"}');
    expect(answer.action).toBe('refused');
    if (answer.action !== 'refused') return;
    expect(answer.detail).toContain('frobnicate');
    expect(answer.detail).toMatch(/tap/);
  });

  it('refuses a non-integer or negative element', () => {
    for (const element of ['"2"', '-1', '1.5', 'null']) {
      const answer = parseStrategyAnswer(`{"action":"tap","element":${element}}`);
      expect(answer.action, element).toBe('refused');
    }
  });

  it('refuses a scroll direction other than up/down', () => {
    const answer = parseStrategyAnswer('{"action":"scroll","direction":"left"}');
    expect(answer.action).toBe('refused');
    if (answer.action !== 'refused') return;
    expect(answer.detail).toMatch(/direction/);
  });

  it('treats a missing or non-string reason as empty rather than failing the step', () => {
    expect(parseStrategyAnswer('{"action":"tap","element":0}'))
      .toEqual({ action: 'tap', element: 0, reason: '' });
    expect(parseStrategyAnswer('{"action":"tap","element":0,"reason":7}'))
      .toEqual({ action: 'tap', element: 0, reason: '' });
  });
});

describe('llmChooser', () => {
  it('maps the chosen index to the offered element identity', async () => {
    const model = stubModel('{"action":"tap","element":0,"reason":"opens the list"}');
    const chooser = llmChooser(model);
    expect(await chooser(context())).toEqual({
      kind: 'tap',
      identity: 'search',
      reason: 'opens the list',
    });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('Button "Search"');
    expect(model.prompts[0]).toContain('0. Button "Search"');
  });

  it('refuses an index past the end of the offer, naming both numbers', async () => {
    const chooser = llmChooser(stubModel('{"action":"tap","element":3,"reason":"x"}'));
    const answer = await chooser(context());
    expect(answer.kind).toBe('refusal');
    if (answer.kind !== 'refusal') return;
    expect(answer.detail).toContain('3');
    expect(answer.detail).toContain('1 element');
  });

  it('refuses scroll and back answers the walk cannot perform', async () => {
    const scrolling = await llmChooser(stubModel('{"action":"scroll","direction":"up"}'))(context());
    expect(scrolling.kind).toBe('refusal');
    if (scrolling.kind !== 'refusal') return;
    expect(scrolling.detail).toMatch(/scroll/);

    const backing = await llmChooser(stubModel('{"action":"back"}'))(context());
    expect(backing.kind).toBe('refusal');
    if (backing.kind !== 'refusal') return;
    expect(backing.detail).toMatch(/back/);
  });

  it('passes allowed scroll, back and stop through', async () => {
    expect(
      await llmChooser(stubModel('{"action":"scroll","direction":"down","reason":"more"}'))(
        context({ canScroll: true }),
      ),
    ).toEqual({ kind: 'scroll', direction: 'down', reason: 'more' });
    expect(await llmChooser(stubModel('{"action":"back","reason":"leave"}'))(context({ canBack: true })))
      .toEqual({ kind: 'back', reason: 'leave' });
    expect(await llmChooser(stubModel('{"action":"stop","reason":"done"}'))(context()))
      .toEqual({ kind: 'stop', reason: 'done' });
  });

  it('turns an unparseable answer into a refusal, not a thrown error', async () => {
    const answer = await llmChooser(stubModel('not json at all'))(context());
    expect(answer.kind).toBe('refusal');
  });

  it('shows the recent history in the prompt, with each step outcome', async () => {
    const model = stubModel('{"action":"stop","reason":"done"}');
    await llmChooser(model)(context({
      history: [step({ nodeId: 'search', outcome: 'navigated' })],
    }));
    expect(model.prompts[0]).toContain('1. tap search → navigated');
  });
});
