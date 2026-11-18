#!/usr/bin/env node
import { CommanderError } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  OhosPerfError,
  buildToolResult,
  renderToolResultFile,
  renderToolResultLine,
} from '@ohos-perf/core';
import { failureLine, failureResult, type CliResult } from './commands';
import { realDeps } from './deps';
import { buildProgram } from './program';

/**
 * The executable entry point: process globals only.
 *
 * All CLI logic lives in `commands.ts` (pure), `deps.ts` (real IO) and
 * `program.ts` (commander wiring), so it can be tested without executing
 * this file. The one thing that cannot live there is a commander usage error:
 * it never reaches an action, so the tool-result envelope for it is built
 * here, from argv and the thrown error.
 */

const deps = realDeps();

function emit(result: CliResult): void {
  try {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (err) {
    // A closed pipe (e.g. `| head`) is not an analysis failure.
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

/**
 * A consumer that stops reading (`| head`) closes the pipe asynchronously, so
 * the `write()` above may succeed and the error still arrives as a stream
 * event. Treat it as a normal end, not a crash.
 */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    // A consumer that stopped reading (`| head`) is not an analysis failure.
    // Do NOT exit here: `emit()` has already computed the exit code, and
    // `process.exit(0)` would turn a failed analysis into success.
    if (err.code === 'EPIPE') return;
    // A non-EPIPE stream failure is a real problem. Throwing here would escape
    // `parseAsync(...).catch` and print a raw Node stack; report it in the
    // same one-line form as every other CLI error instead.
    process.stderr.write(`${failureLine(err)}\n`);
    process.exitCode = 1;
  });
}

ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

/** The global flags that ask for the envelope, read straight from argv. */
interface ContractFlags {
  readonly machineJson: boolean;
  readonly resultFile?: string;
}

/**
 * Read the two contract flags out of raw argv.
 *
 * They are declared on the program, but a usage error is thrown before
 * commander finishes parsing, so the parsed options are not available. Reading
 * argv is the only way to answer "did the caller ask for an envelope?" for a
 * command that never ran.
 */
function contractFlags(argv: readonly string[]): ContractFlags {
  let machineJson = false;
  let resultFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--machine-json') {
      machineJson = true;
    } else if (arg === '--result-file') {
      resultFile = argv[index + 1];
      index += 1;
    } else if (arg !== undefined && arg.startsWith('--result-file=')) {
      resultFile = arg.slice('--result-file='.length);
    }
  }
  return { machineJson, ...(resultFile === undefined ? {} : { resultFile }) };
}

/**
 * The command path from raw argv: the first non-flag token, plus its subcommand.
 *
 * The value of a flag is not a command name, so `--result-file out/r.json
 * root-cause` has to skip the path — a walker that took the first non-dash
 * token would label the run `out/r.json`.
 */
function commandPathFrom(argv: readonly string[]): string {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--result-file') {
      index += 1;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }
  const [first, second] = positionals;
  if (first === undefined) return 'ohos-perf';
  // Only the three grouped commands have a second level, and each names its
  // subcommand as the next positional.
  if (first === 'emulator' || first === 'gesture' || first === 'symbols') {
    return second === undefined ? first : `${first}.${second}`;
  }
  return first;
}

/**
 * A commander throw that is a request for text, not a failure.
 *
 * Three codes mean "commander printed what was asked and is done":
 * `helpDisplayed` (`--help`), `version` (`--version`) and `help` (the `help`
 * subcommand, or a group invoked with no subcommand — the latter with exit 1,
 * which is commander's own long-standing behaviour). None of them is a result,
 * so none gets an envelope, and none may be re-printed: commander's own
 * message for these is the `(outputHelp)` placeholder, which is not text for
 * a user.
 */
function isTextRequest(err: unknown): boolean {
  return err instanceof CommanderError
    && (err.code === 'commander.helpDisplayed'
      || err.code === 'commander.version'
      || err.code === 'commander.help');
}

/**
 * The envelope for a commander failure, or `undefined` when the caller asked
 * for no envelope — or for help, which is not a result.
 *
 * Commander has already printed its own message through `writeErr`; the
 * envelope is added on stdout, so a machine reader gets one document and a
 * human still sees the usage line.
 */
function usageEnvelope(
  argv: readonly string[],
  err: unknown,
  version: string,
): CliResult | undefined {
  if (!(err instanceof CommanderError) || isTextRequest(err)) return undefined;
  const flags = contractFlags(argv);
  if (!flags.machineJson && flags.resultFile === undefined) return undefined;

  const envelope = buildToolResult({
    toolVersion: version,
    command: commandPathFrom(argv),
    exitCode: 1,
    error: { code: 'CLI_USAGE', message: err.message },
  });

  if (flags.resultFile !== undefined) {
    const path = resolve(flags.resultFile);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderToolResultFile(envelope), 'utf8');
    } catch (writeError) {
      return failureResult(new OhosPerfError(
        `could not write the tool result to ${path}: ${(writeError as Error).message}`,
        { code: 'TOOL_RESULT_BAD_PATH' },
      ));
    }
  }
  return flags.machineJson
    ? { stdout: renderToolResultLine(envelope), stderr: '', exitCode: 1 }
    : { stdout: '', stderr: '', exitCode: 1 };
}

const program = buildProgram(deps, {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  emit,
  writeFile: (path, contents) => {
    // Parents are created here rather than in `program.ts`: the wiring layer
    // owns the filesystem, and a genuine permission failure still surfaces as
    // the same typed error.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  },
}, {
  // Without this commander calls `process.exit` on a usage error, so the
  // failure never reaches the catch below and a `--machine-json` caller gets
  // an empty stdout. The override moves the exit decision here, where the
  // envelope is built; `exitCode` is still commander's (1 for usage, 0 for
  // help and version), so the observable behaviour is unchanged.
  exitOverride: true,
});

program.parseAsync(process.argv).catch((err: unknown) => {
  // With `exitOverride`, commander throws even for help and version, which are
  // successful requests for text it has already written. Their exit code is
  // the one commander chose (0 for `--help`/`--version`, 1 for a bare group),
  // and there is nothing left to print.
  if (err instanceof CommanderError && isTextRequest(err)) {
    process.exitCode = err.exitCode;
    return;
  }
  const envelope = usageEnvelope(process.argv.slice(2), err, deps.version);
  if (envelope !== undefined) {
    // Commander already wrote its own message through `writeErr`; the
    // envelope replaces it on stdout, and re-printing it here would show every
    // usage error twice.
    emit(envelope);
    return;
  }
  if (err instanceof CommanderError) {
    // A usage error with no envelope: commander has already written the
    // message (and any suggestion) through `writeErr`, so printing it again
    // would duplicate it. Only the exit code is ours to set.
    process.exitCode = err.exitCode === 0 ? 1 : err.exitCode;
    return;
  }
  process.stderr.write(`${failureLine(err)}\n`);
  process.exitCode = 1;
});
