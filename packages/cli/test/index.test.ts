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
  writeFileSync,
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

/**
 * Drop the warnings Node itself prints for `node:sqlite`.
 *
 * Node 22.13 through 25.x (all inside the supported `^22.13.0 || >=23.4.0`
 * range) prints an `ExperimentalWarning` plus a `--trace-warnings` hint on
 * stderr the first time the builtin loads; measured on 22.13, 23.4, 24.0 and
 * 25.0, absent on 26.13. That is a property of the runtime, not of the CLI,
 * so assertions about the CLI's own stderr must ignore exactly those two
 * lines. Anything else stays visible.
 */
function cliStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(line) &&
        !/^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/.test(line),
    )
    .join('\n')
    .trim();
}

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
    // print help instead of running a capability report. The outcome depends
    // on the host: a developer machine may have hdc and a device, a CI runner
    // has neither. Both outcomes prove the argv reached `caps`; a fall-back
    // to top-level help parses as JSON in neither branch.
    const r = run(['caps', '--json']);
    expect(r.stderr).not.toContain('Usage: ohos-perf');
    if (r.status === 0) {
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    } else {
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(cliStderr(r.stderr)).toContain('hdc unavailable');
    }
  });

  it('exits 0 on --help and writes usage to stdout', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ohos-perf');
    expect(cliStderr(r.stderr)).toBe('');
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
      expect(cliStderr(r.stderr)).toBe('');
      const result = JSON.parse(r.stdout) as {
        metrics: Array<{ id: string; value: number }>;
        evidence: Array<{ kind: string }>;
      };
      const metric = (id: string) => result.metrics.find((m) => m.id === id)?.value;
      expect(metric('frame.count')).toBe(169);
      expect(metric('frame.rendered.count')).toBe(161);
      expect(metric('frame.jank.rate')).toBe(37.267080745341616);
      expect(result.evidence.filter((e) => e.kind === 'jank')).toHaveLength(60);
      // Only trace.db was copied: no scene.json and no --app means the app was
      // never identified, so binder must be absent, not a confident zero.
      expect(result.metrics.some((m) => m.id === 'binder.transactions.count')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs query against a scene with --json', () => {
    // The pure command layer and the deps layer are both covered elsewhere;
    // this is the only test that proves `query` works through the built
    // entry point (argument parsing, io.emit and the exit code).
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-index-query-'));
    try {
      createTraceDb(join(dir, 'trace.db'));
      const r = run(['query', dir, 'frames.all',
        '--args', '{"window":{"startNs":0,"endNs":2000}}', '--limit', '2', '--json']);
      expect(r.status).toBe(0);
      expect(cliStderr(r.stderr)).toBe('');
      const parsed = JSON.parse(r.stdout) as {
        query: string; rows: unknown[]; total: number; truncated: boolean;
      };
      expect(parsed.query).toBe('frames.all');
      expect(parsed.rows.length).toBeLessThanOrEqual(2);
      expect(parsed.truncated).toBe(parsed.total > parsed.rows.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // I1: a scene.json written by collect supplies the app without --app.
  it.skipIf(!existsSync(spikeDb))('analyzes a real scene from its scene.json without --app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-index-'));
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(spikeDb, join(dir, 'trace.db'));
      writeFileSync(join(dir, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'pbench.baseline', processNames: ['pbench.baseline'] },
        pids: [16702], deviceId: 'offline',
      }));
      const r = run(['analyze', dir, '--json']);
      expect(r.status).toBe(0);
      expect(cliStderr(r.stderr)).toBe('');
      const result = JSON.parse(r.stdout) as {
        metrics: Array<{ id: string; value: number }>;
      };
      const metric = (id: string) => result.metrics.find((m) => m.id === id)?.value;
      expect(metric('binder.transactions.count')).toBe(372);
      expect(metric('fault.arkui.HandleOnAreaChangeEvent')).toBe(51);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Full-analyzer wiring: the offline capability matrix must let fault-tree,
  // binder and threads run (not degrade) on a trace that has their tables.
  it.skipIf(!existsSync(spikeDb))('runs every analyzer with byte-identical --json output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-index-'));
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(spikeDb, join(dir, 'trace.db'));
      const first = run(['analyze', dir, '--json', '--app', 'pbench.baseline']);
      const second = run(['analyze', dir, '--json', '--app', 'pbench.baseline']);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(cliStderr(first.stderr)).toBe('');
      expect(cliStderr(second.stderr)).toBe('');
      // Byte-identical, not merely deep-equal: `analyze --json` is a stable
      // machine contract (D5).
      expect(first.stdout).toBe(second.stdout);
      const result = JSON.parse(first.stdout) as {
        metrics: Array<{ id: string; value: number | string }>;
        evidence: Array<{ kind: string }>;
      };
      const ids = result.metrics.map((m) => m.id);
      expect(ids).toContain('fault.arkui.HandleOnAreaChangeEvent');
      expect(ids).toContain('binder.transactions.count');
      expect(ids).toContain('thread.patterns.count');
      // No analyzer was silently degraded on a trace with all core tables.
      expect(ids).not.toContain('fault-tree.degraded');
      expect(ids).not.toContain('binder.degraded');
      expect(ids).not.toContain('threads.degraded');
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

/*
 * P33 task 4 — the contract from the built binary.
 *
 * A commander usage error never reaches an action, so the envelope cannot be
 * built in `program.ts`: `index.ts` is the only place that sees the failure
 * and still knows argv. Help is deliberately not a result — an agent asking
 * for it wants the text.
 */
describe('tool-result contract from the built binary', () => {
  it('prints one envelope for a missing required option', () => {
    const r = run(['root-cause', '--machine-json']);
    expect(r.status).toBe(1);
    const lines = r.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: '1.0',
      toolId: 'ohos-perf',
      command: 'root-cause',
      success: false,
      exitCode: 1,
      error: { code: 'CLI_USAGE' },
    });
  });

  it('writes the envelope to --result-file and creates its parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-contract-'));
    const path = join(dir, 'nested', 'result.json');
    const r = run(['root-cause', '--machine-json', '--result-file', path]);
    expect(r.status).toBe(1);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { error: { code: string } };
    expect(written.error.code).toBe('CLI_USAGE');
  });

  it('still prints help as text under --machine-json', () => {
    const r = run(['--help', '--machine-json']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ohos-perf');
    expect(r.stdout).not.toContain('"schemaVersion"');
  });

  it('prints no envelope when neither flag was given', () => {
    const r = run(['root-cause']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(cliStderr(r.stderr)).toContain('--out');
  });

  it('prints a usage error once, not twice', () => {
    // Commander writes its own message through `writeErr` before the catch
    // sees the error. Printing it again turns one usage line into two, which
    // reads as a repeated failure rather than one.
    const r = run(['--bogus']);
    expect(r.status).toBe(1);
    const occurrences = cliStderr(r.stderr).split('\n')
      .filter((line) => line.includes("unknown option '--bogus'"));
    expect(occurrences).toHaveLength(1);
  });

  it('prints a usage error once under --machine-json too', () => {
    const r = run(['--bogus', '--machine-json']);
    expect(r.status).toBe(1);
    const occurrences = cliStderr(r.stderr).split('\n')
      .filter((line) => line.includes("unknown option '--bogus'"));
    expect(occurrences).toHaveLength(1);
    expect(JSON.parse(r.stdout).error.code).toBe('CLI_USAGE');
  });

  it('exits 0 and prints help text for the help subcommand', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ohos-perf');
    // Commander's own exit placeholder is not a message for a user.
    expect(cliStderr(r.stderr)).toBe('');
    expect(r.stdout).not.toContain('(outputHelp)');
  });

  it('prints a bare group\'s help without its exit placeholder', () => {
    // Commander writes a bare group's help to stderr with exit 1 (the group
    // names no subcommand, which is its own long-standing choice). What it
    // must not also print is the `(outputHelp)` message it exits with.
    const r = run(['emulator']);
    expect(r.status).toBe(1);
    expect(cliStderr(r.stderr)).toContain('Usage: ohos-perf emulator');
    expect(r.stdout).toBe('');
    expect(cliStderr(r.stderr)).not.toContain('(outputHelp)');
  });

  it('reads the command path past a --result-file that precedes it', () => {
    // The flag's value is not a command name. An argv walker that took the
    // first non-dash token labelled this run `out/r.json`.
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-path-'));
    const path = join(dir, 'r.json');
    const r = run(['--result-file', path, 'root-cause']);
    expect(r.status).toBe(1);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { command: string };
    expect(written.command).toBe('root-cause');
  });
});

/*
 * P34 — the MCP server.
 *
 * The built binary is the only honest place to test this: the framing is a
 * property of the process (stdin in, one line out per message), and a harness
 * that called `handle()` directly would not prove the command is reachable or
 * that nothing else writes to stdout.
 */
describe('mcp over stdio', () => {
  const MODERN = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  it('answers server/discover and tools/list, one line each', () => {
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN } }),
    ].join('\n') + '\n';
    const r = spawnSync(process.execPath, [cliDist, 'mcp'], { encoding: 'utf8', input });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((line) => line !== '');
    // Nothing but MCP messages: one JSON-RPC response per request.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).result.supportedVersions).toContain('2026-07-28');
    const names = JSON.parse(lines[1]!).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('ohos-perf_analyze');
    expect(names).toContain('ohos-perf_emulator_list');
    expect(names).toContain('ohos-perf_gesture_click');
  });

  it('serves the legacy handshake too, because an old client should still measure', () => {
    const input = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    }) + '\n';
    const r = spawnSync(process.execPath, [cliDist, 'mcp'], { encoding: 'utf8', input });
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout.split('\n')[0]!).result;
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo.name).toBe('ohos-perf');
  });

  it('runs a real tool call and returns the envelope', () => {
    // A failing analysis, because it needs no device and no fixture: the point
    // is that a call reaches a command and comes back as an envelope.
    const input = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { _meta: MODERN, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/nonexistent' } },
    }) + '\n';
    const r = spawnSync(process.execPath, [cliDist, 'mcp'], { encoding: 'utf8', input });
    expect(r.status).toBe(0);
    const { result } = JSON.parse(r.stdout.split('\n')[0]!);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('SCENE_NO_INPUT');
    expect(result.structuredContent.command).toBe('analyze');
  });

  it('keeps serving after a malformed line', () => {
    const input = [
      '{not json',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN } }),
    ].join('\n') + '\n';
    const r = spawnSync(process.execPath, [cliDist, 'mcp'], { encoding: 'utf8', input });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n').filter((line) => line !== '');
    expect(JSON.parse(lines[0]!).error.code).toBe(-32700);
    expect(JSON.parse(lines[1]!).result.tools.length).toBeGreaterThan(20);
  });
});
