import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import type { CliDeps } from '../src/commands';
import { runGesture } from '../src/commands';
import { parseCoordinate, parseKey, parseVelocity } from '../src/gesture';
import type { Gesture } from '@ohos-perf/core';


/** The shared deps, with `gesture` returning the given result or a key press. */
const deps = (result?: { gesture: Gesture; output: string }): CliDeps =>
  cliDeps({
    gesture: async () => result ?? { gesture: { action: 'key', key: 'Home' }, output: 'No Error' },
  });

describe('parseGesture arguments', () => {
  it('accepts a non-negative whole coordinate and rejects the rest', () => {
    expect(parseCoordinate('500', '<x>')).toBe(500);
    for (const raw of ['-1', '1.5', 'abc', '']) {
      expect(() => parseCoordinate(raw, '<x>'))
        .toThrow(/invalid <x>: expected a non-negative whole number/);
    }
  });

  it('accepts only the measured velocity range', () => {
    expect(parseVelocity('200')).toBe(200);
    expect(parseVelocity('40000')).toBe(40_000);
    for (const raw of ['199', '40001', 'abc']) {
      expect(() => parseVelocity(raw)).toThrow(/expected a whole number from 200 to 40000/);
    }
  });

  it('accepts Back, Home, Power and positive key codes', () => {
    expect(parseKey('Back')).toBe('Back');
    expect(parseKey('2')).toBe(2);
    for (const raw of ['back', 'NotAKey', '0', '-2']) {
      expect(() => parseKey(raw)).toThrow(/expected Back, Home, Power or a positive key code/);
    }
  });
});

describe('runGesture rendering', () => {
  it('prints one accepted line for each action', async () => {
    const cases: Array<[Gesture, string]> = [
      [{ action: 'click', x: 500, y: 800 }, 'click 500 800 accepted\n'],
      [{ action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200, velocity: 600 },
        'swipe 500,800 -> 500,200 (velocity 600) accepted\n'],
      [{ action: 'key', key: 'Home' }, 'key Home accepted\n'],
      [{ action: 'inputText', x: 500, y: 500, text: 'hi' }, 'input 500 500 "hi" accepted\n'],
      [{ action: 'text', text: 'hi' }, 'text "hi" accepted\n'],
    ];
    for (const [gesture, line] of cases) {
      const r = await runGesture(deps({ gesture, output: 'No Error' }), { gesture }, {});
      expect(r).toMatchObject({ stdout: line, stderr: '', exitCode: 0 });
    }
  });

  it('prints the core result as JSON', async () => {
    const gesture: Gesture = { action: 'key', key: 'Home' };
    const r = await runGesture(deps({ gesture, output: 'No Error' }), { gesture }, { json: true });
    expect(JSON.parse(r.stdout)).toEqual({ gesture, output: 'No Error' });
  });

  it('maps a failure to exit 1 with empty stdout', async () => {
    const d = deps();
    d.gesture = async () => { throw new Error('uitest not present on device'); };
    const r = await runGesture(d, { gesture: { action: 'key', key: 'Home' } }, {});
    expect(r).toMatchObject({ stdout: '', stderr: 'uitest not present on device\n', exitCode: 1 });
  });
});
