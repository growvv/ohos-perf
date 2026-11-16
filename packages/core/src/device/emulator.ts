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
import {
  OhosPerfError, EmulatorCommandError, EmulatorImageMissingError, EmulatorNotFoundError,
} from '../errors';
import { Hdc, type Env, type HdcTarget } from '../transport/hdc';

// Re-exported so the module a caller reaches for is the one that names its
// error, matching how `transport/hdc.ts` pairs `Hdc` with `HdcNotFoundError`.
export { EmulatorCommandError, EmulatorImageMissingError, EmulatorNotFoundError };

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

/** What `create` needs; validated by the lifecycle layer before it is spawned. */
export interface CreateEmulatorRequest {
  readonly name: string;
  readonly deviceType: string;
  readonly osVersion: string;
  readonly screenProfile?: string;
  readonly memoryGb?: number;
  readonly storageGb?: number;
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
  /**
   * Host platform, for the binary name and the install candidate list.
   * Defaults to `process.platform`; injectable so a test can exercise the
   * non-Windows branch on any host. Typed as `string` on purpose: `NodeJS`
   * types are not part of this package's published declarations.
   */
  platform?: string;
}

/** The binary's file name; only the `PATH` join needs the platform difference. */
function emulatorBinName(platform: string): string {
  return platform === 'win32' ? 'Emulator.exe' : 'Emulator';
}

/**
 * DevEco installs on Windows, in the order a caller is most likely to have
 * them. No macOS or Linux path is invented: the spec records that the macOS
 * distribution was never measured, and a guessed path fails later with a
 * confusing error instead of the honest "searched nothing here".
 */
function defaultCommonPaths(env: Env, platform: string): string[] {
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
  private readonly platform: string;
  private resolvedPath?: string;
  private parsedVersion?: string;

  constructor(opts: EmulatorClientOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
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

  /**
   * `-start <name>`.
   *
   * Fire-and-forget by design: the real binary returns in well under a second
   * and the instance keeps running after it exits, so the caller must poll
   * {@link listDetailed} for the state change.
   */
  async startInstance(name: string): Promise<void> {
    await this.run(['-start', name, ...this.instancePathArgs(), ...this.imageRootArgs()]);
  }

  /** `-stop <name>`; also fire-and-forget, see {@link startInstance}. */
  async stopInstance(name: string): Promise<void> {
    await this.run(['-stop', name, ...this.instancePathArgs()]);
  }

  /**
   * `-create`, with no validation.
   *
   * The binary silently ignores a bad device type, an unknown OS version or a
   * name that already exists — it prints nothing and exits 0. Deciding those
   * is {@link EmulatorLifecycle.create}'s job, before this runs.
   */
  async createInstance(req: CreateEmulatorRequest): Promise<void> {
    await this.run([
      '-create', req.name,
      '-deviceType', req.deviceType,
      '-osVersion', req.osVersion,
      ...(req.screenProfile === undefined ? [] : ['-screenProfile', req.screenProfile]),
      ...(req.memoryGb === undefined ? [] : ['-memory', String(req.memoryGb)]),
      ...(req.storageGb === undefined ? [] : ['-storage', String(req.storageGb)]),
      ...this.instancePathArgs(),
      ...this.imageRootArgs(),
    ]);
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

  /** `-imageRoot` when the caller configured one; no flag otherwise. */
  private imageRootArgs(): string[] {
    return this.opts.imageRoot === undefined ? [] : ['-imageRoot', this.opts.imageRoot];
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

/** The client operations the lifecycle needs; `EmulatorClient` satisfies it structurally. */
export interface EmulatorBackend {
  listDetailed(): Promise<EmulatorInstance[]>;
  imageList(): Promise<EmulatorImage[]>;
  startInstance(name: string): Promise<void>;
  stopInstance(name: string): Promise<void>;
  createInstance(req: CreateEmulatorRequest): Promise<void>;
}

/** What a successful {@link EmulatorLifecycle.start} reports. */
export interface EmulatorStartResult {
  readonly name: string;
  /** The hdc target id, ready for `collect --target`. */
  readonly target: string;
  /** True when the instance was already running before this call. */
  readonly alreadyRunning: boolean;
  /** Wall-clock milliseconds this call spent waiting for boot. */
  readonly waitedMs: number;
}

/** What a successful {@link EmulatorLifecycle.stop} reports. */
export interface EmulatorStopResult {
  readonly name: string;
  /** False when the instance was not running; nothing was sent to `-stop`. */
  readonly wasRunning: boolean;
}

/** The `hdc` operations the lifecycle needs; `Hdc` satisfies it structurally. */
export interface HdcSlice {
  listTargets(): Promise<HdcTarget[]>;
  shell(target: string, cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface EmulatorLifecycleOptions {
  /** Defaults to a real {@link EmulatorClient}; tests inject a plain object. */
  client?: EmulatorBackend;
  /** Defaults to a real `Hdc`; tests inject a plain object. */
  hdc?: HdcSlice;
  /** Total budget for `start`, across all three phases. */
  startTimeoutMs?: number;
  /** Total budget for `stop`. */
  stopTimeoutMs?: number;
  /** Poll interval for every wait. */
  pollMs?: number;
  /** Injection point for tests; production leaves it unset. */
  now?: () => number;
}

/** Poll without a timer keeping the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A connected target reached over TCP — a real device is USB. */
function isConnectedTcp(target: HdcTarget): boolean {
  // `raw` is `id\t\tTRANSPORT\tSTATUS\t...`; splitting on tabs and dropping
  // the empty runs keeps the field index independent of the padding.
  const fields = target.raw.split('\t').filter((field) => field !== '');
  return target.connected && fields[1] === 'TCP';
}

/**
 * State and waiting, as distinct from spawning and parsing.
 *
 * `-start` and `-stop` both return before the state they report has settled,
 * and `-list -details` is the only authority on it. Every method here re-reads
 * that state rather than trusting a command's exit or its success line.
 */
export class EmulatorLifecycle {
  private readonly client: EmulatorBackend;
  private readonly hdc: HdcSlice;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(opts: EmulatorLifecycleOptions = {}) {
    // Lazy by construction: nothing spawns until a method runs, so the default
    // is safe for a caller who injects only `hdc`.
    this.client = opts.client ?? new EmulatorClient();
    this.hdc = opts.hdc ?? new Hdc();
    this.startTimeoutMs = opts.startTimeoutMs ?? 180_000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 1_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Instances with a `target` attached when it can be attributed.
   *
   * The port is not knowable from config — `hw.hdc.port` is `notset` by
   * default, and the same instance has been observed on different ports in
   * different sessions. So a target is reported only when there is exactly one
   * running instance and exactly one connected TCP target; guessing would
   * produce a plausible-looking wrong answer, which is worse than a reason.
   */
  async list(): Promise<EmulatorInstance[]> {
    const instances = await this.client.listDetailed();
    const running = instances.filter((i) => i.running);
    // Nothing running: the answer needs no hdc, and asking would make `list`
    // fail on a machine that has the emulator but no hdc on PATH.
    if (running.length === 0) return instances;

    const tcp = (await this.hdc.listTargets()).filter(isConnectedTcp);
    const attributed: EmulatorInstance = running.length > 1
      ? { ...running[0], targetReason: `${running.length} emulators are running, so a target cannot be attributed` }
      : tcp.length === 0
        ? { ...running[0], targetReason: 'no connected TCP target was found' }
        : tcp.length > 1
          ? { ...running[0], targetReason: `${tcp.length} connected TCP targets were found, so a target cannot be attributed` }
          : { ...running[0], target: tcp[0].id };

    return instances.map((instance) => (
      instance.name === attributed.name ? attributed : instance
    ));
  }

  /**
   * Start `name` and wait until its guest has finished booting.
   *
   * Three phases, one deadline: the instance reports `isRunning`, a new
   * connected TCP target appears, and `bootevent.boot.completed` turns true.
   * Each phase has its own timeout message because "it timed out" leaves the
   * caller unable to tell a slow boot from a broken start.
   *
   * A timeout never stops the emulator: a half-booted instance is the evidence
   * of what went wrong, and the message says how to remove it.
   */
  async start(name: string, opts: { timeoutMs?: number } = {}): Promise<EmulatorStartResult> {
    const startedAt = this.now();
    const budgetMs = opts.timeoutMs ?? this.startTimeoutMs;
    const deadline = startedAt + budgetMs;

    const instances = await this.client.listDetailed();
    const found = instances.find((i) => i.name === name);
    if (found === undefined) {
      const names = instances.map((i) => i.name);
      throw new OhosPerfError(
        `no emulator instance named "${name}". Instances: ${names.length === 0 ? 'none' : names.join(', ')}`,
        { code: 'EMULATOR_INSTANCE_NOT_FOUND' },
      );
    }

    const before = new Set((await this.hdc.listTargets()).map((t) => t.id));

    let target: string;
    let alreadyRunning: boolean;
    if (found.running) {
      // Never spawn a second emulator for an instance that is already up: an
      // agent's retry must be safe. Its target is the one already connected.
      const tcp = (await this.hdc.listTargets()).filter(isConnectedTcp);
      if (tcp.length !== 1) {
        throw new OhosPerfError(
          tcp.length === 0
            ? `"${name}" is running but no connected TCP target was found, so its target cannot be attributed`
            : `"${name}" is running and ${tcp.length} connected TCP targets were found, so its target cannot be attributed`,
          { code: 'EMULATOR_TARGET_AMBIGUOUS' },
        );
      }
      target = tcp[0].id;
      alreadyRunning = true;
    } else {
      await this.client.startInstance(name);
      alreadyRunning = false;
      await this.waitUntil(deadline, budgetMs, 'the instance did not report isRunning', name, async () => (
        (await this.client.listDetailed()).find((i) => i.name === name)?.running === true
          ? true
          : undefined
      ));
      target = await this.waitUntil(deadline, budgetMs, 'no new TCP target appeared', name, async () => {
        const fresh = (await this.hdc.listTargets()).filter(isConnectedTcp).filter((t) => !before.has(t.id));
        if (fresh.length > 1) {
          throw new OhosPerfError(
            `two new TCP targets appeared after starting "${name}": ${fresh.map((t) => t.id).join(', ')}`,
            { code: 'EMULATOR_TARGET_AMBIGUOUS' },
          );
        }
        return fresh[0]?.id;
      });
    }

    await this.waitUntil(
      deadline, budgetMs, 'the target was up but bootevent.boot.completed never became true', name,
      async () => {
      try {
        const result = await this.hdc.shell(target, 'param get bootevent.boot.completed');
        // A failed shell during boot is "not ready yet", not an error: the
        // device answers [Fail] until the guest's hdc daemon is up.
        return result.stdout.trim() === 'true' ? true : undefined;
      } catch {
        return undefined;
      }
      },
    );

    return { name, target, alreadyRunning, waitedMs: this.now() - startedAt };
  }

  /**
   * Stop `name` and wait until the instance reports `isRunning: false`.
   *
   * The real `-stop` prints `Stop emulator <name> successfully` and returns in
   * about 140 ms, while the instance keeps reporting `isRunning: true` for
   * several seconds. Trusting its output would report a stop that has not
   * happened, so this re-reads state.
   */
  async stop(name: string, opts: { timeoutMs?: number } = {}): Promise<EmulatorStopResult> {
    const instances = await this.client.listDetailed();
    const found = instances.find((i) => i.name === name);
    if (found === undefined) {
      const names = instances.map((i) => i.name);
      throw new OhosPerfError(
        `no emulator instance named "${name}". Instances: ${names.length === 0 ? 'none' : names.join(', ')}`,
        { code: 'EMULATOR_INSTANCE_NOT_FOUND' },
      );
    }
    if (!found.running) return { name, wasRunning: false };

    const budgetMs = opts.timeoutMs ?? this.stopTimeoutMs;
    await this.client.stopInstance(name);
    await this.waitUntil(
      this.now() + budgetMs,
      budgetMs,
      '`-stop` reported success but the instance still reports isRunning: true',
      name,
      async () => ((await this.client.listDetailed()).find((i) => i.name === name)?.running === false
        ? true
        : undefined),
      { code: 'EMULATOR_STOP_TIMEOUT' },
    );
    return { name, wasRunning: true };
  }

  /**
   * Create an instance, validating before anything is spawned.
   *
   * The binary is silent about every rejection measured — a bad device type, an
   * unknown OS version, a duplicate name and a missing image all print nothing
   * and exit 0. So the checks here are the only thing between the caller and a
   * create that did nothing, and the post-create re-read is the only proof that
   * it did something.
   */
  async create(req: CreateEmulatorRequest): Promise<EmulatorInstance> {
    if (!EMULATOR_NAME.test(req.name) || req.name.includes('..')) {
      throw new OhosPerfError(
        `invalid emulator name "${req.name}": letters, digits, '.', '_' and '-' only, ` +
          'no ".." (the name becomes a directory under the instance root)',
        { code: 'EMULATOR_NAME_INVALID' },
      );
    }

    const existing = await this.client.listDetailed();
    if (existing.some((i) => i.name === req.name)) {
      throw new OhosPerfError(
        `an emulator instance named "${req.name}" already exists`,
        { code: 'EMULATOR_INSTANCE_EXISTS' },
      );
    }

    const images = await this.client.imageList();
    const available = images.some((image) => (
      image.deviceType === req.deviceType && image.osVersion === req.osVersion
    ));
    if (!available) {
      const installCommand = `-install -deviceType ${req.deviceType} -osVersion "${req.osVersion}"`;
      throw new EmulatorImageMissingError(
        `no downloaded image for device type "${req.deviceType}" and ${req.osVersion}. ` +
          `Run \`Emulator.exe ${installCommand}\` first.`,
        installCommand,
        { code: 'EMULATOR_IMAGE_MISSING' },
      );
    }

    if (req.memoryGb !== undefined && (req.memoryGb < 2 || req.memoryGb > 32)) {
      throw new OhosPerfError('out of range: --memory must be 2-32 GB', { code: 'EMULATOR_MEMORY_RANGE' });
    }
    if (req.storageGb !== undefined && (req.storageGb < 2 || req.storageGb > 1023)) {
      throw new OhosPerfError('out of range: --storage must be 2-1023 GB', { code: 'EMULATOR_STORAGE_RANGE' });
    }

    await this.client.createInstance(req);

    const created = (await this.client.listDetailed()).find((i) => i.name === req.name);
    if (created === undefined) {
      throw new OhosPerfError(
        `the emulator reported success but "${req.name}" did not appear in \`-list -details\``,
        { code: 'EMULATOR_CREATE_FAILED' },
      );
    }
    return created;
  }

  /**
   * Poll `attempt` until it returns a value, or the deadline passes.
   *
   * The deadline is absolute so one budget covers every phase of `start`;
   * a per-phase budget would multiply the caller's timeout by three.
   */
  private async waitUntil<T>(
    deadline: number,
    budgetMs: number,
    phase: string,
    name: string,
    attempt: () => Promise<T | undefined>,
    opts: { code?: string } = {},
  ): Promise<T> {
    for (;;) {
      if (this.now() >= deadline) {
        throw new OhosPerfError(
          `${phase} after ${budgetMs}ms. The emulator may be half-started; ` +
            `run \`ohos-perf emulator stop ${name}\` to remove it.`,
          { code: opts.code ?? 'EMULATOR_START_TIMEOUT' },
        );
      }
      const value = await attempt();
      if (value !== undefined) return value;
      await sleep(this.pollMs);
    }
  }
}

/** A name that becomes a directory under the instance root. */
const EMULATOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
