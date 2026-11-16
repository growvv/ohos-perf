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
import { OhosPerfError, EmulatorCommandError, EmulatorNotFoundError } from '../errors';
import type { Env } from '../transport/hdc';

// Re-exported so the module a caller reaches for is the one that names its
// error, matching how `transport/hdc.ts` pairs `Hdc` with `HdcNotFoundError`.
export { EmulatorCommandError, EmulatorNotFoundError };

/** One instance as `-list -details` reports it. */
export interface EmulatorInstance {
  readonly name: string;
  readonly running: boolean;
  /** `os.apiVersion`, e.g. `"24"`. */
  readonly apiVersion?: string;
  /** `imageSubPath`, e.g. `system-image/HarmonyOS-6.1.1/phone_all_x86/`. */
  readonly imageDir?: string;
  /** Absolute instance directory. */
  readonly instancePath: string;
  readonly uuid?: string;
  /** `os.osVersion`, e.g. `HarmonyOS 6.1.1(24)`. */
  readonly osVersion?: string;
  /** The hdc target id; present only when it can be attributed unambiguously. */
  readonly target?: string;
  /** Why `target` is absent, when it is absent for a reason other than "not running". */
  readonly targetReason?: string;
}

/** One row of `-imageList -downloaded true`. */
export interface EmulatorImage {
  readonly deviceType: string;
  /** `osVersion`, e.g. `"HarmonyOS 6.1.1(24)"`. */
  readonly osVersion: string;
  readonly downloaded: boolean;
  /** `SoftWareVersion`, e.g. `"6.1.0.126"`. */
  readonly softwareVersion: string;
  readonly releaseType?: string;
}

/** A line that means the command failed, despite the exit code saying 0. */
const FAILURE_LINE = /^(?:Emulator: |Unable to )/;

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

  /**
   * `-list -details`, parsed and sorted by name.
   *
   * `[Empty]` is the real binary's answer when the instance root holds none;
   * it is success with zero instances, not a parse failure.
   */
  async listDetailed(): Promise<EmulatorInstance[]> {
    // `-list` spells the flag `-path`, unlike every mutating command, which
    // uses `-instancePath`. Measured on 6.1.1.200.
    const args = [
      '-list', '-details',
      ...(this.opts.instancePath === undefined ? [] : ['-path', this.opts.instancePath]),
    ];
    const result = await this.run(args);
    if (result.stdout.trim() === '[Empty]') return [];
    const rows = this.parseJson<Record<string, unknown>>(args, result);
    return rows
      .map((row): EmulatorInstance => {
        const name = stringField(row, 'name');
        const instancePath = stringField(row, 'instancePath');
        return {
          name,
          running: row.isRunning === 'true' || row.isRunning === true,
          instancePath,
          ...optional('apiVersion', stringField(row, 'os.apiVersion')),
          ...optional('imageDir', stringField(row, 'imageSubPath')),
          ...optional('uuid', stringField(row, 'uuid')),
          ...optional('osVersion', stringField(row, 'os.osVersion')),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** `-imageList -downloaded true`, parsed and sorted by type then version. */
  async imageList(): Promise<EmulatorImage[]> {
    const args = [
      '-imageList', '-downloaded', 'true',
      ...(this.opts.imageRoot === undefined ? [] : ['-imageRoot', this.opts.imageRoot]),
    ];
    const rows = this.parseJson<Record<string, unknown>>(args, await this.run(args));
    return rows
      .map((row): EmulatorImage => ({
        deviceType: stringField(row, 'deviceType'),
        osVersion: stringField(row, 'osVersion'),
        downloaded: row.downloaded === 'true' || row.downloaded === true,
        softwareVersion: stringField(row, 'SoftWareVersion'),
        ...optional('releaseType', stringField(row, 'releaseType')),
      }))
      .sort((a, b) => {
        if (a.deviceType !== b.deviceType) return a.deviceType < b.deviceType ? -1 : 1;
        return a.osVersion < b.osVersion ? -1 : a.osVersion > b.osVersion ? 1 : 0;
      });
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

  /** `-instancePath` when the caller configured one; no flag otherwise. */
  private instancePathArgs(): string[] {
    return this.opts.instancePath === undefined ? [] : ['-instancePath', this.opts.instancePath];
  }

  /** Resolve the binary, spawn, and classify the output. */
  private async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.assertOk(args, await this.spawnProcess(await this.resolvePath(), args));
  }

  /**
   * The exit code is 0 for every failure the binary produces, so success is
   * the absence of a failure line — not a non-zero code.
   *
   * The match is structural (`Emulator: `, `Unable to `) rather than a list of
   * known sentences: the binary uses its own name as a prefix for argument
   * errors and `Unable to …` for operational ones, and a future message of
   * either shape should fail loudly instead of being read as success.
   */
  private assertOk(
    args: string[],
    result: { stdout: string; stderr: string; code: number },
  ): { stdout: string; stderr: string; code: number } {
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      throw new EmulatorCommandError(
        `${args[0] ?? 'emulator'} exited ${result.code}`,
        output,
        { code: 'EMULATOR_COMMAND_FAILED' },
      );
    }
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (FAILURE_LINE.test(trimmed)) {
        throw new EmulatorCommandError(trimmed, output, { code: 'EMULATOR_COMMAND_FAILED' });
      }
    }
    return result;
  }

  /** Parse a JSON array, naming the first line of output when it is not one. */
  private parseJson<T>(args: string[], result: { stdout: string; stderr: string }): T[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      const first = result.stdout.trim().split('\n')[0] ?? '';
      throw new EmulatorCommandError(
        `unrecognised ${args[0] ?? ''} output: expected JSON, got ${first}`,
        `${result.stdout}\n${result.stderr}`,
        { code: 'EMULATOR_OUTPUT_UNPARSED' },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new EmulatorCommandError(
        `unrecognised ${args[0] ?? ''} output: expected a JSON array`,
        result.stdout,
        { code: 'EMULATOR_OUTPUT_UNPARSED' },
      );
    }
    return parsed as T[];
  }
}

/** A required string field; a missing one is a shape the binary no longer produces. */
function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Spread an optional field only when it has a value.
 *
 * Assigning `undefined` would make the key present-but-empty, which breaks
 * deep-equality against a hand-written expectation and makes `--json` output
 * carry nulls the caller never asked for.
 */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined || value === '' ? {} : { [key]: value }) as { [P in K]?: string };
}
