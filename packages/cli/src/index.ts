#!/usr/bin/env node
import { safeMessage, type CliResult } from './commands';
import { realDeps } from './deps';
import { buildProgram } from './program';

/**
 * The executable entry point: process globals only.
 *
 * All CLI logic lives in `commands.ts` (pure), `deps.ts` (real IO) and
 * `program.ts` (commander wiring), so it can be tested without executing
 * this file.
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
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

const program = buildProgram(deps, {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  emit,
});

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${safeMessage(err)}\n`);
  process.exitCode = 1;
});
