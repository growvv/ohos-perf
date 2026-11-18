/**
 * The MCP server: dispatch one line, answer with one line.
 *
 * A tool call is a CLI run with `--machine-json`, so the answer an agent gets
 * over MCP is byte-identical to the one it gets from a shell — P33's envelope,
 * validated in core. Nothing here re-implements a command or reshapes its
 * payload: this module is a transport, and the measurement is the CLI's.
 */

import {
  MCP_INVALID_PARAMS,
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
import type { McpTool } from './mcp-catalog';

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
    const unknown = Object.keys(supplied).filter((key) => !(key in tool.inputSchema.properties));
    if (unknown.length > 0) {
      return fail(
        id,
        MCP_INVALID_PARAMS,
        `unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}`,
        { tool: tool.name, known: Object.keys(tool.inputSchema.properties) },
      );
    }

    const argv = [...tool.argv(supplied), '--machine-json'];
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
    if (version !== undefined && !MCP_SUPPORTED_VERSIONS.includes(version)) {
      return fail(id, MCP_UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supported: [...MCP_SUPPORTED_VERSIONS],
        requested: version,
      });
    }

    switch (method) {
      case 'initialize':
        // Legacy handshake. The negotiated version is the client's when this
        // server speaks it, which the check above has already established.
        return ok(id, {
          protocolVersion: version ?? MCP_LEGACY_VERSION,
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
      case 'tools/list':
        return ok(id, { resultType: 'complete', tools: toolList() });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, MCP_METHOD_NOT_FOUND, `unknown method ${JSON.stringify(method)}`, {
          supported: ['initialize', 'server/discover', 'tools/list', 'tools/call'],
        });
    }
  };

  return {
    async handle(line: string): Promise<string | undefined> {
      const message = parseMessage(line);
      if (message.kind === 'invalid') {
        // No id is recoverable from a document that did not parse, and
        // JSON-RPC allows a null id for exactly this case.
        return fail(null, MCP_PARSE_ERROR, message.reason);
      }
      // A notification is answered with silence, by the spec.
      if (message.kind === 'notification') return undefined;
      return dispatch(message.id, message.method, message.params);
    },
  };
}
