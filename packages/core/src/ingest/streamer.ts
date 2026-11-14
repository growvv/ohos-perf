import { spawn } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { IngestError, StreamerNotFoundError } from '../errors';

export interface StreamerOptions {
  /** Explicit trace_streamer executable. Checked first by resolvePath(). */
  streamerPath?: string;
  /** Environment used both for spawning and for OHOS_PERF_STREAMER / PATH lookup. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the built-in DevEco candidate list. Tests pass `[]` so the search
   * list is exactly the one they assert on.
   */
  commonPaths?: string[];
}

export interface SpawnSpec {
  command: string;
  args: string[];
  shell: false;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  /** Null when the process was terminated by a signal. */
  code: number | null;
  signal?: NodeJS.Signals | null;
}

/** Minimum trace_streamer version whose `-e` SQLite output we understand. */
const MIN_VERSION: readonly [number, number, number] = [4, 3, 0];

/** Metadata file the 4.3.7 binary writes beside every converted database. */
const SIDECAR_SUFFIX = '.ohos.ts';

/**
 * `trace_streamer.exe FILE -e sqlite_out.db` is the convert invocation printed
 * by the 4.3.7 binary itself. `-nm`, `-tn`, `-c` and `-D` exist but are not
 * used here; this builder only ever emits the plain conversion form.
 */
export function buildConvertArgv(inputPath: string, outputDbPath: string): string[] {
  return [inputPath, '-e', outputDbPath];
}

/** First `\d+.\d+.\d+` in a banner such as `version 4.3.7`. */
export function parseVersion(banner: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(banner)?.[1];
}

function streamerBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'trace_streamer.exe' : 'trace_streamer';
}

/** DevEco installs that ship trace_streamer, in probe order. */
function defaultCommonPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const tail = ['tools', 'profiler', 'dic_server', streamerBinName()];
  return [
    join('D:', 'Application', 'DevEco Studio', ...tail),
    join('C:', 'Program Files', 'Huawei', 'DevEco Studio', ...tail),
  ];
}

function compareVersions(a: string, b: readonly [number, number, number]): number {
  const parts = a.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (parts[i] ?? 0) - b[i];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export class Streamer {
  private readonly opts: StreamerOptions;
  private readonly env: NodeJS.ProcessEnv;
  private resolvedPath?: string;
  private parsedVersion?: string;
  /** Per-instance temp-name counter; deterministic across runs and processes. */
  private tempCounter = 0;

  constructor(opts: StreamerOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
  }

  /**
   * Search order: explicit path -> OHOS_PERF_STREAMER -> common DevEco
   * installs -> PATH. Throws StreamerNotFoundError listing every candidate.
   */
  async resolvePath(): Promise<string> {
    return this.resolvePathSync();
  }

  /**
   * Banner version, e.g. `4.3.7`. The real 4.3.7 binary prints `version 4.3.7`
   * to **stderr** and exits 1 for `-v`, so the banner is what counts, not the
   * exit code or the stream.
   */
  async version(): Promise<string> {
    if (this.parsedVersion) return this.parsedVersion;
    const spec = this.spawnSpecFor(['-v']);
    const result = await this.spawnProcess(spec.command, spec.args);
    const parsed = parseVersion(result.stdout) ?? parseVersion(result.stderr);
    if (!parsed) {
      throw new IngestError(
        `Could not determine trace_streamer version from \`${spec.command} -v\`` +
          ` (exit code ${result.code})`,
        result.stderr,
        'STREAMER_VERSION_UNKNOWN',
      );
    }
    this.parsedVersion = parsed;
    return parsed;
  }

  /** Requires >= 4.3.0; older or unparseable versions throw IngestError. */
  async assertSupported(): Promise<void> {
    const version = await this.version();
    if (compareVersions(version, MIN_VERSION) < 0) {
      throw new IngestError(
        `trace_streamer ${version} is not supported; version >= ${MIN_VERSION.join('.')} is required`,
        '',
        'STREAMER_VERSION_UNSUPPORTED',
      );
    }
  }

  /**
   * Convert an `.htrace` capture into a SQLite database.
   *
   * The converter writes to a sibling temp path and is renamed over the real
   * output only on success, so a failed conversion leaves any previously-good
   * database untouched. A non-zero exit, a signal termination, or exit 0
   * without a fresh file all fail. Every filesystem failure is surfaced as an
   * IngestError, never a raw fs error.
   */
  async convert(inputPath: string, outputDbPath: string): Promise<void> {
    await this.assertSupported();

    const tempPath = `${outputDbPath}.tmp-${process.pid}-${this.tempCounter++}`;
    const tempSidecar = tempPath + SIDECAR_SUFFIX;
    const spec = this.spawnSpec(inputPath, tempPath);
    let committed = false;
    try {
      const result = await this.spawnProcess(spec.command, spec.args);

      if (result.signal) {
        throw new IngestError(
          `trace_streamer was killed by signal ${result.signal} while converting ${inputPath}`,
          result.stderr,
          `STREAMER_KILLED_${result.signal}`,
        );
      }
      // code === null without a signal name still means "not a normal exit".
      if (result.code === null) {
        throw new IngestError(
          `trace_streamer did not exit normally while converting ${inputPath}`,
          result.stderr,
          'STREAMER_KILLED_UNKNOWN',
        );
      }
      if (result.code !== 0) {
        throw new IngestError(
          `trace_streamer failed converting ${inputPath} (exit code ${result.code})`,
          result.stderr,
          `STREAMER_EXIT_${result.code}`,
        );
      }
      if (!existsSync(tempPath)) {
        throw new IngestError(
          `trace_streamer exited 0 but produced no database for ${inputPath}`,
          result.stderr,
          'STREAMER_NO_OUTPUT',
        );
      }

      try {
        // Same-directory rename: atomic overwrite on POSIX and Windows.
        renameSync(tempPath, outputDbPath);
      } catch (err) {
        throw new IngestError(
          `Failed to move converted database into place at ${outputDbPath}: ${(err as Error).message}`,
          result.stderr,
          'STREAMER_FS_FAILED',
          { cause: err },
        );
      }
      committed = true;

      // The binary also emits `<output>.ohos.ts` beside the DB. Move it along
      // so no temp-named sidecar is orphaned; its absence is not a failure.
      try {
        if (existsSync(tempSidecar)) renameSync(tempSidecar, outputDbPath + SIDECAR_SUFFIX);
      } catch {
        /* metadata only */
      }
    } finally {
      // Never mask the original failure with a cleanup error. After commit the
      // temp DB is gone; only an orphaned temp sidecar could remain.
      for (const p of [tempPath, tempSidecar]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * `shell: false` is mandatory: the DevEco install path contains spaces, and
   * a shell would split `D:/Application/DevEco Studio/...` into pieces.
   */
  spawnSpec(inputPath: string, outputDbPath: string): SpawnSpec {
    return this.spawnSpecFor(buildConvertArgv(inputPath, outputDbPath));
  }

  private spawnSpecFor(args: string[]): SpawnSpec {
    return { command: this.resolvePathSync(), args, shell: false };
  }

  /** Spawn without a shell so spaces in the executable path stay intact. */
  protected spawnProcess(command: string, args: string[]): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        env: this.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        reject(
          new IngestError(`Failed to spawn trace_streamer (${command}): ${err.message}`, '', 'STREAMER_SPAWN_FAILED', {
            cause: err,
          }),
        );
      });
      child.on('close', (code, signal) => {
        resolve({ stdout, stderr, code, signal });
      });
    });
  }

  private resolvePathSync(): string {
    if (this.resolvedPath) return this.resolvedPath;

    const candidates: string[] = [];
    const push = (p: string | undefined): void => {
      if (p && !candidates.includes(p)) candidates.push(p);
    };

    push(this.opts.streamerPath);
    push(this.env.OHOS_PERF_STREAMER);
    for (const p of this.opts.commonPaths ?? defaultCommonPaths()) push(p);

    const bin = streamerBinName();
    for (const dir of (this.env.PATH ?? '').split(delimiter)) {
      if (dir) push(join(dir, bin));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.resolvedPath = candidate;
        return candidate;
      }
    }
    throw new StreamerNotFoundError(candidates);
  }
}
