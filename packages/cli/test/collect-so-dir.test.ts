import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/program';
import type { CliDeps, CliResult } from '../src/commands';

/*
 * `collect --so-dir`: the flag names a host directory the device symbolizer
 * reads, so it only means something beside `--hiperf`. The CLI's job is to
 * forward it unchanged and to refuse it before a device is touched when it
 * cannot mean anything — the core repeats both checks.
 */

/** Build the program with every dependency but `collect` stubbed. */
function harness(collect: CliDeps['collect']): (argv: string[]) => Promise<CliResult> {
  const stub = async () => { throw new Error('not stubbed'); };
  const build = (emit: (result: CliResult) => void) => buildProgram(
    {
      doctor: stub,
      caps: async () => [],
      connect: stub,
      collect,
      gesture: stub,
      query: stub,
      tools: () => [],
      analyze: stub,
      compare: stub,
      uiCompare: stub,
      report: stub,
      hap: stub,
      emulator: { list: async () => [], start: stub, stop: stub, create: stub },
      run: stub,
      version: '0.11.0',
    } as unknown as CliDeps,
    { writeOut: () => {}, writeErr: () => {}, emit },
    { exitOverride: true },
  );

  return (argv) => new Promise<CliResult>((resolve, reject) => {
    const program = build((result) => resolve(result));
    program.parseAsync(['node', 'ohos-perf', ...argv]).catch(reject);
  });
}

function existingDir(): string {
  return mkdtempSync(join(tmpdir(), 'ohosperf-so-cli-'));
}

describe('collect --so-dir', () => {
  it('forwards the directory with --hiperf', async () => {
    const seen: Array<string | undefined> = [];
    const run = harness(async (req) => {
      seen.push(req.soDir);
      return {
        sceneDir: '/abs/scene1',
        device: { id: 't1', kind: 'emulator' },
        collectors: ['hitrace', 'hiperf'],
      };
    });
    const result = await run([
      'collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
      '--hiperf', '--so-dir', '/symbols',
    ]);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(['/symbols']);
  });

  it('mentions the symbol directory in the human output', async () => {
    // `deps.collect` reports the resolved directory it actually used, which is
    // what the renderer prints; the stub mirrors that contract.
    const run = harness(async (req) => ({
      sceneDir: '/abs/scene1',
      device: { id: 't1', kind: 'emulator' },
      collectors: ['hitrace', 'hiperf'],
      ...(req.soDir === undefined ? {} : { soDir: req.soDir }),
    }));
    const result = await run([
      'collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
      '--hiperf', '--so-dir', '/symbols',
    ]);
    expect(result.stdout).toContain('/symbols');
  });

  it('refuses --so-dir without --hiperf, naming the flag', async () => {
    let called = false;
    const run = harness(async () => {
      called = true;
      return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
    });
    const result = await run([
      'collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
      '--so-dir', '/symbols',
    ]);
    expect(called).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--hiperf');
  });

  it('accepts an existing directory and forwards it unchanged', async () => {
    const dir = existingDir();
    try {
      const seen: Array<string | undefined> = [];
      const run = harness(async (req) => {
        seen.push(req.soDir);
        return { sceneDir: '/x', device: { id: 't1', kind: 'emulator' }, collectors: [] };
      });
      const result = await run([
        'collect', '--app', 'com.demo', '--duration', '10', '--out', 'scene1',
        '--hiperf', '--so-dir', dir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(seen).toEqual([dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
