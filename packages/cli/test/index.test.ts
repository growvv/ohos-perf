import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTraceDb } from './helpers/trace-db';

/**
 * Tests for the executable entry point (`src/index.ts`).
 *
 * `index.ts` owns the process globals — argv, the exit code, the streams and
 * the EPIPE handlers — so the only honest way to test it is to run the built
 * binary and observe what a shell would see.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliDist = join(here, '../dist/index.js');
const cliPkg = join(here, '../package.json');
const spikeDb = join(here, '../../../spike/out/emu_big.db');

const distExists = existsSync(cliDist);
if (!distExists) {
  // Visible skip: a silent one would hide that the entry point is untested.
  console.warn(
    `[cli] ${cliDist} is missing; the entry-point tests are skipped. ` +
      'Run `npm run build -w @ohos-perf/cli` first.',
  );
}

if (!existsSync(spikeDb)) {
  // `spike/out/` is gitignored, so a clean checkout never has this fixture.
  // The test itself uses `it.skipIf` (vitest then reports it as skipped, not
  // passed); this warning says how to get the fixture back.
  console.warn(
    `[cli] ${spikeDb} is missing; the real-scene end-to-end test is skipped. ` +
      'Generate it by converting a recorded capture with trace_streamer: ' +
      '`trace_streamer <capture.htrace> -e spike/out/emu_big.db`.',
  );
}

/** Run the built CLI and capture everything a shell would see. */
function run(args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [cliDist, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? here,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run the CLI with one of its output pipes closed before it can write.
 *
 * `spawnSync` cannot express this, and it is the only way to exercise the
 * EPIPE handlers in `index.ts`. Resolves with the exit code and whether the
 * child died from a signal.
 */
function runWithClosedPipe(
  args: string[],
  which: 'stdout' | 'stderr',
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliDist, ...args], {
      stdio: ['ignore', which === 'stdout' ? 'pipe' : 'ignore', which === 'stderr' ? 'pipe' : 'ignore'],
    });
    const stream = which === 'stdout' ? child.stdout : child.stderr;
    // Closing the read end makes the child's next write fail with EPIPE.
    stream?.destroy();
    stream?.on('error', () => {
      // Expected: the pipe is gone.
    });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal }));
  });
}

/** Newest mtime under `dir`, recursively. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

describe.skipIf(!distExists)('cli entry point', () => {
  it('propagates a failing analysis to the exit code', () => {
    const r = run(['analyze', '/nonexistent-scene-dir']);
    expect(r.status).toBe(1);
    // Partial output on failure would be worse than none.
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Nothing to ingest');
  });

  it('prints the version from package.json, not a constant', () => {
    const manifest = JSON.parse(readFileSync(cliPkg, 'utf8')) as { version: string };
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(manifest.version);
  });

  it('reads its own arguments', () => {
    // With a fixed argv, `caps` would degrade to the top-level command and
    // print help instead of the capability array.
    const r = run(['caps', '--json']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('exits 0 on --help and writes usage to stdout', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ohos-perf');
    expect(r.stderr).toBe('');
  });

  it('exits non-zero on an unknown command, with the error on stderr', () => {
    const r = run(['not-a-command']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not-a-command');
    expect(r.stdout).toBe('');
  });

  it('keeps a failing analysis at exit 1 when the output pipe is closed', async () => {
    // The regression this round fixes: an EPIPE handler that calls
    // `process.exit(0)` reports a failed analysis as success. Repeated
    // because closing the pipe is a race with the child's first write; the
    // correct implementation is 1 every time, the broken one is not.
    for (let i = 0; i < 5; i += 1) {
      const r = await runWithClosedPipe(['analyze', '/nonexistent-scene-dir'], 'stderr');
      expect(r).toEqual({ status: 1, signal: null });
    }
  });

  it('exits 0 when a successful run has its stdout pipe closed', async () => {
    // A synthetic two-frame trace, not the 17.9 MB spike DB: this test is the
    // only coverage of the stdout EPIPE handler, so it must run on every
    // machine, including a clean checkout where `spike/out/` is absent.
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-index-'));
    try {
      createTraceDb(join(dir, 'trace.db'));
      const r = await runWithClosedPipe(['analyze', dir, '--json'], 'stdout');
      expect(r).toEqual({ status: 0, signal: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The only test that validates the whole chain against a real 17.9 MB
  // recording, so it keeps the fixture dependency; `it.skipIf` makes vitest
  // report it as skipped (a bare `return` would report it as passed).
  it.skipIf(!existsSync(spikeDb))('analyzes a real scene end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-index-'));
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(spikeDb, join(dir, 'trace.db'));
      const r = run(['analyze', dir, '--json']);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      const result = JSON.parse(r.stdout) as {
        metrics: Array<{ id: string; value: number }>;
        evidence: Array<{ kind: string }>;
      };
      const metric = (id: string) => result.metrics.find((m) => m.id === id)?.value;
      expect(metric('frame.count')).toBe(169);
      expect(metric('frame.rendered.count')).toBe(161);
      expect(metric('frame.jank.rate')).toBe(37.267080745341616);
      expect(result.evidence.filter((e) => e.kind === 'jank')).toHaveLength(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the bundle is not older than the sources it was built from', () => {
    // These tests spawn `dist/index.js`, and every entry-point assertion is
    // therefore only as fresh as the last build. A stale bundle once hid a
    // deleted exit-code propagation. `git checkout` can bump a source mtime
    // without changing its content, which fails this test in the safe
    // direction: it asks for a rebuild, never lets a stale bundle pass.
    const distMtime = statSync(cliDist).mtimeMs;
    const srcMtime = newestMtime(join(here, '../src'));
    expect(
      distMtime,
      'packages/cli/dist/index.js is older than packages/cli/src — run ' +
        '`npm run build -w @ohos-perf/cli` before testing. A stale bundle makes ' +
        'every entry-point assertion validate the previous build.',
    ).toBeGreaterThanOrEqual(srcMtime);
  });
});
