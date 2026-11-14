import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Streamer, buildConvertArgv, parseVersion } from '../src/ingest/streamer';
import { IngestError, StreamerNotFoundError } from '../src/errors';

// The stub overrides spawnProcess, but this mock lets one test assert the
// real options object handed to child_process.spawn (notably `shell: false`).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

describe('buildConvertArgv', () => {
  it('passes input, -e, output in that order', () => {
    expect(buildConvertArgv('a.htrace', 'b.db')).toEqual(['a.htrace', '-e', 'b.db']);
  });
});

describe('parseVersion', () => {
  it('extracts semver from streamer banner', () => {
    expect(parseVersion('version 4.3.7')).toBe('4.3.7');
    expect(parseVersion('Trace Streamer 4.3.7 (build x)')).toBe('4.3.7');
  });

  it('returns undefined when no version is present', () => {
    expect(parseVersion('trace analyze tool')).toBeUndefined();
  });
});

describe('Streamer path handling', () => {
  it('spawns without shell so paths with spaces stay intact', () => {
    // Hermetic: a temp directory whose name contains a space stands in for the
    // DevEco install path, so no host installation is required.
    const dir = mkdtempSync(join(tmpdir(), 'ohos streamer '));
    const bin = join(dir, 'trace_streamer.exe');
    writeFileSync(bin, '');
    try {
      const s = new Streamer({ streamerPath: bin, env: { PATH: '' }, commonPaths: [] });
      const spec = s.spawnSpec('in.htrace', 'out.db');
      expect(spec.command).toBe(bin);
      expect(spec.command).toContain(' ');
      expect(spec.args).toEqual(['in.htrace', '-e', 'out.db']);
      expect(spec.shell).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the explicit path over OHOS_PERF_STREAMER', async () => {
    const explicit = join(tmpdir(), 'explicit-streamer.exe');
    const fromEnv = join(tmpdir(), 'env-streamer.exe');
    writeFileSync(explicit, '');
    writeFileSync(fromEnv, '');
    try {
      const s = new Streamer({
        streamerPath: explicit,
        env: { OHOS_PERF_STREAMER: fromEnv, PATH: '' },
      });
      expect(await s.resolvePath()).toBe(explicit);
    } finally {
      rmSync(explicit, { force: true });
      rmSync(fromEnv, { force: true });
    }
  });

  it('falls back to OHOS_PERF_STREAMER', async () => {
    const fromEnv = join(tmpdir(), 'env-streamer.exe');
    writeFileSync(fromEnv, '');
    try {
      const s = new Streamer({
        streamerPath: join(tmpdir(), 'missing-streamer.exe'),
        env: { OHOS_PERF_STREAMER: fromEnv, PATH: '' },
        commonPaths: [],
      });
      expect(await s.resolvePath()).toBe(fromEnv);
    } finally {
      rmSync(fromEnv, { force: true });
    }
  });

  it('throws StreamerNotFoundError listing every candidate', async () => {
    const s = new Streamer({
      streamerPath: 'C:/definitely/missing/trace_streamer.exe',
      env: { OHOS_PERF_STREAMER: 'C:/also/missing/trace_streamer.exe', PATH: '' },
      commonPaths: ['D:/nope/trace_streamer.exe'],
    });
    await expect(s.resolvePath()).rejects.toBeInstanceOf(StreamerNotFoundError);
    await expect(s.resolvePath()).rejects.toMatchObject({
      searchedPaths: [
        'C:/definitely/missing/trace_streamer.exe',
        'C:/also/missing/trace_streamer.exe',
        'D:/nope/trace_streamer.exe',
      ],
    });
  });
});

describe('child_process.spawn options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ohos-spawn-'));
  const bin = join(dir, 'trace_streamer.exe');
  writeFileSync(bin, '');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => spawnMock.mockReset());

  it('calls spawn with shell: false and no shell string', async () => {
    spawnMock.mockImplementation((() => {
      const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      queueMicrotask(() => {
        (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from('version 4.3.7'));
        (child as unknown as { emit: EventEmitter['emit'] }).emit('close', 0, null);
      });
      return child;
    }) as unknown as typeof spawn);

    const s = new Streamer({ streamerPath: bin, env: { PATH: '' }, commonPaths: [] });
    expect(await s.version()).toBe('4.3.7');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe(bin);
    expect(args).toEqual(['-v']);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });
});

/** Replaces process spawning so tests stay hermetic and fast. */
class StubStreamer extends Streamer {
  private static readonly dir = mkdtempSync(join(tmpdir(), 'ohos-stub-'));
  static readonly bin = join(StubStreamer.dir, 'trace_streamer.exe');
  static cleanup(): void {
    rmSync(StubStreamer.dir, { recursive: true, force: true });
  }
  static {
    writeFileSync(StubStreamer.bin, '');
  }
  calls: Array<{ command: string; args: string[]; shell: boolean }> = [];
  versionBanner = 'version 4.3.7\n';
  versionStream: 'stdout' | 'stderr' = 'stdout';
  versionExitCode = 0;
  exitCode = 0;
  killSignal: NodeJS.Signals | null = null;
  stderr = '';
  writeOutput = true;

  constructor() {
    super({ streamerPath: StubStreamer.bin, env: { PATH: '' }, commonPaths: [] });
  }

  protected override async spawnProcess(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number | null; signal?: NodeJS.Signals | null }> {
    this.calls.push({ command, args, shell: false });
    if (args.includes('-v')) {
      return this.versionStream === 'stderr'
        ? { stdout: '', stderr: this.versionBanner, code: this.versionExitCode, signal: null }
        : { stdout: this.versionBanner, stderr: '', code: this.versionExitCode, signal: null };
    }
    const out = args[args.indexOf('-e') + 1];
    if (this.writeOutput && out) {
      writeFileSync(out, 'sqlite');
      // The real 4.3.7 binary always writes this sidecar beside the DB.
      writeFileSync(out + '.ohos.ts', 'sidecar');
    }
    if (this.killSignal) {
      return { stdout: '', stderr: this.stderr, code: null, signal: this.killSignal };
    }
    return { stdout: '', stderr: this.stderr, code: this.exitCode, signal: null };
  }

  /** Calls after the version probe, i.e. the conversion invocation(s). */
  get convertCalls(): Array<{ command: string; args: string[]; shell: boolean }> {
    return this.calls.filter((c) => !c.args.includes('-v'));
  }
}

afterAll(() => StubStreamer.cleanup());

describe('Streamer.version / assertSupported', () => {
  it('reads the banner and accepts 4.3.7', async () => {
    const s = new StubStreamer();
    expect(await s.version()).toBe('4.3.7');
    await expect(s.assertSupported()).resolves.toBeUndefined();
    expect(s.calls[0]).toEqual({
      command: StubStreamer.bin,
      args: ['-v'],
      shell: false,
    });
  });

  it('accepts the real banner shape: stderr and exit 1', async () => {
    const s = new StubStreamer();
    s.versionStream = 'stderr';
    s.versionExitCode = 1;
    s.versionBanner = 'version 4.3.7\r\n';
    expect(await s.version()).toBe('4.3.7');
    await expect(s.assertSupported()).resolves.toBeUndefined();
  });

  it('orders versions numerically: 4.10.0 is accepted', async () => {
    const s = new StubStreamer();
    s.versionBanner = 'version 4.10.0';
    expect(await s.version()).toBe('4.10.0');
    await expect(s.assertSupported()).resolves.toBeUndefined();
  });

  it('rejects versions older than 4.3.0', async () => {
    const s = new StubStreamer();
    s.versionBanner = 'version 4.2.9';
    await expect(s.assertSupported()).rejects.toBeInstanceOf(IngestError);
    await expect(s.assertSupported()).rejects.toThrow(/4\.3\.0/);
  });

  it('rejects an unparseable banner', async () => {
    const s = new StubStreamer();
    s.versionBanner = 'trace analyze tool';
    await expect(s.assertSupported()).rejects.toBeInstanceOf(IngestError);
  });
});

describe('Streamer.convert', () => {
  let dir: string;
  let output: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohos-streamer-'));
    output = join(dir, 'out.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gates on assertSupported before spawning the conversion', async () => {
    const s = new StubStreamer();
    s.versionBanner = 'version 4.2.9';
    await expect(s.convert(join(dir, 'in.htrace'), output)).rejects.toBeInstanceOf(IngestError);
    expect(s.convertCalls).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });

  it('spawns input -e <temp> and renames the result into place', async () => {
    const s = new StubStreamer();
    const input = join(dir, 'in.htrace');
    await s.convert(input, output);

    const [call] = s.convertCalls;
    expect(call.command).toBe(StubStreamer.bin);
    expect(call.shell).toBe(false);
    expect(call.args[0]).toBe(input);
    expect(call.args[1]).toBe('-e');
    // Written to a sibling temp path, not straight to the final output.
    expect(call.args[2]).toMatch(
      new RegExp(`^${escapeRegExp(output)}\\.tmp-\\d+-\\d+$`),
    );
    expect(existsSync(output)).toBe(true);
    // The `.ohos.ts` sidecar is moved alongside the DB, not left temp-named.
    expect(existsSync(output + '.ohos.ts')).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('throws IngestError with STREAMER_EXIT_<code> on non-zero exit', async () => {
    const s = new StubStreamer();
    s.exitCode = 3;
    s.stderr = 'parse failed';
    const err = await s.convert(join(dir, 'in.htrace'), output).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'STREAMER_EXIT_3', stderr: 'parse failed' });
  });

  it('throws when exit is 0 but no database was produced', async () => {
    const s = new StubStreamer();
    s.writeOutput = false;
    const err = await s.convert(join(dir, 'in.htrace'), output).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'STREAMER_NO_OUTPUT' });
  });

  it('treats signal termination as failure, even with a partial database', async () => {
    const s = new StubStreamer();
    s.killSignal = 'SIGKILL';
    const err = await s.convert(join(dir, 'in.htrace'), output).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ code: 'STREAMER_KILLED_SIGKILL' });
    expect((err as IngestError).message).toContain('SIGKILL');
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a failed conversion leaves a pre-existing good database intact', async () => {
    writeFileSync(output, 'good-db');
    const s = new StubStreamer();
    s.exitCode = 1;
    s.writeOutput = false;
    await expect(s.convert(join(dir, 'in.htrace'), output)).rejects.toBeInstanceOf(IngestError);
    expect(existsSync(output)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(readdirSync(dir)).toEqual(['out.db']);
  });

  it('a successful conversion replaces the old database', async () => {
    writeFileSync(output, 'old-db');
    const s = new StubStreamer();
    await s.convert(join(dir, 'in.htrace'), output);
    expect(existsSync(output)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(output, 'utf8')).toBe('sqlite');
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
