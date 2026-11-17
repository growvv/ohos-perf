import { describe, it, expect } from 'vitest';
import {
  deviceExplorationHost,
  explore,
  explorationDevice,
  hashPageShape,
  hashTree,
  planNextAction,
  type ExplorationDevice,
  type ExplorationHost,
  type ExplorationState,
} from '../src/scenario/explore';
import type { Gesture, GestureResult } from '../src/device/gesture';
import type { UiNode } from '../src/query/ui';

/*
 * HapTest exploration (HapRay parity row 4) — ported, and made checkable.
 *
 * HapRay's `haptest` captures the UI tree, hashes it, and taps an unvisited
 * clickable element until it runs out of steps. Three strategies (`depth_first`,
 * `breadth_first`, `random`) and a default 30-step cap. It never verifies that
 * anything happened: a tap on a dead element counts the same as a tap that
 * opened a new screen, and `random` makes two runs of the same app explore
 * different screens.
 *
 * The port keeps the shape — tree, hash, unvisited clickables, strategies — and
 * changes the parts that made the result unusable as evidence:
 *
 * - Every ordering is a total order over node identity, so the same tree and
 *   the same visited set always produce the same next tap.
 * - `random` is seeded and the seed is recorded, so "random" means "a fixed
 *   order you did not choose", not "different every run".
 * - A tap whose resulting state hash did not change is recorded `no_change`
 *   rather than counted as a success. Exploration coverage is the count of
 *   distinct state hashes reached, not the count of taps made.
 */

const node = (
  overrides: Partial<UiNode> & { id: string },
): UiNode => ({
  depth: 1,
  type: 'Text',
  bundleName: 'com.demo',
  abilityName: 'Main',
  text: '',
  bounds: '[0,0][10,10]',
  clickable: false,
  enabled: true,
  scrollable: false,
  children: 0,
  ...overrides,
});

const root = (children: UiNode[]): UiNode[] => [
  node({ id: 'root', type: 'Root', children: children.length }),
  ...children,
];

describe('hashTree', () => {
  it('is the same for the same nodes in the same order', () => {
    const tree = root([node({ id: 'a', text: 'One' }), node({ id: 'b', text: 'Two' })]);
    expect(hashTree(tree)).toBe(hashTree([...tree]));
  });

  it('changes when a node text changes', () => {
    const a = root([node({ id: 'a', text: 'One' })]);
    const b = root([node({ id: 'a', text: 'Two' })]);
    expect(hashTree(a)).not.toBe(hashTree(b));
  });

  it('changes when the order of two nodes changes', () => {
    // Two screens with the same elements in a different order are different
    // states; the hash must say so or exploration would stop early.
    const a = root([node({ id: 'a', text: 'One' }), node({ id: 'b', text: 'Two' })]);
    const b = root([node({ id: 'b', text: 'Two' }), node({ id: 'a', text: 'One' })]);
    expect(hashTree(a)).not.toBe(hashTree(b));
  });

  it('changes when a node becomes clickable', () => {
    const a = root([node({ id: 'a' })]);
    const b = root([node({ id: 'a', clickable: true })]);
    expect(hashTree(a)).not.toBe(hashTree(b));
  });

  it('is a short stable hex digest, not the whole tree', () => {
    const tree = root([node({ id: 'a' })]);
    expect(hashTree(tree)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('hashPageShape', () => {
  it('ignores text, ids and bounds: the same template is the same page', () => {
    const one = root([node({ id: 'a', text: 'Alpha', bounds: '[0,0][1,1]', type: 'Button', clickable: true })]);
    const two = root([node({ id: 'b', text: 'Beta', bounds: '[4,4][9,9]', type: 'Button', clickable: true })]);
    expect(hashPageShape(one)).toBe(hashPageShape(two));
    expect(hashTree(one)).not.toBe(hashTree(two));
  });

  it('changes when the structure changes', () => {
    const button = root([node({ id: 'a', type: 'Button', clickable: true })]);
    const text = root([node({ id: 'a', type: 'Text', clickable: true })]);
    expect(hashPageShape(button)).not.toBe(hashPageShape(text));
  });

  it('changes when a node is added, removed or moves depth', () => {
    const shallow = root([node({ id: 'a', type: 'Button' })]);
    const deeper = root([node({ id: 'a', type: 'Button', depth: 2 })]);
    const both = root([node({ id: 'a', type: 'Button' }), node({ id: 'b', type: 'Text' })]);
    expect(new Set([hashPageShape(shallow), hashPageShape(deeper), hashPageShape(both)]).size).toBe(3);
  });
});

describe('planNextAction', () => {
  const clickable = (id: string, text = ''): UiNode =>
    node({ id, text, clickable: true, type: 'Button' });

  it('picks the first unvisited clickable in depth-first order', () => {
    const tree = root([clickable('a'), clickable('b'), clickable('c')]);
    const state: ExplorationState = { tree, visited: new Set(), strategy: 'depth_first' };
    expect(planNextAction(state)).toEqual({ kind: 'tap', nodeId: 'a', bounds: tree[1].bounds });
  });

  it('skips a clickable that was already tapped', () => {
    const tree = root([clickable('a'), clickable('b')]);
    const state: ExplorationState = { tree, visited: new Set(['a']), strategy: 'depth_first' };
    expect(planNextAction(state)?.nodeId).toBe('b');
  });

  it('returns undefined when every clickable has been visited', () => {
    const tree = root([clickable('a'), clickable('b')]);
    const state: ExplorationState = {
      tree,
      visited: new Set(['a', 'b']),
      strategy: 'depth_first',
    };
    expect(planNextAction(state)).toBeUndefined();
  });

  it('orders breadth-first by depth, whatever the document order', () => {
    // `inner` comes first in the dump and sits deepest; breadth-first must
    // still take the shallower `deep`, or the strategy is just depth-first
    // under another name.
    const tree = root([
      node({ id: 'inner', depth: 3, clickable: true, type: 'Button', text: 'Inner' }),
      clickable('deep'),
      node({ id: 'shallow', depth: 1, clickable: true, type: 'Button', text: 'Shallow' }),
    ]);
    const state: ExplorationState = { tree, visited: new Set(), strategy: 'breadth_first' };
    expect(planNextAction(state)?.nodeId).toBe('deep');
    expect(planNextAction({ ...state, strategy: 'depth_first' })?.nodeId).toBe('inner');
  });

  it('refuses to tap a clickable whose bounds did not parse', () => {
    // HapRay taps (0,0) when the rect is unusable. A tap at the origin is a
    // gesture on whatever happens to be there — never the node it meant.
    const tree = root([
      node({ id: 'broken', clickable: true, type: 'Button', bounds: 'nonsense' }),
      clickable('good'),
    ]);
    const state: ExplorationState = { tree, visited: new Set(), strategy: 'depth_first' };
    expect(planNextAction(state)).toEqual({ kind: 'tap', nodeId: 'good', bounds: '[0,0][10,10]' });
  });

  it('skips a clickable the dump marked disabled', () => {
    const tree = root([node({ id: 'off', clickable: true, enabled: false }), clickable('on')]);
    const state: ExplorationState = { tree, visited: new Set(), strategy: 'depth_first' };
    expect(planNextAction(state)?.nodeId).toBe('on');
  });

  it('identifies a node without an inspector id by its place on screen', () => {
    const tree = root([
      node({ id: '', clickable: true, type: 'Button', text: 'Save', bounds: '[1,1][2,2]' }),
      clickable('next'),
    ]);
    const first = planNextAction({ tree, visited: new Set(), strategy: 'depth_first' });
    expect(first?.nodeId).toBe('at:Button|Save|[1,1][2,2]');
    const second = planNextAction({
      tree,
      visited: new Set([first!.nodeId]),
      strategy: 'depth_first',
    });
    expect(second?.nodeId).toBe('next');
  });

  it('produces the same order twice for the same seed', () => {
    const tree = root([clickable('a'), clickable('b'), clickable('c'), clickable('d')]);
    const run = (): string[] => {
      const visited = new Set<string>();
      const order: string[] = [];
      for (let step = 0; step < 4; step += 1) {
        const action = planNextAction({ tree, visited, strategy: 'random', seed: 7 });
        if (action === undefined) break;
        order.push(action.nodeId);
        visited.add(action.nodeId);
      }
      return order;
    };
    expect(run()).toEqual(run());
    expect(new Set(run()).size).toBe(4);
  });

  it('changes the order when the seed changes', () => {
    const tree = root([clickable('a'), clickable('b'), clickable('c'), clickable('d')]);
    const picks = new Set(
      [1, 2, 3, 4].map(
        (seed) => planNextAction({ tree, visited: new Set(), strategy: 'random', seed })?.nodeId,
      ),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('explore', () => {
  /**
   * A device whose screen advances when the expected node is tapped.
   *
   * `screens` maps a tap target's bounds to the tree that appears after it;
   * a bounds with no entry leaves the screen unchanged, which is how a dead
   * element behaves on a real device.
   */
  function device(screens: Record<string, UiNode[]>): ExplorationDevice {
    let current = screens.start ?? [];
    return {
      dump: async () => current,
      tap: async (bounds) => {
        const next = screens[bounds];
        if (next !== undefined) current = next;
      },
    };
  }

  /** A chain of `count` screens, each with one clickable that leads to the next. */
  function chain(count: number): Record<string, UiNode[]> {
    const screens: Record<string, UiNode[]> = {};
    const boundsAt = (index: number): string =>
      `[${index},${index}][${index + 1},${index + 1}]`;
    screens.start = root([
      // The type carries the level, so each screen is a distinct page template
      // as well as a distinct exact state.
      node({ id: 'b0', clickable: true, type: 'Button0', bounds: boundsAt(0) }),
    ]);
    for (let index = 0; index < count; index += 1) {
      screens[boundsAt(index)] =
        index + 1 === count
          ? root([])
          : root([node({ id: `b${index + 1}`, clickable: true, type: `Button${index + 1}`, bounds: boundsAt(index + 1) })]);
    }
    return screens;
  }

  it('stops at maxSteps and reports how many states it reached', async () => {
    const dev = device(chain(5));
    const result = await explore(dev, { maxSteps: 3, strategy: 'depth_first' });
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((step) => step.outcome)).toEqual([
      'navigated',
      'navigated',
      'navigated',
    ]);
    // The start screen plus one new screen per step.
    expect(result.statesReached).toBe(4);
    expect(result.pagesReached).toBe(4);
    expect(result.exhausted).toBe(false);
  });

  it('stops early when nothing is left to tap', async () => {
    const start = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const result = await explore(device({ start }), { maxSteps: 30, strategy: 'depth_first' });
    // One tap, then the same screen: the only clickable is visited, so
    // exploration ends well before the cap.
    expect(result.steps).toHaveLength(1);
    expect(result.exhausted).toBe(true);
  });

  it('records a tap that changed nothing as no_change, not as a step forward', async () => {
    const start = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const result = await explore(device({ start }), { maxSteps: 5, strategy: 'depth_first' });
    expect(result.steps[0].outcome).toBe('no_change');
    expect(result.statesReached).toBe(1);
  });

  it('counts a tap that reached a new screen as a new state', async () => {
    const start = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const next = root([node({ id: 'b', clickable: true, type: 'List', bounds: '[2,2][3,3]' })]);
    const result = await explore(device({ start, '[0,0][1,1]': next }), {
      maxSteps: 2,
      strategy: 'depth_first',
    });
    expect(result.statesReached).toBe(2);
    expect(result.pagesReached).toBe(2);
    expect(result.steps.map((step) => step.outcome)).toEqual(['navigated', 'no_change']);
  });

  it('calls a text-only change an updated page, not a new page', async () => {
    // HapRay asks a model whether two screens are the same page. The same
    // template with different data is one page; the model's opinion is a
    // proxy for this structural comparison.
    const start = root([node({ id: 'a', clickable: true, type: 'Button', text: 'One', bounds: '[0,0][1,1]' })]);
    const next = root([node({ id: 'a', clickable: true, type: 'Button', text: 'Two', bounds: '[0,0][1,1]' })]);
    const result = await explore(device({ start, '[0,0][1,1]': next }), {
      maxSteps: 1,
      strategy: 'depth_first',
    });
    expect(result.steps[0].outcome).toBe('updated');
    expect(result.pagesReached).toBe(1);
    expect(result.statesReached).toBe(2);
    expect(result.pages).toHaveLength(1);
  });

  it('records the state hash of every step, so a run is reproducible evidence', async () => {
    const start = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const result = await explore(device({ start }), { maxSteps: 1, strategy: 'depth_first' });
    expect(result.steps[0].before).toBe(hashTree(start));
    expect(result.steps[0].after).toBe(hashTree(start));
  });

  it('treats the same node id on two screens as two different elements', async () => {
    // `visited` is per screen, not per run. `a` on the first screen and `a` on
    // the second are different elements that share an inspector id; a global
    // visited set would skip the second one and claim the screen was covered.
    const first = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const second = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[2,2][3,3]' })]);
    const result = await explore(
      device({ start: first, '[0,0][1,1]': second, '[2,2][3,3]': first }),
      { maxSteps: 5, strategy: 'depth_first' },
    );
    expect(result.steps.map((step) => step.bounds)).toEqual(['[0,0][1,1]', '[2,2][3,3]']);
    // Back on the first screen: its only clickable is already visited, so the
    // walk ends instead of cycling.
    expect(result.exhausted).toBe(true);
  });

  it('is deterministic: the same screens and seed give the same steps', async () => {
    const start = root([
      node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' }),
      node({ id: 'b', clickable: true, type: 'Button', bounds: '[2,2][3,3]' }),
    ]);
    const once = await explore(device({ start }), { maxSteps: 4, strategy: 'random', seed: 3 });
    const twice = await explore(device({ start }), { maxSteps: 4, strategy: 'random', seed: 3 });
    expect(once.steps.map((step) => step.nodeId)).toEqual(twice.steps.map((step) => step.nodeId));
    expect(once.seed).toBe(3);
  });

  it('records the seed it chose when random is asked for without one', async () => {
    const start = root([node({ id: 'a', clickable: true, type: 'Button', bounds: '[0,0][1,1]' })]);
    const first = await explore(device({ start }), { maxSteps: 2, strategy: 'random' });
    const second = await explore(device({ start }), { maxSteps: 2, strategy: 'random' });
    expect(first.seed).toBeDefined();
    expect(first.seed).toBe(second.seed);
  });

  it('refuses a non-positive maxSteps rather than exploring forever', async () => {
    await expect(
      explore(device({ start: [] }), { maxSteps: 0, strategy: 'depth_first' }),
    ).rejects.toThrow(/maxSteps/);
  });
});

describe('explorationDevice', () => {
  /** A host with a virtual clock, so a settle costs no real time. */
  function host(
    screens: UiNode[][],
    opts: { changeAfterPolls: number },
  ): ExplorationHost & { sleeps: number[] } {
    const sleeps: number[] = [];
    let clock = 0;
    let screen = 0;
    let polls = 0;
    return {
      sleeps,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      dump: async () => {
        if (polls > 0 && polls >= opts.changeAfterPolls) {
          screen = Math.min(screen + 1, screens.length - 1);
        }
        polls += 1;
        return screens[screen]!;
      },
      tap: async () => {
        polls = 1;
      },
    };
  }

  const tree = (id: string): UiNode[] => [
    node({ id, clickable: true, type: 'Button', bounds: `[0,0][${id.length},1]` }),
  ];

  it('returns as soon as the screen changes, instead of waiting the full window', async () => {
    // HapRay spends a fixed 5 s on every action whether the screen moved in
    // 50 ms or never. Polling is the same wait for a dead element and a
    // fraction of it for a live one.
    const h = host([tree('a'), tree('bb')], { changeAfterPolls: 2 });
    const dev = explorationDevice(h, { settleMs: 5000, pollMs: 100 });
    await dev.tap('[0,0][1,1]');
    expect(h.sleeps.length).toBeLessThan(5);
    expect(await dev.dump()).toEqual(tree('bb'));
  });

  it('gives up at settleMs when the screen never changes', async () => {
    const h = host([tree('a')], { changeAfterPolls: 1_000_000 });
    const dev = explorationDevice(h, { settleMs: 250, pollMs: 100 });
    await dev.tap('[0,0][1,1]');
    // Three looks, the last one short: the window is 250 ms and the walk must
    // not overshoot it to a full poll. A multiple of the poll interval would
    // hide that, which is why the window here is not one.
    expect(h.sleeps).toEqual([100, 100, 50]);
    expect(await dev.dump()).toEqual(tree('a'));
  });

  it('dumps once per tap, so a settle is not paid for twice', async () => {
    let dumps = 0;
    const h = host([tree('a'), tree('bb')], { changeAfterPolls: 2 });
    const counting: ExplorationHost = {
      ...h,
      dump: async () => {
        dumps += 1;
        return h.dump();
      },
    };
    const dev = explorationDevice(counting, { settleMs: 1000, pollMs: 100 });
    await dev.tap('[0,0][1,1]');
    const afterTap = dumps;
    await dev.dump();
    await dev.dump();
    expect(dumps).toBe(afterTap);
  });

  it('refuses a poll interval that would never advance the clock', async () => {
    expect(() => explorationDevice(host([], { changeAfterPolls: 1 }), {
      settleMs: 100,
      pollMs: 0,
    })).toThrow(/pollMs/);
  });
});

describe('deviceExplorationHost', () => {
  /** A device that records the gestures it was sent. */
  function fakeDevice(tree: UiNode[]): {
    id: string;
    uiTree(): Promise<readonly UiNode[]>;
    gesture(g: Gesture): Promise<GestureResult>;
    sent: Gesture[];
  } {
    const sent: Gesture[] = [];
    return {
      id: 'emu',
      sent,
      uiTree: async () => tree,
      gesture: async (g) => {
        sent.push(g);
        return { gesture: g, output: 'No Error' };
      },
    };
  }

  it('taps the centre of the named node, not the corner of its rect', async () => {
    const target = node({
      id: 'b',
      clickable: true,
      type: 'Button',
      bounds: '[10,20][30,60]',
    });
    const dev = fakeDevice(root([target]));
    const host = deviceExplorationHost(dev, { settleMs: 0, pollMs: 100 });
    await host.tap('[10,20][30,60]');
    // (10+30)/2 = 20, (20+60)/2 = 40.
    expect(dev.sent).toEqual([{ action: 'click', x: 20, y: 40 }]);
  });

  it('refuses bounds the dump never wrote as a rect, rather than tapping (0,0)', async () => {
    // The node really is on screen, so the stale-target check cannot be what
    // refuses this: the rect itself is unusable, and tapping it would click
    // the corner. HapRay taps (0,0) here.
    const broken = node({ id: 'b', clickable: true, bounds: 'nonsense' });
    const dev = fakeDevice(root([broken]));
    const host = deviceExplorationHost(dev, { settleMs: 0, pollMs: 100 });
    await expect(host.tap('nonsense')).rejects.toThrow(/bounds/);
    expect(dev.sent).toEqual([]);
  });

  it('refuses a tap whose target is not on the screen it just dumped', async () => {
    // Bounds are the only handle exploration has; tapping coordinates for a
    // node that is gone is a gesture on whatever moved into its place.
    const dev = fakeDevice(root([node({ id: 'a', bounds: '[0,0][10,10]' })]));
    const host = deviceExplorationHost(dev, { settleMs: 0, pollMs: 100 });
    await expect(host.tap('[5,5][15,15]')).rejects.toThrow(/not on the screen/);
    expect(dev.sent).toEqual([]);
  });

  it('fails the tap when the device does not report acceptance', async () => {
    const target = node({ id: 'b', clickable: true, bounds: '[0,0][10,10]' });
    const dev = {
      id: 'emu',
      uiTree: async () => root([target]),
      gesture: async (g: Gesture): Promise<GestureResult> => ({ gesture: g, output: 'denied' }),
    };
    const host = deviceExplorationHost(dev, { settleMs: 0, pollMs: 100 });
    await expect(host.tap('[0,0][10,10]')).rejects.toThrow(/No Error/);
  });
});
