import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { OhosPerfError, type CapabilityState } from '@ohos-perf/core';
import {
  runAnalyze, runCaps, runCollect, runDoctor, runEmulatorList, runEmulatorStart,
  runGate, runTools,
  type CliDeps, type CliResult, type DoctorDeps,
} from '../src/commands';

const okDevice = {
  id: 't1',
  kind: 'emulator',
  abi: 'x86_64',
  capabilities: async () => ({ all: () => [] as CapabilityState[] }),
};

function available(id: CapabilityState['id']): CapabilityState {
  return { id, available: true, collector: 'hitrace', fidelity: 'exact', probe: { command: '', stdout: '', stderr: '', code: 0 } };
}

function unavailable(id: CapabilityState['id']): CapabilityState {
  return {
    id,
    available: false,
    fidelity: 'exact',
    reason: 'not supported',
    probe: { command: '', stdout: '', stderr: '', code: 0 },
  };
}

/** A complete deps object with every field overridable, including the doctor half. */
function deps(
  overrides: { doctor?: Partial<DoctorDeps> } & Partial<Omit<CliDeps, 'doctor'>> = {},
): CliDeps {
  const { doctor, ...rest } = overrides;
  return cliDeps({
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => okDevice,
      ...doctor,
    },
    ...rest,
  });
}

describe('runDoctor', () => {
  it('exits 1 when hdc is unavailable, even if a device answers', async () => {
    const r = await runDoctor(
      deps({ doctor: { resolveHdc: async () => { throw new Error('no hdc'); } } }),
      { json: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout);
    expect(report.hdc.ok).toBe(false);
    // A device that answers must not mask a missing toolchain (mutant F).
    expect(report.device?.id).toBe('t1');
  });

  it('exits 0 when hdc works but no device is attached', async () => {
    const r = await runDoctor(
      deps({ doctor: { connectDevice: async () => { throw new Error('no device'); } } }),
      { json: true },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).device).toBeUndefined();
  });

  it('says the device probe failed, not that no device is attached', async () => {
    // "Nothing plugged in" and "the probe threw" collapse into the same
    // catch in `doctorReport`; either way the human report must say what
    // happened instead of claiming a device was never probed.
    const r = await runDoctor(
      deps({ doctor: { connectDevice: async () => { throw new Error('probe exploded'); } } }),
      {},
    );
    expect(r.exitCode).toBe(0); // still environmental, not a toolchain failure
    expect(r.stdout).toContain('device   probe failed: probe exploded');
    expect(r.stdout).not.toContain('none attached');
    // A failed probe has no matrix; the "no device probed" line would be false.
    expect(r.stdout).not.toContain('no capabilities (no device probed)');
  });

  it('exits 0 when capabilities are merely degraded', async () => {
    const r = await runDoctor(
      deps({
        doctor: {
          connectDevice: async () => ({
            ...okDevice,
            capabilities: async () => ({ all: () => [unavailable('perf.pmu')] }),
          }),
        },
      }),
      { json: true },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).capabilities).toHaveLength(1);
  });

  it('exits 0 and drops the device when capabilities() throws', async () => {
    const r = await runDoctor(
      deps({
        doctor: {
          connectDevice: async () => ({
            ...okDevice,
            capabilities: async () => { throw new Error('probe exploded'); },
          }),
        },
      }),
      { json: true },
    );
    const report = JSON.parse(r.stdout);
    expect(r.exitCode).toBe(0);
    // The probe failure is environmental: hdc is still healthy (mutant G).
    expect(report.hdc.ok).toBe(true);
    expect(report.device).toBeUndefined();
    expect(report.capabilities).toEqual([]);
  });

  it('prints the human report with a capability line', async () => {
    const r = await runDoctor(
      deps({
        doctor: {
          connectDevice: async () => ({
            ...okDevice,
            capabilities: async () => ({ all: () => [available('trace.frames')] }),
          }),
        },
      }),
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hdc      ok  /hdc');
    expect(r.stdout).toContain('device   t1 (emulator, x86_64)');
    expect(r.stdout).toContain('✓ trace.frames  hitrace  exact');
  });

  it('truncates a search-path error in human mode but not in --json', async () => {
    const long =
      'hdc executable not found. Searched paths: ' +
      Array.from({ length: 100 }, (_, i) => `C:/tools/${i}/hdc.exe`).join(', ');
    const failing = () => deps({ doctor: { resolveHdc: async () => { throw new Error(long); } } });

    const human = await runDoctor(failing(), {});
    expect(human.stdout).toContain('hdc      FAIL  hdc executable not found.');
    expect(human.stdout).toContain('(use --json for the full search path list)');
    expect(human.stdout).not.toContain('C:/tools/99/hdc.exe');

    const json = await runDoctor(failing(), { json: true });
    expect(json.stdout).toContain('C:/tools/99/hdc.exe');
  });

  it('does not offer --json for a multi-line error with no search path list', async () => {
    // Truncation is real (only the first line is shown), but there is no list
    // to reveal, so the hint would be a lie.
    const r = await runDoctor(
      deps({
        doctor: {
          resolveHdc: async () => {
            throw new Error('line one\nline two\nline three');
          },
        },
      }),
      {},
    );
    expect(r.stdout).toContain('hdc      FAIL  line one\n');
    expect(r.stdout).not.toContain('line two');
    expect(r.stdout).not.toContain('--json');
  });
});

describe('runCaps', () => {
  it('writes nothing to stdout and exits 1 when hdc is unavailable', async () => {
    const r = await runCaps(
      deps({ capsReport: async () => ({ hdcOk: false, hdcError: 'no hdc', capabilities: [] }) }),
      { json: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no hdc');
  });

  it('exits 0 with an empty capability list', async () => {
    const r = await runCaps(deps({ capsReport: async () => ({ hdcOk: true, capabilities: [] }) }), {
      json: true,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it('terminates --json output with exactly one newline', async () => {
    // Byte-level, not `JSON.parse`: D5 requires stable bytes.
    const r = await runCaps(deps({ capsReport: async () => ({ hdcOk: true, capabilities: [] }) }), {
      json: true,
    });
    expect(r.stdout).toBe('[]\n');
  });

  it('prints a human-readable line when nothing was probed', async () => {
    const r = await runCaps(
      deps({ capsReport: async () => ({ hdcOk: true, capabilities: [] }) }),
      {},
    );
    expect(r.stdout).toBe('no capabilities (no device probed)\n');
  });

  it('says the probe failed, rather than pretending there are no capabilities', async () => {
    const r = await runCaps(
      deps({
        capsReport: async () => ({ hdcOk: true, probeError: 'probe exploded', capabilities: [] }),
      }),
      {},
    );
    expect(r.stdout).toBe('capabilities unavailable: probe exploded\n');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0); // environmental, not a failure
  });

  it('keeps --json a bare array even when the probe failed', async () => {
    // Machine consumers keep the contract they had before probeError existed.
    const r = await runCaps(
      deps({
        capsReport: async () => ({ hdcOk: true, probeError: 'probe exploded', capabilities: [] }),
      }),
      { json: true },
    );
    expect(r.stdout).toBe('[]\n');
    expect(r.exitCode).toBe(0);
  });

  it('prints capabilities in human mode', async () => {
    const r = await runCaps(
      deps({ capsReport: async () => ({ hdcOk: true, capabilities: [available('trace.frames')] }) }),
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('✓ trace.frames  hitrace  exact');
  });
});

describe('runAnalyze', () => {
  const result = {
    metrics: [
      { id: 'frame.count', value: 2, unit: 'count' as const, fidelity: 'exact' as const },
      { id: 'frame.fps', value: 5.5, unit: 'fps' as const, fidelity: 'approximate' as const },
    ],
    evidence: [{ kind: 'jank' }, { kind: 'no_data' }, { kind: 'jank' }],
  };

  it('prints JSON and exits 0 on success', async () => {
    const r = await runAnalyze(deps({ analyze: async () => result }), 'scene', { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual(result);
  });

  it('prints one line per metric and an evidence summary in human mode', async () => {
    const r = await runAnalyze(deps({ analyze: async () => result }), 'scene', {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      'frame.count  2 count (exact)\n' +
        'frame.fps  5.5 fps (approximate)\n' +
        'evidence  3 items (jank: 2)\n',
    );
  });

  it('passes the scene dir and app through', async () => {
    const seen: Array<[string, string | undefined]> = [];
    await runAnalyze(
      deps({ analyze: async (dir, app) => { seen.push([dir, app]); return result; } }),
      'scene1',
      { app: 'com.demo' },
    );
    expect(seen).toEqual([['scene1', 'com.demo']]);
  });

  it('writes errors to stderr only and exits 1 on failure', async () => {
    const r = await runAnalyze(
      deps({ analyze: async () => { throw new Error('Nothing to ingest'); } }),
      'missing',
      { json: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('Nothing to ingest\n');
  });
});

describe('runCollect', () => {
  const req = { app: 'com.demo', durationMs: 10_000, out: 'scene1' };
  const output = { sceneDir: '/abs/scene1', device: { id: 't1', kind: 'emulator' }, collectors: [] };

  it('prints the scene path in human mode', async () => {
    const r = await runCollect(deps({ collect: async () => output }), req, {});
    expect(r).toMatchObject({ stdout: 'scene  /abs/scene1\n', stderr: '', exitCode: 0 });
  });

  it('prints the scene and device as JSON in --json mode', async () => {
    const r = await runCollect(deps({ collect: async () => output }), req, { json: true });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(output);
    expect(r.stdout.endsWith('\n')).toBe(true);
  });

  it('lists the collectors that ran and what each captured', async () => {
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace', 'hiperf', 'hidumper', 'uitest'],
          hiperf: { samples: 150 },
          hidumper: { frames: 601 },
          ui: { nodes: 76 },
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toBe(
      'scene  /abs/scene1\n' +
      'collectors  hitrace, hiperf, hidumper, uitest\n' +
      'samples  hiperf 150, hidumper 601, ui 76\n',
    );
  });

  it('names the screenshot dimensions in the samples line', async () => {
    // A screenshot capture is reported by its size, the one number a caller can
    // act on: a 0x0 screen would mean the capture recorded nothing.
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace', 'uitest', 'screenshot'],
          ui: { nodes: 76 },
          screenshot: { width: 1260, height: 2720 },
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toContain('samples  ui 76, screenshot 1260x2720\n');
  });

  it('names the thermal sample count after the hilog line count', async () => {
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace', 'hilog', 'thermal'],
          hilog: { lines: 12 },
          thermal: { samples: 3 },
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toContain('samples  hilog 12, thermal 3\n');
  });

  it('prints a zero-frame hidumper capture explicitly', async () => {
    // Review Focus 1: a screen that presented nothing is a measurement. A
    // missing line would read as "hidumper did not run".
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace', 'hidumper'],
          hidumper: { frames: 0 },
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toContain('samples  hidumper 0\n');
  });

  it('prints a zero-sample hiperf capture explicitly rather than dropping the line', async () => {
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace', 'hiperf'],
          hiperf: { samples: 0 },
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toContain('samples  hiperf 0\n');
  });

  it('omits the samples line when no extra collector ran', async () => {
    const r = await runCollect(
      deps({
        collect: async () => ({
          sceneDir: '/abs/scene1',
          device: { id: 't1', kind: 'emulator' },
          collectors: ['hitrace'],
        }),
      }),
      req,
      {},
    );
    expect(r.stdout).toBe('scene  /abs/scene1\ncollectors  hitrace\n');
  });

  it('keeps the failure contract: empty stdout, message on stderr, exit 1', async () => {
    const r = await runCollect(
      deps({ collect: async () => { throw new Error('no device attached'); } }),
      req,
      { json: true },
    );
    expect(r).toMatchObject({ stdout: '', stderr: 'no device attached\n', exitCode: 1 });
  });
});

/*
 * P33 task 2 — every command carries its payload and its failure.
 *
 * `--json` prints the payload; `--machine-json` wraps it. The envelope can only
 * be as complete as these two fields, so a command that forgets one shows up
 * here rather than as a payload-less envelope in a user's pipeline.
 */
describe('CliResult carries the structured answer', () => {
  it('jsonResult returns the payload as stdout and as result', async () => {
    const r = await runAnalyze(deps(), '/scene', { json: true });
    expect(r.result).toEqual({ metrics: [], evidence: [] });
    expect(JSON.parse(r.stdout)).toEqual(r.result);
    expect(r.error).toBeUndefined();
  });

  it('keeps a command\'s own exit code beside its payload', async () => {
    const r = await runGate(deps({ gate: async () => ({
      result: { name: 'b', status: 'fail', verdicts: [], totals: { pass: 0, fail: 1, missing: 0 } },
      files: [],
    }) }), { budget: 'b.json', input: '/scene' }, { json: true });
    expect(r.exitCode).toBe(2);
    expect(r.result).toMatchObject({ status: 'fail' });
    expect(r.error).toBeUndefined();
  });

  it('a failure carries the typed code and the message, and no result', async () => {
    const r = await runAnalyze(
      deps({ analyze: async () => { throw new OhosPerfError('nothing to ingest', { code: 'SCENE_NO_INPUT' }); } }),
      '/scene',
      { json: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.result).toBeUndefined();
    expect(r.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(r.stderr).toBe('SCENE_NO_INPUT: nothing to ingest\n');
  });

  it('a failure with no code still names the message', async () => {
    const r = await runAnalyze(
      deps({ analyze: async () => { throw new Error('plain'); } }), '/scene', {},
    );
    expect(r.error).toEqual({ message: 'plain' });
    expect(r.stderr).toBe('plain\n');
  });

  it('every command with a --json branch returns a result in that branch', async () => {
    const cases: Array<[string, () => Promise<CliResult>]> = [
      ['caps', async () => runCaps(deps(), { json: true })],
      ['tools', async () => runTools(deps(), { json: true })],
      ['emulator.list', async () => runEmulatorList(deps(), { json: true })],
      ['emulator.start', async () => runEmulatorStart(
        deps({
          emulator: {
            ...cliDeps().emulator,
            start: async () => ({ name: 'e', target: 't1', alreadyRunning: false, waitedMs: 0 }),
          },
        }),
        'e',
        { json: true },
      )],
    ];
    for (const [name, run] of cases) {
      expect((await run()).result, name).toBeDefined();
    }
  });
});
