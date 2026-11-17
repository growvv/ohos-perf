import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CliDeps } from '../src/commands';
import { runScenarioCommand } from '../src/commands';
import { parseOnly } from '../src/run';
import { parseScenario } from '@ohos-perf/core';

const DOC = {
  version: 1,
  name: 'two',
  app: 'com.example.app',
  steps: [
    { id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } },
    { id: 'scroll', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } },
  ],
};

function scenarioFile(doc: unknown = DOC): string {
  const path = join(mkdtempSync(join(tmpdir(), 'scenario-')), 'scenario.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

function runResult(overrides: Record<string, unknown> = {}) {
  const step = (id: string, index: number, status: 'ok' | 'failed') => ({
    round: 1, index, id, name: id, status,
    ...(status === 'ok' ? { sceneDir: `/out/${id}/round-1` } : { error: 'boom' }),
    startedAtMs: 1, durationMs: 2, actions: [],
  });
  return {
    scenario: 'two',
    app: 'com.example.app',
    device: { id: 't1', kind: 'emulator' },
    rounds: 1,
    status: 'completed' as const,
    steps: [step('open', 0, 'ok'), step('scroll', 1, 'ok')],
    startedAtMs: 1,
    durationMs: 2,
    pids: { pids: [1], processNames: ['com.example.app'] },
    ...overrides,
  };
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: '0.8.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/s', device: { id: 't', kind: 'emulator' }, collectors: [] }),
    gesture: async () => ({ gesture: { action: 'key' as const, key: 'Home' }, output: 'No Error' }),
    query: async () => ({ query: 'q', rows: [], total: 0, truncated: false }),
    tools: () => [],
    compare: async () => { throw new Error('not stubbed'); },
    uiCompare: async () => { throw new Error('ui-compare not stubbed'); },
    report: async () => { throw new Error('not stubbed'); },
    hap: async () => { throw new Error('hap not stubbed'); },
    emulator: {
      list: async () => [],
      start: async () => { throw new Error('not stubbed'); },
      stop: async () => { throw new Error('not stubbed'); },
      create: async () => { throw new Error('not stubbed'); },
    },
    run: async () => runResult(),
    ...overrides,
  };
}

const REQ = { outDir: '/out' };

describe('parseOnly', () => {
  it('splits, trims and keeps order', () => {
    expect(parseOnly('open, scroll')).toEqual(['open', 'scroll']);
  });

  it('rejects an empty element rather than dropping it', () => {
    expect(() => parseOnly('open,,scroll')).toThrow(/empty/i);
    expect(() => parseOnly(',')).toThrow(/empty/i);
  });

  it('rejects an empty list', () => {
    expect(() => parseOnly('  ')).toThrow(/empty/i);
  });
});

describe('runScenarioCommand', () => {
  it('rejects an unreadable scenario before calling deps.run', async () => {
    let called = false;
    const result = await runScenarioCommand(
      deps({ run: async () => { called = true; return runResult(); } }),
      { scenarioPath: '/definitely/not/here.json', ...REQ },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/scenario/i);
    expect(called).toBe(false);
  });

  it('rejects an invalid document before calling deps.run', async () => {
    let called = false;
    const result = await runScenarioCommand(
      deps({ run: async () => { called = true; return runResult(); } }),
      { scenarioPath: scenarioFile({ version: 1, name: 'x', app: 'com.a', steps: [] }), ...REQ },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/steps/);
    expect(called).toBe(false);
  });

  it('hands the parsed scenario and options to deps.run', async () => {
    const calls: unknown[] = [];
    const path = scenarioFile();
    await runScenarioCommand(
      deps({ run: async (req) => { calls.push(req); return runResult(); } }),
      { scenarioPath: path, outDir: '/out', rounds: 3, only: ['scroll'], keepGoing: true, target: 't1' },
      {},
    );
    expect(calls).toHaveLength(1);
    const req = calls[0] as { scenario: ReturnType<typeof parseScenario> };
    expect(req.scenario.name).toBe('two');
    expect(calls[0]).toMatchObject({
      outDir: '/out', rounds: 3, only: ['scroll'], keepGoing: true, target: 't1',
    });
  });

  it('prints one line per step and a summary', async () => {
    const result = await runScenarioCommand(
      deps(), { scenarioPath: scenarioFile(), ...REQ }, {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^ok\s+open\s+round 1\s+\/out\/open\/round-1$/m);
    expect(result.stdout).toMatch(/^ok\s+scroll\s+round 1\s+\/out\/scroll\/round-1$/m);
    expect(result.stdout).toMatch(/steps 2\/2 ok/);
  });

  it('marks a failed step and its error in the human output', async () => {
    const result = await runScenarioCommand(
      deps({ run: async () => runResult({
        status: 'failed',
        steps: [
          { ...runResult().steps[0], status: 'failed', error: 'uitest refused', sceneDir: '/out/open/round-1' },
        ],
      }) }),
      { scenarioPath: scenarioFile(), ...REQ },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^failed\s+open\s+round 1\s+\/out\/open\/round-1\s+uitest refused$/m);
    expect(result.stdout).toMatch(/steps 0\/1 ok, 1 failed/);
    // The failure is in the report, not in the invocation.
    expect(result.stderr).toBe('');
  });

  it('omits the scene column for a step that produced none', async () => {
    const result = await runScenarioCommand(
      deps({ run: async () => runResult({
        status: 'failed',
        steps: [{ ...runResult().steps[0], status: 'failed', error: 'setup failed', sceneDir: undefined }],
      }) }),
      { scenarioPath: scenarioFile(), ...REQ },
      {},
    );
    expect(result.stdout).toMatch(/^failed\s+open\s+round 1\s+setup failed$/m);
  });

  it('--json is the RunResult', async () => {
    const result = await runScenarioCommand(
      deps(), { scenarioPath: scenarioFile(), ...REQ }, { json: true },
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.status).toBe('completed');
  });

  it('maps a thrown run failure to exit 1 with empty stdout', async () => {
    const result = await runScenarioCommand(
      deps({ run: async () => { throw new Error('no device'); } }),
      { scenarioPath: scenarioFile(), ...REQ },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/no device/);
  });
});

/*
 * P17: `run --cases <dir>`.
 *
 * The cases command is a suite: one run directory per case, one index, and an
 * exit code that means "every case passed". A case file that does not parse
 * fails that case only, so one typo never hides the rest.
 */
describe('runScenarioCommand --cases', () => {
  function casesDir(files: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'cases-'));
    for (const [name, doc] of Object.entries(files)) {
      writeFileSync(join(root, name), typeof doc === 'string' ? doc : JSON.stringify(doc));
    }
    return root;
  }

  const ONE_STEP = {
    version: 1,
    name: 'one',
    app: 'com.example.app',
    steps: [{ id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
  };

  it('runs every case into its own directory and writes cases.json', async () => {
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    const seen: string[] = [];
    const result = await runScenarioCommand(
      deps({
        run: async (req) => {
          seen.push(req.outDir);
          return runResult({ scenario: req.scenario.name });
        },
      }),
      {
        scenarioPath: '',
        casesDir: casesDir({ 'b.scenario.json': ONE_STEP, 'a.scenario.json': ONE_STEP }),
        outDir: out,
      },
      {},
    );
    expect(result.exitCode).toBe(0);
    // One run directory per case, named by the case id, in name order.
    expect(seen.map((dir) => basename(dir))).toEqual(['a', 'b']);
    const index = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8'));
    expect(index.cases.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    expect(index.cases.every((c: { status: string }) => c.status === 'ok')).toBe(true);
  });

  it('fails the run when any case fails, and names which', async () => {
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    const result = await runScenarioCommand(
      deps({
        run: async (req) => runResult({
          scenario: req.scenario.name,
          status: req.scenario.name === 'b' ? 'failed' : 'completed',
          steps: [{ ...runResult().steps[0], status: req.scenario.name === 'b' ? 'failed' : 'ok' }],
        }),
      }),
      {
        scenarioPath: '',
        casesDir: casesDir({
          'a.scenario.json': { ...ONE_STEP, name: 'a' },
          'b.scenario.json': { ...ONE_STEP, name: 'b' },
        }),
        outDir: out,
      },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^failed\s+b\b/m);
    expect(result.stdout).toMatch(/^ok\s+a\b/m);
  });

  it('reports a malformed case without running the others', async () => {
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    const ran: string[] = [];
    const result = await runScenarioCommand(
      deps({ run: async (req) => { ran.push(req.scenario.name); return runResult(); } }),
      {
        scenarioPath: '',
        casesDir: casesDir({
          'good.scenario.json': { ...ONE_STEP, name: 'good' },
          'bad.scenario.json': '{ not json',
        }),
        outDir: out,
      },
      {},
    );
    expect(ran).toEqual(['good']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^failed\s+bad\b/m);
    const index = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8'));
    expect(index.cases.find((c: { id: string }) => c.id === 'bad').error).toBeDefined();
  });

  it('refuses --cases together with a positional scenario', async () => {
    const result = await runScenarioCommand(
      deps(),
      { scenarioPath: scenarioFile(), casesDir: '/tmp/whatever', outDir: '/out' },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--cases/);
  });

  it('refuses a filter that matches nothing, naming the cases found', async () => {
    const result = await runScenarioCommand(
      deps(),
      {
        scenarioPath: '',
        casesDir: casesDir({ 'scroll.scenario.json': ONE_STEP }),
        filter: '^nothing$',
        outDir: '/out',
      },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/scroll/);
  });

  it('--json is the cases index', async () => {
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    const result = await runScenarioCommand(
      deps(),
      {
        scenarioPath: '',
        casesDir: casesDir({ 'a.scenario.json': ONE_STEP }),
        outDir: out,
      },
      { json: true },
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0].id).toBe('a');
  });
});

describe('runScenarioCommand --cases index honesty', () => {
  const ONE_STEP = {
    version: 1,
    name: 'one',
    app: 'com.example.app',
    steps: [{ id: 'open', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
  };

  function casesDir(files: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'cases-'));
    for (const [name, doc] of Object.entries(files)) {
      writeFileSync(join(root, name), typeof doc === 'string' ? doc : JSON.stringify(doc));
    }
    return root;
  }

  it('records the case directory relative to --out, not as a host path', async () => {
    // A document must not carry a host path: two checkouts of the same
    // scenarios would produce different indexes for a reason that has
    // nothing to do with the run.
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    await runScenarioCommand(
      deps(),
      { scenarioPath: '', casesDir: casesDir({ 'a.scenario.json': ONE_STEP }), outDir: out },
      {},
    );
    const index = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8'));
    expect(index.cases[0].outDir).toBe('a');
    expect(index.cases[0].outDir).not.toContain(out);
  });

  it('omits outDir for a case that never ran', async () => {
    // A device that is gone throws before any scene exists; naming a
    // directory there sends a reader to a path that was never written.
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    await runScenarioCommand(
      deps({ run: async () => { throw new Error('no device'); } }),
      { scenarioPath: '', casesDir: casesDir({ 'a.scenario.json': ONE_STEP }), outDir: out },
      {},
    );
    const index = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8'));
    expect(index.cases[0].status).toBe('failed');
    expect(index.cases[0]).not.toHaveProperty('outDir');
    expect(index.cases[0].error).toMatch(/no device/);
  });

  it('names a malformed case by file name, not by its host path', async () => {
    const out = mkdtempSync(join(tmpdir(), 'run-'));
    const cases = casesDir({ 'bad.scenario.json': '{ not json' });
    await runScenarioCommand(
      deps(),
      { scenarioPath: '', casesDir: cases, outDir: out },
      {},
    );
    const index = JSON.parse(readFileSync(join(out, 'cases.json'), 'utf8'));
    expect(index.cases[0].error).toContain('bad.scenario.json');
    expect(index.cases[0].error).not.toContain(cases);
  });
});
