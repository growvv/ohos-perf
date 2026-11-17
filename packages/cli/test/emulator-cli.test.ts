import { describe, it, expect } from 'vitest';
import type { CliDeps } from '../src/commands';
import { buildProgram } from '../src/program';

const instances = [
  { name: 'ProbePhone', running: true, target: '127.0.0.1:5555', apiVersion: '24', osVersion: 'HarmonyOS 6.1.1(24)', instancePath: '/i/ProbePhone' },
  { name: 'SpecProbe', running: false, instancePath: '/i/SpecProbe', apiVersion: '24', osVersion: 'HarmonyOS 6.1.1(24)' },
];

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' }, collectors: [] }),
    gesture: async () => ({ gesture: { action: 'key' as const, key: 'Home' }, output: 'No Error' }),
    query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false }),
    tools: () => [],
    compare: async () => { throw new Error('compare not stubbed'); },
    uiCompare: async () => { throw new Error('ui-compare not stubbed'); },
    report: async () => { throw new Error('report not stubbed'); },
    hap: async () => { throw new Error('hap not stubbed'); },
    emulator: {
      list: async () => instances,
      start: async (name: string) => ({ name, target: '127.0.0.1:5555', alreadyRunning: false, waitedMs: 61_840 }),
      stop: async (name: string) => ({ name, wasRunning: true }),
      create: async (req) => ({ name: req.name, running: false, instancePath: `/i/${req.name}` }),
    },
    run: async () => { throw new Error('run not stubbed'); },
    ...overrides,
  };
}

async function parse(argv: string[], overrides: Partial<CliDeps> = {}) {
  const emitted: { stdout: string; stderr: string; exitCode: number }[] = [];
  const program = buildProgram(deps(overrides), {
    writeOut: () => {},
    writeErr: () => {},
    emit: (r) => emitted.push(r),
  }, { exitOverride: true });
  await program.parseAsync(['node', 'ohos-perf', ...argv]);
  return emitted;
}

describe('emulator list', () => {
  it('renders a table with the target and a dash for a missing one', async () => {
    const [r] = await parse(['emulator', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('NAME');
    expect(r.stdout).toContain('ProbePhone  yes      127.0.0.1:5555');
    expect(r.stdout).toContain('SpecProbe   no       —');
  });

  it('prints instances as JSON under an `instances` key', async () => {
    const [r] = await parse(['emulator', 'list', '--json']);
    expect(JSON.parse(r.stdout)).toEqual({ instances });
  });

  it('says so when there are no instances', async () => {
    const [r] = await parse(['emulator', 'list'], {
      emulator: { ...deps().emulator, list: async () => [] },
    });
    expect(r.stdout).toBe('no emulator instances\n');
  });
});

describe('emulator start', () => {
  it('reports the target and the boot time in seconds', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone']);
    expect(r.stdout).toBe('ProbePhone started on 127.0.0.1:5555 (booted in 62s)\n');
  });

  it('passes --timeout through as milliseconds', async () => {
    let seen: number | undefined;
    const [r] = await parse(['emulator', 'start', 'ProbePhone', '--timeout', '30'], {
      emulator: {
        ...deps().emulator,
        start: async (name, opts) => { seen = opts.timeoutMs; return { name, target: 't', alreadyRunning: false, waitedMs: 0 }; },
      },
    });
    expect(seen).toBe(30_000);
    expect(r.exitCode).toBe(0);
  });

  it('rejects a non-positive timeout instead of polling with a zero budget', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone', '--timeout', '0']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--timeout must be greater than 0/);
  });

  it('keeps the parser\'s reason for a positive timeout it cannot honour', async () => {
    // `--timeout 9999999` is > 0; the real problem is the 32-bit limit.
    // Reporting "must be greater than 0" sends the caller the wrong way.
    const [r] = await parse(['emulator', 'start', 'ProbePhone', '--timeout', '9999999']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('9999999');
    expect(r.stderr).toMatch(/32-bit/);
    expect(r.stderr).not.toMatch(/greater than 0/);
  });

  it('rejects a fractional --memory instead of truncating it', async () => {
    // `--memory 6.5` silently became 6 GB, and `--memory 6abc` also became 6:
    // the instance is created with a size the caller never asked for.
    let created = false;
    const [r] = await parse(
      ['emulator', 'create', 'X', '--device-type', 'phone', '--os-version', 'V', '--memory', '6.5'],
      { emulator: { ...deps().emulator, create: async () => { created = true; throw new Error('unreachable'); } } },
    );
    expect(created).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--memory/);
  });

  it('says "was already running" without a boot time', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone'], {
      emulator: {
        ...deps().emulator,
        start: async (name) => ({ name, target: '127.0.0.1:5555', alreadyRunning: true, waitedMs: 120 }),
      },
    });
    expect(r.stdout).toBe('ProbePhone was already running on 127.0.0.1:5555\n');
  });

  it('exits 1 with the message on stderr when the wait times out', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone'], {
      emulator: { ...deps().emulator, start: async () => { throw new Error('no new TCP target appeared after 100ms'); } },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('no new TCP target appeared after 100ms\n');
  });
});

describe('emulator stop', () => {
  it('reports a real stop', async () => {
    const [r] = await parse(['emulator', 'stop', 'ProbePhone']);
    expect(r.stdout).toBe('ProbePhone stopped\n');
  });

  it('reports a no-op honestly', async () => {
    const [r] = await parse(['emulator', 'stop', 'ProbePhone'], {
      emulator: { ...deps().emulator, stop: async (name) => ({ name, wasRunning: false }) },
    });
    expect(r.stdout).toBe('ProbePhone was not running\n');
  });
});

describe('emulator create', () => {
  it('requires --device-type and --os-version', async () => {
    const [r] = await parse(['emulator', 'create', 'X']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--device-type and --os-version are required/);
  });

  it('reports the created instance and its path', async () => {
    const [r] = await parse([
      'emulator', 'create', 'SpecProbe', '--device-type', 'phone', '--os-version', 'HarmonyOS 6.1.1(24)',
    ]);
    expect(r.stdout).toBe('Created SpecProbe (phone, HarmonyOS 6.1.1(24)) at /i/SpecProbe\n');
  });

  it('forwards --memory and --storage as numbers', async () => {
    let seen: { memoryGb?: number; storageGb?: number } = {};
    await parse([
      'emulator', 'create', 'X', '--device-type', 'phone', '--os-version', 'V',
      '--memory', '6', '--storage', '8',
    ], {
      emulator: { ...deps().emulator, create: async (req) => { seen = req; return { name: req.name, running: false, instancePath: '/i/X' }; } },
    });
    expect(seen).toMatchObject({ memoryGb: 6, storageGb: 8 });
  });

  it('passes --instance-path and --emulator to the deps', async () => {
    let seen: { instancePath?: string; emulatorPath?: string } = {};
    await parse([
      'emulator', 'list', '--instance-path', 'C:/Users/me/DevEco Studio/instances', '--emulator', 'C:/x/Emulator.exe',
    ], {
      emulator: { ...deps().emulator, list: async (opts) => { seen = opts; return []; } },
    });
    expect(seen).toEqual({
      instancePath: 'C:/Users/me/DevEco Studio/instances',
      emulatorPath: 'C:/x/Emulator.exe',
    });
  });
});
