import { Command } from 'commander';
import type { HiprofilerPluginName } from '@ohos-perf/core';
import {
  runAnalyze,
  runCaps,
  runCollect,
  runCompare,
  runDoctor,
  runEmulatorCreate,
  runEmulatorList,
  runEmulatorStart,
  runEmulatorStop,
  runQuery,
  runTools,
  safeMessage,
  type CliDeps,
  type CliResult,
  type EmulatorTargetOptions,
} from './commands';
import { parseDurationSeconds, parsePluginList } from './collect';
import { parseLimit, parseQueryArgs } from './query';

/**
 * Commander wiring, kept free of `process`.
 *
 * `index.ts` supplies the process streams and the emit function; tests supply
 * buffers. The version comes from the injected deps (which read
 * `package.json`), so `--version` cannot drift from the manifest.
 */

/** Everything {@link buildProgram} needs from the process. */
export interface ProgramIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  emit(result: CliResult): void;
}

export interface ProgramOptions {
  /**
   * Throw instead of calling `process.exit` for `--help`, `--version` and
   * usage errors. Tests enable this so those paths are observable; production
   * leaves it off, which is commander's default behaviour.
   */
  exitOverride?: boolean;
}

/**
 * The emulator location flags as commander parses them.
 *
 * `--emulator` is the flag name (short, and it matches the parent command);
 * `emulatorPath` is the core's field name. Translating between the two
 * happens in {@link targetOptionsOf} so no action has to remember it.
 */
interface EmulatorFlags {
  instancePath?: string;
  imageRoot?: string;
  emulator?: string;
}

/** Map parsed emulator flags onto the core's target options, omitting unset ones. */
function targetOptionsOf(opts: EmulatorFlags): EmulatorTargetOptions {
  return {
    ...(opts.instancePath === undefined ? {} : { instancePath: opts.instancePath }),
    ...(opts.imageRoot === undefined ? {} : { imageRoot: opts.imageRoot }),
    ...(opts.emulator === undefined ? {} : { emulatorPath: opts.emulator }),
  };
}

export function buildProgram(deps: CliDeps, io: ProgramIo, opts: ProgramOptions = {}): Command {
  const program = new Command();
  // Route commander's own output (help, version, usage errors) through the
  // injected streams so the whole surface is observable in tests. The help
  // widths are left at commander's defaults (the real TTY width), so the
  // rendered help is byte-identical to before this split.
  program.configureOutput({
    writeOut: io.writeOut,
    writeErr: io.writeErr,
  });
  if (opts.exitOverride) program.exitOverride();

  program
    .name('ohos-perf')
    .description('Performance analysis for OpenHarmony devices and captured traces')
    .version(deps.version);

  program
    .command('doctor')
    .description('check the hdc/trace_streamer toolchain and the attached device')
    .option('--target <id>', 'probe this hdc target instead of the first connected one')
    .option('--json', 'print the report as JSON')
    .action(async (opts: { target?: string; json?: boolean }) => {
      // `doctor` probes through the same injected deps as `caps`; when a
      // target is named, the device half of its report must honour it or the
      // report describes a different device than the one asked about.
      io.emit(await runDoctor(deps, opts));
    });

  program
    .command('caps')
    .description('print the capability matrix of the attached device')
    .option('--target <id>', 'probe this hdc target instead of the first connected one')
    .option('--json', 'print the capabilities as JSON')
    .action(async (opts: { target?: string; json?: boolean }) => {
      io.emit(await runCaps(deps, opts));
    });

  program
    .command('analyze')
    .description('analyze a captured scene directory (trace.db or trace.htrace)')
    .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
    .option('--app <packageName>', 'app package name, for evidence wording')
    .option('--json', 'print the analysis result as JSON')
    .action(async (sceneDir: string, opts: { app?: string; json?: boolean }) => {
      io.emit(await runAnalyze(deps, sceneDir, opts));
    });

  program
    .command('collect')
    .description('capture a scene from the attached device')
    .option(
      '--app <pkg>',
      'application package name (required for --procfs, --cold-start, --hiperf and hiprofiler nativehook)',
    )
    .requiredOption('--duration <seconds>', 'capture duration in seconds (10 or 10s)')
    .requiredOption('--out <dir>', 'scene output directory')
    .option('--procfs', 'also sample /proc memory state for the app')
    .option('--cold-start <ability>', 'launch this ability before capturing')
    .option('--hiprofiler', 'capture through hiprofiler instead of hitrace')
    .option(
      '--plugins <list>',
      'hiprofiler plugins, comma-separated: ftrace, gpu, xpower, nativehook, memory',
    )
    .option('--hiperf', 'also capture a hiperf perf.data (debuggable app only)')
    .option('--hidumper', 'also sample the RenderService fps and hitch counters')
    .option('--uitest', 'also dump the on-screen UI tree')
    .option('--target <id>', 'capture from this hdc target instead of the first connected one')
    .option('--json', 'print the result as JSON')
    .action(async (opts: {
      app?: string;
      duration: string;
      out: string;
      procfs?: boolean;
      coldStart?: string;
      hiprofiler?: boolean;
      plugins?: string;
      hiperf?: boolean;
      hidumper?: boolean;
      uitest?: boolean;
      target?: string;
      json?: boolean;
    }) => {
      // Validation lives in the action (not a commander option parser) so a bad
      // value produces the same failure contract as every other CLI error:
      // empty stdout, one message on stderr, exit 1.
      let durationMs: number;
      try {
        durationMs = parseDurationSeconds(opts.duration);
      } catch (err) {
        io.emit({ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 });
        return;
      }

      // `--plugins` only means something to hiprofiler. Accepting it silently
      // without `--hiprofiler` would capture through hitrace and quietly drop
      // the user's request.
      if (opts.plugins !== undefined && opts.hiprofiler !== true) {
        io.emit({
          stdout: '',
          stderr: 'invalid --plugins: --hiprofiler is required\n',
          exitCode: 1,
        });
        return;
      }
      let hiprofilerRequest: { plugins?: readonly HiprofilerPluginName[] } | undefined;
      if (opts.hiprofiler === true) {
        try {
          hiprofilerRequest = opts.plugins === undefined
            ? {}
            : { plugins: parsePluginList(opts.plugins) };
        } catch (err) {
          io.emit({ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 });
          return;
        }
      }

      // `--app` is optional for the device-wide collectors, so this action is
      // the gate for the modes that cannot run without one. The core repeats
      // the check; here it must happen before deps.collect connects to a
      // device at all.
      const needsApp =
        opts.procfs === true ||
        opts.coldStart !== undefined ||
        opts.hiperf === true ||
        (hiprofilerRequest?.plugins?.includes('nativehook') ?? false);
      if (needsApp && (opts.app === undefined || opts.app === '')) {
        io.emit({
          stdout: '',
          stderr: 'missing --app: --procfs, --cold-start, --hiperf and the nativehook' +
            ' plugin require an application package name\n',
          exitCode: 1,
        });
        return;
      }

      io.emit(await runCollect(deps, {
        ...(opts.app === undefined ? {} : { app: opts.app }),
        durationMs,
        out: opts.out,
        ...(opts.procfs === true ? { procfs: true } : {}),
        ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
        ...(hiprofilerRequest === undefined ? {} : { hiprofiler: hiprofilerRequest }),
        ...(opts.hiperf === true ? { hiperf: {} } : {}),
        ...(opts.hidumper === true ? { hidumper: true } : {}),
        ...(opts.uitest === true ? { uitest: true } : {}),
        ...(opts.target === undefined ? {} : { target: opts.target }),
      }, { json: opts.json }));
    });

  program
    .command('query')
    .description('run one named drill-down query against a captured scene')
    .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
    .argument('<name>', 'named query; list them with `ohos-perf tools`')
    .option('--app <packageName>', 'app package name, overriding scene.json')
    .option('--args <json>', 'query arguments as a JSON object')
    .option('--limit <n>', 'maximum rows to return (default 100, max 1000)')
    .option('--json', 'print the result as JSON')
    .action(async (sceneDir: string, name: string, opts: {
      app?: string;
      args?: string;
      limit?: string;
      json?: boolean;
    }) => {
      let args: Record<string, unknown> | undefined;
      let limit: number | undefined;
      try {
        args = opts.args === undefined ? undefined : parseQueryArgs(opts.args);
        limit = opts.limit === undefined ? undefined : parseLimit(opts.limit);
      } catch (err) {
        io.emit({ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 });
        return;
      }
      io.emit(await runQuery(deps, {
        sceneDir,
        name,
        ...(opts.app !== undefined ? { app: opts.app } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }, { json: opts.json }));
    });

  program
    .command('compare')
    .description('compare a current analysis against a baseline')
    .argument('<baseline>', 'scene directory or `analyze --json` file')
    .argument('<current>', 'scene directory or `analyze --json` file')
    .option('--json', 'print the comparison as JSON')
    .action(async (baseline: string, current: string, opts: { json?: boolean }) => {
      io.emit(await runCompare(deps, { baseline, current }, { json: opts.json }));
    });

  program
    .command('tools')
    .description('list the named drill-down queries an agent can call')
    .option('--json', 'print the query definitions as JSON')
    .action((opts: { json?: boolean }) => {
      io.emit(runTools(deps, opts));
    });

  /**
   * Add the emulator location options to one subcommand.
   *
   * They are declared on every subcommand rather than once on the parent:
   * commander resolves `--instance-path` against the command that consumes
   * the action's options object, and a parent-level option would require
   * every action to look up its parent to see it.
   */
  const withEmulatorTargets = (cmd: Command): Command =>
    cmd
      .option('--instance-path <dir>', 'emulator instance root (overrides discovery)')
      .option('--image-root <dir>', 'emulator image root (overrides discovery)')
      .option('--emulator <path>', 'path to the HarmonyOS Emulator executable');

  const emulator = program
    .command('emulator')
    .description('manage HarmonyOS emulator instances');

  withEmulatorTargets(
    emulator
      .command('list')
      .description('list emulator instances and the target each one owns')
      .option('--json', 'print the instances as JSON'),
  ).action(async (opts: EmulatorFlags & { json?: boolean }) => {
    io.emit(await runEmulatorList(deps, {
      ...targetOptionsOf(opts),
      ...(opts.json === undefined ? {} : { json: opts.json }),
    }));
  });

  withEmulatorTargets(
    emulator
      .command('start')
      .description('start an emulator instance and wait until it has booted')
      .argument('<name>', 'emulator instance name')
      .option('--timeout <seconds>', 'how long to wait for the boot, in seconds')
      .option('--json', 'print the result as JSON'),
  ).action(async (name: string, opts: EmulatorFlags & { timeout?: string; json?: boolean }) => {
    const { timeout, json } = opts;
    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      // `parseDurationSeconds` accepts a bare number or an `s` suffix and
      // rejects anything that is not a positive whole number of milliseconds,
      // which is exactly the budget a poll loop needs — `0` and negatives are
      // rejected there, before any deps call. Its message names `--duration`,
      // so the rejection is re-worded for this flag.
      try {
        timeoutMs = parseDurationSeconds(timeout);
      } catch {
        io.emit({
          stdout: '',
          stderr: `invalid --timeout ${JSON.stringify(timeout)}: --timeout must be greater` +
            ' than 0 (a positive number of seconds, e.g. 30)\n',
          exitCode: 1,
        });
        return;
      }
    }
    io.emit(await runEmulatorStart(deps, name, {
      ...targetOptionsOf(opts),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(json === undefined ? {} : { json }),
    }));
  });

  withEmulatorTargets(
    emulator
      .command('stop')
      .description('stop an emulator instance')
      .argument('<name>', 'emulator instance name')
      .option('--json', 'print the result as JSON'),
  ).action(async (name: string, opts: EmulatorFlags & { json?: boolean }) => {
    io.emit(await runEmulatorStop(deps, name, {
      ...targetOptionsOf(opts),
      ...(opts.json === undefined ? {} : { json: opts.json }),
    }));
  });

  withEmulatorTargets(
    emulator
      .command('create')
      .description('create an emulator instance from an already-downloaded image')
      .argument('<name>', 'instance name; it becomes a directory under the instance root')
      .option('--device-type <type>', 'image device type, e.g. phone or foldable')
      .option('--os-version <version>', 'image OS version, e.g. "HarmonyOS 6.1.1(24)"')
      .option('--screen-profile <model>', 'screen profile name')
      .option('--memory <GB>', 'RAM size in GB')
      .option('--storage <GB>', 'data partition size in GB')
      .option('--json', 'print the created instance as JSON'),
  ).action(async (name: string, opts: {
    deviceType?: string;
    osVersion?: string;
    screenProfile?: string;
    memory?: string;
    storage?: string;
    json?: boolean;
  } & EmulatorFlags) => {
    // Declared as plain options, not `requiredOption`: commander's own
    // "required option ... not specified" writes through `writeErr` and exits
    // before the action, which would break the CLI-wide failure contract
    // (one message on stderr, an emitted exit-1 result).
    if (opts.deviceType === undefined || opts.osVersion === undefined) {
      io.emit({
        stdout: '',
        stderr: '--device-type and --os-version are required\n',
        exitCode: 1,
      });
      return;
    }
    const number = (flag: string, raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) {
        throw new Error(`invalid ${flag}: expected a whole number, got ${JSON.stringify(raw)}`);
      }
      return value;
    };
    let memoryGb: number | undefined;
    let storageGb: number | undefined;
    try {
      memoryGb = number('--memory', opts.memory);
      storageGb = number('--storage', opts.storage);
    } catch (err) {
      io.emit({ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 });
      return;
    }
    io.emit(await runEmulatorCreate(deps, {
      name,
      deviceType: opts.deviceType,
      osVersion: opts.osVersion,
      ...(opts.screenProfile === undefined ? {} : { screenProfile: opts.screenProfile }),
      ...(memoryGb === undefined ? {} : { memoryGb }),
      ...(storageGb === undefined ? {} : { storageGb }),
      ...targetOptionsOf(opts),
    }, { json: opts.json }));
  });

  return program;
}
