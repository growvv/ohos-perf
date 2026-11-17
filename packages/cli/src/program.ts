import { Command } from 'commander';
import type { Gesture, HiprofilerPluginName } from '@ohos-perf/core';
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
  runGesture,
  runHap,
  runQuery,
  runReport,
  runRender,
  runExplore,
  runScenarioCommand,
  runTools,
  runTrend,
  runUiCompare,
  safeMessage,
  failureLine,
  type CliDeps,
  type CliResult,
  type EmulatorTargetOptions,
} from './commands';
import { parseDurationSeconds, parsePluginList } from './collect';
import { parseMaxSteps, parseStrategy } from './explore';
import { parseCoordinate, parseKey, parseText, parseVelocity } from './gesture';
import { parseLimit, parseQueryArgs } from './query';
import { parseOnly } from './run';
import { collectLabels } from './trend';

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
    .option(
      '--so-dir <dir>',
      'host directory of shared objects to symbolize the hiperf capture with',
    )
    .option('--hidumper', 'also sample the RenderService fps and hitch counters')
    .option('--uitest', 'also dump the on-screen UI tree')
    .option('--screenshot', 'also capture the whole screen into screenshot.png')
    .option('--hilog', 'also stream the device log (hilog) for the capture window')
    .option('--jsheap', 'also dump a JS heap snapshot for the app (debuggable app only)')
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
      soDir?: string;
      hidumper?: boolean;
      uitest?: boolean;
      screenshot?: boolean;
      hilog?: boolean;
      jsheap?: boolean;
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
        io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
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
      // `--so-dir` names a host directory the device symbolizer reads. Without
      // `--hiperf` there is no perf capture to symbolize, so accepting it would
      // run a capture that quietly drops the user's request.
      if (opts.soDir !== undefined && opts.hiperf !== true) {
        io.emit({
          stdout: '',
          stderr: 'invalid --so-dir: --hiperf is required\n',
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
          io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
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
        opts.jsheap === true ||
        (hiprofilerRequest?.plugins?.includes('nativehook') ?? false);
      if (needsApp && (opts.app === undefined || opts.app === '')) {
        io.emit({
          stdout: '',
          stderr: 'missing --app: --procfs, --cold-start, --hiperf, --jsheap and the' +
            ' nativehook plugin require an application package name\n',
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
        ...(opts.soDir === undefined ? {} : { soDir: opts.soDir }),
        ...(opts.hidumper === true ? { hidumper: true } : {}),
        ...(opts.uitest === true ? { uitest: true } : {}),
        ...(opts.screenshot === true ? { screenshot: true } : {}),
        ...(opts.hilog === true ? { hilog: true } : {}),
        ...(opts.jsheap === true ? { jsheap: true } : {}),
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
        io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
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
    .command('ui-compare')
    .description('compare two captures by UI tree and screenshot')
    .argument('<a>', 'scene directory for side a')
    .argument('<b>', 'scene directory for side b')
    .requiredOption('--out <dir>', 'output directory for ui-diff.json/html and marked PNGs')
    .option('--json', 'print the comparison as JSON')
    .action(async (a: string, b: string, opts: { out: string; json?: boolean }) => {
      io.emit(await runUiCompare(deps, { a, b, outDir: opts.out }, { json: opts.json }));
    });

  program
    .command('report')
    .description('analyze a scene and write report.html, JSON, summary, CSV and XLSX')
    .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
    .requiredOption('--out <dir>', 'output directory for the report artifacts')
    .option('--app <packageName>', 'app package name, for evidence wording')
    .option('--baseline <input>', 'scene directory or `analyze --json` file to compare against')
    .option('--json', 'print the artifact manifest as JSON')
    .action(
      async (
        sceneDir: string,
        opts: { out: string; app?: string; baseline?: string; json?: boolean },
      ) => {
        io.emit(
          await runReport(
            deps,
            {
              sceneDir,
              outDir: opts.out,
              ...(opts.app === undefined ? {} : { app: opts.app }),
              ...(opts.baseline === undefined ? {} : { baseline: opts.baseline }),
            },
            { json: opts.json },
          ),
        );
      },
    );

  program
    .command('render')
    .description('re-render a saved report bundle from its report.json, without re-analyzing')
    .argument('<report>', 'report.json file or the bundle directory that holds one')
    .requiredOption('--out <dir>', 'output directory for the re-rendered artifacts')
    .option('--json', 'print the artifact manifest as JSON')
    .action(async (report: string, opts: { out: string; json?: boolean }) => {
      io.emit(await runRender(deps, { report, outDir: opts.out }, { json: opts.json }));
    });

  program
    .command('trend')
    .description('aggregate two or more saved reports into one trend page')
    .argument('<reports...>', 'report.json files or report bundle directories (at least two)')
    .requiredOption('--out <dir>', 'output directory for trend.html and trend.json')
    .option(
      '--label <label>',
      'a run label, repeated once per report in order (default: the report path)',
      collectLabels,
    )
    .option('--json', 'print the trend manifest as JSON')
    .action(async (reports: string[], opts: { out: string; label?: string[]; json?: boolean }) => {
      io.emit(
        await runTrend(
          deps,
          {
            reports: reports.map((path, index) => {
              const label = opts.label?.[index];
              return { path, ...(label === undefined ? {} : { label }) };
            }),
            outDir: opts.out,
          },
          { json: opts.json },
        ),
      );
    });

  program
    .command('hap')
    .description('inspect a .hap/.hsp package offline: files, sizes, technologies, duplicates')
    .argument('<package>', 'path to a .hap, .hsp or .zip file')
    .option('--out <dir>', 'write hap.json and hap.html to this directory')
    .option('--json', 'print the analysis as JSON')
    .action(async (packagePath: string, opts: { out?: string; json?: boolean }) => {
      io.emit(
        await runHap(
          deps,
          {
            packagePath,
            ...(opts.out === undefined ? {} : { outDir: opts.out }),
          },
          { json: opts.json },
        ),
      );
    });

  program
    .command('run')
    .description('run a declarative scenario, capturing one scene per step')
    .argument('[scenario]', 'scenario JSON file (omit when using --cases)')
    .requiredOption('--out <dir>', 'run output directory (one scene per step)')
    .option('--cases <dir>', 'run every *.scenario.json in this directory as one suite')
    .option('--filter <regex>', 'anchored regex over case ids; only with --cases')
    .option('--target <id>', 'run against this hdc target instead of the first connected one')
    .option('--rounds <n>', 'repeat every step this many times (overrides the scenario)')
    .option('--only <ids>', 'comma-separated step ids to run, in scenario order')
    .option('--keep-going', 'continue after a failed step instead of stopping')
    .option('--json', 'print the run result as JSON')
    .action(async (scenarioPath: string | undefined, opts: {
      out: string;
      cases?: string;
      filter?: string;
      target?: string;
      rounds?: string;
      only?: string;
      keepGoing?: boolean;
      json?: boolean;
    }) => {
      // Parse both list/number flags before any device is touched, so a bad
      // value produces the CLI-wide failure contract rather than a partial run.
      let rounds: number | undefined;
      let only: string[] | undefined;
      try {
        if (opts.rounds !== undefined) {
          if (!/^[1-9]\d*$/.test(opts.rounds)) {
            throw new Error(
              `invalid --rounds ${JSON.stringify(opts.rounds)}: expected a positive whole number`,
            );
          }
          rounds = Number(opts.rounds);
        }
        only = opts.only === undefined ? undefined : parseOnly(opts.only);
      } catch (err) {
        io.emit({ stdout: '', stderr: `${failureLine(err)}
`, exitCode: 1 });
        return;
      }
      io.emit(await runScenarioCommand(deps, {
        scenarioPath: scenarioPath ?? '',
        outDir: opts.out,
        ...(opts.cases === undefined ? {} : { casesDir: opts.cases }),
        ...(opts.filter === undefined ? {} : { filter: opts.filter }),
        ...(opts.target === undefined ? {} : { target: opts.target }),
        ...(rounds === undefined ? {} : { rounds }),
        ...(only === undefined ? {} : { only }),
        ...(opts.keepGoing === true ? { keepGoing: true } : {}),
      }, { json: opts.json }));
    });

  program
    .command('explore')
    .description('walk an app\'s UI, tapping unvisited elements, and report the screens reached')
    .argument('<app>', 'bundle name to explore, e.g. com.example.app')
    .option('--max-steps <n>', 'stop after this many taps', '30')
    .option(
      '--strategy <name>',
      'depth_first, breadth_first or random',
      'depth_first',
    )
    .option('--seed <n>', 'make --strategy random reproducible')
    .option('--target <id>', 'walk this hdc target instead of the first connected one')
    .option('--json', 'print the walk result as JSON')
    .action(async (app: string, opts: {
      maxSteps: string;
      strategy: string;
      seed?: string;
      target?: string;
      json?: boolean;
    }) => {
      // Parse before touching a device: an unknown strategy is an invocation
      // error, and the walk has no sensible fallback to run instead.
      let maxSteps: number;
      let strategy: 'depth_first' | 'breadth_first' | 'random';
      let seed: number | undefined;
      try {
        maxSteps = parseMaxSteps(opts.maxSteps);
        strategy = parseStrategy(opts.strategy);
        if (opts.seed !== undefined) {
          seed = parseMaxSteps(opts.seed);
        }
      } catch (err) {
        io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
        return;
      }
      io.emit(
        await runExplore(
          deps,
          {
            app,
            maxSteps,
            strategy,
            ...(seed === undefined ? {} : { seed }),
            ...(opts.target === undefined ? {} : { target: opts.target }),
          },
          { json: opts.json },
        ),
      );
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
      // rejects anything that is not a positive whole number of milliseconds.
      // Its message names `--duration`, so the flag is re-worded; the reason
      // is kept, because `9999999` is rejected for the 32-bit limit, not for
      // being non-positive, and the caller needs the real one.
      try {
        timeoutMs = parseDurationSeconds(timeout);
      } catch (err) {
        // The parser's reason, minus its `--duration`-specific prefix. A
        // non-positive value gets the flag's own wording; every other
        // rejection (32-bit limit, sub-millisecond fraction) keeps the real
        // reason, because "must be greater than 0" would be false for it.
        const reason = safeMessage(err).replace(/^invalid --duration [^:]*: /, '');
        const message = reason.startsWith('expected a positive number of seconds')
          ? '--timeout must be greater than 0 (a positive number of seconds, e.g. 30)'
          : reason;
        io.emit({
          stdout: '',
          stderr: `invalid --timeout ${JSON.stringify(timeout)}: ${message}\n`,
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
      // `Number.parseInt` would turn `6.5` into 6 and `6abc` into 6: an
      // instance created at a size the caller never asked for. A GB count is
      // a whole number, so anything else is a usage error.
      const value = Number(raw);
      if (!Number.isInteger(value)) {
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
      io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
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

  /**
   * Gesture injection.
   *
   * Every subcommand declares `--target`/`--json` for the same reason the
   * emulator group does: commander resolves options against the command whose
   * action consumes them. The argument parsers run inside the action's
   * `build` callback so a bad positional takes the CLI-wide failure path
   * (empty stdout, one stderr line, exit 1) -- not commander's own usage
   * error, and never a device call.
   */
  const gestureGroup = program
    .command('gesture')
    .description('inject a UI gesture on the attached device');

  const withGestureTargets = (cmd: Command): Command =>
    cmd
      .option('--target <id>', 'inject on this hdc target instead of the first connected one')
      .option('--json', 'print the result as JSON');

  const sendGesture = async (
    build: () => Gesture,
    opts: { target?: string; json?: boolean },
  ): Promise<void> => {
    let gesture: Gesture;
    try {
      gesture = build();
    } catch (err) {
      io.emit({ stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 });
      return;
    }
    io.emit(await runGesture(deps, {
      gesture,
      ...(opts.target === undefined ? {} : { target: opts.target }),
    }, { json: opts.json }));
  };

  withGestureTargets(
    gestureGroup
      .command('click')
      .description('tap at <x>,<y>')
      .argument('<x>')
      .argument('<y>'),
  ).action(async (x: string, y: string, opts: { target?: string; json?: boolean }) => {
    await sendGesture(
      () => ({ action: 'click', x: parseCoordinate(x, '<x>'), y: parseCoordinate(y, '<y>') }),
      opts,
    );
  });

  withGestureTargets(
    gestureGroup
      .command('swipe')
      .description('swipe from <from-x>,<from-y> to <to-x>,<to-y>')
      .argument('<from-x>')
      .argument('<from-y>')
      .argument('<to-x>')
      .argument('<to-y>')
      .option('--velocity <n>', 'swipe velocity, 200 to 40000 (device default 600)'),
  ).action(async (
    fromX: string,
    fromY: string,
    toX: string,
    toY: string,
    opts: { velocity?: string; target?: string; json?: boolean },
  ) => {
    await sendGesture(
      () => ({
        action: 'swipe',
        fromX: parseCoordinate(fromX, '<from-x>'),
        fromY: parseCoordinate(fromY, '<from-y>'),
        toX: parseCoordinate(toX, '<to-x>'),
        toY: parseCoordinate(toY, '<to-y>'),
        ...(opts.velocity === undefined ? {} : { velocity: parseVelocity(opts.velocity) }),
      }),
      opts,
    );
  });

  withGestureTargets(
    gestureGroup
      .command('key')
      .description('inject a key event')
      .argument('<key>', 'Back, Home, Power or a positive key code'),
  ).action(async (key: string, opts: { target?: string; json?: boolean }) => {
    await sendGesture(() => ({ action: 'key', key: parseKey(key) }), opts);
  });

  withGestureTargets(
    gestureGroup
      .command('input')
      .description('type text at <x>,<y>')
      .argument('<x>')
      .argument('<y>')
      .argument('<text>', 'text to type; quote it when it contains spaces'),
  ).action(async (x: string, y: string, text: string, opts: { target?: string; json?: boolean }) => {
    await sendGesture(
      () => ({
        action: 'inputText',
        x: parseCoordinate(x, '<x>'),
        y: parseCoordinate(y, '<y>'),
        text: parseText(text),
      }),
      opts,
    );
  });

  withGestureTargets(
    gestureGroup
      .command('text')
      .description('type text at the focused field')
      .argument('<text>', 'text to type; quote it when it contains spaces'),
  ).action(async (text: string, opts: { target?: string; json?: boolean }) => {
    await sendGesture(() => ({ action: 'text', text: parseText(text) }), opts);
  });

  return program;
}
