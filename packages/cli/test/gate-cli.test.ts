import { describe, it, expect } from 'vitest';
import type { GateResult, GateVerdict } from '@ohos-perf/core';
import { cliDeps as deps } from './helpers/deps';
import { runGate, type GateRequest } from '../src/commands';

/*
 * The exit code is the contract a CI job reads, so these tests assert it
 * directly rather than inferring it from the text: 0 passed, 2 a budget was
 * violated or not measured, 1 the gate could not run. A job that reads a
 * failed gate as an error and an un-runnable gate as a pass would be wrong in
 * both directions.
 */

const verdict = (over: Partial<GateVerdict> & Pick<GateVerdict, 'id' | 'status'>): GateVerdict => ({
  bound: { kind: 'max', limit: 5 },
  ...over,
});

function result(verdicts: GateVerdict[]): GateResult {
  const totals = { pass: 0, fail: 0, missing: 0 };
  for (const item of verdicts) totals[item.status] += 1;
  return {
    name: 'open-app',
    status: totals.pass === verdicts.length ? 'pass' : 'fail',
    verdicts,
    totals,
  };
}

const req: GateRequest = { budget: 'budgets.json', input: 'scene' };

describe('runGate', () => {
  it('prints one line per budget plus a totals line and exits 0 when all pass', async () => {
    const gate = result([
      verdict({ id: 'frame.jank.rate', status: 'pass', value: 3.2 }),
      verdict({ id: 'frame.fps', status: 'pass', value: 59 }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      'frame.jank.rate  3.2 <= 5  pass\n' +
        'frame.fps  59 <= 5  pass\n' +
        'totals  pass 2, fail 0, missing 0\n' +
        'gate  open-app  pass\n',
    );
  });

  it('shows how far past the bound a failing value was and exits 2', async () => {
    const gate = result([
      verdict({ id: 'frame.jank.rate', status: 'fail', value: 7.5, excess: 2.5 }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(
      'frame.jank.rate  7.5 <= 5  fail  (2.5 past)\n' +
        'totals  pass 0, fail 1, missing 0\n' +
        'gate  open-app  fail\n',
    );
  });

  it('prints the reason for a metric that was not measured and exits 2', async () => {
    const gate = result([
      verdict({
        id: 'frame.fps',
        status: 'missing',
        bound: { kind: 'min', limit: 55 },
        reason: 'the run emitted no frame.fps',
      }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(
      'frame.fps  >= 55  missing  the run emitted no frame.fps\n' +
        'totals  pass 0, fail 0, missing 1\n' +
        'gate  open-app  fail\n',
    );
  });

  it('prints a missing maxDeltaPct budget with the upper-bound operator', async () => {
    // A percentage budget says "must not rise more than", so the operator on
    // the line is `<=`. Printing `>=` told the reader the opposite direction.
    const gate = result([
      verdict({
        id: 'frame.count',
        status: 'missing',
        bound: { kind: 'maxDeltaPct', limit: 10 },
        reason: 'a percentage of a zero frame.count baseline is undefined',
      }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.stdout).toContain('frame.count  <= 10%  missing  a percentage of a zero frame.count baseline is undefined\n');
  });

  it('renders a min budget and a failing delta with the right operators', async () => {
    const gate = result([
      verdict({ id: 'frame.fps', status: 'fail', value: 50, excess: 5, bound: { kind: 'min', limit: 55 } }),
      verdict({
        id: 'frame.avg.duration',
        status: 'fail',
        value: 18,
        baseline: 16,
        excess: 1,
        bound: { kind: 'maxDelta', limit: 1 },
      }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.stdout).toBe(
      'frame.fps  50 >= 55  fail  (5 past)\n' +
        'frame.avg.duration  16 -> 18 (+2) <= 1  fail  (1 past)\n' +
        'totals  pass 0, fail 2, missing 0\n' +
        'gate  open-app  fail\n',
    );
  });

  it('renders a delta bound with its baseline', async () => {
    const gate = result([
      verdict({
        id: 'frame.avg.duration',
        status: 'pass',
        value: 21,
        baseline: 20,
        bound: { kind: 'maxDeltaPct', limit: 5 },
      }),
    ]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {});
    expect(r.stdout).toContain('frame.avg.duration  20 -> 21 (+5% <= 5%)  pass\n');
  });

  it('prints the GateResult alone with --json and still exits 2 when it failed', async () => {
    const gate = result([verdict({ id: 'frame.fps', status: 'fail', value: 50, excess: 5 })]);
    const r = await runGate(deps({ gate: async () => ({ result: gate, files: [] }) }), req, {
      json: true,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(JSON.stringify(gate, null, 2) + '\n');
  });

  it('names the artifact it wrote when an output directory was given', async () => {
    const gate = result([verdict({ id: 'frame.fps', status: 'pass', value: 60 })]);
    const r = await runGate(
      deps({ gate: async () => ({ result: gate, outDir: '/out', files: ['gate.json'] }) }),
      { ...req, outDir: '/out' },
      {},
    );
    expect(r.stdout).toContain('artifact  /out/gate.json\n');
  });

  it('exits 1 with empty stdout when the gate could not run', async () => {
    const r = await runGate(
      deps({ gate: async () => { throw new Error('invalid budget document: budgets[0]: no bound'); } }),
      req,
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no bound');
  });
});
