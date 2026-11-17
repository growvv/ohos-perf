import { describe, it, expect } from 'vitest';
import {
  hashTree,
  type ExplorationTargetDevice,
} from '../src/scenario/explore';
import type { Gesture, GestureResult } from '../src/device/gesture';
import type { UiNode } from '../src/query/ui';
import {
  agentPrompt,
  describeDecision,
  IRREVERSIBLE_PATTERNS,
  irreversibleReason,
  parseDecision,
  renderTree,
  replayAgent,
  runAgent,
  type AgentDecision,
  type AgentModel,
  type AgentTurn,
  type AgentTranscript,
} from '../src/scenario/agent';

/*
 * The LLM GUI agent (HapRay parity row 5).
 *
 * HapRay's `gui-agent` wraps the external `phone_agent` package: the model sees
 * a screenshot and the tree, answers with an action, and says `finished` when
 * it believes the task is done. Three things are wrong with that as a
 * measurement tool:
 *
 * 1. `finished` is taken on faith. A model that says "done" after tapping a
 *    button that did nothing is recorded as a success.
 * 2. The safety rule — "avoid login, payment, ordering, transfer, posting" —
 *    lives only in the prompt, so a model that ignores it acts anyway.
 * 3. The transcript records action/thinking/message as free text, so a run
 *    cannot be replayed or compared; the same task on two builds produces two
 *    unrelated logs.
 *
 * This module keeps the shape and fixes all three: completion is verified
 * against the screen, an irreversible action is refused rather than asked
 * about, and every step records enough to replay the walk without a model.
 */

/** A scripted model: the tests decide what the model "sees" and answers. */
function scripted(...decisions: AgentDecision[]): AgentModel & { seen: AgentTurn[] } {
  const seen: AgentTurn[] = [];
  let index = 0;
  return {
    seen,
    async decide(request) {
      seen.push(request);
      const decision = decisions[index];
      index += 1;
      if (decision === undefined) throw new Error('scripted model ran out of decisions');
      return decision;
    },
  };
}

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    depth: 1, type: 'Button', bundleName: 'com.demo', abilityName: 'EntryAbility',
    text: 'Continue', id: 'continue', bounds: '[0,0][100,100]',
    clickable: true, enabled: true, scrollable: false, children: 0,
    boundsRect: { left: 0, top: 0, right: 100, bottom: 100 },
    ...overrides,
  };
}

/** A device whose screen the test controls. */
function fakeDevice(screens: UiNode[][], opts: { rejectGestures?: boolean } = {}): ExplorationTargetDevice & {
  gestures: Gesture[];
  dumps: number;
} {
  const gestures: Gesture[] = [];
  let dumps = 0;
  let screen = 0;
  return {
    id: 'emu-1',
    gestures,
    get dumps() {
      return dumps;
    },
    async uiTree() {
      dumps += 1;
      const current = screens[Math.min(screen, screens.length - 1)]!;
      // A dump after a gesture advances the screen, so a test reads the loop's
      // ordering from the trees it was given.
      return current;
    },
    async gesture(g: Gesture): Promise<GestureResult> {
      if (opts.rejectGestures === true) throw new Error('device refused the gesture');
      gestures.push(g);
      screen += 1;
      return { gesture: g, output: 'No Error' };
    },
  };
}

const task = 'open the settings page';

describe('irreversibleReason', () => {
  it('names the reason a payment button is refused', () => {
    const reason = irreversibleReason(node({ text: '立即支付' }));
    expect(reason).toMatch(/pay/i);
  });

  it('names the reason an order-confirmation button is refused', () => {
    expect(irreversibleReason(node({ text: 'Confirm order' }))).toMatch(/order/i);
  });

  it('covers every pattern the guard ships', () => {
    // The table is the contract; a pattern added without a test would ship
    // untested, and one removed silently would weaken the guard. The sample is
    // put in the *text* and in the *id*, so a pattern that only matches one of
    // the two labels is caught here.
    for (const pattern of IRREVERSIBLE_PATTERNS) {
      expect(irreversibleReason(node({ text: pattern.sample }))).toBe(pattern.why);
      expect(irreversibleReason(node({ text: '', id: pattern.sample }))).toBe(pattern.why);
    }
  });

  it('reads an id whose words are joined by underscores', () => {
    // `pay_button` is one token to `\b`, so a guard that only read the text, or
    // only read the id as written, would wave through the most common shape of
    // an unlabeled action button.
    expect(irreversibleReason(node({ text: '', id: 'pay_button' }))).toBe('payment is irreversible');
    expect(irreversibleReason(node({ text: '', id: 'confirm-order' })))
      .toBe('placing an order is irreversible');
  });

  it('does not refuse an ordinary navigation button', () => {
    expect(irreversibleReason(node({ text: 'Continue' }))).toBeUndefined();
  });

  it('does not refuse a node whose text merely mentions a word inside a longer one', () => {
    // "Payment settings" is a page a walk may legitimately open; only the
    // action word makes a tap irreversible. Matching a bare substring would
    // block the settings screen the task needs.
    expect(irreversibleReason(node({ text: 'Payment settings' }))).toBeUndefined();
  });
});

describe('describeDecision', () => {
  it('says what the decision does, in one line', () => {
    expect(describeDecision({ action: { action: 'click', x: 10, y: 20 }, reason: 'tap it' }))
      .toBe('click at (10, 20)');
    expect(describeDecision({ done: true, reason: 'the page is open' }))
      .toBe('done');
  });
});

describe('renderTree', () => {
  it('renders one line per node, with the fields a model needs to choose', () => {
    // The model never sees a screenshot here: the tree is the whole input, so
    // the renderer has to carry text, id, type, whether it is tappable, and
    // where it is — the five things a decision is made from.
    const text = renderTree([
      node({ text: 'Settings', id: 'settings' }),
      node({ text: '', id: 'back', type: 'Image', clickable: true }),
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Settings');
    expect(lines[0]).toContain('settings');
    expect(lines[0]).toContain('Button');
    expect(lines[0]).toContain('[0,0][100,100]');
    expect(lines[1]).toContain('Image');
  });

  it('marks a node that cannot be tapped, so the model does not try', () => {
    const text = renderTree([node({ text: 'Static', clickable: false, enabled: false })]);
    expect(text).toContain('Static');
    expect(text).toContain('unclickable');
    expect(text).toContain('disabled');
  });

  it('says an empty screen is empty rather than returning a blank string', () => {
    // An empty prompt reads to a model like a broken request; naming the state
    // is what lets it answer "I cannot see anything".
    expect(renderTree([])).toMatch(/empty/i);
  });
});

describe('agentPrompt', () => {
  it('carries the task, the screen and the answer format', () => {
    // The prompt is the whole interface between this package and whatever model
    // a caller brings, so it has to state the task, show the screen, and say
    // exactly what shape of answer comes back.
    const request: AgentTurn = {
      task: 'open settings', app: 'com.demo', step: 0, maxSteps: 5,
      screen: 'Button "Settings" [0,0][100,100] clickable',
      history: [],
    };
    const prompt = agentPrompt(request);
    expect(prompt).toContain('open settings');
    expect(prompt).toContain('com.demo');
    expect(prompt).toContain('Button "Settings"');
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"done"');
    expect(prompt).toMatch(/Step 1 of 5/);
  });

  it('shows earlier steps so the model does not repeat itself', () => {
    const request: AgentTurn = {
      task: 'open settings', app: 'com.demo', step: 1, maxSteps: 5,
      screen: 'Button "Settings" clickable',
      history: [{ step: 0, status: 'acted', reason: 'tap it', did: 'click at (5, 5)' }],
    };
    const prompt = agentPrompt(request);
    expect(prompt).toContain('tap it');
    expect(prompt).toContain('click at (5, 5)');
  });

  it('says no steps were taken rather than leaving the section blank', () => {
    const prompt = agentPrompt({
      task: 't', app: 'a', step: 0, maxSteps: 2, screen: 'x', history: [],
    });
    expect(prompt).toMatch(/no steps/i);
  });
});

describe('parseDecision', () => {
  it('reads an action answer', () => {
    const decision = parseDecision(JSON.stringify({
      action: { action: 'click', x: 10, y: 20 }, reason: 'tap it',
    }));
    expect(decision).toEqual({
      action: { action: 'click', x: 10, y: 20 }, reason: 'tap it',
    });
  });

  it('reads a done answer with its expectation', () => {
    const decision = parseDecision(JSON.stringify({
      done: true,
      expect: { present: [{ selector: { kind: 'text', text: 'Settings' } }] },
      reason: 'the page is open',
    }));
    expect(decision).toMatchObject({ done: true, reason: 'the page is open' });
  });

  it('reads an answer wrapped in a markdown fence', () => {
    // Models fence their JSON even when told not to; refusing the answer would
    // spend a step on a formatting habit rather than on the task.
    const decision = parseDecision('```json\n{"done": true, "reason": "x"}\n```');
    expect(decision).toMatchObject({ done: true });
  });

  it('refuses an answer that is not JSON, naming what it got', () => {
    expect(() => parseDecision('I will tap the button')).toThrow(/JSON/i);
  });

  it('refuses an action with a gesture the device does not accept', () => {
    // A model inventing `{"action": "long_press"}` would otherwise reach the
    // gesture driver as a malformed object and fail there, far from the answer
    // that caused it.
    expect(() => parseDecision(JSON.stringify({
      action: { action: 'long_press', x: 1, y: 1 }, reason: 'hold',
    }))).toThrow(/long_press/);
  });

  it('refuses an expectation the scenario schema would refuse', () => {
    // The expectation is evaluated by the same code a scenario uses, so it is
    // validated by the same parser: a malformed clause must fail here, with the
    // path, rather than at evaluation time.
    expect(() => parseDecision(JSON.stringify({
      done: true, expect: { present: [{ selector: { kind: 'nonsense' } }] }, reason: 'x',
    }))).toThrow(/selector/i);
  });

  it('refuses an answer that is both an action and a completion', () => {
    expect(() => parseDecision(JSON.stringify({
      action: { action: 'click', x: 1, y: 1 }, done: true, reason: 'both',
    }))).toThrow(/exactly one/);
  });

  it('refuses an answer with neither', () => {
    expect(() => parseDecision(JSON.stringify({ reason: 'thinking' })))
      .toThrow(/exactly one/);
  });

  it('keeps the reason, and supplies an empty one rather than undefined', () => {
    const decision = parseDecision(JSON.stringify({ action: { action: 'key', key: 'Back' } }));
    expect(decision).toEqual({ action: { action: 'key', key: 'Back' }, reason: '' });
  });
});

describe('runAgent — the loop', () => {
  it('runs the model until it claims done and the screen agrees', async () => {
    const device = fakeDevice([
      [node({ text: 'Settings' })],
      [node({ text: 'Settings' }), node({ text: 'Done', id: 'done' })],
    ]);
    const model = scripted(
      { action: { action: 'click', x: 50, y: 50 }, reason: 'open settings' },
      { done: true, expect: { present: [{ selector: { kind: 'text', text: 'Done' } }] }, reason: 'done' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 5 });
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.action).toEqual({ action: 'click', x: 50, y: 50 });
    expect(device.gestures).toHaveLength(1);
  });

  it('refuses to count a completion the screen contradicts', async () => {
    // The defect this row exists to fix: HapRay records `finished` as success
    // without looking. Here the model's claim is checked, and a false one is a
    // failure with the screen named.
    const device = fakeDevice([[node({ text: 'Settings' })]]);
    const model = scripted({
      done: true,
      expect: { present: [{ selector: { kind: 'text', text: 'Done' } }] },
      reason: 'I believe it is done',
    });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 5 });
    expect(result.status).toBe('unverified');
    expect(result.steps[0]!.status).toBe('unverified');
    expect(result.steps[0]!.detail).toMatch(/Done/);
  });

  it('treats a bare `done` with no assertion as unverified, not completed', async () => {
    // A model that asserts nothing has proven nothing. Accepting it would make
    // every claim a success, which is the same as measuring nothing.
    const device = fakeDevice([[node()]]);
    const model = scripted({ done: true, reason: 'trust me' });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 5 });
    expect(result.status).toBe('unverified');
    expect(result.steps[0]!.detail).toMatch(/no expectation/i);
  });

  it('stops at the step cap and says so', async () => {
    const device = fakeDevice([[node()], [node()], [node()]]);
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'a' },
      { action: { action: 'click', x: 2, y: 2 }, reason: 'b' },
      { action: { action: 'click', x: 3, y: 3 }, reason: 'c' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 2 });
    expect(result.status).toBe('exhausted');
    expect(result.steps).toHaveLength(2);
  });

  it('refuses an irreversible action instead of performing it', async () => {
    // HapRay puts "avoid payment" in the prompt and hopes. The guard reads the
    // node the action lands on and refuses the tap outright.
    const device = fakeDevice([[node({ text: '立即支付', bounds: '[0,0][200,200]' })]]);
    const model = scripted({
      action: { action: 'click', x: 100, y: 100 },
      reason: 'pay for the order',
    });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(device.gestures).toHaveLength(0);
    expect(result.steps[0]!.status).toBe('refused');
    expect(result.steps[0]!.detail).toMatch(/pay/i);
    // Stopped by the guard, not by the budget: the two are different outcomes
    // and a reader has to be able to tell which one ended the run.
    expect(result.status).toBe('refused');
  });

  it('refuses a tap that lands just outside the payment button', async () => {
    // Measured on 2026-11-17 against a real model: given a checkout screen whose
    // only control is "Pay now" at `[0,1800][1080,1950]`, one model answered
    // `click {x:540, y:1965}` twice — 15 px below the button. The tap lands on
    // the screen's padding, and on a real device that padding is often part of
    // the same hit region. Strict containment let it through.
    const device = fakeDevice([[node({
      text: 'Pay now', id: 'pay_now', bounds: '[0,1800][1080,1950]',
      boundsRect: { left: 0, top: 1800, right: 1080, bottom: 1950 },
    })]]);
    const model = scripted({
      action: { action: 'click', x: 540, y: 1965 },
      reason: 'complete the purchase',
    });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(device.gestures).toHaveLength(0);
    expect(result.steps[0]!.status).toBe('refused');
    expect(result.status).toBe('refused');
  });

  it('does not refuse a tap that lands on a neighbouring control', async () => {
    // The margin must not swallow a neighbour. Buttons stack with no gap on a
    // real screen: "Back" starts exactly where "Pay now" ends, so a tap 15 px
    // inside Back is also 15 px from Pay now — inside the near-miss distance.
    // The landed-on control wins, or the guard would block the one navigation
    // that leaves the checkout screen.
    const pay = node({
      text: 'Pay now', id: 'pay_now', bounds: '[0,1800][1080,1950]',
      boundsRect: { left: 0, top: 1800, right: 1080, bottom: 1950 },
    });
    const back = node({
      text: 'Back', id: 'back', bounds: '[0,1950][1080,2070]',
      boundsRect: { left: 0, top: 1950, right: 1080, bottom: 2070 },
    });
    const device = fakeDevice([[pay, back], [pay, back]]);
    const model = scripted(
      { action: { action: 'click', x: 540, y: 1965 }, reason: 'leave checkout' },
      { done: true, reason: 'x' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.status).toBe('acted');
    expect(device.gestures).toHaveLength(1);
  });

  it('does not refuse a tap far from any irreversible control', async () => {
    // The margin is bounded: 25 px below the button is outside it, so the guard
    // does not become a screen-wide no-tap zone.
    const device = fakeDevice([[node({
      text: 'Pay now', id: 'pay_now', bounds: '[0,1800][1080,1950]',
      boundsRect: { left: 0, top: 1800, right: 1080, bottom: 1950 },
    })], [node()]]);
    const model = scripted(
      { action: { action: 'click', x: 540, y: 1975 }, reason: 'scroll area' },
      { done: true, reason: 'x' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.status).toBe('acted');
  });

  it('lets an irreversible action through when the caller opts in', async () => {
    const device = fakeDevice([[node({ text: '立即支付', bounds: '[0,0][200,200]' })]]);
    const model = scripted({
      action: { action: 'click', x: 100, y: 100 },
      reason: 'pay',
    }, { done: true, reason: 'x' });
    const result = await runAgent(device, model, {
      task, app: 'com.demo', maxSteps: 3, allowIrreversible: true,
    });
    expect(device.gestures).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('acted');
  });

  it('records a gesture the device rejected as failed and keeps going', async () => {
    const device = fakeDevice([[node()], [node()]], { rejectGestures: true });
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'a' },
      { done: true, reason: 'b' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.detail).toMatch(/refused the gesture/);
  });

  it('shows the model the screens it has already been on', async () => {
    // A model that cannot see its history repeats itself; HapRay passes only
    // the current frame. The history is what lets a model say "I already
    // tried that".
    const device = fakeDevice([[node({ text: 'A' })], [node({ text: 'B' })], [node({ text: 'C' })]]);
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'first' },
      { action: { action: 'click', x: 2, y: 2 }, reason: 'second' },
      { done: true, reason: 'stop' },
    );
    await runAgent(device, model, { task, app: 'com.demo', maxSteps: 4 });
    expect(model.seen[0]!.history).toEqual([]);
    expect(model.seen[1]!.history).toHaveLength(1);
    expect(model.seen[1]!.history[0]!.reason).toBe('first');
    expect(model.seen[2]!.history).toHaveLength(2);
  });

  it('counts a screen reached, distinct from a step spent', async () => {
    const device = fakeDevice([[node()], [node()], [node()]]);
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'a' },
      { action: { action: 'click', x: 1, y: 1 }, reason: 'a' },
      { done: true, reason: 'b' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 4 });
    // The fake returns the same tree every dump, so one state was reached.
    expect(result.statesReached).toBe(1);
    expect(result.steps).toHaveLength(3);
  });

  it('refuses a maxSteps that is not a positive integer', async () => {
    const device = fakeDevice([[node()]]);
    const model = scripted();
    await expect(runAgent(device, model, { task, app: 'com.demo', maxSteps: 0 }))
      .rejects.toThrow(/maxSteps/);
    await expect(runAgent(device, model, { task, app: 'com.demo', maxSteps: 1.5 }))
      .rejects.toThrow(/maxSteps/);
  });

  it('refuses an empty task rather than sending a blank prompt', async () => {
    const device = fakeDevice([[node()]]);
    await expect(runAgent(device, scripted(), { task: '  ', app: 'com.demo', maxSteps: 3 }))
      .rejects.toThrow(/task/);
  });

  it('records the screen hash before and after each action', async () => {
    const before = [node({ text: 'A' })];
    const after = [node({ text: 'B' })];
    const device = fakeDevice([before, after]);
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'a' },
      { done: true, reason: 'b' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.before).toBe(hashTree(before));
    expect(result.steps[0]!.after).toBe(hashTree(after));
    expect(result.steps[0]!.navigated).toBe(true);
  });

  it('records a tap that changed nothing as not navigated', async () => {
    // The defect HapRay has: every tap counts as progress. A dead button is
    // recorded as `acted` with `navigated: false`, so the walk's coverage is
    // the screens it reached rather than the taps it spent.
    const still = [node({ text: 'Same' })];
    const device = fakeDevice([still, still]);
    const model = scripted(
      { action: { action: 'click', x: 1, y: 1 }, reason: 'dead button' },
      { done: true, reason: 'b' },
    );
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.status).toBe('acted');
    expect(result.steps[0]!.navigated).toBe(false);
    expect(result.statesReached).toBe(1);
  });

  it('guards a text entry aimed at an irreversible field, not just a tap', async () => {
    // Typing into a field is aimed at a node too. A model that fills in an
    // amount and then submits is the same act as tapping pay, and a guard that
    // only watched clicks would miss the first half of it.
    const device = fakeDevice([[node({ text: 'Transfer', bounds: '[0,0][200,200]' })]]);
    const model = scripted({
      action: { action: 'inputText', x: 100, y: 100, text: '1000' },
      reason: 'fill in the amount',
    });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(device.gestures).toHaveLength(0);
    expect(result.steps[0]!.status).toBe('refused');
  });

  it('finds the target node when the dump omitted the parsed rect', async () => {
    // A dump from an older reader carries `bounds` but no `boundsRect`. A guard
    // that only read the parsed rect would find no target and wave the tap
    // through, which is the failure the guard exists to prevent.
    const bare = node({ text: '立即支付', bounds: '[0,0][200,200]' });
    delete (bare as { boundsRect?: unknown }).boundsRect;
    const device = fakeDevice([[bare]]);
    const model = scripted({ action: { action: 'click', x: 100, y: 100 }, reason: 'pay' });
    const result = await runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 });
    expect(result.steps[0]!.status).toBe('refused');
  });

  it('refuses a model answer that is both an action and a completion', async () => {
    // Answering both is ambiguous: the loop cannot know whether to act or to
    // stop, and guessing would record a walk that never happened.
    const device = fakeDevice([[node()]]);
    const model = scripted({
      action: { action: 'click', x: 1, y: 1 },
      done: true,
      reason: 'both',
    } as unknown as AgentDecision);
    await expect(runAgent(device, model, { task, app: 'com.demo', maxSteps: 3 }))
      .rejects.toThrow(/exactly one/);
    expect(device.gestures).toHaveLength(0);
  });
});

describe('replayAgent', () => {
  it('replays a transcript without a model', async () => {
    // The transcript is the measurement: a run on one build can be replayed on
    // another, and the two walks compared. HapRay's log cannot do this because
    // it records prose, not gestures.
    const first = [node()];
    const second = [node({ text: 'B' })];
    const transcript: AgentTranscript = {
      version: 1,
      task,
      app: 'com.demo',
      steps: [
        {
          index: 0, status: 'acted', reason: 'open settings',
          action: { action: 'click', x: 50, y: 50 },
          before: hashTree(first), after: hashTree(second), navigated: true,
        },
      ],
      status: 'exhausted',
      statesReached: 2,
    };
    const device = fakeDevice([first, second]);
    const result = await replayAgent(device, transcript);
    expect(device.gestures).toEqual([{ action: 'click', x: 50, y: 50 }]);
    expect(result.performed).toBe(1);
    expect(result.divergedAt).toBeUndefined();
  });

  it('stops and names the step when the replay reaches a different screen', async () => {
    // The screen before the second action no longer matches, so the recorded
    // action may land on the wrong element. Continuing would be a walk of a
    // different app than the one recorded.
    const transcript: AgentTranscript = {
      version: 1,
      task,
      app: 'com.demo',
      steps: [
        {
          index: 0, status: 'acted', reason: 'one',
          action: { action: 'click', x: 1, y: 1 },
          before: 'not-the-real-hash', after: 'bbbb', navigated: true,
        },
      ],
      status: 'exhausted',
      statesReached: 1,
    };
    const device = fakeDevice([[node({ text: 'A' })]]);
    const result = await replayAgent(device, transcript);
    expect(result.divergedAt).toBe(0);
    expect(result.performed).toBe(0);
    expect(device.gestures).toHaveLength(0);
  });

  it('skips a step that was refused, because it never touched the device', async () => {
    const transcript: AgentTranscript = {
      version: 1,
      task,
      app: 'com.demo',
      steps: [
        {
          index: 0, status: 'refused', reason: 'payment', detail: 'irreversible',
          before: 'aaaa', after: 'aaaa', navigated: false,
        },
      ],
      status: 'exhausted',
      statesReached: 1,
    };
    const device = fakeDevice([[node()]]);
    const result = await replayAgent(device, transcript);
    expect(result.performed).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
