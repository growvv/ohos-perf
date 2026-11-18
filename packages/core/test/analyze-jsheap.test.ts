import { describe, it, expect } from 'vitest';
import { JsheapAnalyzer } from '../src/analyze/jsheap';
import { defaultAnalyzers } from '../src/analyze/engine';
import { CapabilityMatrix } from '../src/device/capability';
import type { AnalyzeContext } from '../src/analyze/types';
import type { FrameQuery } from '../src/query/frames';
import type { ProcessQuery } from '../src/query/process';

/*
 * JS heap snapshot analysis (HapRay parity row 20, extended).
 *
 * HapRay's row 20 is capture only: `hidumper --mem-jsheap`, pull the
 * `.heapsnapshot`, done. Nothing on either side reads it, so a captured heap
 * is a file a person opens in DevEco Studio and no report ever mentions.
 *
 * This analyzer reads the snapshot the capture pulled. The device route stays
 * unavailable for the measured reason (see `device/capability.ts`), so a scene
 * is the only way in — and a scene with no snapshot says so, rather than
 * reporting a zero-byte heap.
 */

/** Two objects of 64 and 32 bytes under the root, one detached. */
function heap(): string {
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [
          ['hidden', 'array', 'string', 'object'],
          'string', 'number', 'number', 'number', 'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
          'string_or_number', 'node',
        ],
      },
      node_count: 3,
      edge_count: 2,
    },
    nodes: [0, 0, 1, 0, 2, 0, 3, 1, 2, 64, 0, 2, 3, 2, 3, 32, 0, 1],
    edges: [2, 1, 6, 2, 2, 12],
    strings: ['', 'A', 'B'],
  });
}

/** The minimum a context needs for an analyzer that reads one scene file. */
function context(overrides: Partial<AnalyzeContext> = {}): AnalyzeContext {
  return {
    frames: {} as FrameQuery,
    processes: {} as ProcessQuery,
    app: { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 1 },
    caps: new CapabilityMatrix([]),
    deviceId: 'emu-1',
    ...overrides,
  } as unknown as AnalyzeContext;
}

describe('JsheapAnalyzer', () => {
  it('reports total heap, node count, detached count and object count', async () => {
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    const byId = new Map(result.metrics.map((m) => [m.id, m.value]));
    expect(byId.get('jsheap.total.bytes')).toBe(96);
    expect(byId.get('jsheap.nodes.count')).toBe(3);
    expect(byId.get('jsheap.detached.count')).toBe(1);
    expect(byId.get('jsheap.objects.count')).toBe(2);
  });

  it('marks every metric exact and names the snapshot file', async () => {
    // Unlike coverage, the number comes from this package's own parse of the
    // heap itself — no build or external tool sits between the file and the
    // metric — so `approximate` would understate it.
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    for (const metric of result.metrics) {
      expect(metric.fidelity).toBe('exact');
      expect(metric.provenance.collector).toBe('scene:jsheap.heapsnapshot');
    }
  });

  it('names the largest constructor rather than listing every one', async () => {
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    const item = result.evidence.find((e) => e.kind === 'js_heap');
    expect(item?.explain).toContain('A');
    expect(item?.signals).toMatchObject({ constructor: 'A', selfSize: 64 });
  });

  it('warns when the snapshot holds detached nodes', async () => {
    // A detached node is memory the app can no longer reach and has not yet
    // freed — the shape of a leak, and the one thing a heap snapshot answers
    // that no other capture does.
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    const item = result.evidence.find((e) => e.kind === 'js_heap');
    expect(item?.severity).toBe('warn');
  });

  it('degrades with a reason when the scene carries no snapshot', async () => {
    const result = await new JsheapAnalyzer().run(context());
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.kind).toBe('no_data');
    expect(result.evidence[0]!.explain).toMatch(/jsheap\.heapsnapshot/);
    expect(result.evidence[0]!.explain).toMatch(/--jsheap/);
  });

  it('refuses a corrupt snapshot rather than reporting a heap it could not read', async () => {
    await expect(
      new JsheapAnalyzer().run(context({ jsheap: '{"snapshot":' })),
    ).rejects.toMatchObject({ code: 'JSHEAP_BAD_SNAPSHOT' });
  });

  it('is registered with the default analyzers', () => {
    expect(defaultAnalyzers().map((a) => a.constructor.name)).toContain('JsheapAnalyzer');
  });
});
