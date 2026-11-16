import { describe, it, expect } from 'vitest';
import { executeAction, type ActionDevice } from '../src/scenario/actions';

function fakeDevice(overrides: Partial<ActionDevice> = {}): ActionDevice & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    id: 't1',
    async shell(cmd) {
      calls.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    },
    async gesture(g) {
      calls.push(`gesture:${g.action}`);
      return { gesture: g, output: 'No Error' };
    },
    ...overrides,
  };
}

describe('executeAction', () => {
  it('maps every action to its device command', async () => {
    const device = fakeDevice();
    await executeAction(device, 'com.a', { kind: 'launch', ability: 'EntryAbility' });
    await executeAction(device, 'com.a', { kind: 'forceStop' });
    await executeAction(device, 'com.a', { kind: 'click', x: 5, y: 6 });
    await executeAction(device, 'com.a', {
      kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4, velocity: 600,
    });
    await executeAction(device, 'com.a', { kind: 'key', key: 'Home' });
    await executeAction(device, 'com.a', { kind: 'text', text: 'hi' });
    await executeAction(device, 'com.a', { kind: 'inputText', x: 7, y: 8, text: 'hi' });
    expect(device.calls).toEqual([
      'aa start -a EntryAbility -b com.a',
      'aa force-stop com.a',
      'gesture:click', 'gesture:swipe', 'gesture:key', 'gesture:text', 'gesture:inputText',
    ]);
  });

  it('passes a text with a space and a quote through unquoted', async () => {
    // Quoting belongs to the gesture driver; double-quoting here would send
    // the quotes to the device as characters.
    const seen: unknown[] = [];
    const device = fakeDevice({
      async gesture(g) {
        seen.push(g);
        return { gesture: g, output: 'No Error' };
      },
    });
    await executeAction(device, 'com.a', { kind: 'text', text: "it's here" });
    // `Gesture` spells its discriminator `action`, not `kind`.
    expect(seen).toEqual([{ action: 'text', text: "it's here" }]);
  });

  it('fails on a non-zero aa exit, naming the command', async () => {
    const device = fakeDevice({
      async shell() { return { stdout: '', stderr: 'StartAbility failed', code: 2 }; },
    });
    await expect(executeAction(device, 'com.a', { kind: 'launch', ability: 'X' }))
      .rejects.toThrow(/aa start.*exit 2.*StartAbility failed/);
  });

  it('fails on a non-zero aa force-stop exit', async () => {
    const device = fakeDevice({
      async shell() { return { stdout: '', stderr: '', code: 1 }; },
    });
    await expect(executeAction(device, 'com.a', { kind: 'forceStop' }))
      .rejects.toThrow(/aa force-stop.*exit 1/);
  });

  it('propagates a gesture failure unchanged', async () => {
    const device = fakeDevice({ async gesture() { throw new Error('uitest refused'); } });
    await expect(executeAction(device, 'com.a', { kind: 'click', x: 1, y: 1 }))
      .rejects.toThrow(/uitest refused/);
  });

  it('waits without touching the device', async () => {
    const device = fakeDevice();
    const started = Date.now();
    await executeAction(device, 'com.a', { kind: 'wait', ms: 20 });
    expect(device.calls).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('returns the device output for a shell action', async () => {
    const device = fakeDevice({
      async shell() { return { stdout: ' StartAbility successfully \n', stderr: '', code: 0 }; },
    });
    expect(await executeAction(device, 'com.a', { kind: 'launch', ability: 'X' }))
      .toEqual({ output: 'StartAbility successfully' });
  });

  it('returns the gesture output for a gesture action', async () => {
    const device = fakeDevice();
    expect(await executeAction(device, 'com.a', { kind: 'click', x: 1, y: 1 }))
      .toEqual({ output: 'No Error' });
  });

  it('refuses a marker: the runner records those', async () => {
    const device = fakeDevice();
    await expect(executeAction(device, 'com.a', { kind: 'marker', name: 'm' }))
      .rejects.toThrow(/marker/);
    expect(device.calls).toEqual([]);
  });
});
