/**
 * The MCP server: dispatch one line, answer with one line.
 *
 * A tool call is a CLI run with `--machine-json`, so the answer an agent gets
 * over MCP is byte-identical to the one it gets from a shell — P33's envelope,
 * validated in core. Nothing here re-implements a command or reshapes its
 * payload: this module is a transport, and the measurement is the CLI's.
 */

import {
  MCP_INTERNAL_ERROR,
  MCP_INVALID_PARAMS,
  MCP_INVALID_REQUEST,
  MCP_LEGACY_VERSION,
  MCP_METHOD_NOT_FOUND,
  MCP_PARSE_ERROR,
  MCP_SUPPORTED_VERSIONS,
  MCP_UNSUPPORTED_VERSION,
  fail,
  ok,
  parseMessage,
  type RequestId,
} from './mcp-protocol';
import type { McpSchemaProperty, McpTool } from './mcp-catalog';

/** One CLI invocation, as the server needs it: the three streams and a code. */
export interface McpRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** How the server executes a tool call. Injected, so tests need no subprocess. */
export type McpRunner = (argv: readonly string[]) => Promise<McpRunResult>;

export interface McpServerOptions {
  readonly tools: readonly McpTool[];
  readonly run: McpRunner;
  readonly version: string;
  readonly serverName?: string;
}

/** The server: one line in, at most one line out. */
export interface McpServer {
  /** `undefined` means "send nothing": a notification, or a comment line. */
  handle(line: string): Promise<string | undefined>;
}

/** One MCP content block. Text is all a CLI answer needs. */
interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** The `_meta` key that carries the protocol version on a modern request. */
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';

/**
 * The protocol version a request names.
 *
 * A modern request names it in `_meta`; a legacy one names it on `initialize`.
 * A legacy request that names nothing is taken as legacy, because that is what
 * a client which never heard of per-request metadata is.
 */
function requestedVersion(params: Record<string, unknown>): string | undefined {
  const meta = params['_meta'];
  if (typeof meta === 'object' && meta !== null) {
    const value = (meta as Record<string, unknown>)[VERSION_KEY];
    if (typeof value === 'string') return value;
  }
  const legacy = params['protocolVersion'];
  return typeof legacy === 'string' ? legacy : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of a run's failure, for the message a client reads. */
function firstStderrLine(stderr: string): string {
  const [first] = stderr.split('\n');
  return (first ?? '').trim();
}

/** Whether a supplied value has the type its schema declares. */
function matchesType(value: unknown, property: McpSchemaProperty): boolean {
  switch (property.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

/** The type, as a client should read it: `an array of strings`. */
function describeType(property: McpSchemaProperty): string {
  return property.type === 'array' ? 'an array of strings' : `a ${property.type}`;
}

/** The value's actual type, for the refusal message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** A thrown value as one line, for a message a client reads. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** `serverInfo` — the same shape in both eras. */
function serverInfo(name: string, version: string): Record<string, unknown> {
  return { name, version };
}

/** The capability set: tools only, and they never change mid-session. */
const CAPABILITIES = { tools: {} } as const;

/**
 * Build the server.
 *
 * Every result on the modern era carries `resultType: 'complete'`; a legacy
 * client ignores the field, so one shape serves both. A call that fails at the
 * CLI's seam is `isError: true` with the envelope still in `structuredContent`
 * — the agent needs the code, not just the word "error".
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const name = options.serverName ?? 'ohos-perf';
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  const toolList = (): unknown[] => options.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));

  const callTool = async (
    id: RequestId,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const toolName = params['name'];
    if (typeof toolName !== 'string') {
      return fail(id, MCP_INVALID_PARAMS, 'tools/call needs a "name"');
    }
    const tool = tools.get(toolName);
    if (tool === undefined) {
      return fail(id, MCP_INVALID_PARAMS, `unknown tool ${JSON.stringify(toolName)}`, {
        tools: [...tools.keys()],
      });
    }
    const args = params['arguments'];
    if (args !== undefined && !isRecord(args)) {
      return fail(id, MCP_INVALID_PARAMS, 'tools/call "arguments" must be an object');
    }
    const supplied = isRecord(args) ? args : {};
    // The schema promises `additionalProperties: false`, so an undeclared key
    // is a client mistake, not a hint to ignore. `{"basline": "/b"}` (one
    // letter) would otherwise run without a baseline and report success.
    // `Object.hasOwn`, not `in`: `'toString' in properties` is true through
    // the prototype chain, so a membership test with `in` would accept a name
    // no schema ever declared and report a validation it did not perform.
    const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key));
    if (unknown.length > 0) {
      return fail(
        id,
        MCP_INVALID_PARAMS,
        `unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}`,
        { tool: tool.name, known: Object.keys(tool.inputSchema.properties) },
      );
    }
    // A value of the wrong type is not coerced: `{"procfs": "true"}` would
    // otherwise omit the flag and report a capture without the collector the
    // caller asked for as a success. A wrong measurement is worse than a
    // refused call.
    for (const [key, value] of Object.entries(supplied)) {
      const property = tool.inputSchema.properties[key];
      if (property === undefined || matchesType(value, property)) continue;
      return fail(
        id,
        MCP_INVALID_PARAMS,
        `${JSON.stringify(key)} must be ${describeType(property)}, not ${describeValue(value)}`,
        { tool: tool.name, property: key, expected: property.type },
      );
    }

    const argv = tool.argv(supplied, ['--machine-json']);
    let run: McpRunResult;
    try {
      run = await options.run(argv);
    } catch (err) {
      // The process could not even start. The id still has to be answered:
      // a dropped id leaves the client waiting on a reply that never comes.
      return ok(id, {
        resultType: 'complete',
        isError: true,
        content: [{ type: 'text', text: `the command could not be started: ${errorText(err)}` }],
      });
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(run.stdout);
      if (!isRecord(parsed) || typeof parsed['schemaVersion'] !== 'string') throw new Error('shape');
      envelope = parsed;
    } catch {
      // The CLI did not answer with an envelope: either it crashed before the
      // contract layer, or something wrote to stdout that was not a result.
      // That is a tool error, and the stderr line is the only diagnosis.
      const detail = firstStderrLine(run.stderr);
      return ok(id, {
        resultType: 'complete',
        isError: true,
        content: [{
          type: 'text',
          text: `the command produced no tool-result envelope (exit ${run.code})` +
            (detail === '' ? '' : `: ${detail}`),
        }],
      });
    }

    // A result, not a transport failure: the envelope says which.
    const isError = envelope['error'] !== undefined;
    const content: TextBlock[] = [{ type: 'text', text: JSON.stringify(envelope) }];
    const warning = run.stderr.trim();
    // Warnings are diagnostics, not results — they ride beside the answer
    // rather than inside it, exactly as they do on a terminal.
    if (warning !== '') content.push({ type: 'text', text: warning });

    return ok(id, {
      resultType: 'complete',
      isError,
      content,
      structuredContent: envelope,
    });
  };

  const dispatch = async (
    id: RequestId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const version = requestedVersion(params);
    // `initialize` negotiates, it does not refuse: a client on 2025-06-18 can
    // do everything this server offers, and the handshake is the only thing
    // that changed. The answer names a version the server speaks, which is
    // what the spec asks for. A per-request version is a claim about the
    // request's own shape, so an unknown one there is an error.
    const unknownVersion = version !== undefined && !MCP_SUPPORTED_VERSIONS.includes(version);
    if (unknownVersion && method !== 'initialize') {
      return fail(id, MCP_UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supported: [...MCP_SUPPORTED_VERSIONS],
        requested: version,
      });
    }

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: MCP_SUPPORTED_VERSIONS.includes(version ?? '') ? version : MCP_LEGACY_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: serverInfo(name, options.version),
        });
      case 'server/discover':
        return ok(id, {
          resultType: 'complete',
          supportedVersions: [...MCP_SUPPORTED_VERSIONS],
          capabilities: CAPABILITIES,
          serverInfo: serverInfo(name, options.version),
        });
      case 'ping':
        // Both revisions require a prompt answer; a probe that gets -32601
        // can make a client drop the connection.
        return ok(id, { resultType: 'complete' });
      case 'tools/list':
        return ok(id, { resultType: 'complete', tools: toolList() });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, MCP_METHOD_NOT_FOUND, `unknown method ${JSON.stringify(method)}`, {
          supported: ['initialize', 'server/discover', 'ping', 'tools/list', 'tools/call'],
        });
    }
  };

  return {
    async handle(line: string): Promise<string | undefined> {
      const message = parseMessage(line);
      if (message.kind === 'invalid') {
        // A document that did not parse has no id, and JSON-RPC allows a null
        // one for exactly that case. One that parsed but is not a request
        // still carries its id, and gets `-32600` under it.
        return message.id === undefined
          ? fail(null, MCP_PARSE_ERROR, message.reason)
          : fail(message.id, MCP_INVALID_REQUEST, message.reason);
      }
      // A notification is answered with silence, by the spec.
      if (message.kind === 'notification') return undefined;
      try {
        return await dispatch(message.id, message.method, message.params);
      } catch (err) {
        // Every path that can throw is inside a request that has an id, and a
        // request with an id must be answered. The loop would otherwise print
        // to stderr and move on, leaving the client on that id forever.
        return fail(message.id, MCP_INTERNAL_ERROR, `the server could not answer: ${errorText(err)}`);
      }
    },
  };
}
