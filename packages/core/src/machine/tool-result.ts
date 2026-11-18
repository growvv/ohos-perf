import { OhosPerfError } from '../errors';

/**
 * The machine-readable result contract (P33): one envelope per invocation.
 *
 * HapRay ships the same idea as `hapray/core/common/machine_output.py`, with a
 * `plugin.json` `tool_contract` advertising it. Three things are deliberately
 * different here, each for a defect that file has:
 *
 * 1. **It is read back, strictly.** HapRay only writes; a consumer has no way
 *    to notice the contract changed under it. {@link parseToolResult} refuses
 *    an unknown `schemaVersion`, another tool's envelope, and a `success` flag
 *    that contradicts its own `exitCode`.
 * 2. **It is camelCase and versioned**, matching this package's own artifacts
 *    (`schemaVersion`, `startedAtNs`) rather than HapRay's snake_case. Two
 *    spellings of the same field across one package is how a reader ends up
 *    branching on the producer.
 * 3. **`success` is exactly `exitCode === 0`.** No caller-supplied override:
 *    the field exists so a reader need not infer success from a number, and a
 *    second source of truth would defeat that.
 *
 * `outputs` holds the command's own document under `payload` and invents
 * nothing else. A command's artifacts are already inside that document
 * (`files`, `outDir`); a second list here would drift from the first.
 */

/** The contract's version. A shape change bumps it; a new `payload` key does not. */
export const TOOL_RESULT_SCHEMA_VERSION = '1.0';

/** The tool id every envelope from this package carries. */
export const TOOL_ID = 'ohos-perf';

/**
 * The file name a caller may write the envelope to.
 *
 * Not written by default: HapRay drops this file into the report directory
 * whether or not anyone asked, and a measurement tool must not add a file to a
 * scene a reader will diff.
 */
export const TOOL_RESULT_FILE = 'ohos-perf-tool-result.json';

/** Why a command could not produce an answer. */
export interface ToolResultError {
  /**
   * The typed code, when the failure had one — the same token the CLI prints
   * before its message, or `CLI_USAGE` for a commander error. Absent for an
   * untyped throw, because inventing a code is worse than saying there is none.
   */
  readonly code?: string;
  readonly message: string;
}

/** One invocation's result, as a machine reads it. */
export interface ToolResult {
  readonly schemaVersion: typeof TOOL_RESULT_SCHEMA_VERSION;
  readonly toolId: typeof TOOL_ID;
  readonly toolVersion: string;
  /** The command path with dots: `analyze`, `emulator.list`, `gesture.click`. */
  readonly command: string;
  /** Exactly `exitCode === 0`. */
  readonly success: boolean;
  readonly exitCode: number;
  readonly outputs: { readonly payload?: unknown };
  /** Present only when the command could not run. */
  readonly error?: ToolResultError;
}

export interface ToolResultInput {
  readonly toolVersion: string;
  readonly command: string;
  readonly exitCode: number;
  readonly payload?: unknown;
  readonly error?: ToolResultError;
}

function badDocument(message: string): OhosPerfError {
  return new OhosPerfError(`tool result: ${message}`, { code: 'TOOL_RESULT_BAD_DOCUMENT' });
}

/**
 * Build the envelope for one invocation.
 *
 * `success` is derived, never accepted: a caller that could set it would be
 * able to describe a failed run as a successful one.
 */
export function buildToolResult(input: ToolResultInput): ToolResult {
  if (input.command === '') {
    throw badDocument('a command path is required, and was empty');
  }
  if (!Number.isInteger(input.exitCode)) {
    throw badDocument(`exitCode must be a whole number, got ${String(input.exitCode)}`);
  }
  const error: ToolResultError | undefined =
    input.error === undefined
      ? undefined
      : {
          ...(input.error.code === undefined ? {} : { code: input.error.code }),
          message: input.error.message,
        };
  return {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    toolId: TOOL_ID,
    toolVersion: input.toolVersion,
    command: input.command,
    success: input.exitCode === 0,
    exitCode: input.exitCode,
    outputs: input.payload === undefined ? {} : { payload: input.payload },
    ...(error === undefined ? {} : { error }),
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badDocument(`${what} must be an object, got ${Array.isArray(value) ? 'an array' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw badDocument(`"${key}" must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate a parsed document as a {@link ToolResult}.
 *
 * Strict on purpose: this is the only place a consumer can find out that the
 * contract it was written against is not the one it is reading. Every refusal
 * names the value that failed, so a mismatched field is a one-line diagnosis.
 *
 * Returns a fresh object — a parsed document must not alias the input a caller
 * may keep mutating.
 */
export function parseToolResult(value: unknown): ToolResult {
  const record = asRecord(value, 'the tool result');

  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== TOOL_RESULT_SCHEMA_VERSION) {
    throw badDocument(
      `schemaVersion must be "${TOOL_RESULT_SCHEMA_VERSION}", got ${JSON.stringify(schemaVersion)}`,
    );
  }
  const toolId = record['toolId'];
  if (toolId !== TOOL_ID) {
    throw badDocument(`toolId must be "${TOOL_ID}", got ${JSON.stringify(toolId)}`);
  }
  const toolVersion = requireString(record, 'toolVersion');
  const command = requireString(record, 'command');

  const exitCode = record['exitCode'];
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    throw badDocument(`"exitCode" must be a whole number, got ${JSON.stringify(exitCode)}`);
  }
  const success = record['success'];
  if (typeof success !== 'boolean' || success !== (exitCode === 0)) {
    throw badDocument(
      `"success" must be ${String(exitCode === 0)} for exitCode ${exitCode},`
      + ` got ${JSON.stringify(success)}`,
    );
  }

  const outputs = asRecord(record['outputs'], '"outputs"');
  const rawError = record['error'];
  let error: ToolResultError | undefined;
  if (rawError !== undefined) {
    const errorRecord = asRecord(rawError, '"error"');
    const message = errorRecord['message'];
    if (typeof message !== 'string') {
      throw badDocument(`"error.message" must be a string, got ${JSON.stringify(message)}`);
    }
    const code = errorRecord['code'];
    if (code !== undefined && typeof code !== 'string') {
      throw badDocument(`"error.code" must be a string, got ${JSON.stringify(code)}`);
    }
    error = { ...(code === undefined ? {} : { code }), message };
  }

  return {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    toolId: TOOL_ID,
    toolVersion,
    command,
    success,
    exitCode,
    outputs: { ...outputs },
    ...(error === undefined ? {} : { error }),
  };
}

/** The envelope as stdout carries it: exactly one line, no interior whitespace. */
export function renderToolResultLine(result: ToolResult): string {
  return `${JSON.stringify(result)}\n`;
}

/** The envelope as a file carries it: two-space indented, trailing newline. */
export function renderToolResultFile(result: ToolResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
