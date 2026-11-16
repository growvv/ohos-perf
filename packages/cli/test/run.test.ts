import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
