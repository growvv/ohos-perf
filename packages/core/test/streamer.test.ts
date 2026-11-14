import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Streamer, buildConvertArgv, parseVersion } from '../src/ingest/streamer';
import { IngestError, StreamerNotFoundError } from '../src/errors';

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
    const s = new Streamer({ streamerPath: 'D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe' });
    const spec = s.spawnSpec('in.htrace', 'out.db');
    expect(spec.command).toBe('D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe');
    expect(spec.args).toEqual(['in.htrace', '-e', 'out.db']);
    expect(spec.shell).toBe(false);
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

/** Replaces process spawning so tests stay hermetic and fast. */
class StubStreamer extends Streamer {
  static readonly bin = join(mkdtempSync(join(tmpdir(), 'ohos-stub-')), 'trace_streamer.exe');
  static {
    writeFileSync(StubStreamer.bin, '');
  }
  calls: Array<{ command: string; args: string[]; shell: boolean }> = [];
  versionBanner = 'version 4.3.7\n';
  versionStream: 'stdout' | 'stderr' = 'stdout';
  versionExitCode = 0;
  exitCode = 0;
  stderr = '';
  writeOutput = true;

  constructor() {
    super({ streamerPath: StubStreamer.bin, env: { PATH: '' } });
  }

  protected override async spawnProcess(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    this.calls.push({ command, args, shell: false });
    if (args.includes('-v')) {
      return this.versionStream === 'stderr'
        ? { stdout: '', stderr: this.versionBanner, code: this.versionExitCode }
        : { stdout: this.versionBanner, stderr: '', code: this.versionExitCode };
    }
    const out = args[args.indexOf('-e') + 1];
    if (this.writeOutput && out) writeFileSync(out, 'sqlite');
    return { stdout: '', stderr: this.stderr, code: this.exitCode };
  }
}

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

  it('spawns input -e output with shell disabled', async () => {
    const s = new StubStreamer();
    await s.convert(join(dir, 'in.htrace'), output);
    expect(s.calls[0]).toEqual({
      command: StubStreamer.bin,
      args: [join(dir, 'in.htrace'), '-e', output],
      shell: false,
    });
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

  it('does not accept a stale database left by an earlier run', async () => {
    writeFileSync(output, 'stale');
    const s = new StubStreamer();
    s.writeOutput = false;
    await expect(s.convert(join(dir, 'in.htrace'), output)).rejects.toBeInstanceOf(IngestError);
    expect(existsSync(output)).toBe(false);
  });
});
