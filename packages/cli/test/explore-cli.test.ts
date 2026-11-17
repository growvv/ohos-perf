import { describe, it, expect } from 'vitest';
import type { CliDeps, ExploreOutput } from '../src/commands';
import { runExplore } from '../src/commands';
import { buildProgram } from '../src/program';

/*
 * `explore` is the CLI half of HapRay's `haptest` (parity row 4).
 *
 * The command's job is to state the walk's result in a form a reader can check:
 * how many screens were reached, how many taps moved the screen and how many
 * did not, and which seed produced the order. HapRay prints a step count, which
 * is the number of taps it spent — a walk that tapped a dead button 30 times
 * looks identical to one that opened 30 screens.
 */

const output: ExploreOutput = {
  app: 'com.demo',
  device: { id: 'emu-1', kind: 'emulator' },
  strategy: 'depth_first',
  steps: 4,
  navigated: 3,
  noChange: 1,
  statesReached: 4,
  exhausted: false,
  screens: ['a1b2c3d4e5f60718', '1111222233334444', '5555666677778888', '9999aaaabbbbcccc'],
};

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
    trend: async () => { throw new Error('trend not stubbed'); },
    render: async () => { throw new Error('render not stubbed'); },
    hap: async () => { throw new Error('hap not stubbed'); },
    emulator: {
      list: async () => [],
      start: async () => { throw new Error('emulator not stubbed'); },
      stop: async () => { throw new Error('emulator not stubbed'); },
      create: async () => { throw new Error('emulator not stubbed'); },
    },
    run: async () => { throw new Error('run not stubbed'); },
    explore: async () => output,
    ...overrides,
  };
}

describe('runExplore', () => {
  it('separates taps that moved the screen from taps that did not', async () => {
    const r = await runExplore(deps(), { app: 'com.demo', maxSteps: 4, strategy: 'depth_first' }, {});
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('explore  com.demo on emu-1 (emulator)\n');
    expect(r.stdout).toContain(
      'states  4 reached · 4 taps (3 navigated, 1 no change)\n',
    );
    expect(r.stdout).toContain('order   depth_first\n');
  });

  it('says the walk exhausted the screen instead of stopping at the cap', async () => {
    const r = await runExplore(
      deps({ explore: async () => ({ ...output, exhausted: true, steps: 2 }) }),
      { app: 'com.demo', maxSteps: 30, strategy: 'depth_first' },
      {},
    );
    expect(r.stdout).toContain('stopped  the screen had no unvisited clickable left\n');
  });

  it('names the seed for a random walk, so the order can be reproduced', async () => {
    const r = await runExplore(
      deps({ explore: async () => ({ ...output, strategy: 'random', seed: 42 }) }),
      { app: 'com.demo', maxSteps: 4, strategy: 'random' },
      {},
    );
    expect(r.stdout).toContain('order   random (seed 42)\n');
  });

  it('prints the walk as JSON with --json', async () => {
    const r = await runExplore(
      deps(),
      { app: 'com.demo', maxSteps: 4, strategy: 'depth_first' },
      { json: true },
    );
    expect(JSON.parse(r.stdout)).toEqual(output);
  });

  it('exits 1 with the reason when the device refuses the walk', async () => {
    const r = await runExplore(
      deps({ explore: async () => { throw new Error('ui.tree is not available on this device'); } }),
      { app: 'com.demo', maxSteps: 4, strategy: 'depth_first' },
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('ui.tree is not available');
  });
});

/** Parse through the real program, capturing help text instead of printing. */
async function parse(argv: string[]): Promise<{ out: string[] }> {
  const out: string[] = [];
  const program = buildProgram(
    deps(),
    { writeOut: (text) => out.push(text), writeErr: () => {}, emit: () => {} },
    { exitOverride: true },
  );
  try {
    await program.parseAsync(['node', 'ohos-perf', ...argv]);
  } catch {
    // `--help` exits through commander's override; the captured text is the point.
  }
  return { out };
}

describe('explore command wiring', () => {
  it('defaults maxSteps to HapRay\'s 30 and the strategy to depth_first', async () => {
    const seen: Array<{ app: string; maxSteps: number; strategy: string }> = [];
    const program = buildProgram(
      deps({
        explore: async (req) => {
          seen.push({ app: req.app, maxSteps: req.maxSteps, strategy: req.strategy });
          return output;
        },
      }),
      { writeOut: () => {}, writeErr: () => {}, emit: () => {} },
      { exitOverride: true },
    );
    await program.parseAsync(['node', 'ohos-perf', 'explore', 'com.demo']);
    expect(seen).toEqual([{ app: 'com.demo', maxSteps: 30, strategy: 'depth_first' }]);
  });

  it('forwards --max-steps, --strategy, --seed and --target', async () => {
    const seen: unknown[] = [];
    const program = buildProgram(
      deps({
        explore: async (req) => {
          seen.push(req);
          return output;
        },
      }),
      { writeOut: () => {}, writeErr: () => {}, emit: () => {} },
      { exitOverride: true },
    );
    await program.parseAsync([
      'node', 'ohos-perf', 'explore', 'com.demo',
      '--max-steps', '12', '--strategy', 'random', '--seed', '9', '--target', 'emu-1',
    ]);
    expect(seen).toEqual([
      { app: 'com.demo', maxSteps: 12, strategy: 'random', seed: 9, target: 'emu-1' },
    ]);
  });

  it('refuses a strategy it does not implement, before touching a device', async () => {
    let called = false;
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    const program = buildProgram(
      deps({ explore: async () => { called = true; return output; } }),
      {
        writeOut: (t) => out.push(t),
        writeErr: (t) => err.push(t),
        emit: (result) => { code = result.exitCode; out.push(result.stdout); err.push(result.stderr); },
      },
      { exitOverride: true },
    );
    await program.parseAsync(['node', 'ohos-perf', 'explore', 'com.demo', '--strategy', 'bfs']);
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/strategy/);
    expect(called).toBe(false);
  });

  it('lists explore in --help', async () => {
    const { out } = await parse(['--help']);
    expect(out.join('')).toContain('explore');
  });
});
