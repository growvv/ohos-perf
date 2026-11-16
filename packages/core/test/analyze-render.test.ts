import { describe, it, expect } from 'vitest';
import { RenderAnalyzer } from '../src/analyze/render';
import { CapabilityMatrix } from '../src/device/capability';
import type { AnalyzeContext } from '../src/analyze/types';
import type { HidumperCapture } from '../src/collectors/hidumper';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import type { QueryHandle } from '../src/db/driver';

/**
 * The analyzer only reads `app`, `window`, `caps`, `deviceId` and (optionally)
 * `hidumper`; the query handles are required by the type but never touched, so
 * a stub that throws on any call keeps a hidden dependency visible.
 */
const UNUSED = (() => {
  throw new Error('the render analyzer must not query the database');
}) as unknown as QueryHandle;

function ctxWith(capture?: HidumperCapture): AnalyzeContext {
  return {
    frames: new FrameQuery(UNUSED),
    processes: new ProcessQuery(UNUSED),
    app: { packageName: 'com.demo', pids: [5000], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 1 },
    caps: new CapabilityMatrix([]),
    deviceId: 'test',
    ...(capture === undefined ? {} : { hidumper: capture }),
  };
}

const capture: HidumperCapture = {
  version: 1,
  intervalMs: 10_000,
  samples: [
    {
      ts: 0,
      fpsCounts: [{ refreshRate: 60, count: 1000 }, { refreshRate: 120, count: 0 }],
      hitches: [{ windowId: 'w1', over16_67: 3, over33: 1, over66: 0 }],
    },
    {
      ts: 10_000,
      fpsCounts: [{ refreshRate: 60, count: 1600 }, { refreshRate: 120, count: 600 }],
      hitches: [{ windowId: 'w1', over16_67: 9, over33: 2, over66: 1 }],
    },
  ],
};

describe('RenderAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new RenderAnalyzer();
    expect(analyzer.id).toBe('render');
    expect(analyzer.requires).toEqual(['render.fps_live']);
  });

  it('derives live fps from the delta between the two snapshots', async () => {
    const r = await new RenderAnalyzer().run(ctxWith(capture));
    const fps = r.metrics.find((m) => m.id === 'render.fps.live');
    // (600 + 600) frames over 10 s = 120 fps
    expect(fps?.value).toBe(120);
    expect(fps?.unit).toBe('fps');
    expect(fps?.fidelity).toBe('proxy');
    expect(fps?.provenance.collector).toBe('hidumper');
    expect(fps?.provenance.device).toBe('test');
    expect(fps?.provenance.rows).toBe(2);
  });

  it('derives the hitch count as an exact delta', async () => {
    const r = await new RenderAnalyzer().run(ctxWith(capture));
    const hitch = r.metrics.find((m) => m.id === 'render.hitch.count');
    expect(hitch?.value).toBe(6); // 9 - 3
    expect(hitch?.fidelity).toBe('exact');
    expect(hitch?.unit).toBe('count');
  });

  it('emits evidence for a window whose hitches grew', async () => {
    const r = await new RenderAnalyzer().run(ctxWith(capture));
    const e = r.evidence.find((x) => x.kind === 'fps_baseline');
    expect(e?.signals).toMatchObject({
      window: 'w1', over16_67: 6, over33: 1, over66: 1,
    });
    expect(e?.severity).toBe('warn');
    expect(e?.drillDown?.[0]).toMatchObject({
      tool: 'caps.get',
      args: { ids: ['render.hitch'] },
    });
  });

  it('attributes hitches to the device, not to the app', async () => {
    // hidumper counts the whole screen: the window may belong to any process.
    // Labelling the evidence with the app would send an agent looking for the
    // app's frames when the hitches came from sceneboard or another window.
    const r = await new RenderAnalyzer().run(ctxWith(capture));
    const e = r.evidence.find((x) => x.kind === 'fps_baseline');
    expect(e?.subject.process).not.toBe('com.demo');
    expect(e?.signals.app).toBe('com.demo');
  });

  it('emits no hitch evidence for a window whose counters did not grow', async () => {
    const quiet: HidumperCapture = {
      ...capture,
      samples: [capture.samples[0], { ...capture.samples[1], hitches: capture.samples[0].hitches }],
    };
    const r = await new RenderAnalyzer().run(ctxWith(quiet));
    expect(r.evidence.filter((x) => x.kind === 'fps_baseline')).toEqual([]);
    expect(r.metrics.find((m) => m.id === 'render.hitch.count')?.value).toBe(0);
  });

  it('reports zero rather than throwing when the app rendered nothing', async () => {
    const idle: HidumperCapture = { ...capture, samples: [capture.samples[0], capture.samples[0]] };
    const r = await new RenderAnalyzer().run(ctxWith(idle));
    expect(r.metrics.find((m) => m.id === 'render.fps.live')?.value).toBe(0);
    expect(r.metrics.find((m) => m.id === 'render.hitch.count')?.value).toBe(0);
  });

  it('clamps a counter that went backwards to zero', async () => {
    // The service restarted between snapshots; a negative delta is not a
    // measurement, so it must not subtract from the total.
    const restarted: HidumperCapture = {
      ...capture,
      samples: [
        { ts: 0, fpsCounts: [{ refreshRate: 60, count: 5000 }],
          hitches: [{ windowId: 'w1', over16_67: 10, over33: 5, over66: 2 }] },
        { ts: 10_000, fpsCounts: [{ refreshRate: 60, count: 100 }],
          hitches: [{ windowId: 'w1', over16_67: 1, over33: 0, over66: 0 }] },
      ],
    };
    const r = await new RenderAnalyzer().run(ctxWith(restarted));
    expect(r.metrics.find((m) => m.id === 'render.fps.live')?.value).toBe(0);
    expect(r.metrics.find((m) => m.id === 'render.hitch.count')?.value).toBe(0);
  });

  it('joins hitches by windowId across snapshots', async () => {
    const twoWindows: HidumperCapture = {
      ...capture,
      samples: [
        { ...capture.samples[0], hitches: [
          { windowId: 'a', over16_67: 1, over33: 0, over66: 0 },
          { windowId: 'b', over16_67: 0, over33: 0, over66: 0 },
        ] },
        { ...capture.samples[1], hitches: [
          { windowId: 'b', over16_67: 4, over33: 0, over66: 0 },
          { windowId: 'a', over16_67: 3, over33: 0, over66: 0 },
        ] },
      ],
    };
    const r = await new RenderAnalyzer().run(ctxWith(twoWindows));
    expect(r.metrics.find((m) => m.id === 'render.hitch.count')?.value).toBe(6); // 2 + 4
    expect(r.evidence.map((x) => x.signals.window)).toEqual(['a', 'b']);
  });

  it('treats a window absent from the first snapshot as starting at zero', async () => {
    const appeared: HidumperCapture = {
      ...capture,
      samples: [
        { ...capture.samples[0], hitches: [] },
        { ...capture.samples[1], hitches: [{ windowId: 'new', over16_67: 5, over33: 0, over66: 0 }] },
      ],
    };
    const r = await new RenderAnalyzer().run(ctxWith(appeared));
    expect(r.metrics.find((m) => m.id === 'render.hitch.count')?.value).toBe(5);
  });

  it('sorts metrics by id and evidence by kind then id', async () => {
    const r = await new RenderAnalyzer().run(ctxWith(capture));
    const ids = r.metrics.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    const keys = r.evidence.map((e) => `${e.kind}|${e.window.startNs}|${e.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('degrades without a hidumper capture', async () => {
    const r = await new RenderAnalyzer().run(ctxWith(undefined));
    expect(r.metrics).toEqual([expect.objectContaining({
      id: 'render.degraded', fidelity: 'proxy', value: 0,
    })]);
    expect(r.metrics[0].degraded).toMatchObject({ reason: 'no hidumper capture' });
    expect(r.evidence).toEqual([]);
  });

  it('does not claim a capability the matrix lacks', async () => {
    // The engine, not the analyzer, gates this; the analyzer must still be
    // callable with an empty capture and produce only the degraded metric.
    expect(new RenderAnalyzer().requires).toEqual(['render.fps_live']);
  });
});
