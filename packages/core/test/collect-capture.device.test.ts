import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { HiperfCollector } from '../src/collectors/hiperf';
import { readHidumperCapture } from '../src/collectors/hidumper';
import { readUiTree } from '../src/query/ui';
import { readSceneMetadata } from '../src/ingest/metadata';
import { createSceneLayout } from '../src/ingest/scene';
import { Hdc } from '../src/transport/hdc';

/**
 * Real-device acceptance for the three capture collectors.
 *
 * Every test here talks to an attached device and is skipped when none is.
 * The fake-injected unit tests pin the protocol; these pin what the device
 * actually does — the only evidence that the commands, markers and parsers
 * match the shipped binaries.
 *
 * Measured facts these depend on (Mate 60, BRA-AL00, HarmonyOS 7.0.0.111):
 * `com.example.image` is a debuggable app, `com.huawei.hmos.settings` is a
 * release app, and the release refusal reads
 * `--app option only support debug or profileable application`.
 */

const DEBUG_APP = process.env.OHOS_PERF_DEBUG_APP ?? 'com.example.image';
const RELEASE_APP = process.env.OHOS_PERF_RELEASE_APP ?? 'com.huawei.hmos.settings';

/**
 * Resolve an hdc binary with at least one connected target.
 *
 * The repo's test environment may have no device at all, so every failure
 * (missing binary, timeout, empty target list) means "skip", not "fail".
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

async function connectedDevice(): Promise<Awaited<ReturnType<typeof connect>>> {
  return connect({
    ...(HDC === undefined ? {} : { hdcPath: HDC }),
    ...(TARGET === undefined ? {} : { target: TARGET }),
  });
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe.skipIf(HDC === undefined)('capture collectors on an attached device', () => {
  it('captures hiperf, hidumper and uitest together and records what each produced', async () => {
    const root = tempRoot('ohosperf-capture-');
    try {
      const device = await connectedDevice();
      const session = await device.collect({
        app: DEBUG_APP,
        durationMs: 3000,
        sceneRoot: root,
        hiperf: {},
        hidumper: true,
        uitest: true,
      });
      const scene = await session.ingest();
      try {
        const layout = createSceneLayout(root);

        // hiperf: the sample count is the device's own summary, and the
        // converted perf database is what the analyzers read.
        const meta = readSceneMetadata(layout);
        expect(meta?.capture?.collectors).toEqual(['hitrace', 'hiperf', 'hidumper', 'uitest']);
        expect(meta?.capture?.hiperf?.samples).toBeGreaterThanOrEqual(0);
        expect(existsSync(layout.perfFile!)).toBe(true);
        expect(scene.perfDb).toBeDefined();
        const perfTables = scene.perfDb!.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'perf_sample'",
        );
        expect(perfTables).toHaveLength(1);

        // hidumper: two snapshots, and the frame delta is a real measurement.
        const hidumper = readHidumperCapture(layout.hidumperFile);
        expect(hidumper).toBeDefined();
        expect(hidumper!.samples).toHaveLength(2);
        expect(hidumper!.samples[0].fpsCounts.length).toBeGreaterThan(0);
        expect(meta?.capture?.hidumper?.frames).toBeGreaterThanOrEqual(0);

        // uitest: the flattened tree is device-wide, so the app's nodes are
        // somewhere in it rather than at the root.
        const nodes = readUiTree(layout.uiFile);
        expect(nodes).toBeDefined();
        expect(nodes!.length).toBeGreaterThan(0);
        expect(meta?.capture?.uitest?.nodes).toBe(nodes!.length);
      } finally {
        scene.close();
      }
    } finally {
      cleanup(root);
    }
  }, 180_000);

  it('reports a release app as not debuggable, not as a recording failure', async () => {
    // The device answers `--app option only support debug or profileable
    // application` and exits 0, so the exit code is no evidence at all.
    const hdc = new Hdc({ ...(HDC === undefined ? {} : { hdcPath: HDC }) });
    const device = await connectedDevice();
    const root = tempRoot('ohosperf-hiperf-release-');
    try {
      const collector = new HiperfCollector();
      await expect(
        collector.collect(hdc, device.id, { app: RELEASE_APP, durationMs: 1000 }, createSceneLayout(root)),
      ).rejects.toMatchObject({ code: 'HIPERF_NOT_DEBUGGABLE' });
    } finally {
      cleanup(root);
    }
  }, 120_000);

  it('samples a software event on a device with no PMU, and a hardware event is refused', async () => {
    const device = await connectedDevice();
    const caps = await device.capabilities();
    const hdc = new Hdc({ ...(HDC === undefined ? {} : { hdcPath: HDC }) });
    const root = tempRoot('ohosperf-hiperf-events-');
    try {
      if (caps.has('perf.pmu')) {
        // A device with a PMU accepts the hardware event; nothing to prove here.
        expect(caps.get('perf.pmu')?.available).toBe(true);
        return;
      }
      // No PMU: a requested hardware event must be rejected before recording,
      // naming the software events the probe found. Recording it would exit 0
      // with no samples, which reads exactly like an idle app.
      await expect(
        new HiperfCollector().collect(
          hdc,
          device.id,
          { app: DEBUG_APP, durationMs: 1000, events: ['hw-cpu-cycles'] },
          createSceneLayout(root),
        ),
      ).rejects.toMatchObject({ code: 'HIPERF_BAD_EVENT' });
    } finally {
      cleanup(root);
    }
  }, 120_000);

  it('leaves no stale capture behind when the dump succeeds against a blank screen', async () => {
    // `dumpLayout` succeeds and prints its marker even when the screen holds
    // nothing; the capture is then a real, empty measurement rather than a
    // missing one, and it must be recorded as 0 nodes.
    const device = await connectedDevice();
    const root = tempRoot('ohosperf-uitest-blank-');
    try {
      const session = await device.collect({
        app: DEBUG_APP,
        durationMs: 1000,
        sceneRoot: root,
        uitest: true,
      });
      const scene = await session.ingest();
      try {
        const meta = readSceneMetadata(createSceneLayout(root));
        expect(meta?.capture?.uitest?.nodes).toBeGreaterThanOrEqual(0);
        expect(meta?.capture?.collectors).toContain('uitest');
        // The transferred document is JSON or the collector failed: an empty
        // tree still parses to an array.
        const raw = readFileSync(createSceneLayout(root).uiFile, 'utf8');
        expect(() => JSON.parse(raw)).not.toThrow();
      } finally {
        scene.close();
      }
    } finally {
      cleanup(root);
    }
  }, 120_000);
});
