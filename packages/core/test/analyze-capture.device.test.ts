import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { runAnalyzers, defaultAnalyzers } from '../src/analyze/engine';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery, ThreadQuery } from '../src/query/process';
import { InstantQuery, SchedQuery } from '../src/query/sched';
import { ThreadStateQuery } from '../src/query/thread-state';
import { CallstackQuery } from '../src/query/callstack';
import { PerfQuery } from '../src/query/perf';
import { BinderQuery } from '../src/query/binder';
import { StartupQuery } from '../src/query/startup';
import { readSceneMetadata } from '../src/ingest/metadata';
import { createSceneLayout } from '../src/ingest/scene';
import { readHidumperCapture } from '../src/collectors/hidumper';
import { resolveAppIdentity } from '../src/analyze/context';
import { readUiTree } from '../src/query/ui';

/**
 * Real-device acceptance for the analysis side of a captured scene.
 *
 * The unit tests feed hand-built contexts. This one captures a real scene and
 * runs the real analyzer set over it, which is the only evidence that the
 * collector output and the analyzers agree on a device's actual bytes.
 */

function attachedHdc(): string | undefined {
  const candidates = [
    process.env.OHOS_PERF_HDC,
    process.platform === 'win32'
      ? 'D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
      : undefined,
    'hdc',
  ].filter((path): path is string => path !== undefined);

  for (const hdc of candidates) {
    try {
      const out = execFileSync(hdc, ['list', 'targets'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const targets = out.split(/\r?\n/).filter((line) => {
        const text = line.trim();
        return text !== '' && !text.includes('[Empty]');
      });
      if (targets.length > 0) return hdc;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const HDC = attachedHdc();
const TARGET = process.env.OHOS_PERF_TARGET;
const DEBUG_APP = process.env.OHOS_PERF_DEBUG_APP ?? 'com.example.image';

describe.skipIf(HDC === undefined)('analyzing a scene captured on a device', () => {
  it('produces render metrics from the hidumper pair and never fabricates a zero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-analyze-device-'));
    try {
      const device = await connect({
        ...(HDC === undefined ? {} : { hdcPath: HDC }),
        ...(TARGET === undefined ? {} : { target: TARGET }),
      });
      const session = await device.collect({
        app: DEBUG_APP,
        durationMs: 3000,
        sceneRoot: root,
        hidumper: true,
        uitest: true,
      });
      const scene = await session.ingest();
      try {
        const layout = createSceneLayout(root);
        const db = scene.traceDb;
        const meta = readSceneMetadata(layout);
        const hidumper = readHidumperCapture(layout.hidumperFile);
        const uiTree = readUiTree(layout.uiFile);

        const result = await runAnalyzers(defaultAnalyzers(), {
          db,
          frames: new FrameQuery(db),
          processes: new ProcessQuery(db),
          threads: new ThreadQuery(db),
          sched: new SchedQuery(db),
          instant: new InstantQuery(db),
          threadStates: new ThreadStateQuery(db),
          callstacks: new CallstackQuery(db),
          perf: new PerfQuery(scene.perfDb ?? db),
          binder: new BinderQuery(db),
          startup: new StartupQuery(db),
          ...(hidumper === undefined ? {} : { hidumper }),
          ...(meta === undefined ? {} : { metadata: meta }),
          app: resolveAppIdentity(new ProcessQuery(db), DEBUG_APP),
          window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
          caps: await device.capabilities(),
          deviceId: device.id,
        });

        const byId = new Map(result.metrics.map((metric) => [metric.id, metric]));
        // The capture ran, so the live FPS metric exists and is a proxy —
        // never the degraded marker, which would mean the pair was unreadable.
        expect(byId.get('render.degraded')).toBeUndefined();
        const fps = byId.get('render.fps.live');
        expect(fps).toBeDefined();
        expect(fps!.fidelity).toBe('proxy');
        expect(Number.isFinite(fps!.value)).toBe(true);
        expect(byId.get('render.hitch.count')).toBeDefined();

        // Every metric still carries provenance and no fabricated null.
        for (const metric of result.metrics) {
          expect(metric.provenance).toBeDefined();
          expect(metric.value).not.toBeNaN();
        }

        // The ui tree reached the query layer, device-wide.
        expect(uiTree!.length).toBeGreaterThan(0);
        expect(result.evidence.every((item) => typeof item.kind === 'string')).toBe(true);
      } finally {
        scene.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 180_000);
});
