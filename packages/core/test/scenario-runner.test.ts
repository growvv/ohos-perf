import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBounds, type UiNode } from '../src/query/ui';
import { parseScenario, type Scenario } from '../src/scenario/schema';
import {
  ScenarioRunner,
  writeRunFiles,
  type RunnerCollectOptions,
  type RunResult,
  type RunnerDevice,
} from '../src/scenario/runner';

type CollectOptions = RunnerCollectOptions;

function fakeDevice(behaviour: {
  shell?: (cmd: string) => { stdout: string; stderr: string; code: number };
  collect?: (opts: CollectOptions) => Promise<{ close(): void }>;
} = {}): RunnerDevice & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    id: '127.0.0.1:5555',
    kind: 'emulator',
    async shell(cmd: string) {
      calls.push(cmd);
      if (behaviour.shell !== undefined) {
        const answered = behaviour.shell(cmd);
        // Only the commands the behaviour claims are answered here; the rest
        // fall through to the defaults, so a test names just what it changes.
        if (answered.code !== 0 || answered.stdout !== '' || cmd.startsWith('aa ')) {
          return answered;
        }
      }
      if (cmd === 'cat /proc/uptime') return { stdout: '1000.00 200.00\n', stderr: '', code: 0 };
      if (cmd.startsWith('pidof ')) return { stdout: '4999 5012\n', stderr: '', code: 0 };
      if (cmd.startsWith('bm dump ')) return { stdout: '{"versionName":"1.0.0"}', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async gesture(g) {
      calls.push(`gesture:${g.action}`);
      return { gesture: g, output: 'No Error' };
    },
    async collect(opts: CollectOptions) {
      calls.push(`collect:${opts.sceneRoot}`);
      return {
        async ingest() {
          mkdirSync(opts.sceneRoot, { recursive: true });
          writeFileSync(join(opts.sceneRoot, 'trace.db'), '');
          return behaviour.collect === undefined ? { close() {} } : behaviour.collect(opts);
        },
      };
    },
  };
}

function scenarioOf(patch: Record<string, unknown>): Scenario {
  return parseScenario(JSON.stringify({
    version: 1,
    name: 'two',
    app: 'com.example.app',
    rounds: 2,
    steps: [
      {
        id: 'open',
        setup: [{ kind: 'launch', ability: 'EntryAbility' }],
        actions: [{ kind: 'click', x: 5, y: 6 }, { kind: 'marker', name: 'tapped' }],
        cleanup: [{ kind: 'forceStop' }],
        capture: { durationMs: 1000, collectors: ['hitrace'] },
      },
      {
        id: 'scroll',
        actions: [{ kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4 }],
        capture: { durationMs: 1000, collectors: ['hitrace'] },
      },
    ],
    ...patch,
  }));
}

const TWO_STEPS = scenarioOf({});

function outDir(): string {
  return mkdtempSync(join(tmpdir(), 'run-'));
}

describe('ScenarioRunner', () => {
  it('runs every (round, step) pair in scenario order and writes a scene each', async () => {
    const out = outDir();
    const result = await new ScenarioRunner(fakeDevice(), { outDir: out }).run(TWO_STEPS);
    expect(result.steps.map((s) => `${s.round}:${s.id}`)).toEqual([
      '1:open', '1:scroll', '2:open', '2:scroll',
    ]);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    for (const step of result.steps) {
      expect(existsSync(join(step.sceneDir!, 'trace.db'))).toBe(true);
      expect(step.sceneDir).toBe(join(out, step.id, `round-${step.round}`));
    }
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(2);
    expect(result.scenario).toBe('two');
    expect(result.device).toEqual({ id: '127.0.0.1:5555', kind: 'emulator' });
  });

  it('passes the step reference to the capture', async () => {
    const out = outDir();
    const seen: Array<CollectOptions['step']> = [];
    const device = fakeDevice();
    const collect = device.collect.bind(device);
    device.collect = async (opts) => { seen.push(opts.step); return collect(opts); };
    await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(seen).toEqual([
      { round: 1, index: 0, id: 'open' },
      { round: 1, index: 1, id: 'scroll' },
    ]);
  });

  it('maps the step collectors onto collect options', async () => {
    const out = outDir();
    const seen: CollectOptions[] = [];
    const device = fakeDevice();
    const collect = device.collect.bind(device);
    device.collect = async (opts) => { seen.push(opts); return collect(opts); };
    const scenario = scenarioOf({
      steps: [
        {
          id: 'full',
          actions: [],
          capture: {
            durationMs: 2000,
            collectors: ['hiprofiler', 'procfs', 'hiperf', 'hidumper', 'uitest', 'hilog'],
            hiprofiler: { plugins: ['ftrace', 'gpu'] },
            hiperf: { frequency: 1000 },
          },
        },
      ],
    });
    await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(scenario);
    expect(seen[0]).toMatchObject({
      app: 'com.example.app',
      durationMs: 2000,
      procfs: true,
      hiprofiler: { plugins: ['ftrace', 'gpu'] },
      hiperf: { frequency: 1000 },
      hidumper: true,
      uitest: true,
      hilog: true,
    });
    expect(seen[0]).not.toHaveProperty('coldStart');
    // hitrace is the default trace collector, never a flag of its own.
    expect(seen[0]).not.toHaveProperty('hitrace');
  });

  it('runs setup before the capture starts and cleanup after it', async () => {
    const out = outDir();
    const order: string[] = [];
    const device = fakeDevice();
    const collect = device.collect.bind(device);
    device.collect = async (opts) => { order.push('capture-start'); return collect(opts); };
    const shell = device.shell.bind(device);
    device.shell = async (cmd) => { order.push(cmd); return shell(cmd); };
    const gesture = device.gesture.bind(device);
    device.gesture = async (g) => { order.push(`gesture:${g.action}`); return gesture(g); };
    await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    const aaStart = order.findIndex((e) => e.startsWith('aa start'));
    const start = order.indexOf('capture-start');
    const click = order.findIndex((e) => e === 'gesture:click');
    const forceStop = order.findIndex((e) => e.startsWith('aa force-stop'));
    expect(aaStart).toBeGreaterThanOrEqual(0);
    expect(aaStart).toBeLessThan(start);
    expect(start).toBeLessThan(click);
    expect(click).toBeLessThan(forceStop);
  });

  it('records the marker with its device-uptime instant and no device call', async () => {
    const out = outDir();
    const device = fakeDevice();
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    const marker = result.steps[0].actions.find((a) => a.action.kind === 'marker')!;
    expect(marker.ok).toBe(true);
    // 1000.00 s uptime, read as ns.
    expect(marker.atNs).toBe(1_000_000_000_000);
    expect(marker.atMs).toBeGreaterThan(0);
    expect(device.calls.filter((c) => c.includes('marker'))).toEqual([]);
  });

  it('keeps the scene when an action fails, and fails the step', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.gesture = async () => { throw new Error('uitest refused'); };
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1, keepGoing: true })
      .run(TWO_STEPS);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/uitest refused/);
    expect(existsSync(join(result.steps[0].sceneDir!, 'trace.db'))).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('records a failed action as ok:false with its error', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.gesture = async () => { throw new Error('uitest refused'); };
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    const click = result.steps[0].actions.find((a) => a.action.kind === 'click')!;
    expect(click).toMatchObject({ ok: false, error: 'uitest refused' });
  });

  it('runs cleanup after a failed action and does not mask its error', async () => {
    const out = outDir();
    const device = fakeDevice({
      shell: (cmd) => cmd.startsWith('aa force-stop')
        ? { stdout: '', stderr: 'cleanup broke', code: 3 }
        : { stdout: '', stderr: '', code: 0 },
    });
    device.gesture = async () => { throw new Error('first failure'); };
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(result.steps[0].error).toMatch(/first failure/);
    expect(device.calls.some((c) => c.startsWith('aa force-stop'))).toBe(true);
  });

  it('fails the step on a failed setup, before any capture', async () => {
    const out = outDir();
    const device = fakeDevice({
      shell: (cmd) => cmd.startsWith('aa start')
        ? { stdout: '', stderr: 'no such ability', code: 1 }
        : { stdout: '', stderr: '', code: 0 },
    });
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/aa start/);
    expect(result.steps[0]).not.toHaveProperty('sceneDir');
    expect(device.calls.some((c) => c.startsWith('collect:'))).toBe(false);
  });

  it('stops at the first failure unless keepGoing', async () => {
    const failing = (): RunnerDevice => {
      const device = fakeDevice();
      device.gesture = async () => { throw new Error('boom'); };
      return device;
    };
    const strict = await new ScenarioRunner(failing(), { outDir: outDir(), rounds: 1 })
      .run(TWO_STEPS);
    expect(strict.steps.map((s) => s.id)).toEqual(['open']);

    const loose = await new ScenarioRunner(failing(), {
      outDir: outDir(), rounds: 1, keepGoing: true,
    }).run(TWO_STEPS);
    expect(loose.steps.map((s) => s.id)).toEqual(['open', 'scroll']);
    expect(loose.steps.every((s) => s.status === 'failed')).toBe(true);
    expect(loose.status).toBe('failed');
  });

  it('reports no sceneDir when the capture itself failed', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.collect = async () => ({
      async ingest() { throw new Error('trace capture failed'); },
    });
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/trace capture failed/);
    expect(result.steps[0]).not.toHaveProperty('sceneDir');
  });

  it('closes the scene handle after a successful step', async () => {
    const out = outDir();
    let closed = 0;
    const device = fakeDevice({
      collect: async () => ({ close() { closed += 1; } }),
    });
    await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(closed).toBe(2);
  });

  it('resolves pids once and omits an app version the device will not give', async () => {
    const out = outDir();
    const device = fakeDevice({
      shell: (cmd) => cmd.startsWith('bm dump ')
        ? { stdout: 'error: bundle not found', stderr: '', code: 1 }
        : { stdout: '', stderr: '', code: 0 },
    });
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(result.appVersion).toBeUndefined();
    expect(result.pids).toEqual({ pids: [4999, 5012], processNames: ['com.example.app'] });
    // Once per run, not once per step.
    expect(device.calls.filter((c) => c.startsWith('pidof '))).toHaveLength(1);
    expect(device.calls.filter((c) => c.startsWith('bm dump '))).toHaveLength(1);
  });

  it('reports an empty pid list for an app that is not running', async () => {
    const out = outDir();
    const device = fakeDevice({
      shell: (cmd) => cmd.startsWith('pidof ')
        ? { stdout: '', stderr: '', code: 1 }
        : { stdout: '', stderr: '', code: 0 },
    });
    const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    expect(result.pids).toEqual({ pids: [], processNames: ['com.example.app'] });
  });

  it('runs only the requested steps, in scenario order', async () => {
    const out = outDir();
    const result = await new ScenarioRunner(fakeDevice(), {
      outDir: out, rounds: 1, only: ['scroll', 'open'],
    }).run(TWO_STEPS);
    expect(result.steps.map((s) => s.id)).toEqual(['open', 'scroll']);
  });

  it('rejects an --only id that matches no step', async () => {
    await expect(new ScenarioRunner(fakeDevice(), {
      outDir: outDir(), rounds: 1, only: ['nope'],
    }).run(TWO_STEPS)).rejects.toThrow(/nope.*open, scroll|open, scroll.*nope/);
  });

  it('honours a rounds override', async () => {
    const result = await new ScenarioRunner(fakeDevice(), { outDir: outDir(), rounds: 3 })
      .run(TWO_STEPS);
    expect(result.steps).toHaveLength(6);
    expect(result.rounds).toBe(3);
  });

  it('writes testInfo.json, steps.json and pids.json', async () => {
    const out = outDir();
    const result = await new ScenarioRunner(fakeDevice(), { outDir: out, rounds: 1 })
      .run(TWO_STEPS);
    const testInfo = JSON.parse(readFileSync(join(out, 'testInfo.json'), 'utf8'));
    expect(testInfo).toMatchObject({
      version: 1, scenario: 'two', rounds: 1, steps: 2, status: 'completed',
      app: { packageName: 'com.example.app', version: '1.0.0' },
      device: { id: '127.0.0.1:5555', kind: 'emulator' },
    });
    const steps = JSON.parse(readFileSync(join(out, 'steps.json'), 'utf8'));
    expect(steps.version).toBe(1);
    expect(steps.steps).toHaveLength(2);
    expect(steps.steps[0]).toMatchObject({ round: 1, index: 0, id: 'open', status: 'ok' });
    expect(JSON.parse(readFileSync(join(out, 'pids.json'), 'utf8')))
      .toEqual({ pids: [4999, 5012], processNames: ['com.example.app'] });
    expect(result.steps).toHaveLength(2);
  });

  it('writes the run files on the failure path too', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.gesture = async () => { throw new Error('boom'); };
    await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
    const steps = JSON.parse(readFileSync(join(out, 'steps.json'), 'utf8'));
    expect(steps.steps).toHaveLength(1);
    expect(steps.steps[0].status).toBe('failed');
    const testInfo = JSON.parse(readFileSync(join(out, 'testInfo.json'), 'utf8'));
    expect(testInfo.status).toBe('failed');
  });

  it('is structurally deterministic across runs', async () => {
    // Three host-clock fields legitimately vary: the run's own start and
    // duration, and each action's `atMs`. Everything else — ids, order,
    // paths, statuses, the device-uptime `atNs` — is identical.
    const strip = (result: RunResult): unknown => ({
      ...result,
      startedAtMs: 0,
      durationMs: 0,
      steps: result.steps.map((step) => ({
        ...step,
        startedAtMs: 0,
        durationMs: 0,
        actions: step.actions.map((action) => ({ ...action, atMs: 0 })),
      })),
    });
    // Same run directory: `sceneDir` is an absolute path, so two different
    // temp roots would differ for a reason that has nothing to do with the
    // scenario.
    const out = outDir();
    const a = await new ScenarioRunner(fakeDevice(), { outDir: out, rounds: 1 })
      .run(TWO_STEPS);
    const b = await new ScenarioRunner(fakeDevice(), { outDir: out, rounds: 1 })
      .run(TWO_STEPS);
    expect(strip(a)).toEqual(strip(b));
  });
});

describe('writeRunFiles', () => {
  it('writes three pretty-printed files with a trailing newline', async () => {
    const out = outDir();
    const result = await new ScenarioRunner(fakeDevice(), { outDir: out, rounds: 1 })
      .run(TWO_STEPS);
    writeRunFiles(out, result);
    for (const name of ['testInfo.json', 'steps.json', 'pids.json']) {
      const text = readFileSync(join(out, name), 'utf8');
      expect(text.endsWith('\n'), name).toBe(true);
      expect(text, name).toContain('\n  ');
    }
  });
});

/*
 * P17: assertions.
 *
 * A step's `expect` block is the difference between "the device accepted my
 * tap" and "the screen showed what I expected". The tests below are about the
 * verdict and its explanation, not about which helper computed it.
 */

/** A flattened UI node; `boundsRect` follows `bounds` the way a real dump's does. */
function uiNode(over: Partial<UiNode> = {}): UiNode {
  const bounds = over.bounds ?? '[0,0][100,100]';
  return {
    depth: 0,
    type: 'Button',
    bundleName: 'com.example.app',
    abilityName: 'EntryAbility',
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

/** A one-step scenario carrying `expect` on its only step. */
function scenarioWithExpect(expect: unknown): Scenario {
  return parseScenario(JSON.stringify({
    version: 1,
    name: 'asserted',
    app: 'com.example.app',
    rounds: 1,
    steps: [{
      id: 'check',
      actions: [{ kind: 'click', x: 1, y: 2 }],
      cleanup: [{ kind: 'forceStop' }],
      expect,
      capture: { durationMs: 1000, collectors: ['hitrace'] },
    }],
  }));
}

describe('ScenarioRunner — expectations', () => {
  it('fails a step whose assertion does not hold, and still names its scene', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ id: 'other' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'Done' } }] }),
    );
    const step = result.steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.sceneDir).toBeDefined();
    expect(step.error).toContain('Done');
    expect(step.expectations?.[0]).toMatchObject({ ok: false, actual: 0 });
  });

  it('passes a step whose assertions hold', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ text: 'Done' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({
        present: [{ selector: { kind: 'text', text: 'Done' } }],
        absent: [{ kind: 'id', id: 'spinner' }],
      }),
    );
    expect(result.steps[0]!.status).toBe('ok');
    expect(result.steps[0]!.expectations?.every((e) => e.ok)).toBe(true);
  });

  it('enforces min and max on present', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ text: 'row' }), uiNode({ text: 'row' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({
        present: [{ selector: { kind: 'text', text: 'row' }, min: 1, max: 1 }],
      }),
    );
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toContain('2');
  });

  it('fails a step whose app is no longer in the foreground', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ bundleName: 'com.ohos.sceneboard' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ foreground: true }),
    );
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toContain('com.example.app');
    expect(result.steps[0]!.expectations?.[0]).toMatchObject({ label: 'foreground', ok: false });
  });

  it('accepts a backgrounded app when foreground is false', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ bundleName: 'com.ohos.sceneboard' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ foreground: false }),
    );
    expect(result.steps[0]!.status).toBe('ok');
  });

  it('checks the screen after the actions, not before them', async () => {
    const out = outDir();
    const order: string[] = [];
    const device = fakeDevice();
    device.uiTree = async () => { order.push('dump'); return [uiNode({ text: 'Done' })]; };
    const gesture = device.gesture.bind(device);
    device.gesture = async (g) => { order.push(`gesture:${g.action}`); return gesture(g); };
    const shell = device.shell.bind(device);
    device.shell = async (cmd) => {
      if (cmd.startsWith('aa force-stop')) order.push('cleanup');
      return shell(cmd);
    };
    await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'Done' } }] }),
    );
    expect(order).toEqual(['gesture:click', 'dump', 'cleanup']);
  });

  it('keeps the first failure when an action and an assertion both fail', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ id: 'nothing' })];
    device.gesture = async () => { throw new Error('uitest refused'); };
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'Done' } }] }),
    );
    expect(result.steps[0]!.error).toMatch(/uitest refused/);
    expect(result.steps[0]!.expectations?.[0]).toMatchObject({ ok: false });
  });

  it('records the outcomes in steps.json', async () => {
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ text: 'Done' })];
    await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'Done' } }] }),
    );
    const steps = JSON.parse(readFileSync(join(out, 'steps.json'), 'utf8'));
    // `present` plus the `foreground` clause that defaults on with `expect`.
    expect(steps.steps[0].expectations).toHaveLength(2);
    expect(steps.steps[0].expectations[0]).toMatchObject({ ok: true, actual: 1 });
    expect(steps.steps[0].expectations[1]).toMatchObject({ label: 'foreground', ok: true });
  });

  it('refuses an assertion on a device that cannot dump the screen', async () => {
    const out = outDir();
    const result = await new ScenarioRunner(fakeDevice(), { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'Done' } }] }),
    );
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toMatch(/screen|dump/i);
  });
});

describe('ScenarioRunner — expectations, defaults and cost', () => {
  it('checks foreground by default when an expect block is present', async () => {
    // The spec's default is true: a step that asserts its screen also asserts
    // it is still the app's screen. Silence must not mean "skip the check",
    // or a scenario that wandered into the launcher reports ok.
    const out = outDir();
    const device = fakeDevice();
    device.uiTree = async () => [uiNode({ bundleName: 'com.ohos.sceneboard' })];
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      scenarioWithExpect({ present: [{ selector: { kind: 'text', text: 'x' } }] }),
    );
    const labels = result.steps[0]!.expectations?.map((e) => e.label);
    expect(labels).toContain('foreground');
    expect(result.steps[0]!.status).toBe('failed');
  });

  it('reads the screen once when a tap misses without a timeout', async () => {
    const out = outDir();
    let dumps = 0;
    const device = fakeDevice();
    device.uiTree = async () => { dumps += 1; return [uiNode({ id: 'other' })]; };
    const result = await new ScenarioRunner(device, { outDir: out }).run(
      parseScenario(JSON.stringify({
        version: 1,
        name: 'miss',
        app: 'com.example.app',
        rounds: 1,
        steps: [{
          id: 'open',
          actions: [{ kind: 'tap', target: { kind: 'id', id: 'nope' } }],
          capture: { durationMs: 1000, collectors: ['hitrace'] },
        }],
      })),
    );
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toMatch(/no node matched/);
    // One dump answers "is it there": a second would cost a full
    // dumpLayout + recv (seconds on a real device) to learn nothing new.
    expect(dumps).toBe(1);
  });
});
