import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OhosPerfError,
  buildToolResult,
  renderToolResultFile,
  renderToolResultLine,
  type CasePrompt,
  type Gesture,
  type HiprofilerPluginName,
} from '@ohos-perf/core';
import {
  runAnalyze,
  runCaps,
  runCollect,
  runCompare,
  runGate,
  runDoctor,
  runEmulatorCreate,
  runEmulatorList,
  runEmulatorStart,
  runEmulatorStop,
  runGesture,
  runHap,
  runOptimization,
  runSuspects,
  runQuery,
  runReport,
  runRender,
  runRootCauseCommand,
  runExplore,
  runAgentCommand,
  runSymbolRecovery,
  runScenarioCommand,
  runTools,
  runTrend,
  runUiCompare,
  safeMessage,
  failureResult,
  type CliDeps,
  type CliResult,
  type EmulatorTargetOptions,
} from './commands';
import {
  parseDurationSeconds, parsePluginList, parseThermalIntervalSeconds,
} from './collect';
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
  /**
   * Write the tool-result file. Injected so tests never touch the disk.
   *
   * Optional: twenty-odd test harnesses build this object, and a required
   * member would turn every one of them red for a path they never take. When
   * it is absent, `--result-file` is a `TOOL_RESULT_BAD_PATH` failure rather
   * than a silent no-op.
   */
  writeFile?(path: string, contents: string): void;
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

/**
 * The prompt `suspects` ranks against, from a file or from flags.
 *
 * `--prompt` reads the same `prompt.json` shape the benchmark ships, so a
 * caller can point at the file it already has. `--symptom` and `--scenario`
 * are the same two fields for someone who has no file. Both forms produce the
 * same value; a malformed file is an invocation error, not a scan failure.
 */
function readPrompt(opts: { prompt?: string; symptom?: string; scenario?: string }): CasePrompt | undefined {
  if (opts.prompt !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opts.prompt, 'utf8'));
    } catch (err) {
      throw new OhosPerfError(`cannot read prompt file ${opts.prompt}: ${safeMessage(err)}`, {
        code: 'SUSPECTS_BAD_PROMPT',
      });
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new OhosPerfError(`prompt file is not an object: ${opts.prompt}`, { code: 'SUSPECTS_BAD_PROMPT' });
    }
    const record = parsed as Record<string, unknown>;
    const scenarios = record.perf_scenarios;
    return {
      ...(typeof record.symptom === 'string' ? { symptom: record.symptom } : {}),
      ...(typeof record.scenario === 'string' ? { scenario: record.scenario } : {}),
      ...(Array.isArray(scenarios) && scenarios.every((entry) => typeof entry === 'string')
        ? { perf_scenarios: scenarios as string[] }
        : {}),
    };
  }
  if (opts.symptom === undefined && opts.scenario === undefined) return undefined;
  return {
    ...(opts.symptom === undefined ? {} : { symptom: opts.symptom }),
    ...(opts.scenario === undefined ? {} : { scenario: opts.scenario }),
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

  // Global, so they work on every command without being declared 25 times.
  // `--machine-json` is the envelope form of `--json`: the payload has to be
  // the structured answer, so the hook asks the command for it rather than
  // twenty-five branches each remembering to.
  program
    .option('--machine-json', 'print one tool-result envelope line on stdout instead of the command output')
    .option('--result-file <path>', 'write the tool-result envelope to this file');

  /**
   * The command whose action is running; set by `preAction`, read by `emit`.
   *
   * A stack, not a slot: `buildProgram` is exported and a harness may parse
   * the same program concurrently, in which case a single variable would let
   * the second action relabel the first one's envelope. `postAction` pops, and
   * `emit` reads the top.
   */
  const running: Command[] = [];

  program.hook('preAction', (_self, action) => {
    running.push(action);
    const globals = action.optsWithGlobals() as { machineJson?: boolean; resultFile?: string };
    // Both flags ask for an envelope, and an envelope wraps the structured
    // answer. `--result-file` alone would otherwise write `outputs: {}` for
    // every command whose payload lives only in its `--json` branch.
    if (globals.machineJson === true || globals.resultFile !== undefined) {
      action.setOptionValue('json', true);
    }
  });

  program.hook('postAction', () => {
    running.pop();
  });

  /** `analyze`, `emulator.list` — the path a consumer branches on. */
  const commandPath = (command: Command): string => {
    const parts: string[] = [];
    for (let node: Command | null = command; node !== null && node.parent !== null; node = node.parent) {
      parts.unshift(node.name());
    }
    return parts.join('.');
  };

  /**
   * Wrap a result in the tool-result envelope, when the caller asked for one.
   *
   * `--result-file` writes the document and leaves stdout alone; `--machine-json`
   * replaces stdout with one line. With neither flag this returns the result
   * untouched, so the human path is byte-identical to before.
   *
   * A result file that cannot be written is a failure of the invocation, not a
   * warning: a success line beside a file that does not exist is the one
   * outcome a caller must never have to discover by checking.
   */
  const finish = (command: Command, result: CliResult): CliResult => {
    const globals = command.optsWithGlobals() as { machineJson?: boolean; resultFile?: string };
    if (globals.machineJson !== true && globals.resultFile === undefined) return result;
    const envelope = buildToolResult({
      toolVersion: deps.version,
      command: commandPath(command),
      exitCode: result.exitCode,
      ...(result.result === undefined ? {} : { payload: result.result }),
      ...(result.error === undefined ? {} : { error: result.error }),
    });
    if (globals.resultFile !== undefined) {
      const path = resolve(globals.resultFile);
      try {
        if (io.writeFile === undefined) {
          throw new Error('no file writer is wired for this invocation');
        }
        io.writeFile(path, renderToolResultFile(envelope));
      } catch (err) {
        // The command may have succeeded, but the contract it was asked to
        // write did not. The envelope for *that* failure is the answer, and
        // under `--machine-json` it still has to be one line — a caller that
        // sees zero lines cannot tell a crash from a quiet success.
        const failure = failureResult(new OhosPerfError(
          `could not write the tool result to ${path}: ${safeMessage(err)}`,
          { code: 'TOOL_RESULT_BAD_PATH' },
        ));
        return globals.machineJson === true
          ? {
              ...failure,
              stdout: renderToolResultLine(buildToolResult({
                toolVersion: deps.version,
                command: commandPath(command),
                exitCode: failure.exitCode,
                ...(failure.error === undefined ? {} : { error: failure.error }),
              })),
            }
          : failure;
      }
    }
    return globals.machineJson === true
      ? { ...result, stdout: renderToolResultLine(envelope) }
      : result;
  };

  /** `io.emit` plus the envelope, for every action in this program. */
  const emit = (result: CliResult): void => {
    const current = running[running.length - 1];
    io.emit(current === undefined ? result : finish(current, result));
  };

  program
    .command('doctor')
    .description('check the hdc/trace_streamer toolchain and the attached device')
    .option('--target <id>', 'probe this hdc target instead of the first connected one')
    .option('--json', 'print the report as JSON')
    .action(async (opts: { target?: string; json?: boolean }) => {
      // `doctor` probes through the same injected deps as `caps`; when a
      // target is named, the device half of its report must honour it or the
      // report describes a different device than the one asked about.
      emit(await runDoctor(deps, opts));
    });

  program
    .command('caps')
    .description('print the capability matrix of the attached device')
    .option('--target <id>', 'probe this hdc target instead of the first connected one')
    .option('--json', 'print the capabilities as JSON')
    .action(async (opts: { target?: string; json?: boolean }) => {
      emit(await runCaps(deps, opts));
    });

  program
    .command('analyze')
    .description('analyze a captured scene directory (trace.db or trace.htrace)')
    .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
    .option('--app <packageName>', 'app package name, for evidence wording')
    .option('--json', 'print the analysis result as JSON')
    .action(async (sceneDir: string, opts: { app?: string; json?: boolean }) => {
      emit(await runAnalyze(deps, sceneDir, opts));
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
    .option('--thermal', 'also sample the device thermal sensors for the capture window')
    .option(
      '--thermal-interval <seconds>',
      'thermal sampling interval in seconds (default 5, between 0.1 and 3600)',
    )
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
      thermal?: boolean;
      thermalInterval?: string;
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
        emit(failureResult(err));
        return;
      }

      // `--plugins` only means something to hiprofiler. Accepting it silently
      // without `--hiprofiler` would capture through hitrace and quietly drop
      // the user's request.
      if (opts.plugins !== undefined && opts.hiprofiler !== true) {
        emit(failureResult(new OhosPerfError(
          'invalid --plugins: --hiprofiler is required',
          { code: 'COLLECT_PLUGINS_WITHOUT_HIPROFILER' },
        )));
        return;
      }
      // `--so-dir` names a host directory the device symbolizer reads. Without
      // `--hiperf` there is no perf capture to symbolize, so accepting it would
      // run a capture that quietly drops the user's request.
      if (opts.soDir !== undefined && opts.hiperf !== true) {
        emit(failureResult(new OhosPerfError(
          'invalid --so-dir: --hiperf is required',
          { code: 'COLLECT_SO_DIR_WITHOUT_HIPERF' },
        )));
        return;
      }
      // The interval only means something to a thermal capture; accepting it
      // alone would run a capture that quietly drops the user's request.
      if (opts.thermalInterval !== undefined && opts.thermal !== true) {
        emit(failureResult(new OhosPerfError(
          'invalid --thermal-interval: --thermal is required',
          { code: 'COLLECT_THERMAL_INTERVAL_WITHOUT_THERMAL' },
        )));
        return;
      }
      let thermalRequest: boolean | { intervalMs: number } | undefined;
      if (opts.thermal === true) {
        if (opts.thermalInterval === undefined) {
          thermalRequest = true;
        } else {
          try {
            thermalRequest = {
              intervalMs: parseThermalIntervalSeconds(opts.thermalInterval),
            };
          } catch (err) {
            emit(failureResult(err));
            return;
          }
        }
      }

      let hiprofilerRequest: { plugins?: readonly HiprofilerPluginName[] } | undefined;
      if (opts.hiprofiler === true) {
        try {
          hiprofilerRequest = opts.plugins === undefined
            ? {}
            : { plugins: parsePluginList(opts.plugins) };
        } catch (err) {
          emit(failureResult(err));
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
        emit(failureResult(new OhosPerfError(
          'missing --app: --procfs, --cold-start, --hiperf, --jsheap and the' +
            ' nativehook plugin require an application package name',
          { code: 'COLLECT_APP_REQUIRED' },
        )));
        return;
      }

      emit(await runCollect(deps, {
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
        ...(thermalRequest === undefined ? {} : { thermal: thermalRequest }),
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
        emit(failureResult(err));
        return;
      }
      emit(await runQuery(deps, {
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
      emit(await runCompare(deps, { baseline, current }, { json: opts.json }));
    });

  program
    .command('gate')
    .description('judge a run against a versioned budget document; exit 2 when a budget fails')
    .argument('<budget>', 'budget document (JSON)')
    .argument('<input>', 'scene directory or `analyze --json` file to judge')
    .option('--baseline <input>', 'scene directory or `analyze --json` file for delta budgets')
    .option('--out <dir>', 'write gate.json to this directory')
    .option('--json', 'print the gate result as JSON')
    .addHelpText('after', `
Exit codes: 0 every budget passed, 2 a budget failed or a metric it names was
not measured, 1 the gate could not run. A metric the run never emitted is a
failure, never a pass.`)
    .action(async (budget: string, input: string, opts: {
      baseline?: string;
      out?: string;
      json?: boolean;
    }) => {
      emit(
        await runGate(
          deps,
          {
            budget,
            input,
            ...(opts.baseline === undefined ? {} : { baseline: opts.baseline }),
            ...(opts.out === undefined ? {} : { outDir: opts.out }),
          },
          { json: opts.json },
        ),
      );
    });

  program
    .command('ui-compare')
    .description('compare two captures by UI tree and screenshot')
    .argument('<a>', 'scene directory for side a')
    .argument('<b>', 'scene directory for side b')
    .requiredOption('--out <dir>', 'output directory for ui-diff.json/html and marked PNGs')
    .option('--json', 'print the comparison as JSON')
    .action(async (a: string, b: string, opts: { out: string; json?: boolean }) => {
      emit(await runUiCompare(deps, { a, b, outDir: opts.out }, { json: opts.json }));
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
        emit(
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
      emit(await runRender(deps, { report, outDir: opts.out }, { json: opts.json }));
    });

  program
    .command('root-cause')
    .description('rank a scene\'s measured evidence and explain it, with a model when one is configured')
    .argument('<input>', 'scene directory, report.json file, or a report bundle directory')
    .requiredOption('--out <dir>', 'output directory for root-cause.json, .md and .evidence.json')
    .option('--baseline <input>', 'scene or report to compare against; the movement is always baseline -> input')
    .option('--offline', 'never ask a model; write the deterministic report alone')
    .option('--model <name>', 'model name to send; defaults to the configured one')
    .option('--app <packageName>', 'app package name, for evidence wording')
    .option('--json', 'print the root-cause document as JSON')
    .addHelpText('after', `
With no endpoint configured this writes the offline report and says so, rather
than failing: the ranked evidence is the report, and the model is an addition.
A suspect citing a name this run never measured is marked ungrounded.`)
    .action(async (input: string, opts: {
      out: string;
      baseline?: string;
      offline?: boolean;
      model?: string;
      app?: string;
      json?: boolean;
    }) => {
      emit(
        await runRootCauseCommand(
          deps,
          {
            input,
            outDir: opts.out,
            ...(opts.baseline === undefined ? {} : { baseline: opts.baseline }),
            ...(opts.offline === true ? { offline: true } : {}),
            ...(opts.model === undefined ? {} : { model: opts.model }),
            ...(opts.app === undefined ? {} : { app: opts.app }),
          },
          { json: opts.json },
        ),
      );
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
      emit(
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
      emit(
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
    .command('opt')
    .description(
      "inspect a package's arm64 libraries: optimization level, LTO, debug info",
    )
    .argument('<package>', 'path to a .hap, .hsp, .zip or .so file')
    .option('--json', 'print the analysis as JSON')
    .action(async (packagePath: string, opts: { json?: boolean }) => {
      emit(await runOptimization(deps, { packagePath }, { json: opts.json }));
    });

  program
    .command('suspects')
    .description('scan an ArkTS source tree for performance defects, ranked')
    .argument('<root>', 'project directory to scan')
    .option('--prompt <file>', 'prompt.json with the reported symptom; narrows the ranking')
    .option('--symptom <text>', 'the reported symptom, inline')
    .option('--scenario <text>', 'the perf scenario list, comma separated')
    .option('--out <dir>', 'write suspects.json to this directory')
    .option('--json', 'print the report as JSON')
    .action(
      async (
        root: string,
        opts: { prompt?: string; symptom?: string; scenario?: string; out?: string; json?: boolean },
      ) => {
        const prompt = readPrompt(opts);
        emit(
          await runSuspects(
            deps,
            {
              root,
              ...(prompt === undefined ? {} : { prompt }),
              ...(opts.out === undefined ? {} : { outDir: opts.out }),
            },
            { json: opts.json },
          ),
        );
      },
    );

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
            throw new OhosPerfError(
              `invalid --rounds ${JSON.stringify(opts.rounds)}: expected a positive whole number`,
              { code: 'SCENARIO_BAD_ROUNDS' },
            );
          }
          rounds = Number(opts.rounds);
        }
        only = opts.only === undefined ? undefined : parseOnly(opts.only);
      } catch (err) {
        emit(failureResult(err));
        return;
      }
      emit(await runScenarioCommand(deps, {
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
    .option('--max-steps <n>', 'stop after this many steps', '30')
    .option(
      '--strategy <name>',
      'depth_first, breadth_first or random',
      'depth_first',
    )
    .option('--seed <n>', 'make --strategy random reproducible')
    .option('--model <name>', 'let this model choose each step from the elements the walk found')
    .option('--target <id>', 'walk this hdc target instead of the first connected one')
    .option('--json', 'print the walk result as JSON')
    .addHelpText('after', `
--model needs OHOS_PERF_AGENT_BASE_URL and OHOS_PERF_AGENT_API_KEY (or GLM_*).
The model chooses among the elements the walk dumped; it never supplies
coordinates, and irreversible targets are not offered to it. An answer that
names an element not on the offer is refused and the deterministic order decides
instead.`)
    .action(async (app: string, opts: {
      maxSteps: string;
      strategy: string;
      seed?: string;
      model?: string;
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
        emit(failureResult(err));
        return;
      }
      emit(
        await runExplore(
          deps,
          {
            app,
            maxSteps,
            strategy,
            ...(seed === undefined ? {} : { seed }),
            ...(opts.model === undefined ? {} : { model: opts.model }),
            ...(opts.target === undefined ? {} : { target: opts.target }),
          },
          { json: opts.json },
        ),
      );
    });

  program
    .command('agent')
    .description('drive an app toward a task with a model, and verify the screen reached')
    .argument('<app>', 'bundle name to drive, e.g. com.example.app')
    .argument('<task>', 'what the model should accomplish, in your words')
    .option('--max-steps <n>', 'stop after this many model turns', '50')
    .option('--model <name>', 'model name to send; defaults to the configured one')
    .option('--allow-irreversible', "let the guard's refusals through (payment, ordering, ...)")
    .option('--target <id>', 'drive this hdc target instead of the first connected one')
    .option('--json', 'print the transcript as JSON')
    .addHelpText('after', `
A model chooses every gesture, so this acts on whatever account is signed in.
Irreversible targets are refused by label, but a label is not intent: review the
walk, and prefer a test account or a disposable build.`)
    .action(async (app: string, task: string, opts: {
      maxSteps: string;
      model?: string;
      allowIrreversible?: boolean;
      target?: string;
      json?: boolean;
    }) => {
      // Parsed before any device or endpoint is touched, for the same reason
      // `explore` does: a bad count is an invocation error, not a run.
      let maxSteps: number;
      try {
        maxSteps = parseMaxSteps(opts.maxSteps);
      } catch (err) {
        emit(failureResult(err));
        return;
      }
      emit(
        await runAgentCommand(
          deps,
          {
            app,
            task,
            maxSteps,
            ...(opts.model === undefined ? {} : { model: opts.model }),
            ...(opts.allowIrreversible === true ? { allowIrreversible: true } : {}),
            ...(opts.target === undefined ? {} : { target: opts.target }),
          },
          { json: opts.json },
        ),
      );
    });

  program
    .command('symbols')
    .description('name the addresses a capture could not, from the libraries it ran')
    .command('recover')
    .description("name unresolved addresses from a library's own symbol table")
    .argument('<library>', 'shared object to read, e.g. libs/arm64/libapp.so')
    .argument('[addresses...]', 'libfoo.so+0xoffset references, as a capture writes them')
    .option('--measure', 'ask the model to name held-out functions and report its accuracy')
    .option('--model <name>', 'model name to send when --measure is used')
    .option('--json', 'print the recovery as JSON')
    .action(async (library: string, addresses: string[], opts: {
      measure?: boolean;
      model?: string;
      json?: boolean;
    }) => {
      emit(
        await runSymbolRecovery(
          deps,
          {
            library,
            addresses,
            ...(opts.measure === true ? { measure: true } : {}),
            ...(opts.model === undefined ? {} : { model: opts.model }),
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
      emit(runTools(deps, opts));
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
    emit(await runEmulatorList(deps, {
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
        emit({
          stdout: '',
          stderr: `invalid --timeout ${JSON.stringify(timeout)}: ${message}\n`,
          exitCode: 1,
        });
        return;
      }
    }
    emit(await runEmulatorStart(deps, name, {
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
    emit(await runEmulatorStop(deps, name, {
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
      emit(failureResult(new OhosPerfError(
        '--device-type and --os-version are required',
        { code: 'EMULATOR_FLAGS_REQUIRED' },
      )));
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
      emit(failureResult(err));
      return;
    }
    emit(await runEmulatorCreate(deps, {
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
      emit(failureResult(err));
      return;
    }
    emit(await runGesture(deps, {
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

  /**
   * The MCP server.
   *
   * Registered last on purpose: its catalog is derived from the program, so
   * every command above is a tool, and this one is not (a server cannot call
   * itself into being). It owns stdout from here on — the framing is one
   * JSON-RPC message per line — so the action writes nothing else.
   */
  program
    .command('mcp')
    .description('serve every command as an MCP tool over stdio')
    .addHelpText('after', `
The tool list is the CLI itself: one tool per command, named ohos-perf_<path>
(ohos-perf_emulator_list). Each call runs the command with --machine-json and
returns the tool-result envelope as structuredContent. isError means the
command could not run; a failed gate is a successful call reporting bad news.`)
    .action(async () => {
      const { createMcpServer } = await import('./mcp-server');
      const { buildCatalog } = await import('./mcp-catalog');
      const server = createMcpServer({
        tools: buildCatalog(program),
        run: (argv) => deps.runCli(argv),
        version: deps.version,
      });
      const readline = await import('node:readline');
      const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      // A failure while answering one line must not end the session: the
      // client would see a closed pipe mid-task with no diagnosis.
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let answer: string | undefined;
        try {
          answer = await server.handle(line);
        } catch (err) {
          io.writeErr(`mcp: ${safeMessage(err)}\n`);
          continue;
        }
        if (answer !== undefined) io.writeOut(answer);
      }
    });

  return program;
}
