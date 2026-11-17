import { describe, it, expect } from 'vitest';
import { parseScenario } from '../src/scenario/schema';

const MINIMAL = {
  version: 1,
  name: 'x',
  app: 'com.example.app',
  steps: [{ id: 'a', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
};

/** Parse a document that differs from MINIMAL only where `patch` says. */
function parse(patch: Record<string, unknown>): unknown {
  return parseScenario(JSON.stringify({ ...MINIMAL, ...patch }));
}

/** Parse a document whose single step is MINIMAL's with `patch` applied. */
function parseStep(patch: Record<string, unknown>): unknown {
  const step = { ...MINIMAL.steps[0], ...patch };
  return parseScenario(JSON.stringify({ ...MINIMAL, steps: [step] }));
}

describe('parseScenario', () => {
  it('fills the documented defaults', () => {
    const scenario = parseScenario(JSON.stringify(MINIMAL));
    expect(scenario.rounds).toBe(1);
    expect(scenario.steps[0].setup).toEqual([]);
    expect(scenario.steps[0].cleanup).toEqual([]);
    expect(scenario.steps[0].name).toBe('a');
    expect(scenario.steps[0].capture.collectors).toEqual(['hitrace']);
  });

  it('keeps the description when present', () => {
    expect(parse({ description: 'why' })).toMatchObject({ description: 'why' });
  });

  it('rejects an unknown document key, naming its path', () => {
    expect(() => parse({ rounds: 2, extra: 1 })).toThrow(/rounds|extra/);
    expect(() => parse({ extra: 1 })).toThrow(/\bextra\b/);
  });

  it('rejects an unknown step key, naming its path', () => {
    expect(() => parseStep({ setupx: [] })).toThrow(/steps\[0\]\.setupx/);
  });

  it('rejects an unknown key inside capture, naming its path', () => {
    expect(() => parseStep({ capture: { duratonMs: 1000, collectors: ['hitrace'] } }))
      .toThrow(/steps\[0\]\.capture\.duratonMs/);
  });

  it('rejects a wrong version', () => {
    expect(() => parse({ version: 2 })).toThrow(/version/);
    expect(() => parse({ version: '1' })).toThrow(/version/);
  });

  it('rejects an empty steps array', () => {
    expect(() => parse({ steps: [] })).toThrow(/steps/);
  });

  it('rejects a duplicate step id at the second occurrence', () => {
    const twice = { ...MINIMAL, steps: [MINIMAL.steps[0], MINIMAL.steps[0]] };
    expect(() => parseScenario(JSON.stringify(twice))).toThrow(/steps\[1\]\.id/);
  });

  it('rejects a step id that is not a directory-safe slug', () => {
    for (const id of ['Open Viewer', '../escape', '1open', '', 'open/x']) {
      expect(() => parseStep({ id }), JSON.stringify(id)).toThrow(/steps\[0\]\.id/);
    }
  });

  it('rejects a missing or non-slug app', () => {
    expect(() => parseScenario(JSON.stringify({ ...MINIMAL, app: undefined }))).toThrow(/app/);
    expect(() => parse({ app: 'com.example.app; rm -rf /' })).toThrow(/app/);
  });

  it('rejects a non-positive or fractional rounds value', () => {
    for (const rounds of [0, -1, 1.5, '2']) {
      expect(() => parse({ rounds }), String(rounds)).toThrow(/rounds/);
    }
  });

  it('accepts thermal as a step collector', () => {
    const scenario = parseStep({
      capture: { durationMs: 1000, collectors: ['hitrace', 'thermal'] },
    }) as { steps: Array<{ capture: { collectors: string[] } }> };
    expect(scenario.steps[0]!.capture.collectors).toEqual(['hitrace', 'thermal']);
  });

  it('rejects a collector name outside the known set', () => {
    expect(() => parseStep({ capture: { durationMs: 1000, collectors: ['hitrace', 'ftrace'] } }))
      .toThrow(/collectors\[1\]/);
    // The message lists what a step MAY ask for, so a new collector must be in
    // it — otherwise the user is told a valid name is invalid.
    expect(() => parseStep({ capture: { durationMs: 1000, collectors: ['hitrace', 'ftrace'] } }))
      .toThrow(/thermal/);
  });

  it('rejects an explicitly empty collector list', () => {
    expect(() => parseStep({ capture: { durationMs: 1000, collectors: [] } }))
      .toThrow(/collectors/);
  });

  it('rejects hitrace together with hiprofiler', () => {
    expect(() => parseStep({
      capture: {
        durationMs: 1000,
        collectors: ['hitrace', 'hiprofiler'],
        hiprofiler: { plugins: ['gpu'] },
      },
    })).toThrow(/hiprofiler/);
  });

  it('rejects hiprofiler plugins without the hiprofiler collector', () => {
    expect(() => parseStep({
      capture: { durationMs: 1000, collectors: ['hitrace'], hiprofiler: { plugins: ['gpu'] } },
    })).toThrow(/hiprofiler/);
  });

  it('rejects an explicitly empty plugin list', () => {
    expect(() => parseStep({
      capture: { durationMs: 1000, collectors: ['hiprofiler'], hiprofiler: { plugins: [] } },
    })).toThrow(/plugins/);
  });

  it('rejects a hiperf request without the hiperf collector', () => {
    expect(() => parseStep({
      capture: { durationMs: 1000, collectors: ['hitrace'], hiperf: { frequency: 1000 } },
    })).toThrow(/hiperf/);
  });

  it('rejects a duration outside (0, 2^31-1]', () => {
    for (const durationMs of [0, -1, 1.5, 2 ** 31, '1000']) {
      expect(() => parseStep({ capture: { durationMs, collectors: ['hitrace'] } }),
        String(durationMs)).toThrow(/durationMs/);
    }
  });

  it('rejects an unknown action kind, naming its path', () => {
    // `tap` used to be the example of an unknown kind; P17 made it real, so
    // the fixture uses one that is not in the language at all.
    expect(() => parseStep({ actions: [{ kind: 'longPress', x: 1, y: 2 }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.kind/);
  });

  it('rejects a negative or fractional coordinate', () => {
    expect(() => parseStep({ actions: [{ kind: 'click', x: -1, y: 2 }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.x/);
    expect(() => parseStep({ actions: [{ kind: 'click', x: 1.5, y: 2 }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.x/);
  });

  it('rejects a key outside each action kind', () => {
    // `velocity` belongs to swipe, not click.
    expect(() => parseStep({ actions: [{ kind: 'click', x: 1, y: 2, velocity: 600 }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.velocity/);
  });

  it('rejects a swipe velocity outside the device range', () => {
    for (const velocity of [199, 40001, 600.5]) {
      expect(() => parseStep({
        actions: [{ kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4, velocity }],
      }), String(velocity)).toThrow(/velocity/);
    }
  });

  it('rejects empty text and text with control characters', () => {
    expect(() => parseStep({ actions: [{ kind: 'text', text: '' }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.text/);
    expect(() => parseStep({ actions: [{ kind: 'text', text: 'a\u0007b' }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.text/);
  });

  it('rejects a marker without a name and a wait without ms', () => {
    expect(() => parseStep({ actions: [{ kind: 'marker' }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.name/);
    expect(() => parseStep({ actions: [{ kind: 'wait' }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.ms/);
  });

  it('rejects an ability or key that is not a bare name', () => {
    expect(() => parseStep({ setup: [{ kind: 'launch', ability: 'Entry Ability' }] }))
      .toThrow(/steps\[0\]\.setup\[0\]\.ability/);
    expect(() => parseStep({ actions: [{ kind: 'key', key: 'Home; rm' }] }))
      .toThrow(/steps\[0\]\.actions\[0\]\.key/);
  });

  it('accepts a positive key code and the three named keys', () => {
    const scenario = parseScenario(JSON.stringify({
      ...MINIMAL,
      steps: [{
        ...MINIMAL.steps[0],
        actions: [{ kind: 'key', key: 'Back' }, { kind: 'key', key: 2055 }],
      }],
    }));
    expect(scenario.steps[0].actions).toEqual([
      { kind: 'key', key: 'Back' },
      { kind: 'key', key: 2055 },
    ]);
  });

  it('rejects invalid JSON with a scenario message', () => {
    expect(() => parseScenario('{ nope')).toThrow(/scenario/i);
  });

  it('rejects a non-object document', () => {
    for (const text of ['[]', 'null', '"x"', '3']) {
      expect(() => parseScenario(text), text).toThrow(/scenario/i);
    }
  });

  it('keeps a full document intact', () => {
    const scenario = parseScenario(JSON.stringify({
      version: 1,
      name: 'image-open',
      description: 'open the viewer',
      app: 'com.example.image',
      rounds: 2,
      steps: [{
        id: 'open',
        name: 'Open the viewer',
        setup: [{ kind: 'launch', ability: 'EntryAbility' }, { kind: 'wait', ms: 1500 }],
        actions: [{ kind: 'click', x: 500, y: 800 }, { kind: 'marker', name: 'image-requested' }],
        cleanup: [{ kind: 'forceStop' }],
        capture: {
          durationMs: 5000,
          collectors: ['hiprofiler', 'procfs', 'hilog'],
          hiprofiler: { plugins: ['ftrace', 'gpu'] },
        },
      }],
    }));
    expect(scenario).toEqual({
      version: 1,
      name: 'image-open',
      description: 'open the viewer',
      app: 'com.example.image',
      rounds: 2,
      steps: [{
        id: 'open',
        name: 'Open the viewer',
        setup: [{ kind: 'launch', ability: 'EntryAbility' }, { kind: 'wait', ms: 1500 }],
        actions: [{ kind: 'click', x: 500, y: 800 }, { kind: 'marker', name: 'image-requested' }],
        cleanup: [{ kind: 'forceStop' }],
        capture: {
          durationMs: 5000,
          collectors: ['hiprofiler', 'procfs', 'hilog'],
          hiprofiler: { plugins: ['ftrace', 'gpu'] },
        },
      }],
    });
  });
});

/*
 * P17: selector actions and step expectations.
 *
 * The contract is that a selector is validated as data — every malformed
 * selector names its JSON path — while a coordinate-only scenario from before
 * this phase keeps loading unchanged.
 */
describe('parseScenario — selector actions', () => {
  const actions = (list: unknown[]): unknown => parseStep({ actions: list });

  it('accepts the four selector actions', () => {
    const scenario = actions([
      { kind: 'tap', target: { kind: 'text', text: 'OK' } },
      { kind: 'tapText', text: 'Cancel' },
      { kind: 'swipeArea', area: { kind: 'type', type: 'List' }, direction: 'up' },
      { kind: 'inputInto', target: { kind: 'id', id: 'field' }, text: 'hello' },
    ]) as { steps: { actions: { kind: string }[] }[] };
    expect(scenario.steps[0].actions.map((a) => a.kind))
      .toEqual(['tap', 'tapText', 'swipeArea', 'inputInto']);
  });

  it('accepts tap with scrollTo and timeoutMs', () => {
    const scenario = actions([{
      kind: 'tap',
      target: { kind: 'id', id: 'item' },
      scrollTo: { kind: 'type', type: 'List' },
      timeoutMs: 5000,
    }]) as { steps: { actions: unknown[] }[] };
    expect(scenario.steps[0].actions).toHaveLength(1);
  });

  it('refuses a malformed selector, naming the action path', () => {
    expect(() => actions([{ kind: 'tap', target: { kind: 'text', text: '' } }]))
      .toThrow(/steps\[0\]\.actions\[0\]\.target/);
  });

  it('refuses an unknown direction', () => {
    expect(() => actions([{
      kind: 'swipeArea', area: { kind: 'type', type: 'List' }, direction: 'sideways',
    }])).toThrow(/direction/);
  });

  it('refuses an empty tapText', () => {
    expect(() => actions([{ kind: 'tapText', text: '' }])).toThrow(/text/);
  });

  it('refuses an unknown key on a selector action', () => {
    expect(() => actions([{ kind: 'tapText', text: 'OK', selector: {} }]))
      .toThrow(/selector/);
  });

  it('keeps a coordinate-only scenario working', () => {
    const scenario = actions([{ kind: 'click', x: 10, y: 20 }]) as {
      steps: { actions: { kind: string }[] }[];
    };
    expect(scenario.steps[0].actions[0].kind).toBe('click');
  });
});

describe('parseScenario — expect', () => {
  it('accepts a full expect block', () => {
    const scenario = parseStep({
      expect: {
        present: [{ selector: { kind: 'text', text: 'Done' }, min: 1 }],
        absent: [{ kind: 'id', id: 'spinner' }],
        foreground: true,
      },
    }) as { steps: { expect?: { present?: unknown[] } }[] };
    expect(scenario.steps[0].expect?.present).toHaveLength(1);
  });

  it('accepts an empty expect block', () => {
    expect(() => parseStep({ expect: {} })).not.toThrow();
  });

  it('refuses an unknown key inside expect, naming it', () => {
    expect(() => parseStep({ expect: { presentt: [] } })).toThrow(/presentt/);
  });

  it('refuses a malformed selector inside present, naming its path', () => {
    expect(() => parseStep({
      expect: { present: [{ selector: { kind: 'nope' } }] },
    })).toThrow(/expect\.present\[0\]\.selector/);
  });

  it('refuses min greater than max', () => {
    expect(() => parseStep({
      expect: { present: [{ selector: { kind: 'type', type: 'X' }, min: 3, max: 1 }] },
    })).toThrow(/min|max/);
  });

  it('refuses a non-boolean foreground', () => {
    expect(() => parseStep({ expect: { foreground: 'yes' } })).toThrow(/foreground/);
  });

  it('refuses a malformed selector in absent, naming its path', () => {
    expect(() => parseStep({ expect: { absent: [{ kind: 'text', text: '' }] } }))
      .toThrow(/expect\.absent\[0\]/);
  });
});
