import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliDeps } from './helpers/deps';
import { runWorkloadCommand } from '../src/commands';
import type { WorkloadRunResult } from '@ohos-perf/core';

/**
 * The command layer's job is three things: refuse a bad plan before a device
 * is resolved, forward the parsed plan, and render the phases in the plan's
 * own words. The runner's behaviour is covered in core's tests.
 */

const PLAN = {
  bundle: 'com.example.app',
  ability: 'EntryAbility',
  description: 'search',
  setup: [{ op: 'wait', selector: { text: '首页' } }],
  measured: [{ op: 'launch' }],
  verify: [],
};

function planFile(doc: unknown = PLAN): string {
  const path = join(mkdtempSync(join(tmpdir(), 'workload-plan-')), 'search.workload.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const EMPTY_PHASE = { actions: [], ok: true, elapsedMs: 0 };

function runResult(overrides: Partial<WorkloadRunResult> = {}): WorkloadRunResult {
  return {
    plan: '/plan.json',
    description: 'search',
    app: 'com.example.app',
    ability: 'EntryAbility',
    device: { id: 't1', kind: 'emulator' },
    durationMs: 15_000,
    measuredMs: 4_000,
    status: 'ok',
    sceneDir: '/out',
    launch: {
      ok: true,
      elapsedMs: 300,
      actions: [
        { op: 'stop', description: 'stop', ok: true, atMs: 1, output: 'stopped' },
        { op: 'launch', description: 'launch', ok: true, atMs: 2, output: 'started' },
      ],
    },
    setup: {
      ok: true,
      elapsedMs: 500,
      actions: [{ op: 'wait', description: 'wait text="首页"', ok: true, atMs: 1, output: 'found Text' }],
    },
    measured: {
      ok: true,
      elapsedMs: 4_000,
      actions: [{ op: 'launch', description: 'launch', ok: true, atMs: 2, output: 'started' }],
    },
    verify: EMPTY_PHASE,
    pids: [4242],
    startedAtMs: 1,
    ...overrides,
  };
}

describe('runWorkloadCommand', () => {
  it('forwards the parsed plan and reports the three phases', async () => {
    let seen: { plan: unknown; durationMs: number } | undefined;
    const deps = cliDeps({
      workload: async (req) => {
        seen = { plan: req.plan, durationMs: req.durationMs };
        return runResult();
      },
    });
    const result = await runWorkloadCommand(deps, {
      planPath: planFile(), outDir: '/out', durationMs: 15_000,
    }, {});
    expect(result.exitCode).toBe(0);
    expect(seen?.durationMs).toBe(15_000);
    expect((seen?.plan as { bundle: string }).bundle).toBe('com.example.app');
    expect(result.stdout).toContain('setup    ok');
    expect(result.stdout).toContain('measured ok');
    expect(result.stdout).toContain('wait text="首页"');
    expect(result.stdout).toContain('pids     4242');
  });

  it('refuses an invalid plan before resolving a device', async () => {
    let called = false;
    const deps = cliDeps({
      workload: async () => {
        called = true;
        return runResult();
      },
    });
    const result = await runWorkloadCommand(deps, {
      planPath: planFile({ ...PLAN, measured: [{ op: 'teleport' }] }),
      outDir: '/out',
      durationMs: 1000,
    }, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported action "teleport"');
    expect(called).toBe(false);
  });

  it('fails the command when the run failed, keeping the record on stdout', async () => {
    const deps = cliDeps({
      workload: async () => runResult({
        status: 'failed',
        error: 'UI target not found: text="missing"',
        measured: {
          ok: false,
          elapsedMs: 10,
          error: 'UI target not found: text="missing"',
          actions: [{
            op: 'tap', description: 'tap text="missing"', ok: false, atMs: 3,
            error: 'UI target not found: text="missing"',
          }],
        },
      }),
    });
    const result = await runWorkloadCommand(deps, {
      planPath: planFile(), outDir: '/out', durationMs: 1000,
    }, {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('! tap text="missing"');
    expect(result.stdout).toContain('error    UI target not found');
  });

  it('reports an unreadable plan as a command failure', async () => {
    const deps = cliDeps();
    const result = await runWorkloadCommand(deps, {
      planPath: join(tmpdir(), 'does-not-exist', 'x.workload.json'),
      outDir: '/out',
      durationMs: 1000,
    }, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot read workload plan');
  });

  it('emits the run record as JSON with --json', async () => {
    const deps = cliDeps({ workload: async () => runResult() });
    const result = await runWorkloadCommand(deps, {
      planPath: planFile(), outDir: '/out', durationMs: 15_000,
    }, { json: true });
    expect(JSON.parse(result.stdout).status).toBe('ok');
  });
});
