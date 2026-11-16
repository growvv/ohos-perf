import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenUiTree, readUiTree } from '../src/query/ui';

/** The measured `uitest dumpLayout` shape: `{ attributes, children }`. */
const ROOT = {
  attributes: { type: '', bundleName: '', bounds: '[0,0][1216,2688]' },
  children: [
    {
      attributes: {
        type: 'WindowScene', bundleName: 'com.ohos.sceneboard', abilityName: '',
        bounds: '[0,107][1216,2688]', text: '', id: 'session176',
        clickable: '', enabled: 'true', scrollable: 'false',
      },
      children: [
        {
          attributes: {
            type: 'Image', bundleName: 'com.example.image', abilityName: 'EntryAbility',
            bounds: '[10,200][300,500]', text: '', id: '',
            clickable: 'true', enabled: 'true', scrollable: 'false',
          },
          children: [],
        },
      ],
    },
  ],
};

describe('flattenUiTree', () => {
  it('flattens depth-first in document order', () => {
    const nodes = flattenUiTree(ROOT);
    expect(nodes.map((n) => n.type)).toEqual(['', 'WindowScene', 'Image']);
    expect(nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
  });

  it('keeps the measured attribute subset and coerces flags', () => {
    const image = flattenUiTree(ROOT)[2];
    expect(image).toEqual({
      depth: 2,
      type: 'Image',
      bundleName: 'com.example.image',
      abilityName: 'EntryAbility',
      text: '',
      id: '',
      bounds: '[10,200][300,500]',
      clickable: true,
      enabled: true,
      scrollable: false,
      children: 0,
    });
  });

  it('reads only the documented attribute names', () => {
    const [node] = flattenUiTree({
      attributes: {
        type: 'Text', bundleName: 'b', abilityName: 'a', text: 'hello', id: 'i',
        bounds: '[0,0][1,1]', clickable: 'false', enabled: 'false', scrollable: 'true',
        // Extra inspector fields must not leak into the flattened shape.
        level: '3', inspectorId: 'x',
      },
      children: [],
    });
    expect(node).toEqual({
      depth: 0, type: 'Text', bundleName: 'b', abilityName: 'a', text: 'hello',
      id: 'i', bounds: '[0,0][1,1]', clickable: false, enabled: false,
      scrollable: true, children: 0,
    });
  });

  it('counts direct children only', () => {
    expect(flattenUiTree(ROOT).map((n) => n.children)).toEqual([1, 1, 0]);
  });

  it('tolerates a node with no attributes or children', () => {
    expect(flattenUiTree({})).toEqual([]);
  });

  it('skips a node without attributes together with its subtree', () => {
    const nodes = flattenUiTree({
      attributes: { type: 'Root' },
      children: [
        { children: [{ attributes: { type: 'Hidden' }, children: [] }] },
        { attributes: { type: 'Shown' }, children: [] },
      ],
    });
    // The orphan's child is not promoted to depth 1: its depth is unknown
    // once the parent is skipped.
    expect(nodes.map((n) => n.type)).toEqual(['Root', 'Shown']);
  });

  it('returns [] for a document that is not a tree', () => {
    expect(flattenUiTree({ not: 'a tree' })).toEqual([]);
    expect(flattenUiTree(null)).toEqual([]);
    expect(flattenUiTree('text')).toEqual([]);
  });

  it('coerces a non-string attribute to an empty string', () => {
    const [node] = flattenUiTree({
      attributes: { type: 7, bundleName: null, enabled: 'true' }, children: [],
    });
    expect(node.type).toBe('');
    expect(node.bundleName).toBe('');
    expect(node.enabled).toBe(true);
  });
});

describe('readUiTree', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohosperf-ui-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('returns undefined for a missing file', () => {
    expect(readUiTree(join(dir, 'absent.json'))).toBeUndefined();
  });

  it('reads and flattens a captured tree', () => {
    const path = join(dir, 'ui.json');
    writeFileSync(path, JSON.stringify(ROOT));
    expect(readUiTree(path)?.map((n) => n.type)).toEqual(['', 'WindowScene', 'Image']);
  });

  it('returns undefined for invalid JSON', () => {
    const path = join(dir, 'ui.json');
    writeFileSync(path, '{ not json');
    expect(readUiTree(path)).toBeUndefined();
  });

  it('returns [] for valid JSON that is not a tree', () => {
    const path = join(dir, 'ui.json');
    writeFileSync(path, '{"attributes": "nope"}');
    expect(readUiTree(path)).toEqual([]);
  });
});
