import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { runAgentCommand } from '../src/commands';
import type { AgentTranscript } from '../../core/src/scenario/agent';

/*
 * `ohos-perf agent <app> <task>` — HapRay parity row 5.
 *
 * The command runs a model-driven walk and prints what it reached. The tests
 * below pin the terminal contract: the summary leads with the verified outcome
 * rather than the step count, every step is named, a non-verified run exits
 * non-zero (a claim the screen did not confirm is not a success), and the
 * flags reach the dependency seam.
 */

const transcript: AgentTranscript = {
  version: 1,
  task: 'open the settings page',
  app: 'com.demo',
  steps: [
    {
      index: 0, status: 'acted', reason: 'tap settings',
      action: { action: 'click', x: 50, y: 50 },
      before: 'aaaa', after: 'bbbb', navigated: true,
    },
    { index: 1, status: 'verified', reason: 'the page is open', before: 'bbbb', after: 'bbbb', navigated: false },
  ],
  status: 'completed',
  statesReached: 2,
};

describe('runAgentCommand', () => {
  it('leads with the verified outcome, then the walk', async () => {
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 'open the settings page', maxSteps: 10 },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('agent  com.demo on emu-1 (emulator)');
    expect(result.stdout).toContain('task   open the settings page');
    expect(result.stdout).toContain('result completed');
    expect(result.stdout).toContain('2 steps, 2 states reached');
    // Each step is named by what it did, not just its index.
    expect(result.stdout).toContain('click at (50, 50)');
    expect(result.stdout).toContain('the page is open');
  });

  it('exits non-zero when the model claimed done and the screen disagreed', async () => {
    // The defect this row exists to fix: HapRay records `finished` as success.
    // A run that did not verify is a failed run here, with the clause named.
    const unverified: AgentTranscript = {
      ...transcript,
      status: 'unverified',
      steps: [
        {
          index: 0, status: 'unverified', reason: 'I believe it is done',
          detail: 'present: text containing "Done": expected at least 1, found 0 of 12 nodes',
          before: 'aaaa', after: 'aaaa', navigated: false,
        },
      ],
    };
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript: unverified, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 't', maxSteps: 5 },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('unverified');
    expect(result.stdout).toContain('found 0 of 12 nodes');
  });

  it('names a refused run and exits non-zero', async () => {
    const refused: AgentTranscript = {
      ...transcript,
      status: 'refused',
      steps: [
        {
          index: 0, status: 'refused', reason: 'pay for it',
          action: { action: 'click', x: 10, y: 10 },
          detail: 'payment is irreversible',
          before: 'aaaa', after: 'aaaa', navigated: false,
        },
      ],
    };
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript: refused, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 't', maxSteps: 5 },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('payment is irreversible');
  });

  it('prints the whole document with --json', async () => {
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 'open the settings page', maxSteps: 10 },
      { json: true },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      transcript, device: { id: 'emu-1', kind: 'emulator' },
    });
  });

  it('passes every flag to the seam', async () => {
    let seen: unknown;
    await runAgentCommand(
      cliDeps({
        async agent(req) {
          seen = req;
          return { transcript, device: { id: 'emu-1', kind: 'emulator' } };
        },
      }),
      {
        app: 'com.demo', task: 't', maxSteps: 7,
        allowIrreversible: true, target: 'emulator-5554', model: 'test-model',
      },
      {},
    );
    expect(seen).toMatchObject({
      app: 'com.demo', task: 't', maxSteps: 7,
      allowIrreversible: true, target: 'emulator-5554', model: 'test-model',
    });
  });

  it('refuses an empty task before touching the seam', async () => {
    let called = false;
    const result = await runAgentCommand(
      cliDeps({ agent: async () => { called = true; throw new Error('unreachable'); } }),
      { app: 'com.demo', task: '   ', maxSteps: 5 },
      {},
    );
    expect(called).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/task/);
  });

  it('reports a seam failure as one line', async () => {
    const result = await runAgentCommand(
      cliDeps({ agent: async () => { throw new Error('no model configured'); } }),
      { app: 'com.demo', task: 't', maxSteps: 5 },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no model configured');
  });

  it('warns about the risk of letting a model drive the device', async () => {
    // A model chooses the gestures, so a run acts on a real account. The guard
    // refuses labelled irreversible targets, but it reads labels, not intent —
    // the warning is what tells a user to review the transcript before trusting
    // a run. It goes to stderr so `--json` stdout stays machine-parseable.
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 'open the settings page', maxSteps: 10 },
      {},
    );
    expect(result.stderr).toMatch(/risk/i);
    expect(result.stderr).toMatch(/model/i);
    expect(result.stderr).toMatch(/irreversible/i);
    // The stdout contract is unchanged: the warning must not leak into it.
    expect(result.stdout).not.toMatch(/risk/i);
  });

  it('keeps the warning out of --json stdout', async () => {
    const result = await runAgentCommand(
      cliDeps({ agent: async () => ({ transcript, device: { id: 'emu-1', kind: 'emulator' } }) }),
      { app: 'com.demo', task: 't', maxSteps: 5 },
      { json: true },
    );
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toMatch(/risk/i);
  });
});
