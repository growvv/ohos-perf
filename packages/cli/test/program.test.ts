import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { buildRootCauseDocument } from '../../core/src/report/root-cause';
import { OhosPerfError } from '@ohos-perf/core';
import type { CliDeps, CliResult } from '../src/commands';
import { buildProgram } from '../src/program';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  // The banner prints `deps.version`, so this file pins it to the manifest
  // rather than the shared default.
  return cliDeps({ version: manifest.version, ...overrides });
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
      'doctor', 'caps', 'collect', 'analyze', 'query', 'tools', 'compare', 'report', 'render', 'trend',
      'run', 'ui-compare', 'gate', 'explore', 'agent', 'opt', 'symbols', 'root-cause',
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe('command wiring', () => {
  it('agent forwards the app, task and every flag to runAgentCommand', async () => {
    const transcript = {
      version: 1 as const, task: 'open it', app: 'com.demo', steps: [],
      status: 'completed' as const, statesReached: 1,
    };
    const calls: Array<Record<string, unknown>> = [];
    const { emitted } = await parse(
      ['agent', 'com.demo', 'open it', '--max-steps', '7', '--model', 'm',
        '--allow-irreversible', '--target', 'emu-1'],
      {
        agent: async (req) => {
          calls.push(req as unknown as Record<string, unknown>);
          return { transcript, device: { id: 'emu-1', kind: 'emulator' } };
        },
      },
    );
    expect(calls).toEqual([{
      app: 'com.demo', task: 'open it', maxSteps: 7, model: 'm',
      allowIrreversible: true, target: 'emu-1',
    }]);
    expect(emitted[0]!.exitCode).toBe(0);
  });

  it('agent refuses a non-numeric --max-steps before the seam', async () => {
    let called = false;
    const { emitted } = await parse(['agent', 'com.demo', 't', '--max-steps', '0'], {
      agent: async () => { called = true; throw new Error('unreachable'); },
    });
    expect(called).toBe(false);
    expect(emitted[0]!.exitCode).toBe(1);
    expect(emitted[0]!.stderr).toMatch(/max-steps/);
  });

  it('agent requires a task argument', async () => {
    const { error } = await parse(['agent', 'com.demo']);
    expect(error?.code).toBe('commander.missingArgument');
  });

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
    expect(emitted[0]).toMatchObject({ stdout: '', stderr: 'cannot read base\n', exitCode: 1 });
  });

  it('gate forwards the budget, input, --baseline, --out and --json', async () => {
    const calls: unknown[] = [];
    const result = {
      name: 'open-app',
      status: 'pass' as const,
      verdicts: [],
      totals: { pass: 0, fail: 0, missing: 0 },
    };
    const { emitted } = await parse(
      ['gate', 'b.json', 'scene', '--baseline', 'base', '--out', '/out', '--json'],
      { gate: async (req) => { calls.push(req); return { result, outDir: '/out', files: [] }; } },
    );
    expect(calls).toEqual([{ budget: 'b.json', input: 'scene', baseline: 'base', outDir: '/out' }]);
    expect(JSON.parse(emitted[0].stdout)).toEqual(result);
  });

  it('gate omits an absent baseline and output directory rather than passing undefined', async () => {
    const calls: unknown[] = [];
    await parse(['gate', 'b.json', 'scene'], {
      gate: async (req) => {
        calls.push(req);
        return {
          result: { name: 'g', status: 'pass', verdicts: [], totals: { pass: 0, fail: 0, missing: 0 } },
          files: [],
        };
      },
    });
    expect(calls).toEqual([{ budget: 'b.json', input: 'scene' }]);
  });

  it('ui-compare forwards both directories, --out and --json', async () => {
    const calls: Array<{ a: string; b: string; outDir: string }> = [];
    const result = {
      outDir: '/out', files: ['ui-diff.json'], tree: null, image: null,
      regions: 0, animations: 0, pixelOnly: 0, unmeasuredRegions: 0, degraded: [],
    };
    const { emitted } = await parse(['ui-compare', 'a', 'b', '--out', '/out', '--json'], {
      uiCompare: async (req) => { calls.push(req); return result; },
    });
    expect(calls).toEqual([{ a: 'a', b: 'b', outDir: '/out' }]);
    expect(JSON.parse(emitted[0].stdout)).toEqual(result);
  });

  it('ui-compare requires --out before doing any work', async () => {
    const calls: unknown[] = [];
    const { error } = await parse(['ui-compare', 'a', 'b'], {
      uiCompare: async (req) => { calls.push(req); throw new Error('not reached'); },
    });
    // Commander refuses the missing required option before the action runs.
    expect(error).toBeDefined();
    expect(error?.code).toBe('commander.missingMandatoryOptionValue');
    expect(calls).toEqual([]);
  });

  it('render forwards the report path and --out to runRender', async () => {
    const calls: Array<{ report: string; outDir: string }> = [];
    const result = {
      outDir: '/out', files: ['report.html'], sections: 1, metrics: 2, evidence: 0,
    };
    const { emitted } = await parse(['render', '/saved', '--out', '/out', '--json'], {
      render: async (req) => { calls.push(req); return result; },
    });
    expect(calls).toEqual([{ report: '/saved', outDir: '/out' }]);
    expect(JSON.parse(emitted[0].stdout)).toEqual(result);
  });

  it('render requires --out before doing any work', async () => {
    const calls: unknown[] = [];
    const { error } = await parse(['render', '/saved'], {
      render: async (req) => { calls.push(req); throw new Error('not reached'); },
    });
    expect(error?.code).toBe('commander.missingMandatoryOptionValue');
    expect(calls).toEqual([]);
  });

  it('root-cause forwards the input, --out and the offline flag', async () => {
    const calls: unknown[] = [];
    const document = buildRootCauseDocument({
      app: 'com.demo', device: 'd', window: { startNs: 0, endNs: 1 },
      generator: { name: '@ohos-perf/core', version: '1.0.0' },
      evidence: [],
    });
    const result = {
      document, outDir: '/out', files: ['root-cause.json', 'root-cause.md', 'root-cause.evidence.json'],
    };
    const { emitted } = await parse(
      ['root-cause', '/scene', '--out', '/out', '--offline', '--model', 'm', '--json'],
      { rootCause: async (req) => { calls.push(req); return result; } },
    );
    expect(calls).toEqual([{ input: '/scene', outDir: '/out', offline: true, model: 'm' }]);
    // --json prints the document itself, not a manifest: here the document is
    // the output.
    expect(JSON.parse(emitted[0].stdout)).toEqual(document);
  });

  it('root-cause leaves --offline off when it was not given, so a model may be asked', async () => {
    const calls: Array<{ offline?: boolean }> = [];
    await parse(['root-cause', '/scene', '--out', '/out'], {
      rootCause: async (req) => {
        calls.push(req);
        return {
          document: buildRootCauseDocument({
            app: 'a', device: 'd', window: { startNs: 0, endNs: 1 },
            generator: { name: 'g', version: '1' },
            evidence: [],
          }),
          outDir: '/out', files: [],
        };
      },
    });
    expect(calls[0]!.offline).toBeUndefined();
  });

  it('root-cause forwards --baseline, and omits it when it was not given', async () => {
    const calls: Array<{ baseline?: string }> = [];
    await parse(['root-cause', '/scene', '--out', '/out', '--baseline', '/before'], {
      rootCause: async (req) => {
        calls.push(req);
        return {
          document: buildRootCauseDocument({
            app: 'a', device: 'd', window: { startNs: 0, endNs: 1 },
            generator: { name: 'g', version: '1' },
            evidence: [],
          }),
          outDir: '/out', files: [],
        };
      },
    });
    await parse(['root-cause', '/scene', '--out', '/out'], {
      rootCause: async (req) => {
        calls.push(req);
        return {
          document: buildRootCauseDocument({
            app: 'a', device: 'd', window: { startNs: 0, endNs: 1 },
            generator: { name: 'g', version: '1' },
            evidence: [],
          }),
          outDir: '/out', files: [],
        };
      },
    });
    expect(calls[0]).toMatchObject({ baseline: '/before' });
    // A key that is present but undefined is a different request from one the
    // caller never named.
    expect(calls[1]).not.toHaveProperty('baseline');
  });

  it('root-cause requires --out before doing any work', async () => {
    const calls: unknown[] = [];
    const { error } = await parse(['root-cause', '/scene'], {
      rootCause: async (req) => { calls.push(req); throw new Error('not reached'); },
    });
    expect(error?.code).toBe('commander.missingMandatoryOptionValue');
    expect(calls).toEqual([]);
  });

  it('trend forwards every report, the labels in order and --out', async () => {
    const calls: Array<{ reports: Array<{ label?: string; path: string }>; outDir: string }> = [];
    const result = {
      outDir: '/out', files: ['trend.html', 'trend.json'], runs: [],
      orderedBy: 'argument' as const, series: 0, improved: 0, regressed: 0,
      unchanged: 0, verdictless: 0, unmeasured: 0,
    };
    const { emitted } = await parse(
      ['trend', 'r1', 'r2', '--out', '/out', '--label', 'v1', '--label', 'v2', '--json'],
      { trend: async (req) => { calls.push(req); return result; } },
    );
    expect(calls).toEqual([{
      reports: [{ path: 'r1', label: 'v1' }, { path: 'r2', label: 'v2' }],
      outDir: '/out',
    }]);
    expect(JSON.parse(emitted[0].stdout)).toEqual(result);
  });

  it('trend leaves a label off a report that was not named', async () => {
    const calls: Array<{ reports: Array<{ label?: string; path: string }>; outDir: string }> = [];
    await parse(['trend', 'r1', 'r2', '--out', '/out', '--label', 'v1'], {
      trend: async (req) => {
        calls.push(req);
        return {
          outDir: '/out', files: [], runs: [], orderedBy: 'argument' as const, series: 0,
          improved: 0, regressed: 0, unchanged: 0, verdictless: 0, unmeasured: 0,
        };
      },
    });
    // `runTrend` fills the unnamed run's label with its path before the IO
    // layer sees it, so the page never has a point labelled with nothing.
    expect(calls[0].reports).toEqual([{ path: 'r1', label: 'v1' }, { path: 'r2', label: 'r2' }]);  });

  it('trend requires --out before doing any work', async () => {
    const calls: unknown[] = [];
    const { error } = await parse(['trend', 'r1', 'r2'], {
      trend: async (req) => { calls.push(req); throw new Error('not reached'); },
    });
    expect(error).toBeDefined();
    expect(error?.code).toBe('commander.missingMandatoryOptionValue');
    expect(calls).toEqual([]);
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
    // The code leads, like every other typed failure: it is the token a caller
    // branches on, and this path used to print the message alone.
    expect(emitted[0]).toMatchObject({
      stdout: '', stderr: 'DOCTOR_HDC_UNAVAILABLE: hdc unavailable: no hdc\n', exitCode: 1,
    });
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

  it('collect forwards an app-less screenshot request', async () => {
    // A screenshot is device-wide like hidumper, uitest and hilog: the whole
    // screen is captured with no app to resolve.
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--screenshot'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'screenshot'],
          };
        },
      },
    );
    expect(seen).toEqual([{ durationMs: 10_000, out: 'scene1', screenshot: true }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect forwards an app-less thermal request', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--thermal'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'thermal'],
          };
        },
      },
    );
    expect(seen).toEqual([{ durationMs: 10_000, out: 'scene1', thermal: true }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect converts --thermal-interval seconds into milliseconds', async () => {
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--thermal', '--thermal-interval', '1'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'thermal'],
          };
        },
      },
    );
    expect(seen).toEqual([{
      durationMs: 10_000, out: 'scene1', thermal: { intervalMs: 1000 },
    }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect rejects a bad --thermal-interval before any device work', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--thermal', '--thermal-interval', '0'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/thermal interval/);
  });

  it('collect rejects --thermal-interval without --thermal', async () => {
    // The interval only means something to a thermal capture; accepting it
    // alone would run a capture that quietly drops the user's request.
    let called = false;
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--thermal-interval', '1'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/--thermal/);
  });

  it('collect forwards a --jsheap request with the app it needs', async () => {
    // The snapshot is dumped for one process, so unlike screenshot and hilog
    // this flag needs `--app`; the action must reject it without one rather
    // than capture through hitrace and quietly drop the request.
    const seen: unknown[] = [];
    const { emitted } = await parse(
      ['collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1', '--jsheap'],
      {
        collect: async (req) => {
          seen.push(req);
          return {
            sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' },
            collectors: ['hitrace', 'jsheap'],
          };
        },
      },
    );
    expect(seen).toEqual([{ app: 'com.demo', durationMs: 10_000, out: 'scene1', jsheap: true }]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('collect rejects --jsheap without --app before any device work', async () => {
    let called = false;
    const { emitted } = await parse(
      ['collect', '--duration', '10', '--out', 'scene1', '--jsheap'],
      {
        collect: async () => {
          called = true;
          return { sceneDir: '/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].stderr).toContain('--app');
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
    expect(emitted).toMatchObject([
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
    expect(emitted).toMatchObject([{
      stdout: '', stderr: 'QUERY_BAD_ARGS: invalid --args: not valid JSON\n', exitCode: 1,
    }]);
  });

  it('query rejects an out-of-range --limit with one stderr line', async () => {
    let called = false;
    const { emitted } = await parse(['query', 'scene1', 'frames.get', '--limit', '0'], {
      query: async () => { called = true; throw new Error('should not run'); },
    });
    expect(called).toBe(false);
    expect(emitted).toMatchObject([{
      stdout: '',
      stderr: 'QUERY_BAD_LIMIT: limit must be an integer between 1 and 1000, got "0"\n',
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

describe('run wiring', () => {
  /** A real scenario file: the command layer reads and validates before deps.run. */
  const SCENARIO = (() => {
    const path = join(mkdtempSync(join(tmpdir(), 'program-run-')), 'scenario.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      name: 'two',
      app: 'com.example.app',
      steps: [{ id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
    }));
    return path;
  })();

  const runResult = {
    scenario: 'two',
    app: 'com.example.app',
    device: { id: 't1', kind: 'emulator' },
    rounds: 1,
    status: 'completed' as const,
    steps: [{
      round: 1, index: 0, id: 'open', name: 'open', status: 'ok' as const,
      sceneDir: '/out/open/round-1', startedAtMs: 1, durationMs: 2, actions: [],
    }],
    startedAtMs: 1,
    durationMs: 2,
    pids: { pids: [1], processNames: ['com.example.app'] },
  };

  it('forwards the scenario path, options and --json', async () => {
    const calls: unknown[] = [];
    const { emitted } = await parse(
      ['run', SCENARIO, '--out', 'out', '--target', 't1', '--rounds', '2',
        '--only', 'open, scroll', '--keep-going', '--json'],
      { run: async (req) => { calls.push(req); return runResult; } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      scenarioPath: SCENARIO,
      outDir: 'out',
      target: 't1',
      rounds: 2,
      only: ['open', 'scroll'],
      keepGoing: true,
    });
    expect(JSON.parse(emitted[0].stdout).steps).toHaveLength(1);
  });

  it('rejects a non-positive --rounds before calling the run layer', async () => {
    for (const rounds of ['0', '-1', '1.5', 'x']) {
      let called = false;
      const { emitted } = await parse(
        ['run', SCENARIO, '--out', 'out', '--rounds', rounds],
        { run: async () => { called = true; return runResult; } },
      );
      expect(called, rounds).toBe(false);
      expect(emitted[0].exitCode).toBe(1);
      expect(emitted[0].stderr).toMatch(/--rounds/);
    }
  });

  it('rejects an --only with an empty element before calling the run layer', async () => {
    let called = false;
    const { emitted } = await parse(
      ['run', SCENARIO, '--out', 'out', '--only', 'open,'],
      { run: async () => { called = true; return runResult; } },
    );
    expect(called).toBe(false);
    expect(emitted[0]).toMatchObject({
      stdout: '',
      stderr: 'SCENARIO_BAD_ONLY: invalid --only "open,": an empty step id names no step;' +
        ' expected a comma-separated list of ids\n',
      exitCode: 1,
    });
  });

  it('forwards --cases and --filter without a positional scenario', async () => {
    const root = mkdtempSync(join(tmpdir(), 'program-cases-'));
    for (const id of ['scroll', 'tap']) {
      writeFileSync(join(root, `${id}.scenario.json`), JSON.stringify({
        version: 1,
        name: id,
        app: 'com.example.app',
        steps: [{ id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
      }));
    }
    const out = mkdtempSync(join(tmpdir(), 'program-out-'));
    const calls: unknown[] = [];
    const { emitted } = await parse(
      ['run', '--cases', root, '--filter', '^scroll$', '--out', out, '--json'],
      { run: async (req) => { calls.push(req); return runResult; } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ scenarioPath: join(root, 'scroll.scenario.json') });
    const index = JSON.parse(emitted[0].stdout);
    expect(index.cases.map((c: { id: string }) => c.id)).toEqual(['scroll']);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('refuses a positional scenario together with --cases', async () => {
    let called = false;
    const { emitted } = await parse(
      ['run', SCENARIO, '--cases', 'cases', '--out', 'out'],
      { run: async () => { called = true; return runResult; } },
    );
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/--cases/);
  });

  it('exits 1 when the run reports a failed step', async () => {
    const { emitted } = await parse(['run', SCENARIO, '--out', 'out'], {
      run: async () => ({
        ...runResult,
        status: 'failed',
        steps: [{ ...runResult.steps[0], status: 'failed', error: 'boom' }],
      }),
    });
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stdout).toMatch(/failed  open/);
  });
});

/*
 * P33 task 3 — the tool-result envelope.
 *
 * The two flags are global, so they work on every command without being
 * declared 25 times. `--machine-json` forces the command's own `--json` (the
 * envelope wraps a payload, and a human summary is not one), and `--result-file`
 * writes the same document without changing what stdout carries.
 */
describe('--machine-json and --result-file', () => {
  function machineHarness(overrides: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const emitted: CliResult[] = [];
    const files: Array<{ path: string; contents: string }> = [];
    const program = buildProgram(deps(overrides), {
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      emit: (r) => emitted.push(r),
      writeFile: (path, contents) => files.push({ path, contents }),
    }, { exitOverride: true });
    return { program, out, err, emitted, files };
  }

  async function run(argv: string[], overrides: Partial<CliDeps> = {}) {
    const h = machineHarness(overrides);
    try {
      await h.program.parseAsync(['node', 'ohos-perf', ...argv]);
    } catch {
      // `exitOverride` throws on a non-zero exit; the emitted result is what
      // the assertions read.
    }
    return h;
  }

  it('replaces the bare payload with one envelope line on stdout', async () => {
    const { emitted } = await run(['analyze', '/scene', '--machine-json']);
    const lines = emitted[0]!.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: '1.0',
      toolId: 'ohos-perf',
      toolVersion: manifest.version,
      command: 'analyze',
      success: true,
      exitCode: 0,
      outputs: { payload: { metrics: [], evidence: [] } },
    });
  });

  it('names a nested command with dots', async () => {
    const { emitted } = await run(['emulator', 'list', '--machine-json']);
    expect(JSON.parse(emitted[0]!.stdout).command).toBe('emulator.list');
  });

  it('prints one envelope even when --json is also given', async () => {
    const { emitted } = await run(['analyze', '/scene', '--json', '--machine-json']);
    expect(emitted[0]!.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(emitted[0]!.stdout).outputs.payload).toBeDefined();
  });

  it('wraps a failure with its code and keeps the exit code', async () => {
    const { emitted } = await run(['analyze', '/scene', '--machine-json'], {
      analyze: async () => { throw new OhosPerfError('nothing to ingest', { code: 'SCENE_NO_INPUT' }); },
    });
    const envelope = JSON.parse(emitted[0]!.stdout);
    expect(envelope.success).toBe(false);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(envelope.outputs).toEqual({});
    expect(emitted[0]!.exitCode).toBe(1);
  });

  it('reports a gate verdict as an unsuccessful exit with no error', async () => {
    const { emitted } = await run(['gate', 'b.json', '/scene', '--machine-json'], {
      gate: async () => ({
        result: { name: 'b', status: 'fail', verdicts: [], totals: { pass: 0, fail: 1, missing: 0 } },
        files: [],
      }),
    });
    const envelope = JSON.parse(emitted[0]!.stdout);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.success).toBe(false);
    expect(envelope.error).toBeUndefined();
    expect(envelope.outputs.payload.status).toBe('fail');
  });

  it('writes the envelope to --result-file and leaves stdout as the --json document', async () => {
    const { emitted, files } = await run(['analyze', '/scene', '--json', '--result-file', 'r.json']);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(resolve('r.json'));
    const written = JSON.parse(files[0]!.contents);
    expect(written.command).toBe('analyze');
    expect(written.outputs.payload).toEqual({ metrics: [], evidence: [] });
    expect(JSON.parse(emitted[0]!.stdout)).toEqual({ metrics: [], evidence: [] });
  });

  it('writes the file and prints one line when both flags are given', async () => {
    const { emitted, files } = await run(['analyze', '/scene', '--machine-json', '--result-file', 'r.json']);
    expect(files).toHaveLength(1);
    expect(JSON.parse(emitted[0]!.stdout)).toEqual(JSON.parse(files[0]!.contents));
  });

  it('fails the command when the result file cannot be written, naming the path', async () => {
    // A success line beside a file that was not written is the failure mode
    // this test exists for: the exit code has to say so.
    const out: string[] = [];
    const emitted: CliResult[] = [];
    const program = buildProgram(deps(), {
      writeOut: (t) => out.push(t),
      writeErr: () => {},
      emit: (r) => emitted.push(r),
      writeFile: () => { throw new Error('EACCES: permission denied'); },
    }, { exitOverride: true });
    try {
      await program.parseAsync(['node', 'ohos-perf', 'analyze', '/scene', '--result-file', 'r.json']);
    } catch {
      // exitOverride
    }
    expect(emitted[0]!.exitCode).toBe(1);
    expect(emitted[0]!.stderr).toContain('r.json');
    expect(emitted[0]!.error?.code).toBe('TOOL_RESULT_BAD_PATH');
  });

  it('changes nothing for a run without either flag', async () => {
    const { emitted, files } = await run(['analyze', '/scene', '--json']);
    expect(files).toHaveLength(0);
    expect(JSON.parse(emitted[0]!.stdout)).toEqual({ metrics: [], evidence: [] });
  });

  it('gives --result-file alone a payload, without asking for --json', async () => {
    // The envelope wraps the structured answer, so a caller who asked only for
    // a file still gets one: `outputs: {}` in every written result would make
    // the file useless to the reader it was written for.
    const { files } = await run(['analyze', '/scene', '--result-file', 'r.json']);
    expect(files).toHaveLength(1);
    expect(JSON.parse(files[0]!.contents).outputs.payload).toEqual({ metrics: [], evidence: [] });
  });

  it('still prints one line when the result file cannot be written', async () => {
    // Under `--machine-json` a caller reads stdout, not the file. A write
    // failure that leaves stdout empty looks identical to a crash, so the
    // failure has to arrive as the one line the caller was promised.
    const emitted: CliResult[] = [];
    const program = buildProgram(deps(), {
      writeOut: () => {},
      writeErr: () => {},
      emit: (r) => emitted.push(r),
      writeFile: () => { throw new Error('EACCES: permission denied'); },
    }, { exitOverride: true });
    try {
      await program.parseAsync([
        'node', 'ohos-perf', 'analyze', '/scene', '--machine-json', '--result-file', 'r.json',
      ]);
    } catch {
      // exitOverride
    }
    expect(emitted[0]!.exitCode).toBe(1);
    const lines = emitted[0]!.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      command: 'analyze',
      success: false,
      exitCode: 1,
      error: { code: 'TOOL_RESULT_BAD_PATH' },
    });
  });

  it('gives every refused invocation a code, not just a line', async () => {
    // A validation failure is a result too. `success: false` with `outputs: {}`
    // and no `error` is indistinguishable from a crash, so an agent cannot tell
    // "you typed the duration wrong" from "the tool broke" — the code is the
    // only token that separates them.
    const scenario = join(mkdtempSync(join(tmpdir(), 'machine-code-')), 's.scenario.json');
    writeFileSync(scenario, JSON.stringify({
      version: 1, name: 's', app: 'com.example.app',
      steps: [{ id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
    }));
    const cases: Array<{ argv: string[]; code: string }> = [
      { argv: ['collect', '--duration', 'nope', '--out', 'x'], code: 'COLLECT_BAD_DURATION' },
      { argv: ['collect', '--duration', '10', '--out', 'x', '--plugins', 'gpu'], code: 'COLLECT_PLUGINS_WITHOUT_HIPROFILER' },
      { argv: ['collect', '--duration', '10', '--out', 'x', '--so-dir', '/libs'], code: 'COLLECT_SO_DIR_WITHOUT_HIPERF' },
      { argv: ['collect', '--duration', '10', '--out', 'x', '--thermal-interval', '1'], code: 'COLLECT_THERMAL_INTERVAL_WITHOUT_THERMAL' },
      { argv: ['collect', '--duration', '10', '--out', 'x', '--procfs'], code: 'COLLECT_APP_REQUIRED' },
      { argv: ['trend', 'one', '--out', 'x'], code: 'TREND_TOO_FEW_REPORTS' },
      { argv: ['hap', 'no/such/file.hap'], code: 'HAP_BAD_PATH' },
      { argv: ['opt', 'no/such/file.hap'], code: 'OPT_BAD_PATH' },
      { argv: ['run', 'a.json', '--cases', 'dir', '--out', 'x'], code: 'SCENARIO_BOTH_INPUTS' },
      { argv: ['run', scenario, '--out', 'x', '--rounds', '0'], code: 'SCENARIO_BAD_ROUNDS' },
      { argv: ['run', scenario, '--out', 'x', '--only', 'open,'], code: 'SCENARIO_BAD_ONLY' },
      { argv: ['agent', 'com.demo', '  '], code: 'AGENT_EMPTY_TASK' },
      { argv: ['emulator', 'create', 'X'], code: 'EMULATOR_FLAGS_REQUIRED' },
      { argv: ['gesture', 'swipe', '500', '800', '500', '200', '--velocity', '100'], code: 'UITEST_BAD_GESTURE' },
      { argv: ['query', '/scene', 'name', '--args', '{'], code: 'QUERY_BAD_ARGS' },
    ];
    for (const { argv, code } of cases) {
      const { emitted } = await run([...argv, '--machine-json']);
      expect(emitted[0]!.stdout, argv.join(' ')).not.toBe('');
      const envelope = JSON.parse(emitted[0]!.stdout);
      expect(envelope.error?.code, argv.join(' ')).toBe(code);
      expect(envelope.success, argv.join(' ')).toBe(false);
      expect(envelope.exitCode, argv.join(' ')).toBe(1);
      expect(emitted[0]!.exitCode, argv.join(' ')).toBe(1);
    }
  });
});
