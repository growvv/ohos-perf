/**
 * The MCP tool catalog, derived from the commander program.
 *
 * Deriving it rather than writing it is the point: the CLI has ~40 leaf
 * commands, and a hand-maintained tool list drifts the first time a flag is
 * added. Here a command that exists is a tool, with the flags it declares, so
 * the tool surface cannot disagree with what `--help` prints.
 */

import type { Argument, Command, Option } from 'commander';

/**
 * One property a tool accepts.
 *
 * A scalar is a string or a boolean; a variadic positional is an array of
 * strings, because `[addresses...]` takes more than one and a client's own
 * schema validator would refuse an array against a `string`.
 */
export type McpSchemaProperty =
  | { readonly type: 'string' | 'boolean' | 'number'; readonly description?: string }
  | {
      readonly type: 'array';
      readonly items: { readonly type: 'string' };
      readonly description?: string;
    };

/** The `inputSchema` of a tool: a closed object of named properties. */
export interface McpInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, McpSchemaProperty>;
  readonly required: string[];
  readonly additionalProperties: false;
}

/**
 * What a client may assume about a call, per MCP's `ToolAnnotations`.
 *
 * These are hints, not enforcement — but a client that knows `analyze` cannot
 * change the device can skip a confirmation prompt, which is the difference
 * between an agent that measures and one that asks permission 40 times.
 */
export interface McpAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

/** One callable command, with everything needed to describe and invoke it. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: McpInputSchema;
  readonly annotations: McpAnnotations;
  /**
   * The CLI argv for these arguments.
   *
   * `trailingFlags` are emitted before the `--` separator, because after it
   * they would be positionals: the server's `--machine-json` is what produces
   * the envelope, so it has to stay a flag.
   */
  readonly argv: (args: Record<string, unknown>, trailingFlags?: readonly string[]) => string[];
}

/**
 * Commands that change nothing outside this process.
 *
 * A hint a client may act on by skipping its confirmation prompt, so it has to
 * mean what it says: `report`, `render`, `trend`, `gate`, `ui-compare` and
 * `root-cause` all take `--out` and write artifacts, and a read-only hint on
 * those would let a write through without asking. Named explicitly rather than
 * inferred: "does this touch a device" is not visible in a command's options,
 * and guessing from a `--target` flag would miss `collect` (whose `--target`
 * is optional) and mislabel `gesture`.
 */
const READ_ONLY = new Set([
  'analyze', 'caps', 'compare', 'doctor', 'hap', 'opt', 'query', 'tools',
  'emulator-list',
]);

/**
 * Commands that act on a device, or on something outside this process.
 *
 * A group name covers its leaves, so `emulator` alone would mark
 * `emulator list` destructive; the read-only leaves are named here and the
 * group is not.
 */
const ACTS_ON_DEVICE = new Set([
  'agent', 'collect', 'explore', 'gesture', 'run',
  'emulator-start', 'emulator-stop', 'emulator-create',
]);

/**
 * Options a tool call never exposes.
 *
 * `--json` and `--machine-json` are the output format, and a tool call always
 * wants the envelope; `--result-file` writes a file the client did not ask
 * for; `--help` is not an argument.
 */
const HIDDEN_OPTIONS = new Set(['json', 'machineJson', 'resultFile', 'help', 'version']);

/**
 * `['emulator', 'list']` -> `ohos-perf_emulator_list`.
 *
 * A hyphen becomes an underscore because the result is a tool *name* — an
 * identifier a client stores and calls — and `ui-compare` is the one command
 * with one in it.
 */
export function toolName(path: readonly string[]): string {
  return `ohos-perf_${path.map((part) => part.replaceAll('-', '_')).join('_')}`;
}

/** A commander option's long name without the dashes. */
function optionKey(option: Option): string {
  const long = option.long ?? option.flags.split(/[\s,]+/).find((part) => part.startsWith('--')) ?? option.flags;
  return long.replace(/^--/, '').replace(/^no-/, '');
}

/** Whether an option takes a value. A flag (`--json`) does not. */
function takesValue(option: Option): boolean {
  return /[<[]/.test(option.flags);
}

/**
 * Whether an option accumulates instead of replacing its value.
 *
 * Commander 12 keeps a collector on the option's own `parseArg` but offers no
 * "is this repeatable" flag, so this asks the parser itself: given an empty
 * history, does it return a list? That is a question about behaviour rather
 * than about a name, so `--label` is found without a hand-kept list — the
 * thing this module exists to avoid. A parser that throws, or that returns a
 * scalar, is not a collector.
 */
function isRepeatable(option: Option): boolean {
  if (typeof option.parseArg !== 'function') return false;
  try {
    return Array.isArray((option.parseArg as (value: string, previous: string[]) => unknown)('', []));
  } catch {
    return false;
  }
}

/** Whether an argument is a positional, as opposed to a flag. */
function argumentKey(argument: Argument): string {
  return argument.name();
}

/** The `inputSchema` for one command: its positionals and its options. */
function schemaOf(command: Command): McpInputSchema {
  const properties: Record<string, McpSchemaProperty> = {};
  const required: string[] = [];
  for (const argument of command.registeredArguments) {
    properties[argumentKey(argument)] = argument.variadic
      ? {
          type: 'array',
          items: { type: 'string' },
          ...(argument.description === '' ? {} : { description: argument.description }),
        }
      : {
          type: 'string',
          ...(argument.description === '' ? {} : { description: argument.description }),
        };
    if (argument.required) required.push(argumentKey(argument));
  }
  for (const option of command.options) {
    if (HIDDEN_OPTIONS.has(optionKey(option))) continue;
    const description = option.description === '' ? {} : { description: option.description };
    if (option.mandatory) required.push(optionKey(option));
    properties[optionKey(option)] = !takesValue(option)
      ? { type: 'boolean', ...description }
      : isRepeatable(option)
        ? { type: 'array', items: { type: 'string' }, ...description }
        : { type: 'string', ...description };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The CLI argv for a call.
 *
 * Flags come before positionals so a positional that begins with a dash (a
 * negative coordinate) is not read as a flag; `--` is not needed here because
 * the value is passed as a single argv element.
 */
function argvOf(
  command: Command,
  path: readonly string[],
): (args: Record<string, unknown>, trailingFlags?: readonly string[]) => string[] {
  return (args, trailingFlags = []) => {
    const argv = [...path];
    for (const option of command.options) {
      const key = optionKey(option);
      if (HIDDEN_OPTIONS.has(key)) continue;
      const value = args[key];
      if (value === undefined) continue;
      if (takesValue(option)) {
        // A list means the flag was given more than once (`--label a
        // --label b`); `String(['a','b'])` would be the single value "a,b".
        for (const item of Array.isArray(value) ? value : [value]) {
          argv.push(`--${key}`, String(item));
        }
      } else if (value === true) {
        argv.push(`--${key}`);
      }
    }
    const positionals: string[] = [];
    for (const argument of command.registeredArguments) {
      const value = args[argumentKey(argument)];
      if (value === undefined) continue;
      if (argument.variadic && Array.isArray(value)) {
        for (const item of value) positionals.push(String(item));
      } else {
        positionals.push(String(value));
      }
    }
    // `--` before the positionals, because a positional is parsed by commander
    // like any other element: `{"scene-dir": "--result-file=/tmp/x.json"}` was
    // consumed as the global `--result-file` and wrote a file the client chose.
    // After `--` every element is a value. A command with no positionals gets
    // no separator — there is nothing for it to protect.
    argv.push(...trailingFlags);
    if (positionals.length > 0) argv.push('--', ...positionals);
    return argv;
  };
}

/** The description a client reads: what the command does, and what it takes. */
function describe(command: Command): string {
  const parts = [command.description()];
  for (const argument of command.registeredArguments) {
    if (argument.description === '') continue;
    parts.push(`${argument.name()}: ${argument.description}`);
  }
  return parts.filter((part) => part !== '').join(' ');
}

/**
 * The annotations for one command, from the two sets above.
 *
 * Both the group (`emulator`) and the flattened leaf (`emulator-stop`) are
 * asked, so a set can name a whole group or one leaf of it.
 */
function annotationsOf(path: readonly string[]): McpAnnotations {
  const keys = [path[0] ?? '', path.join('-')];
  const acts = keys.some((key) => ACTS_ON_DEVICE.has(key));
  return {
    readOnlyHint: keys.some((key) => READ_ONLY.has(key)),
    destructiveHint: acts,
    openWorldHint: acts,
  };
}

/**
 * Every leaf command in the program, as a tool.
 *
 * A group (`emulator`, `gesture`, `symbols`) is not callable and gets no tool;
 * only its leaves do. `help` is commander's own and is skipped, and so is
 * `mcp` — it is the transport the client is already talking over, and a tool
 * that spawns a second server reading a stdin nobody writes would hang. The
 * result is sorted by name, so a client that caches the list sees the same
 * bytes.
 */
export function buildCatalog(program: Command): McpTool[] {
  const tools: McpTool[] = [];
  const walk = (command: Command, path: readonly string[]): void => {
    for (const child of command.commands) {
      if (child.name() === 'help' || child.name() === 'mcp') continue;
      const next = [...path, child.name()];
      if (child.commands.length > 0) {
        walk(child, next);
        continue;
      }
      tools.push({
        name: toolName(next),
        title: next.join(' '),
        description: describe(child),
        inputSchema: schemaOf(child),
        annotations: annotationsOf(next),
        argv: argvOf(child, next),
      });
    }
  };
  walk(program, []);
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
