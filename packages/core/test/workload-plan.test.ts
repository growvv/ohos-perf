import { describe, it, expect } from 'vitest';
import { parseWorkloadPlan } from '../src/workload/plan';

/**
 * The plan shape is the one an external harness publishes. Every rejection
 * names the JSON path, because a plan is often copied between projects and a
 * silently-ignored typo turns a measured workload into a no-op that reports
 * "the app did not change".
 */

const MINIMAL = {
  bundle: 'com.example.app',
  ability: 'EntryAbility',
  description: 'browser',
  setup: [{ op: 'wait', selector: { text: '首页' } }],
  measured: [{ op: 'launch' }, { op: 'pause', seconds: 2 }],
  verify: [],
};

function plan(overrides: Record<string, unknown> = {}) {
  return parseWorkloadPlan({ ...MINIMAL, ...overrides });
}

describe('parseWorkloadPlan', () => {
  it('parses the published plan shape', () => {
    const parsed = plan();
    expect(parsed.bundle).toBe('com.example.app');
    expect(parsed.measured).toHaveLength(2);
    expect(parsed.setup[0]).toMatchObject({ op: 'wait' });
  });

  it('keeps the selector fields the reference driver compares', () => {
    const parsed = plan({
      measured: [{
        op: 'tap',
        selector: { type: 'Button', bounds: '[195,326][296,427]', enabled: 'true', index: 1 },
      }],
    });
    expect(parsed.measured[0]).toEqual({
      op: 'tap',
      selector: { type: 'Button', bounds: '[195,326][296,427]', enabled: 'true', index: 1 },
    });
  });

  it('nests repeat actions', () => {
    const parsed = plan({
      measured: [{
        op: 'repeat',
        count: 3,
        actions: [{ op: 'swipe', direction: 'up', count: 2 }],
      }],
    });
    expect(parsed.measured[0]).toMatchObject({
      op: 'repeat',
      count: 3,
      actions: [{ op: 'swipe', direction: 'up', count: 2 }],
    });
  });

  it('refuses an unknown action and names its path', () => {
    expect(() => plan({ measured: [{ op: 'teleport' }] }))
      .toThrow(/plan\.measured\[0\]\.op: unsupported action "teleport"/);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    expect(() => plan({ measured: [{ op: 'pause', seconds: 1, until: 'done' }] }))
      .toThrow(/plan\.measured\[0\]: unknown key "until"/);
  });

  it('refuses a selector with no fields', () => {
    expect(() => plan({ measured: [{ op: 'tap', selector: { match: 'exact' } }] }))
      .toThrow(/expected at least one of text, id, type, hint, bounds, enabled/);
  });

  it('refuses an unknown match mode', () => {
    expect(() => plan({ measured: [{ op: 'tap', selector: { text: 'a', match: 'fuzzy' } }] }))
      .toThrow(/expected one of substring, exact, regex/);
  });

  it('refuses a bundle that is not a bare name', () => {
    // The name is interpolated into `aa start`; a space or a semicolon would
    // be a second command, not part of the name.
    expect(() => plan({ bundle: 'com.example.app; rm -rf /' }))
      .toThrow(/plan\.bundle: expected a bare name/);
  });

  it('refuses an invalid key name but accepts a key code', () => {
    expect(() => plan({ measured: [{ op: 'key', key: 'Escape' }] }))
      .toThrow(/expected Back, Home, Power or a key code/);
    expect(plan({ measured: [{ op: 'key', key: 2054 }] }).measured[0])
      .toEqual({ op: 'key', key: 2054 });
  });

  it('accepts the optional duration some plans carry', () => {
    expect(plan({ duration_s: 15 }).duration_s).toBe(15);
    expect(plan()).not.toHaveProperty('duration_s');
  });

  it('treats an absent setup or verify as empty', () => {
    const parsed = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility', measured: [{ op: 'stop' }],
    });
    expect(parsed.setup).toEqual([]);
    expect(parsed.verify).toEqual([]);
  });
});
