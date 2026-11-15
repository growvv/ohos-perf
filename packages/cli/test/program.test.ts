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
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' } }),
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
  it('lists the three subcommands', async () => {
    const { out } = await parse(['--help']);
    const text = out.join('');
    expect(text).toContain('doctor');
    expect(text).toContain('caps');
    expect(text).toContain('analyze');
  });
});

describe('command wiring', () => {
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
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' } };
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
    });
  });

  it('collect forwards --hiprofiler and --plugins as plugin names', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--hiprofiler', '--plugins', 'gpu,xpower'],
      {
        collect: async (req) => {
          seen.push(req);
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' } };
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
          return { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' } };
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
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' } };
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
          return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' } };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr).toContain('--hiprofiler');
  });

  it('collect rejects an invalid --duration before calling deps.collect', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', 'abc', '--out', 'scene1'],
      { collect: async () => { called = true; return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' } }; } },
    );
    expect(called).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr).toContain('abc');
  });
});
