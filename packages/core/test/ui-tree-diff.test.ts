import { describe, it, expect } from 'vitest';
import { diffTrees } from '../src/ui/diff';
import { flattenUiTree, type UiNode } from '../src/query/ui';

function node(spec: {
  type: string; text?: string; id?: string; bounds?: string;
  extra?: Record<string, string>; children?: unknown[];
}): unknown {
  return {
    attributes: {
      type: spec.type, bundleName: 'com.a', abilityName: 'Main',
      text: spec.text ?? '', id: spec.id ?? '',
      bounds: spec.bounds ?? '[0,0][10,10]',
      clickable: 'false', enabled: 'true', scrollable: 'false',
      ...spec.extra,
    },
    children: spec.children ?? [],
  };
}

const root = (children: unknown[]): unknown => node({ type: 'Root', children });

const flat = (doc: unknown): UiNode[] => flattenUiTree(doc, { full: true });

describe('diffTrees', () => {
  it('reports nothing for identical trees', () => {
    const a = flat(root([node({ type: 'Text', text: 'hi' })]));
    const result = diffTrees(a, a);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toBe(2);
  });

  it('reports an inserted first child as one addition, not a cascade', () => {
    const before = flat(root([
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'b' }),
    ]));
    const after = flat(root([
      node({ type: 'Text', text: 'new' }),
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'b' }),
    ]));
    const result = diffTrees(before, after);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ change: 'added', type: 'Text' });
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('reports a removed node once', () => {
    const before = flat(root([
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'gone' }),
    ]));
    const after = flat(root([node({ type: 'Text', text: 'a' })]));
    const result = diffTrees(before, after);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].attributes).toBeUndefined();
  });

  it('reports a changed attribute with both values', () => {
    const before = flat(root([node({ type: 'Text', text: 'a', extra: { opacity: '1' } })]));
    const after = flat(root([node({ type: 'Text', text: 'a', extra: { opacity: '0.5' } })]));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].attributes).toEqual([
      { name: 'opacity', before: '1', after: '0.5' },
    ]);
  });

  it('ignores a geometry change under 5 px', () => {
    const before = flat(root([node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]' })]));
    const after = flat(root([node({ type: 'Text', text: 'a', bounds: '[13,12][53,54]' })]));
    expect(diffTrees(before, after).changed).toEqual([]);
  });

  it('reports a geometry change at or over 5 px with both rects', () => {
    const before = flat(root([node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]' })]));
    const after = flat(root([node({ type: 'Text', text: 'a', bounds: '[16,10][50,50]' })]));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].attributes).toEqual([
      { name: 'bounds', before: '[10,10][50,50]', after: '[16,10][50,50]' },
    ]);
  });

  it('ignores attributes on the documented list', () => {
    const before = flat(root([
      node({ type: 'Text', text: 'a', extra: { rsNode: '1', frameProxy: 'x' } }),
    ]));
    const after = flat(root([
      node({ type: 'Text', text: 'a', extra: { rsNode: '2', frameProxy: 'y' } }),
    ]));
    expect(diffTrees(before, after).changed).toEqual([]);
  });

  it('pairs duplicate identities in document order', () => {
    const before = flat(root([
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
    ]));
    const after = flat(root([
      node({ type: 'Text', text: 'x', extra: { opacity: '0' } }),
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
    ]));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].path).toBe('0.0');
  });

  it('carries the node bounds on a changed difference so an image region can be drawn', () => {
    const before = flat(root([
      node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]', extra: { opacity: '1' } }),
    ]));
    const after = flat(root([
      node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]', extra: { opacity: '0' } }),
    ]));
    expect(diffTrees(before, after).changed[0].bounds)
      .toEqual({ left: 10, top: 10, right: 50, bottom: 50 });
  });
});
