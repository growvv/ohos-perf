import { Command } from 'commander';
import type { HiprofilerPluginName } from '@ohos-perf/core';
import {
  runAnalyze,
  runCaps,
  runCollect,
  runCompare,
  runDoctor,
  runQuery,
  runTools,
  safeMessage,
  type CliDeps,
  type CliResult,
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
    .option('--json', 'print the report as JSON')
    .action(async (opts: { json?: boolean }) => {
      io.emit(await runDoctor(deps, opts));
    });

  program
    .command('caps')
    .description('print the capability matrix of the attached device')
    .option('--json', 'print the capabilities as JSON')
    .action(async (opts: { json?: boolean }) => {
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
      'hiprofiler plugins, comma-separated: ftrace, gpu, xpower, nativehook',
    )
    .option('--hiperf', 'also capture a hiperf perf.data (debuggable app only)')
    .option('--hidumper', 'also sample the RenderService fps and hitch counters')
    .option('--uitest', 'also dump the on-screen UI tree')
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

  return program;
}
