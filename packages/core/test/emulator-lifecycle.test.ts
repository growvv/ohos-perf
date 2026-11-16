import { describe, it, expect } from 'vitest';
import {
  EmulatorImageMissingError, EmulatorLifecycle, type EmulatorInstance,
} from '../src/device/emulator';
import type { HdcTarget } from '../src/transport/hdc';

const instance = (name: string, running: boolean): EmulatorInstance =>
  ({ name, running, instancePath: `/instances/${name}` });

const target = (id: string, transport: string, connected: boolean): HdcTarget =>
  ({ id, connected, raw: `${id}\t\t${transport}\t${connected ? 'Connected' : 'Offline'}\tlocalhost\thdc` });

function fakeClient(instances: EmulatorInstance[]) {
  return {
    listDetailed: async () => instances,
    imageList: async () => [],
    startInstance: async () => {},
    stopInstance: async () => {},
    createInstance: async () => {},
  };
}

describe('EmulatorLifecycle.list target attribution', () => {
  it('does not consult hdc when nothing is running', async () => {
    let asked = false;
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', false)]),
      hdc: { listTargets: async () => { asked = true; return []; }, shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
    });
    const [a] = await lifecycle.list();
    expect(a.target).toBeUndefined();
    expect(a.targetReason).toBeUndefined();
    expect(asked).toBe(false);
  });

  it('attributes the single TCP target when exactly one instance runs', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true), instance('B', false)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true), target('REDACTED-DEVICE-SERIAL', 'USB', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const instances = await lifecycle.list();
    expect(instances.find((i) => i.name === 'A')?.target).toBe('127.0.0.1:5555');
    expect(instances.find((i) => i.name === 'B')?.target).toBeUndefined();
  });

  it('refuses to attribute when two emulators run', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true), instance('B', true)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.target).toBeUndefined();
    expect(a.targetReason).toContain('2 emulators are running');
  });

  it('explains a missing TCP target', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true)]),
      hdc: {
        listTargets: async () => [target('REDACTED-DEVICE-SERIAL', 'USB', true), target('127.0.0.1:5555', 'TCP', false)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.targetReason).toContain('no connected TCP target');
  });

  it('refuses to attribute when two TCP targets are connected', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true), target('127.0.0.1:5557', 'TCP', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.targetReason).toContain('2 connected TCP targets');
  });
});

describe('EmulatorLifecycle.start', () => {
  /** A client whose isRunning flips after the first listDetailed call. */
  function startingClient(before: EmulatorInstance[], after: EmulatorInstance[]) {
    let calls = 0;
    const started: string[] = [];
    return {
      started,
      client: {
        listDetailed: async () => (calls++ === 0 ? before : after),
        imageList: async () => [],
        startInstance: async (name: string) => { started.push(name); },
        stopInstance: async () => {},
        createInstance: async () => {},
      },
    };
  }

  /** A real emulator's target appears only after it was started. */
  function targetsAfterStart(started: string[], ids: string[]): () => Promise<HdcTarget[]> {
    return async () => (started.length === 0 ? [] : ids.map((id) => target(id, 'TCP', true)));
  }

  it('waits through instance, target and boot, then reports the target', async () => {
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: targetsAfterStart(started, ['127.0.0.1:5555']),
        shell: async () => ({ stdout: 'true\r\n', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    const result = await lifecycle.start('A');
    expect(started).toEqual(['A']);
    expect(result).toEqual({
      name: 'A', target: '127.0.0.1:5555', alreadyRunning: false, waitedMs: expect.any(Number),
    });
  });

  it('accepts a target that existed but was disconnected before the start', async () => {
    // Measured: the emulator always comes back on 127.0.0.1:5555, and after a
    // stop that id lingers in `hdc list targets` as `Offline`/disconnected.
    // Snapshotting every id — rather than every CONNECTED id — made the
    // reconnected 5555 look "old", so start could never succeed.
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => (started.length === 0
          ? [target('127.0.0.1:5555', 'TCP', false)]
          : [target('127.0.0.1:5555', 'TCP', true)]),
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    await expect(lifecycle.start('A')).resolves.toMatchObject({ target: '127.0.0.1:5555' });
  });

  it('is idempotent: a second start never spawns another emulator', async () => {
    const { client, started } = startingClient([instance('A', true)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    const result = await lifecycle.start('A');
    expect(started).toEqual([]);
    expect(result.alreadyRunning).toBe(true);
    expect(result.target).toBe('127.0.0.1:5555');
  });

  it('names the instance phase when isRunning never flips', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', false)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => (clock += 10),
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/did not report isRunning after 100ms/);
  });

  it('names the target phase when no new TCP target appears', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', true)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => (clock += 10),
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/no new TCP target appeared after 100ms/);
  });

  it('names the boot phase when bootevent.boot.completed stays false', async () => {
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: targetsAfterStart(started, ['127.0.0.1:5555']),
        shell: async () => ({ stdout: 'false', stderr: '', code: 0 }),
      },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => (clock += 10),
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/bootevent\.boot\.completed never became true/);
  });

  it('every timeout tells the caller how to clean up', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', false)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => (clock += 10),
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/ohos-perf emulator stop A/);
  });

  it('rejects two new TCP targets instead of picking one', async () => {
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: targetsAfterStart(started, ['127.0.0.1:5555', '127.0.0.1:5557']),
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/127\.0\.0\.1:5555.*127\.0\.0\.1:5557/);
  });

  it('reports the wall-clock wait', async () => {
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    let calls = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: targetsAfterStart(started, ['127.0.0.1:5555']),
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
      now: () => (calls++ === 0 ? 1_000 : 61_000),
    });
    const result = await lifecycle.start('A');
    expect(result.waitedMs).toBe(60_000);
  });

  it('fails when the named instance does not exist', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('B', false)]),
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/no emulator instance named "A".*B/);
  });
});

describe('EmulatorLifecycle.stop', () => {
  it('does nothing when the instance is not running', async () => {
    let stopped = false;
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([instance('A', false)]), stopInstance: async () => { stopped = true; } },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.stop('A')).resolves.toEqual({ name: 'A', wasRunning: false });
    expect(stopped).toBe(false);
  });

  it('polls until isRunning goes false, because -stop returns early', async () => {
    let calls = 0;
    const lifecycle = new EmulatorLifecycle({
      client: {
        listDetailed: async () => [instance('A', calls++ === 0)],
        imageList: async () => [],
        startInstance: async () => {},
        stopInstance: async () => {},
        createInstance: async () => {},
      },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.stop('A')).resolves.toEqual({ name: 'A', wasRunning: true });
    expect(calls).toBeGreaterThan(1);
  });

  it('names the measured fire-and-forget behaviour on timeout', async () => {
    // The clock must advance on the poll that stop actually performs:
    // advancing it inside `shell` would never fire, and the loop would spin.
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client: {
        listDetailed: async () => { clock += 10; return [instance('A', true)]; },
        imageList: async () => [],
        startInstance: async () => {},
        stopInstance: async () => {},
        createInstance: async () => {},
      },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      stopTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.stop('A')).rejects.toThrow(/still reports isRunning: true/);
  });

  it('fails when the named instance does not exist', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([]),
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.stop('A')).rejects.toThrow(/no emulator instance named "A"/);
  });
});

describe('EmulatorLifecycle.create', () => {
  const images = [{
    deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)', downloaded: true, softwareVersion: '6.1.0.126',
  }];

  function createClient(existing: EmulatorInstance[] = []) {
    const created: unknown[] = [];
    const after: EmulatorInstance[] = [];
    return {
      created,
      client: {
        listDetailed: async () => [...existing, ...after],
        imageList: async () => images,
        startInstance: async () => {},
        stopInstance: async () => {},
        createInstance: async (req: unknown) => {
          created.push(req);
          after.push(instance((req as { name: string }).name, false));
        },
      },
    };
  }

  it('creates an instance and returns it as list() reports it', async () => {
    const { client, created } = createClient();
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    const result = await lifecycle.create({
      name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)',
    });
    expect(created).toHaveLength(1);
    expect(result).toEqual({ name: 'SpecProbe', running: false, instancePath: '/instances/SpecProbe' });
  });

  it.each(['../x', 'a/b', 'a\b', '', '.hidden'])('rejects the name %j before spawning', async (name) => {
    const { client, created } = createClient();
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({ name, deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)' }))
      .rejects.toThrow(/invalid emulator name/);
    expect(created).toHaveLength(0);
  });

  it('rejects a name that already exists before spawning', async () => {
    const { client, created } = createClient([instance('SpecProbe', false)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({
      name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)',
    })).rejects.toThrow(/already exists/);
    expect(created).toHaveLength(0);
  });

  it('names the exact -install command when the image is missing', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([]), imageList: async () => [] },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    const error = await lifecycle
      .create({ name: 'X', deviceType: 'tablet', osVersion: 'HarmonyOS 6.1.1(24)' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorImageMissingError);
    expect((error as EmulatorImageMissingError).installCommand)
      .toBe('-install -deviceType tablet -osVersion "HarmonyOS 6.1.1(24)"');
  });

  it.each([[1, 4], [6, 1], [4, 2048]])(
    'rejects out-of-range memory/storage %i/%i',
    async (memoryGb, storageGb) => {
      const { client, created } = createClient();
      const lifecycle = new EmulatorLifecycle({
        client,
        hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
        pollMs: 0,
      });
      await expect(lifecycle.create({
        name: 'X', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)', memoryGb, storageGb,
      })).rejects.toThrow(/out of range/);
      expect(created).toHaveLength(0);
    },
  );

  it('fails when the binary accepted the create but no instance appeared', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([]), imageList: async () => images },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({
      name: 'Ghost', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)',
    })).rejects.toThrow(/did not appear/);
  });
});
