/**
 * HarmonyOS emulator lifecycle.
 *
 * DevEco Studio ships `Emulator.exe`, which owns the instance directory format,
 * the image signature check and the QEMU launch. This module drives it rather
 * than reproducing it: `EmulatorClient` spawns and parses, `EmulatorLifecycle`
 * proves state transitions with `hdc`.
 *
 * Two measured properties shape everything here:
 *
 * 1. **The exit code carries no information.** `Unable to start the emulator`,
 *    `Emulator: Unknown option 'bogus'.` and a silently rejected `-create` all
 *    exit 0. Success is proven by re-reading state, never by `$?`.
 * 2. **`-start` and `-stop` are fire-and-forget.** Both return in well under a
 *    second while the instance is still booting or still shutting down, so a
 *    caller that trusts their output reports the wrong state.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { OhosPerfError, EmulatorNotFoundError } from '../errors';
import type { Env } from '../transport/hdc';

// Re-exported so the module a caller reaches for is the one that names its
// error, matching how `transport/hdc.ts` pairs `Hdc` with `HdcNotFoundError`.
export { EmulatorNotFoundError };

export interface EmulatorClientOptions {
  /** Explicit `Emulator.exe`; checked first by {@link EmulatorClient.resolvePath}. */
  emulatorPath?: string;
  /** Environment used both for spawning and for the `OHOS_PERF_EMULATOR`/`PATH` lookup. */
  env?: Env;
  /**
   * Override the built-in install candidate list. Tests pass `[]` so the
   * search list is exactly the one they assert on.
   */
  commonPaths?: string[];
  /** `-instancePath` for every command that accepts it. */
  instancePath?: string;
  /** `-imageRoot` for every command that accepts it. */
  imageRoot?: string;
}

/** The binary's file name; only the `PATH` join needs the platform difference. */
function emulatorBinName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Emulator.exe' : 'Emulator';
}

/**
 * DevEco installs on Windows, in the order a caller is most likely to have
 * them. No macOS or Linux path is invented: the spec records that the macOS
 * distribution was never measured, and a guessed path fails later with a
 * confusing error instead of the honest "searched nothing here".
 */
function defaultCommonPaths(env: Env, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [];
  const tail = ['tools', 'emulator', 'Emulator.exe'];
  const paths: string[] = [];
  if (env.DEVECO_SDK_HOME) paths.push(join(env.DEVECO_SDK_HOME, ...tail));
  paths.push(join('D:', 'Application', 'DevEco Studio', ...tail));
  paths.push(join('C:', 'Program Files', 'Huawei', 'DevEco Studio', ...tail));
  return paths;
}

/**
 * The `Emulator.exe` process surface.
 *
 * Every method here runs the binary and interprets its output; none of them
 * decides what a state *means*. That split is what lets the lifecycle layer be
 * tested with a plain object while this layer is tested against recorded output.
 */
export class EmulatorClient {
  private readonly opts: EmulatorClientOptions;
  private readonly env: Env;
  private readonly platform: NodeJS.Platform;
  private resolvedPath?: string;
  private parsedVersion?: string;

  constructor(opts: EmulatorClientOptions = {}, platform: NodeJS.Platform = process.platform) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.platform = platform;
  }

  /**
   * Search order: explicit path -> OHOS_PERF_EMULATOR -> common DevEco
   * installs -> PATH. Throws {@link EmulatorNotFoundError} listing every
   * candidate in order, so a caller can see exactly what was tried.
   */
  async resolvePath(): Promise<string> {
    if (this.resolvedPath) return this.resolvedPath;

    const candidates: string[] = [];
    const push = (p: string | undefined): void => {
      if (p && !candidates.includes(p)) candidates.push(p);
    };

    push(this.opts.emulatorPath);
    push(this.env.OHOS_PERF_EMULATOR);
    for (const p of this.opts.commonPaths ?? defaultCommonPaths(this.env, this.platform)) push(p);

    const bin = emulatorBinName(this.platform);
    for (const dir of (this.env.PATH ?? '').split(delimiter)) {
      if (dir) push(join(dir, bin));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.resolvedPath = candidate;
        return candidate;
      }
    }
    throw new EmulatorNotFoundError(candidates);
  }

  /**
   * Banner version, e.g. `6.1.1.200`. The real binary prints
   * `HarmonyOS Emulator :6.1.1.200` and exits 0.
   */
  async version(): Promise<string> {
    if (this.parsedVersion) return this.parsedVersion;
    const { stdout } = await this.spawnProcess(await this.resolvePath(), ['-version']);
    const match = /HarmonyOS Emulator\s*:\s*(\d+(?:\.\d+)+)/.exec(stdout);
    if (match === null) {
      throw new OhosPerfError(`unrecognised -version output: ${stdout.trim()}`, {
        code: 'EMULATOR_VERSION_UNPARSED',
      });
    }
    this.parsedVersion = match[1];
    return this.parsedVersion;
  }

  /** Spawn without a shell so install paths with spaces stay one argv element. */
  protected spawnProcess(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
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
          new OhosPerfError(`Failed to spawn the emulator (${command}): ${err.message}`, {
            cause: err,
            code: 'EMULATOR_SPAWN_FAILED',
          }),
        );
      });
      child.on('close', (code) => {
        // `code === null` means the child was killed by a signal, which is
        // never a success; -1 makes every `code !== 0` check treat it as one.
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}
