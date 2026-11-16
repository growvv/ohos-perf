import { describe, it, expect } from 'vitest';
import { UiAnalyzer } from '../src/analyze/ui';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';
import type { UiNode } from '../src/query/ui';
import { dhash } from '../src/image/diff';
import type { RgbaImage } from '../src/image/png';
import type { QueryHandle } from '../src/db/driver';

/**
 * The analyzer reads only `ui` and `screenshot`; a handle that throws on any
 * call keeps a hidden database dependency visible.
 */
const UNUSED = (() => {
  throw new Error('the ui analyzer must not query the database');
}) as unknown as QueryHandle;

function ctxWith(
  ui?: readonly UiNode[],
  screenshot?: RgbaImage,
): AnalyzeContext {
  return {
    frames: new FrameQuery(UNUSED),
    processes: new ProcessQuery(UNUSED),
    app: { packageName: 'com.demo', pids: [5000], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 1 },
    caps: new CapabilityMatrix([]),
    deviceId: 'test',
    ...(ui === undefined ? {} : { ui }),
    ...(screenshot === undefined ? {} : { screenshot }),
  };
}

/** Three nodes, two levels deep: a root with a text and a clickable child. */
const TREE: UiNode[] = [
  {
    depth: 0, type: 'root', bundleName: 'com.demo', abilityName: 'Entry',
    text: '', id: '', bounds: '[0,0][1080,2340]', clickable: false,
    enabled: true, scrollable: false, children: 2,
  },
  {
    depth: 1, type: 'Text', bundleName: 'com.demo', abilityName: 'Entry',
    text: 'Hello', id: '', bounds: '[0,0][540,100]', clickable: false,
    enabled: true, scrollable: false, children: 0,
  },
  {
    depth: 1, type: 'Button', bundleName: 'com.demo', abilityName: 'Entry',
    text: 'OK', id: 'ok', bounds: '[540,0][1080,100]', clickable: true,
    enabled: true, scrollable: false, children: 0,
  },
];

const IMAGE: RgbaImage = {
  width: 4,
  height: 2,
  data: new Uint8Array([
    0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 128, 128, 128, 255, 64, 64, 64, 255, 0, 0, 0, 255,
  ]),
};

function metric(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

describe('UiAnalyzer', () => {
  it('is registered under the documented identity and requires nothing', () => {
    const analyzer = new UiAnalyzer();
    expect(analyzer.id).toBe('ui');
    expect(analyzer.requires).toEqual([]);
  });

  it('measures tree and image when both artifacts are present', async () => {
    const r = await new UiAnalyzer().run(ctxWith(TREE, IMAGE));

    expect(metric(r, 'ui.nodes.count').value).toBe(3);
    expect(metric(r, 'ui.nodes.clickable').value).toBe(1);
    expect(metric(r, 'ui.nodes.text').value).toBe(2);
    expect(metric(r, 'ui.tree.depth.max').value).toBe(1);
    expect(metric(r, 'ui.screenshot.width').value).toBe(4);
    expect(metric(r, 'ui.screenshot.height').value).toBe(2);
    expect(metric(r, 'ui.screenshot.dhash').value).toBe(dhash(IMAGE));
    expect(metric(r, 'ui.screenshot.dhash').unit).toBe('hash');

    for (const m of r.metrics) expect(m.fidelity).toBe('exact');
    expect(metric(r, 'ui.nodes.count').provenance).toEqual({
      collector: 'uitest', table: 'ui.json', rows: 3, device: 'test',
    });
    expect(metric(r, 'ui.screenshot.width').provenance).toEqual({
      collector: 'screenshot', table: 'screenshot.png', device: 'test',
    });
  });

  it('emits one ui_tree evidence item describing the tree', async () => {
    const r = await new UiAnalyzer().run(ctxWith(TREE, IMAGE));
    const items = r.evidence.filter((e) => e.kind === 'ui_tree');
    expect(items).toHaveLength(1);
    expect(items[0].signals).toEqual({ nodes: 3, depth: 1, clickable: 1, text: 2 });
    expect(items[0].severity).toBe('info');
  });

  it('degrades the image half with a reason when only the tree exists', async () => {
    const r = await new UiAnalyzer().run(ctxWith(TREE, undefined));

    expect(metric(r, 'ui.nodes.count').fidelity).toBe('exact');
    for (const id of ['ui.screenshot.width', 'ui.screenshot.height', 'ui.screenshot.dhash']) {
      const m = metric(r, id);
      expect(m.fidelity).toBe('proxy');
      expect(m.degraded?.reason).toBe('no screenshot in this scene');
    }
    expect(r.evidence.filter((e) => e.kind === 'ui_tree')).toHaveLength(1);
  });

  it('degrades the tree half with a reason when only the image exists', async () => {
    const r = await new UiAnalyzer().run(ctxWith(undefined, IMAGE));

    expect(metric(r, 'ui.screenshot.width').fidelity).toBe('exact');
    for (const id of ['ui.nodes.count', 'ui.nodes.clickable', 'ui.nodes.text', 'ui.tree.depth.max']) {
      const m = metric(r, id);
      expect(m.fidelity).toBe('proxy');
      expect(m.degraded?.reason).toBe('no UI tree in this scene');
    }
    expect(r.evidence.filter((e) => e.kind === 'ui_tree')).toEqual([]);
  });

  it('degrades to one proxy and a no_data item when neither exists', async () => {
    const r = await new UiAnalyzer().run(ctxWith());

    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0].id).toBe('ui.degraded');
    expect(r.metrics[0].fidelity).toBe('proxy');
    expect(r.metrics[0].degraded?.reason).toBe('no UI capture in this scene');

    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].kind).toBe('no_data');
    expect(r.evidence[0].explain).toMatch(/ui\.json/);
    expect(r.evidence[0].explain).toMatch(/screenshot\.png/);
  });

  it('reports the decoder message when the screenshot exists but cannot be read', async () => {
    const ctx: AnalyzeContext = {
      ...ctxWith(TREE, undefined),
      screenshotError: 'PNG image data is incomplete: inflated 8 bytes, expected 34 for 4x2',
    };
    const r = await new UiAnalyzer().run(ctx);

    expect(metric(r, 'ui.screenshot.width').fidelity).toBe('proxy');
    expect(metric(r, 'ui.screenshot.width').degraded?.reason).toMatch(/inflated 8 bytes/);
    expect(metric(r, 'ui.nodes.count').fidelity).toBe('exact');
  });

  it('sorts its metrics by id', async () => {
    const r = await new UiAnalyzer().run(ctxWith(TREE, IMAGE));
    const ids = r.metrics.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
  });
});
