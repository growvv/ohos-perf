import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DeviceNotFoundError, HdcNotFoundError, OhosPerfError } from '../errors';

/**
 * Environment variables passed to spawned processes.
 *
 * Structurally identical to Node's `ProcessEnv` (`Record<string, string |
 * undefined>`) but declared here so the published declarations do not depend on
 * `@types/node` being installed in the consumer's project.
 */
export type Env = Record<string, string | undefined>;

export interface HdcOptions {
  /** Explicit hdc executable. Checked first by resolvePath(). */
  hdcPath?: string;
  /** Environment used both for spawning and for OHOS_PERF_HDC / PATH lookup. */
  env?: Env;
  /**
   * Override the built-in SDK candidate list. Tests pass `[]` so the search
   * list is exactly the one they assert on.
   */
  commonPaths?: string[];
}

export interface HdcTarget {
  id: string;
  connected: boolean;
  /** Original `hdc list targets -v` line, with the trailing CR removed. */
  raw: string;
}

export interface HdcResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type HdcOp = 'shell' | 'recv' | 'send' | 'tconn' | 'fport' | 'listTargets';

export interface HdcArgvParams {
  shell: { target: string; cmd: string };
  recv: { target: string; devicePath: string; localPath: string };
  send: { target: string; localPath: string; devicePath: string };
  tconn: { target: string };
  fport: { target: string; local: number; remote: number };
  listTargets: Record<string, never>;
}

/**
 * hdc writes `[Fail]...` diagnostics to stdout and still exits 0. Some builds
 * decorate the prefix (`hdc: [Fail]...`), so allow that before the marker.
 */
const FAIL_PREFIX = /^[ \t]*(?:hdc:[ \t]*)?\[Fail\]/m;
/** hdc emits these when the connect key does not name a live device. */
const TARGET_MISSING = /Not match target founded|need connect-key|\[E001005\]/;
/** Positive completion markers. Without one, a transfer is not successful. */
const SUCCESS_MARKER = {
  recv: /FileTransfer finish/,
  send: /FileTransfer finish/,
  fport: /Forwardport result:[ \t]*OK/,
} as const;
/** Listing lines that mean "nothing to show" rather than "command failed". */
const EMPTY_LISTING = /^[ \t]*\[(Empty|Info|Warning)\]/;

/**
 * hdc on Windows joins drive-letter paths that use forward slashes onto the
 * working directory (`E:/x/y` becomes `<cwd>\E:/x/y`), while `E:\x\y` and
 * relative paths work. Normalize absolute Windows paths to backslashes.
 * Relative paths are left alone so callers keep control of the working dir.
 */
export function normalizeLocalPath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return p;
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\//g, '\\');
  return p;
}

function hdcBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'hdc.exe' : 'hdc';
}

/** SDK roots that ship hdc, in probe order. */
function defaultCommonPaths(env: Env): string[] {
  const bin = hdcBinName();
  const tail = ['openharmony', 'toolchains', bin];
  const paths: string[] = [];
  if (process.platform === 'win32') {
    paths.push(
      join('D:', 'Application', 'DevEco Studio', 'sdk', 'default', ...tail),
      join('C:', 'Program Files', 'Huawei', 'DevEco Studio', 'sdk', 'default', ...tail),
    );
  }

  const sdkRoots = [
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Huawei', 'Sdk') : undefined,
    env.HOME ? join(env.HOME, 'Huawei', 'Sdk') : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const root of sdkRoots) {
    if (!existsSync(root)) continue;
    paths.push(join(root, 'default', ...tail));
    let versions: string[];
    try {
      versions = readdirSync(root)
        .filter((name) => {
          try {
            return statSync(join(root, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      continue;
    }
    for (const version of versions) {
      paths.push(join(root, version, ...tail));
    }
  }
  return paths;
}

export class Hdc {
  private readonly opts: HdcOptions;
  private readonly env: Env;
  private resolvedPath?: string;

  constructor(opts: HdcOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
  }

  /**
   * Pure argv builder. `shell` keeps the whole command as one argv element and
   * `shell: false` is used at spawn time, so nothing is re-parsed or quoted.
   */
  buildArgv<K extends HdcOp>(op: K, params: HdcArgvParams[K]): string[] {
    switch (op) {
      case 'shell': {
        const { target, cmd } = params as HdcArgvParams['shell'];
        return ['-t', target, 'shell', cmd];
      }
      case 'recv': {
        const { target, devicePath, localPath } = params as HdcArgvParams['recv'];
        return ['-t', target, 'file', 'recv', devicePath, localPath];
      }
      case 'send': {
        const { target, localPath, devicePath } = params as HdcArgvParams['send'];
        return ['-t', target, 'file', 'send', localPath, devicePath];
      }
      case 'tconn': {
        const { target } = params as HdcArgvParams['tconn'];
        return ['tconn', target];
      }
      case 'fport': {
        const { target, local, remote } = params as HdcArgvParams['fport'];
        return ['-t', target, 'fport', `tcp:${local}`, `tcp:${remote}`];
      }
      case 'listTargets':
        return ['list', 'targets', '-v'];
      default: {
        const exhaustive: never = op;
        throw new OhosPerfError(`Unsupported hdc operation: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * MSYS_NO_PATHCONV stops Git Bash from rewriting `/data/local/tmp/...` into
   * a Windows path before hdc ever sees it. Always on, never overridable.
   */
  buildEnv(base: Env): Env {
    return { ...base, MSYS_NO_PATHCONV: '1' };
  }

  /**
   * Search order: explicit path -> OHOS_PERF_HDC -> common SDK installs ->
   * PATH. Throws HdcNotFoundError listing every candidate in order.
   */
  async resolvePath(): Promise<string> {
    if (this.resolvedPath) return this.resolvedPath;

    const candidates: string[] = [];
    const push = (p: string | undefined): void => {
      if (p && !candidates.includes(p)) candidates.push(p);
    };

    push(this.opts.hdcPath);
    push(this.env.OHOS_PERF_HDC);
    for (const p of this.opts.commonPaths ?? defaultCommonPaths(this.env)) push(p);

    const bin = hdcBinName();
    for (const dir of (this.env.PATH ?? '').split(delimiter)) {
      if (dir) push(join(dir, bin));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.resolvedPath = candidate;
        return candidate;
      }
    }
    throw new HdcNotFoundError(candidates);
  }

  /** `hdc list targets -v`; only status `Connected` counts as usable. */
  async listTargets(): Promise<HdcTarget[]> {
    return (await this.listTargetsRaw()).targets;
  }

  /**
   * Like listTargets(), but also returns the raw `hdc list targets -v` text so
   * callers (DeviceNotFoundError.targetsOutput) do not need a second call.
   *
   * A genuine empty listing (`[Empty]`, no lines, or hdc's "Not match target
   * founded") yields zero targets. Any other `[Fail]` line is a server error
   * and throws, so "hdc is broken" is never mistaken for "no devices".
   */
  async listTargetsRaw(): Promise<{ targets: HdcTarget[]; raw: string }> {
    const result = await this.run(this.buildArgv('listTargets', {}));
    const raw = result.stdout;
    if (result.code !== 0) {
      throw new OhosPerfError(
        `hdc list targets failed: exit code ${result.code}${failDetail(result) ? ` (${failDetail(result)})` : ''}`,
        { code: 'HDC_LIST_TARGETS_FAILED' },
      );
    }

    const targets: HdcTarget[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.replace(/\r$/, '');
      const trimmed = stripped.trim();
      if (!trimmed || EMPTY_LISTING.test(stripped)) continue;

      if (FAIL_PREFIX.test(stripped)) {
        // Not an error: hdc simply has no target matching the connect key.
        if (/Not match target founded/i.test(trimmed)) continue;
        throw new OhosPerfError(`hdc list targets failed: ${trimmed}`, {
          code: 'HDC_LIST_TARGETS_FAILED',
        });
      }

      // Real format: id \t \t transport \t status \t host \t server. A line
      // without tabs is not a target row and must not become a fake target.
      if (!stripped.includes('\t')) continue;
      const fields = stripped
        .split(/\t+/)
        .map((f) => f.trim())
        .filter(Boolean);
      const id = fields[0];
      if (!id || fields.length < 2) continue;
      const status = fields.length >= 3 ? fields[2] : fields[1];
      targets.push({ id, connected: status === 'Connected', raw: stripped });
    }
    return { targets, raw };
  }

  /**
   * Best-effort connect. USB targets answer `[Fail]CreateConnect failed` while
   * already usable, so the authoritative liveness signal is listTargets().
   */
  async tconn(target: string): Promise<void> {
    try {
      await this.run(this.buildArgv('tconn', { target }));
    } catch (err) {
      // A missing hdc binary is not a "connect failed" condition; surface it.
      if (err instanceof HdcNotFoundError) throw err;
      // Deliberately swallowed; callers verify via listTargets().
    }
  }

  async shell(target: string, cmd: string): Promise<HdcResult> {
    const result = await this.run(this.buildArgv('shell', { target, cmd }));
    this.assertTargetAlive(result.stdout);
    // No success marker exists for shell: empty output is legitimate. A
    // non-zero exit is still proof of failure.
    if (result.code !== 0) {
      throw new OhosPerfError(
        `hdc shell failed: exit code ${result.code}${failDetail(result) ? ` (${failDetail(result)})` : ''}`,
        { code: 'HDC_SHELL_FAILED' },
      );
    }
    return result;
  }

  async recv(target: string, devicePath: string, localPath: string): Promise<void> {
    const result = await this.run(
      this.buildArgv('recv', {
        target,
        devicePath,
        localPath: normalizeLocalPath(localPath),
      }),
    );
    this.assertSuccess('recv', result);
  }

  async send(target: string, localPath: string, devicePath: string): Promise<void> {
    const result = await this.run(
      this.buildArgv('send', {
        target,
        localPath: normalizeLocalPath(localPath),
        devicePath,
      }),
    );
    this.assertSuccess('send', result);
  }

  async fport(target: string, local: number, remote: number): Promise<void> {
    const result = await this.run(this.buildArgv('fport', { target, local, remote }));
    this.assertSuccess('fport', result);
  }

  /** Spawn without a shell so spaces and device paths pass through untouched. */
  protected run(args: string[]): Promise<HdcResult> {
    return this.spawnHdc(args);
  }

  private async spawnHdc(args: string[]): Promise<HdcResult> {
    const command = await this.resolvePath();
    return new Promise<HdcResult>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        env: this.buildEnv(this.env),
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
          new OhosPerfError(`Failed to spawn hdc (${command}): ${err.message}`, {
            cause: err,
            code: 'HDC_SPAWN_FAILED',
          }),
        );
      });
      child.on('close', (code) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  private assertTargetAlive(stdout: string): void {
    if (TARGET_MISSING.test(stdout)) {
      throw new DeviceNotFoundError(stdout.trim());
    }
  }

  /**
   * hdc exits 0 even when a transfer fails, so success needs both:
   *   1. exit code 0, and
   *   2. a positive completion marker on stdout.
   * Without the marker an empty/truncated/unrecognised response would read as
   * success and leave a stale destination file behind.
   *
   * `[Fail]` on stdout always fails. `[Fail]` on stderr only fails when stdout
   * has no success marker, so a benign stderr warning cannot mask a good
   * transfer.
   */
  private assertSuccess(op: 'recv' | 'send' | 'fport', result: HdcResult): void {
    this.assertTargetAlive(result.stdout);

    const stdoutOk = SUCCESS_MARKER[op].test(result.stdout);
    const failOnStdout = FAIL_PREFIX.test(result.stdout);
    const failOnStderrOnly = !stdoutOk && FAIL_PREFIX.test(result.stderr);

    if (result.code !== 0 || failOnStdout || failOnStderrOnly || !stdoutOk) {
      let detail: string;
      if (result.code !== 0) {
        const context = failDetail(result) || firstLine(result);
        detail = `exit code ${result.code}${context ? ` (${context})` : ''}`;
      } else {
        detail = failDetail(result) || 'no success marker in output';
      }
      throw new OhosPerfError(`hdc ${op} failed: ${detail}`, {
        code: `HDC_${op.toUpperCase()}_FAILED`,
      });
    }
  }
}

/** First `[Fail]` line across stdout then stderr, or ''. */
function failDetail(result: HdcResult): string {
  for (const stream of [result.stdout, result.stderr]) {
    const line = stream
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => FAIL_PREFIX.test(l));
    if (line) return line;
  }
  return '';
}

/** First non-empty line across stdout then stderr, or ''. */
function firstLine(result: HdcResult): string {
  for (const stream of [result.stdout, result.stderr]) {
    const line = stream
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (line) return line;
  }
  return '';
}
