import { describe, it, expect } from 'vitest';
import { matchSelector, parseSelector, resolveSelector } from '../src/scenario/selector';
import { OhosPerfError } from '../src/errors';
import { parseBounds, type UiNode } from '../src/query/ui';

/*
 * Selectors, tested as the language an author writes rather than as an
 * implementation. Every case here is a sentence a scenario author could put in
 * a step, and the ones that refuse are as important as the ones that match: a
 * selector that silently matches everything is how a test taps the status bar
 * and reports ok.
 */

/**
 * A node whose `boundsRect` is derived from its `bounds` string, the way a real
 * dump's is. A helper that set the string but left the rect at a default would
 * put every node at the same place, and every geometry test would pass for the
 * wrong reason.
 */
function node(over: Partial<UiNode> & { bounds?: string } = {}): UiNode {
  const bounds = over.bounds ?? '[0,0][100,100]';
  return {
    depth: 0,
    type: 'Button',
    bundleName: 'com.demo',
    abilityName: 'Entry',
    text: '',
    id: '',
    bounds,
    clickable: false,
    enabled: true,
    scrollable: false,
    children: 0,
    boundsRect: parseBounds(bounds),
    ...over,
  };
}

describe('parseSelector', () => {
  it('accepts every documented kind', () => {
    expect(parseSelector({ kind: 'text', text: 'OK' }, 's').kind).toBe('text');
    expect(parseSelector({ kind: 'id', id: 'btn' }, 's').kind).toBe('id');
    expect(parseSelector({ kind: 'type', type: 'Button' }, 's').kind).toBe('type');
    expect(parseSelector({ kind: 'clickable' }, 's').kind).toBe('clickable');
    expect(
      parseSelector({ kind: 'all', of: [{ kind: 'clickable' }] }, 's').kind,
    ).toBe('all');
    expect(
      parseSelector({ kind: 'not', of: { kind: 'clickable' } }, 's').kind,
    ).toBe('not');
    expect(
      parseSelector(
        { kind: 'index', of: { kind: 'clickable' }, index: 0 },
        's',
      ).kind,
    ).toBe('index');
    expect(
      parseSelector(
        {
          kind: 'bounds',
          of: { kind: 'clickable' },
          within: { left: 0, top: 0, right: 10, bottom: 10 },
        },
        's',
      ).kind,
    ).toBe('bounds');
    expect(
      parseSelector(
        {
          kind: 'relative',
          of: { kind: 'clickable' },
          relation: 'below',
          to: { kind: 'type', type: 'Text' },
        },
        's',
      ).kind,
    ).toBe('relative');
  });

  it('refuses an empty text, which would match every node', () => {
    expect(() =>
      parseSelector({ kind: 'text', text: '' }, 'steps[0].target'),
    ).toThrow(/steps\[0\]\.target/);
  });

  it('refuses an unknown kind and names the path', () => {
    const err = (() => {
      try {
        parseSelector({ kind: 'xpath', xpath: '//a' }, 'steps[1].target');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(OhosPerfError);
    expect((err as OhosPerfError).code).toBe('SCENARIO_BAD_SELECTOR');
    expect((err as OhosPerfError).message).toContain('steps[1].target');
  });

  it('refuses a negative index', () => {
    expect(() =>
      parseSelector(
        { kind: 'index', of: { kind: 'type', type: 'X' }, index: -1 },
        's',
      ),
    ).toThrow(/index/);
  });

  it('refuses an empty combinator list', () => {
    expect(() => parseSelector({ kind: 'all', of: [] }, 's')).toThrow(/of/);
    expect(() => parseSelector({ kind: 'any', of: [] }, 's')).toThrow(/of/);
  });

  it('refuses an unknown relation', () => {
    expect(() =>
      parseSelector(
        {
          kind: 'relative',
          of: { kind: 'clickable' },
          relation: 'inside',
          to: { kind: 'type', type: 'Text' },
        },
        's',
      ),
    ).toThrow(/relation/);
  });

  it('names the nested path when a child selector is malformed', () => {
    expect(() =>
      parseSelector(
        { kind: 'all', of: [{ kind: 'clickable' }, { kind: 'text', text: '' }] },
        'steps[2].target',
      ),
    ).toThrow(/steps\[2\]\.target\.of\[1\]/);
  });

  it('refuses a non-object', () => {
    expect(() => parseSelector('text', 's')).toThrow(/selector/);
    expect(() => parseSelector(null, 's')).toThrow(/selector/);
  });
});

describe('matchSelector', () => {
  const nodes = [
    node({ text: 'OK', id: 'ok', bounds: '[0,0][100,100]' }),
    node({ text: 'Cancel', id: 'cancel', bounds: '[0,200][100,300]' }),
    node({ text: 'OK', id: 'ok2', bounds: '[0,400][100,500]' }),
  ];

  it('matches text case-insensitively as a substring by default', () => {
    expect(matchSelector(nodes, { kind: 'text', text: 'ok' })).toHaveLength(2);
  });

  it('matches text exactly when asked, still case-insensitively', () => {
    // Exactness narrows substring to equality; it does not make the match
    // case-sensitive. An author who wants case sensitivity has no selector
    // for it, deliberately: a label's case is not a property worth testing.
    expect(matchSelector(nodes, { kind: 'text', text: 'ok', exact: true })).toHaveLength(2);
    expect(matchSelector(nodes, { kind: 'text', text: 'O', exact: true })).toHaveLength(0);
  });

  it('matches id and type exactly', () => {
    expect(matchSelector(nodes, { kind: 'id', id: 'ok' }).map((n) => n.id)).toEqual(['ok']);
    expect(matchSelector(nodes, { kind: 'type', type: 'Button' })).toHaveLength(3);
    expect(matchSelector(nodes, { kind: 'type', type: 'button' })).toHaveLength(0);
  });

  it('matches only enabled clickable nodes', () => {
    const list = [
      node({ id: 'a', clickable: true }),
      node({ id: 'b', clickable: false }),
      node({ id: 'c', clickable: true, enabled: false }),
    ];
    expect(matchSelector(list, { kind: 'clickable' }).map((n) => n.id)).toEqual(['a']);
  });

  it('intersects with all and unions with any', () => {
    const ok = { kind: 'text', text: 'OK' } as const;
    const cancel = { kind: 'text', text: 'Cancel' } as const;
    expect(matchSelector(nodes, { kind: 'all', of: [ok, cancel] })).toHaveLength(0);
    expect(matchSelector(nodes, { kind: 'any', of: [ok, cancel] })).toHaveLength(3);
  });

  it('scopes not to the candidate set, not the whole tree', () => {
    // `all: [text OK, not id ok2]` must drop only ok2, not every non-OK node.
    const matched = matchSelector(nodes, {
      kind: 'all',
      of: [{ kind: 'text', text: 'OK' }, { kind: 'not', of: { kind: 'id', id: 'ok2' } }],
    });
    expect(matched.map((n) => n.id)).toEqual(['ok']);
  });

  it('selects one node by index in document order', () => {
    const matched = matchSelector(nodes, {
      kind: 'index',
      of: { kind: 'text', text: 'OK' },
      index: 1,
    });
    expect(matched.map((n) => n.id)).toEqual(['ok2']);
  });

  it('returns nothing for an index past the end', () => {
    expect(
      matchSelector(nodes, { kind: 'index', of: { kind: 'text', text: 'OK' }, index: 9 }),
    ).toEqual([]);
  });

  it('restricts by bounds', () => {
    const matched = matchSelector(nodes, {
      kind: 'bounds',
      of: { kind: 'type', type: 'Button' },
      within: { left: 0, top: 150, right: 200, bottom: 350 },
    });
    expect(matched.map((n) => n.id)).toEqual(['cancel']);
  });

  it('relates to the first node matching the anchor', () => {
    const matched = matchSelector(nodes, {
      kind: 'relative',
      of: { kind: 'type', type: 'Button' },
      relation: 'below',
      to: { kind: 'id', id: 'ok' },
    });
    // Below the FIRST 'ok' (top 0): cancel (200) and ok2 (400).
    expect(matched.map((n) => n.id)).toEqual(['cancel', 'ok2']);
  });

  it('relates in every direction, using the node centre', () => {
    const left = node({ id: 'left', bounds: '[0,0][100,100]' });
    const right = node({ id: 'right', bounds: '[300,0][400,100]' });
    const list = [left, right];
    expect(
      matchSelector(list, {
        kind: 'relative', of: { kind: 'type', type: 'Button' }, relation: 'rightOf',
        to: { kind: 'id', id: 'left' },
      }).map((n) => n.id),
    ).toEqual(['right']);
    expect(
      matchSelector(list, {
        kind: 'relative', of: { kind: 'type', type: 'Button' }, relation: 'leftOf',
        to: { kind: 'id', id: 'right' },
      }).map((n) => n.id),
    ).toEqual(['left']);
    expect(
      matchSelector(list, {
        kind: 'relative', of: { kind: 'type', type: 'Button' }, relation: 'above',
        to: { kind: 'id', id: 'right' },
      }),
    ).toEqual([]);
  });

  it('never satisfies a relation for a node with unparsed bounds', () => {
    const odd = { ...node({ id: 'odd', bounds: 'weird' }), boundsRect: undefined };
    const anchor = node({ id: 'anchor', bounds: '[0,0][10,10]' });
    expect(
      matchSelector([anchor, odd], {
        kind: 'relative', of: { kind: 'type', type: 'Button' }, relation: 'below',
        to: { kind: 'id', id: 'anchor' },
      }),
    ).toEqual([]);
  });

  it('returns a new array rather than the input', () => {
    const matched = matchSelector(nodes, { kind: 'type', type: 'Button' });
    expect(matched).not.toBe(nodes);
  });
});

describe('resolveSelector', () => {
  it('throws NO_MATCH naming the label when nothing matches', () => {
    const err = (() => {
      try {
        resolveSelector([], { kind: 'text', text: 'x' }, 'target');
      } catch (e) {
        return e as OhosPerfError;
      }
      return undefined;
    })();
    expect(err?.code).toBe('SCENARIO_SELECTOR_NO_MATCH');
    expect(err?.message).toContain('target');
  });

  it('throws AMBIGUOUS when more than one matches', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const err = (() => {
      try {
        resolveSelector(nodes, { kind: 'type', type: 'Button' }, 'target');
      } catch (e) {
        return e as OhosPerfError;
      }
      return undefined;
    })();
    expect(err?.code).toBe('SCENARIO_SELECTOR_AMBIGUOUS');
    expect(err?.message).toContain('2');
  });

  it('returns the one node when exactly one matches', () => {
    expect(resolveSelector([node({ id: 'only' })], { kind: 'id', id: 'only' }, 't').id)
      .toBe('only');
  });
});

describe('parseSelector — prototype keys are not selector kinds', () => {
  it('refuses Object.prototype members with a typed error, not a TypeError', () => {
    // `kind in KEYS` walks the prototype chain, so `toString` and
    // `constructor` pass the guard and then crash in `KEYS[kind].includes`.
    // The contract is a SCENARIO_BAD_SELECTOR naming the path.
    for (const kind of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const err = (() => {
        try {
          parseSelector({ kind }, 'steps[0].target');
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err, kind).toBeInstanceOf(OhosPerfError);
      expect((err as OhosPerfError).code, kind).toBe('SCENARIO_BAD_SELECTOR');
      expect((err as Error).message, kind).toContain('steps[0].target');
    }
  });
});
