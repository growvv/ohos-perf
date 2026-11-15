import { Command } from 'commander';
import type { HiprofilerPluginName } from '@ohos-perf/core';
import {
  runAnalyze,
  runCaps,
  runCollect,
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
    .requiredOption('--app <pkg>', 'application package name')
    .requiredOption('--duration <seconds>', 'capture duration in seconds (10 or 10s)')
    .requiredOption('--out <dir>', 'scene output directory')
    .option('--procfs', 'also sample /proc memory state for the app')
    .option('--cold-start <ability>', 'launch this ability before capturing')
    .option('--hiprofiler', 'capture through hiprofiler instead of hitrace')
    .option(
      '--plugins <list>',
      'hiprofiler plugins, comma-separated: ftrace, gpu, xpower, nativehook',
    )
    .option('--json', 'print the result as JSON')
    .action(async (opts: {
      app: string;
      duration: string;
      out: string;
      procfs?: boolean;
      coldStart?: string;
      hiprofiler?: boolean;
      plugins?: string;
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

      io.emit(await runCollect(deps, {
        app: opts.app,
        durationMs,
        out: opts.out,
        ...(opts.procfs === true ? { procfs: true } : {}),
        ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
        ...(hiprofilerRequest === undefined ? {} : { hiprofiler: hiprofilerRequest }),
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
    .command('tools')
    .description('list the named drill-down queries an agent can call')
    .option('--json', 'print the query definitions as JSON')
    .action((opts: { json?: boolean }) => {
      io.emit(runTools(deps, opts));
    });

  return program;
}
