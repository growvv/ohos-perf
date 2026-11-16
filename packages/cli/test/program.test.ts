import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import type { CliDeps, CliResult } from '../src/commands';
import { buildProgram } from '../src/program';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: manifest.version,
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
    report: async () => { throw new Error('report not stubbed'); },
    emulator: {
      list: async () => [],
      start: async () => { throw new Error('emulator not stubbed'); },
      stop: async () => { throw new Error('emulator not stubbed'); },
      create: async () => { throw new Error('emulator not stubbed'); },
    },
    ...overrides,
  };
}

/** Builds a program whose output and results are captured instead of printed. */
function harness(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const emitted: CliResult[] = [];
  const program = buildProgram(
    deps(overrides),
    {
      writeOut: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      emit: (result) => emitted.push(result),
    },
    { exitOverride: true },
  );
  return { program, out, err, emitted };
}

async function parse(argv: string[], overrides: Partial<CliDeps> = {}) {
  const h = harness(overrides);
  let error: CommanderError | undefined;
  try {
    await h.program.parseAsync(['node', 'ohos-perf', ...argv]);
  } catch (caught) {
    error = caught as CommanderError;
  }
  return { ...h, error };
}

describe('--version', () => {
  it('prints the package.json version, so the two cannot drift', async () => {
    const { out, error } = await parse(['--version']);
    expect(out.join('')).toBe(`${manifest.version}\n`);
    expect(error?.exitCode).toBe(0);
  });

  it('follows the injected version rather than a hard-coded constant', async () => {
    const { out } = await parse(['--version'], { version: '9.9.9' });
    expect(out.join('')).toBe('9.9.9\n');
  });
});

describe('--help', () => {
  it('lists every subcommand', async () => {
    const { out } = await parse(['--help']);
    const text = out.join('');
    for (const name of [
      'doctor', 'caps', 'collect', 'analyze', 'query', 'tools', 'compare', 'report',
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe('command wiring', () => {
  it('compare forwards both arguments and --json to runCompare', async () => {
    const comparison = { rows: [], totals: {
      improved: 0, regressed: 0, unchanged: 0, added: 0, removed: 0, incomparable: 0,
    } };
    const calls: Array<{ baseline: string; current: string }> = [];
    const { emitted } = await parse(['compare', 'base', 'cur', '--json'], {
      compare: async (req) => { calls.push(req); return comparison; },
    });
    expect(calls).toEqual([{ baseline: 'base', current: 'cur' }]);
    expect(JSON.parse(emitted[0].stdout)).toEqual(comparison);
  });

  it('compare maps a failure to exit 1 with empty stdout', async () => {
    const { emitted } = await parse(['compare', 'base', 'cur'], {
      compare: async () => { throw new Error('cannot read base'); },
    });
    expect(emitted[0]).toEqual({ stdout: '', stderr: 'cannot read base\n', exitCode: 1 });
  });

  it('doctor forwards --json to runDoctor', async () => {
    const { emitted } = await parse(['doctor', '--json']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(0);
    expect(JSON.parse(emitted[0].stdout).hdc.ok).toBe(true);
  });

  it('caps forwards --json to runCaps', async () => {
    const { emitted } = await parse(['caps', '--json'], {
      capsReport: async () => ({ hdcOk: false, hdcError: 'no hdc', capabilities: [] }),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ stdout: '', stderr: 'hdc unavailable: no hdc\n', exitCode: 1 });
  });

  it('analyze forwards the scene directory and --app', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const { emitted } = await parse(['analyze', 'scene1', '--app', 'com.demo'], {
      analyze: async (dir, app) => { seen.push([dir, app]); return { metrics: [], evidence: [] }; },
    });
    expect(seen).toEqual([['scene1', 'com.demo']]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect maps every flag to one CollectRequest', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10s', '--out', 'scene1',
        '--procfs', '--cold-start', 'EntryAbility', '--json'],
      {
        collect: async (req) => {
          seen.push(req);
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      out: 'scene1',
      procfs: true,
      coldStart: 'EntryAbility',
    }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(0);
    expect(JSON.parse(emitted[0].stdout)).toEqual({
      sceneDir: '/abs/scene1',
      device: { id: 't1', kind: 'emulator' },
      collectors: [],
    });
  });

  it('collect forwards --target to the capture request', async () => {
    // The emulator workflow's whole handoff is this flag: `emulator list`
    // prints a target id, and `collect --target <id>` must use exactly it
    // rather than the first connected device.
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--target', '127.0.0.1:5555'],
      {
        collect: async (req) => {
          seen.push(req);
          return { sceneDir: '/scene1', device: { id: '127.0.0.1:5555', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      out: 'scene1',
      target: '127.0.0.1:5555',
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('caps and doctor forward --target so the emulator can be probed by id', async () => {
    const capsTargets: (string | undefined)[] = [];
    const doctorTargets: (string | undefined)[] = [];
    await parse(['caps', '--target', '127.0.0.1:5555'], {
      capsReport: async (target) => {
        capsTargets.push(target);
        return { hdcOk: true, capabilities: [] };
      },
    });
    // `doctor` probes through its own deps object, so the target has to reach
    // `connectDevice` there too — otherwise `doctor --target X` reports on a
    // different device than the one the caller named.
    await parse(['doctor', '--target', '127.0.0.1:5555'], {
      doctor: {
        resolveHdc: async () => '/hdc',
        resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
        connectDevice: async (target) => {
          doctorTargets.push(target);
          return {
            id: '127.0.0.1:5555', kind: 'emulator', abi: 'x86_64',
            capabilities: async () => ({ all: () => [] }),
          };
        },
      },
    });
    expect(capsTargets).toEqual(['127.0.0.1:5555']);
    expect(doctorTargets).toEqual(['127.0.0.1:5555']);
  });

  it('collect forwards --hiprofiler and --plugins as plugin names', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--hiprofiler', '--plugins', 'gpu,xpower'],
      {
        collect: async (req) => {
          seen.push(req);
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      out: 'scene1',
      hiprofiler: { plugins: ['gpu', 'xpower'] },
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect requests hiprofiler with its default plugin list when --plugins is absent', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1', '--hiprofiler'],
      {
        collect: async (req) => {
          seen.push(req);
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      out: 'scene1',
      hiprofiler: {},
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect rejects an unknown plugin with one stderr line and empty stdout', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--hiprofiler', '--plugins', 'gpu,nope'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr.trim().split('\n')).toHaveLength(1);
    expect(emitted[0].stderr).toContain('nope');
  });

  it('collect rejects --plugins without --hiprofiler', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--plugins', 'gpu'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr).toContain('--hiprofiler');
  });

  it('collect forwards --hiperf, --hidumper and --uitest to one CollectRequest', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--hiperf', '--hidumper', '--uitest'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1',
            device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'hiperf', 'hidumper', 'uitest'],
          };
        },
      },
    );
    expect(seen).toEqual([{
      app: 'com.demo',
      durationMs: 10_000,
      out: 'scene1',
      hiperf: {},
      hidumper: true,
      uitest: true,
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect forwards an app-less hidumper and uitest request', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--hidumper', '--uitest'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'hidumper', 'uitest'],
          };
        },
      },
    );
    expect(seen).toEqual([{ durationMs: 10_000, out: 'scene1', hidumper: true, uitest: true }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect forwards an app-less hilog request', async () => {
    // hilog is device-wide like hidumper and uitest: no --app is required.
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--hilog'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'hilog'],
          };
        },
      },
    );
    expect(seen).toEqual([{ durationMs: 10_000, out: 'scene1', hilog: true }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect rejects --hiperf without --app before any device work', async () => {
    // `--app` is optional now, so the action owns this gate: a request that
    // cannot be served must fail before deps.collect connects to a device.
    let called = false;
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--hiperf'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted).toEqual([
      { stdout: '', stderr: expect.stringContaining('--app'), exitCode: 1 },
    ]);
  });

  it('collect rejects --procfs and --cold-start without --app before any device work', async () => {
    for (const mode of [['--procfs'], ['--cold-start', 'EntryAbility']]) {
      let called = false;
      const { emitted } = await parse(
        ['collect', '--duration', '10', '--out', 'scene1', ...mode],
        {
          collect: async () => {
            called = true;
            return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
          },
        },
      );
      expect(called, mode.join(' ')).toBe(false);
      expect(emitted[0].exitCode, mode.join(' ')).toBe(1);
      expect(emitted[0].stderr, mode.join(' ')).toContain('--app');
    }
  });

  it('collect rejects --hiprofiler --plugins nativehook without --app', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1',
        '--hiprofiler', '--plugins', 'nativehook'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toContain('--app');
  });

  it('collect rejects an invalid --duration before calling deps.collect', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', 'abc', '--out', 'scene1'],
      { collect: async () => { called = true; return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] }; } },
    );
    expect(called).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr).toContain('abc');
  });

  it('query maps flags to one QueryRequest', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['query', 'scene1', 'frames.get', '--app', 'com.demo',
        '--args', '{"id":2}', '--limit', '5', '--json'],
      {
        query: async (req) => {
          seen.push(req);
          return { query: 'frames.get', rows: [], total: 0, truncated: false };
        },
      },
    );
    expect(seen).toEqual([{
      sceneDir: 'scene1', name: 'frames.get', app: 'com.demo', args: { id: 2 }, limit: 5,
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('query rejects a malformed --args before calling the query layer', async () => {
    let called = false;
    const { emitted } = await parse(['query', 'scene1', 'frames.get', '--args', 'nope'], {
      query: async () => { called = true; throw new Error('should not run'); },
    });
    expect(called).toBe(false);
    expect(emitted).toEqual([{
      stdout: '', stderr: 'invalid --args: not valid JSON\n', exitCode: 1,
    }]);
  });

  it('query rejects an out-of-range --limit with one stderr line', async () => {
    let called = false;
    const { emitted } = await parse(['query', 'scene1', 'frames.get', '--limit', '0'], {
      query: async () => { called = true; throw new Error('should not run'); },
    });
    expect(called).toBe(false);
    expect(emitted).toEqual([{
      stdout: '',
      stderr: 'limit must be an integer between 1 and 1000, got "0"\n',
      exitCode: 1,
    }]);
  });

  it('tools forwards --json to the definitions', async () => {
    const info = [{
      name: 'frames.get',
      description: 'One frame by id.',
      args: [{ name: 'id', type: 'number' as const, required: true, description: 'frame row id' }],
      returns: 'Frame',
    }];
    const { emitted } = await parse(['tools', '--json'], { tools: () => info });
    expect(JSON.parse(emitted[0].stdout)).toEqual(info);
  });
});
