import { describe, it, expect } from 'vitest';
import { EmulatorLifecycle, type EmulatorInstance } from '../src/device/emulator';
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
