import { describe, it, expect } from 'vitest';
import { executeAction, type ActionDevice } from '../src/scenario/actions';
import type { Gesture } from '../src/device/gesture';
import { parseBounds, type UiNode } from '../src/query/ui';

/*
 * P17: actions that select instead of coordinate.
 *
 * The device surface is unchanged; what is new is a `dump` in the action
 * context. A resolved tap is a click at the selected node's centre, so the
 * assertion is about where the click lands, not about which helper ran.
 */

/** A node whose rect matches its bounds string, as a real dump's does. */
function uiNode(over: Partial<UiNode> & { bounds?: string } = {}): UiNode {
  const bounds = over.bounds ?? '[0,0][100,100]';
  return {
    depth: 0,
    type: 'Button',
    bundleName: 'com.demo',
    abilityName: 'Entry',
    text: '',
    id: '',
    bounds,
    clickable: true,
    enabled: true,
    scrollable: false,
    children: 0,
    boundsRect: parseBounds(bounds),
    ...over,
  };
}

function gesturesOf(): { list: Gesture[]; device: ActionDevice } {
  const list: Gesture[] = [];
  return {
    list,
    device: {
      id: 't1',
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      gesture: async (g) => {
        list.push(g);
        return { gesture: g, output: 'No Error' };
      },
    },
  };
}

describe('executeAction — selector actions', () => {
  it('taps the centre of the selected node', async () => {
    const { list, device } = gesturesOf();
    const dump = async () => [uiNode({ id: 'ok', bounds: '[100,200][300,400]' })];
    await executeAction(
      device,
      'com.a',
      { kind: 'tap', target: { kind: 'id', id: 'ok' } },
      { dump },
    );
    expect(list[0]).toEqual({ action: 'click', x: 200, y: 300 });
  });

  it('taps by text with the short form', async () => {
    const { list, device } = gesturesOf();
    const dump = async () => [uiNode({ text: 'Cancel', bounds: '[0,0][100,200]' })];
    await executeAction(device, 'com.a', { kind: 'tapText', text: 'cancel' }, { dump });
    expect(list[0]).toEqual({ action: 'click', x: 50, y: 100 });
  });

  it('refuses to tap a node whose bounds did not parse', async () => {
    const { device } = gesturesOf();
    const dump = async () => [
      { ...uiNode({ id: 'ok', bounds: 'weird' }), boundsRect: undefined },
    ];
    const err = await executeAction(
      device,
      'com.a',
      { kind: 'tap', target: { kind: 'id', id: 'ok' } },
      { dump },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
    expect((err as Error).message).toContain('weird');
  });

  it('refuses when the context has no dump', async () => {
    const { device } = gesturesOf();
    const err = await executeAction(
      device,
      'com.a',
      { kind: 'tap', target: { kind: 'id', id: 'x' } },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_TREE' });
  });

  it('scrolls the container until the target appears', async () => {
    const { list, device } = gesturesOf();
    const listNode = uiNode({
      id: 'list',
      type: 'List',
      scrollable: true,
      bounds: '[0,0][1000,1000]',
    });
    const item = uiNode({ id: 'item', bounds: '[0,0][100,100]' });
    let reads = 0;
    const dump = async () => {
      reads += 1;
      return reads === 1 ? [listNode] : [listNode, item];
    };
    await executeAction(
      device,
      'com.a',
      {
        kind: 'tap',
        target: { kind: 'id', id: 'item' },
        scrollTo: { kind: 'id', id: 'list' },
      },
      { dump },
    );
    const swipes = list.filter((g) => g.action === 'swipe');
    expect(swipes).toHaveLength(1);
    // Upward swipe inside the container: from 70% to 30% of its height.
    expect(swipes[0]).toMatchObject({ fromY: 700, toY: 300 });
    expect(list.at(-1)).toMatchObject({ action: 'click' });
  });

  it('fails after five swipes and names the count', async () => {
    const { list, device } = gesturesOf();
    // A list that keeps moving but never shows the target: the loop must
    // spend its whole budget rather than mistake motion for the edge.
    let offset = 0;
    const dump = async () => {
      offset += 100;
      return [
        uiNode({
          id: 'list',
          type: 'List',
          scrollable: true,
          bounds: `[0,${offset}][1000,${1000 + offset}]`,
        }),
      ];
    };
    const err = await executeAction(
      device,
      'com.a',
      {
        kind: 'tap',
        target: { kind: 'id', id: 'nope' },
        scrollTo: { kind: 'id', id: 'list' },
      },
      { dump },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
    expect((err as Error).message).toContain('5');
    expect(list.filter((g) => g.action === 'swipe')).toHaveLength(5);
  });

  it('stops early when a swipe changes nothing', async () => {
    const { list, device } = gesturesOf();
    const listNode = uiNode({
      id: 'list',
      type: 'List',
      scrollable: true,
      bounds: '[0,0][1000,1000]',
    });
    // The same tree every time: the list is at its edge, so a second swipe
    // would only burn time.
    const dump = async () => [listNode];
    const err = await executeAction(
      device,
      'com.a',
      {
        kind: 'tap',
        target: { kind: 'id', id: 'nope' },
        scrollTo: { kind: 'id', id: 'list' },
      },
      { dump },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
    expect(list.filter((g) => g.action === 'swipe').length).toBeLessThan(5);
  });

  it('refuses a scrollTo container that is not scrollable', async () => {
    const { device } = gesturesOf();
    const dump = async () => [uiNode({ id: 'box', type: 'Column', scrollable: false })];
    const err = await executeAction(
      device,
      'com.a',
      {
        kind: 'tap',
        target: { kind: 'id', id: 'nope' },
        scrollTo: { kind: 'id', id: 'box' },
      },
      { dump },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
    expect((err as Error).message).toContain('scrollable');
  });

  it('swipes inside the selected area in the requested direction', async () => {
    const { list, device } = gesturesOf();
    const dump = async () => [uiNode({ id: 'carousel', bounds: '[0,0][1000,500]' })];
    await executeAction(
      device,
      'com.a',
      { kind: 'swipeArea', area: { kind: 'id', id: 'carousel' }, direction: 'left' },
      { dump },
    );
    const swipe = list[0] as Extract<Gesture, { action: 'swipe' }>;
    expect(swipe.action).toBe('swipe');
    // Leftward: from 70% of the width to 30%, vertically centred.
    expect(swipe.fromX).toBe(700);
    expect(swipe.toX).toBe(300);
    expect(swipe.fromY).toBe(250);
    expect(swipe.toY).toBe(250);
  });

  it('honours distance as a percentage of the area', async () => {
    const { list, device } = gesturesOf();
    const dump = async () => [uiNode({ id: 'c', bounds: '[0,0][1000,1000]' })];
    await executeAction(
      device,
      'com.a',
      { kind: 'swipeArea', area: { kind: 'id', id: 'c' }, direction: 'up', distance: 20 },
      { dump },
    );
    const swipe = list[0] as Extract<Gesture, { action: 'swipe' }>;
    // 20% of 1000 px, centred on 500: 600 -> 400.
    expect(swipe.fromY).toBe(600);
    expect(swipe.toY).toBe(400);
  });

  it('taps a field then types into it', async () => {
    const { list, device } = gesturesOf();
    const dump = async () => [uiNode({ id: 'field', bounds: '[0,0][400,100]' })];
    await executeAction(
      device,
      'com.a',
      { kind: 'inputInto', target: { kind: 'id', id: 'field' }, text: 'hello' },
      { dump },
    );
    expect(list[0]).toEqual({ action: 'click', x: 200, y: 50 });
    expect(list[1]).toMatchObject({ action: 'inputText', text: 'hello', x: 200, y: 50 });
  });
});
