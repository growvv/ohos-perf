import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkloadPlan } from '../src/workload/plan';
import { WorkloadRunner, type WorkloadDevice } from '../src/workload/runner';
import type { Gesture } from '../src/device/gesture';
import type { UiNode } from '../src/query/ui';

/**
 * The runner's contract, on a fake device:
 *
 * - setup runs before the capture and a failure there starts none;
 * - measured runs inside the window, and the window is still ingested when an
 *   action fails (the trace is the record);
 * - verify runs after the window and its failure fails the run without
 *   discarding the scene.
 */

let dir: string;

function node(over: Partial<UiNode>): UiNode {
  return {
    depth: 1, type: 'Text', bundleName: 'com.example.app', abilityName: 'EntryAbility',
    text: '', id: '', bounds: '[0,0][100,100]', clickable: true, enabled: true,
    scrollable: false, children: 0,
    boundsRect: { left: 0, top: 0, right: 100, bottom: 100 },
    attributes: {}, ...over,
  };
}

const HOME = node({ text: '首页', type: 'Text' });
const SEARCH = node({
  type: 'SearchField', text: '', attributes: { hint: '搜索歌曲、音乐人、播客' },
  bounds: '[0,200][1000,300]', boundsRect: { left: 0, top: 200, right: 1000, bottom: 300 },
});
const ROOT = node({
  type: 'Root', depth: 0, bounds: '[0,0][1080,2340]',
  boundsRect: { left: 0, top: 0, right: 1080, bottom: 2340 },
});

interface FakeOptions {
  screens?: UiNode[][];
  failIngest?: boolean;
  writeScene?: boolean;
}

function fakeDevice(opts: FakeOptions = {}) {
  const shellCalls: string[] = [];
  const gestures: Gesture[] = [];
  const collects: Array<{ app: string; durationMs: number }> = [];
  let dump = 0;
  const screens = opts.screens ?? [[ROOT, HOME], [ROOT, HOME, SEARCH]];
  const device: WorkloadDevice & { shellCalls: string[]; gestures: Gesture[]; collects: unknown[] } = {
    id: 'fake', kind: 'emulator',
    shellCalls, gestures, collects: collects as unknown[],
    async shell(cmd: string) {
      shellCalls.push(cmd);
      if (cmd.startsWith('pidof ')) return { stdout: '4242\n', stderr: '', code: 0 };
      if (cmd.startsWith('uitest uiInput')) return { stdout: 'No Error\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async gesture(g: Gesture) {
      gestures.push(g);
      return { gesture: g, output: 'No Error' };
    },
    async uiTree() {
      // Each call advances one screen, then holds on the last one.
      const screen = screens[Math.min(dump, screens.length - 1)]!;
      dump += 1;
      return screen;
    },
    async collect(request) {
      collects.push({ app: request.app, durationMs: request.durationMs });
      return {
        async ingest() {
          if (opts.failIngest === true) throw new Error('conversion failed');
          writeFileSync(join(request.sceneRoot, 'trace.db'), '');
          // The real capture writes its descriptor with the pids it could
          // resolve before the window; a plan that launches the app has none.
          if (opts.writeScene !== false) {
            writeFileSync(join(request.sceneRoot, 'scene.json'), JSON.stringify({
              version: 1,
              app: { packageName: request.app, processNames: [request.app] },
              pids: [],
              deviceId: 'fake',
              capture: { startedAtMs: 1, durationMs: request.durationMs, collectors: ['hitrace'] },
            }));
          }
          return { close() {} };
        },
      };
    },
  };
  return device;
}

function runner(device: WorkloadDevice, durationMs = 5000, now?: () => number) {
  return new WorkloadRunner(device, {
    outDir: dir,
    durationMs,
    ...(now === undefined ? {} : { now }),
    sleep: async () => {},
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-workload-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('WorkloadRunner', () => {
  it('runs setup, captures the measured phase and verifies afterwards', async () => {
    const device = fakeDevice();
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app',
      ability: 'EntryAbility',
      description: 'search',
      setup: [{ op: 'stop' }, { op: 'launch' }, { op: 'wait', selector: { text: '首页' } }],
      measured: [{ op: 'tap', selector: { type: 'SearchField', hint: '搜索' } }],
      verify: [{ op: 'wait', selector: { hint: '搜索' } }],
    });
    const result = await runner(device).run(plan);

    expect(result.status).toBe('ok');
    expect(result.setup.ok).toBe(true);
    expect(result.measured.ok).toBe(true);
    expect(result.verify.ok).toBe(true);
    expect(device.collects).toEqual([{ app: 'com.example.app', durationMs: 5000 }]);
    // The tap went to the centre of the search field's rect.
    expect(device.gestures).toEqual([{ action: 'click', x: 500, y: 250 }]);
    expect(result.pids).toEqual([4242]);
    expect(existsSync(join(dir, 'workload.json'))).toBe(true);
  });

  it('records the pid resolved after the window in the scene descriptor', async () => {
    // The app is launched inside the window, so the capture's own descriptor
    // holds no pid. The trace's `process.name` is the 15-char comm, which is
    // not the bundle — without this pid the analyzer cannot find the app.
    const device = fakeDevice();
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility', measured: [{ op: 'launch' }],
    });
    const result = await runner(device).run(plan);
    expect(result.status).toBe('ok');
    const meta = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
    expect(meta.pids).toEqual([4242]);
    expect(meta.capture.durationMs).toBe(5000);
  });

  it('launches the app before the plan\'s own phases', async () => {
    // The published plans do not launch the app; their harness does. A plan
    // whose first action waits for an in-app screen therefore depends on this
    // preamble, and a runner without it starts on the home screen.
    const device = fakeDevice();
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility', measured: [{ op: 'pause', seconds: 1 }],
    });
    const result = await runner(device).run(plan);
    expect(result.launch.ok).toBe(true);
    expect(result.launch.actions.map((action) => action.op)).toEqual(['stop', 'launch']);
    expect(device.shellCalls).toContain('aa force-stop com.example.app');
    expect(device.shellCalls).toContain('aa start -a EntryAbility -b com.example.app');
  });

  it('starts no capture when setup fails', async () => {
    const device = fakeDevice({ screens: [[ROOT]] });
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility',
      setup: [{ op: 'wait', selector: { text: '首页' }, timeout_s: 0 }],
      measured: [{ op: 'launch' }],
    });
    const outDir = join(dir, 'setup-failed');
    const result = await new WorkloadRunner(device, {
      outDir, durationMs: 1000, sleep: async () => {},
    }).run(plan);
    expect(result.status).toBe('failed');
    expect(result.setup.ok).toBe(false);
    expect(device.collects).toEqual([]);
    expect(result.sceneDir).toBeUndefined();
    // The run happened even though no capture did, so the record exists.
    expect(existsSync(join(outDir, 'workload.json'))).toBe(true);
  });

  it('keeps the scene when a measured action fails', async () => {
    const device = fakeDevice({ screens: [[ROOT]] });
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility',
      measured: [
        { op: 'launch' },
        { op: 'tap', selector: { text: 'missing' }, },
      ],
    });
    // A clock that outruns the find timeout immediately: the target never
    // appears, and the test must not spend the real 15 s waiting for it.
    let clock = 0;
    const result = await runner(device, 60_000, () => (clock += 16_000)).run(plan);
    expect(result.status).toBe('failed');
    expect(result.measured.ok).toBe(false);
    expect(result.sceneDir).toBe(dir);
    expect(result.error).toMatch(/UI target not found/);
  });

  it('fails the run when the capture cannot be converted', async () => {
    const device = fakeDevice({ failIngest: true });
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility', measured: [{ op: 'launch' }],
    });
    const result = await runner(device).run(plan);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/capture failed: conversion failed/);
    expect(result.sceneDir).toBeUndefined();
  });

  it('reports a measured phase longer than the capture window', async () => {
    // A fake clock: every read advances 1 s, so the measured phase spans more
    // than the 1 s window the caller asked for.
    let clock = 0;
    const device = fakeDevice();
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility', measured: [{ op: 'launch' }],
    });
    const result = await runner(device, 1000, () => (clock += 1000)).run(plan);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/exceeding the 1\.00s capture window/);
  });

  it('types a value and verifies the field holds it', async () => {
    let typed = '';
    const search = { ...SEARCH };
    const device = fakeDevice({
      screens: [[ROOT, search], [ROOT, search], [ROOT, search]],
    });
    const original = device.gesture;
    device.gesture = async (g: Gesture) => {
      if (g.action === 'inputText') typed += g.text;
      return original(g);
    };
    const plan = parseWorkloadPlan({
      bundle: 'com.example.app', ability: 'EntryAbility',
      measured: [{ op: 'type_keys', selector: { hint: '搜索' }, value: 'electronic' }],
    });
    const result = await runner(device).run(plan);
    // The fake screen never reflects typed text, so the verification must
    // fail — and it must say what it expected and what it found.
    expect(typed).toBe('electronic');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/typed value does not match/);
  });
});
