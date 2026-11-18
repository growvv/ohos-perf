/**
 * JSON-RPC framing for the MCP server, and the two protocol eras.
 *
 * MCP speaks JSON-RPC 2.0 over newline-delimited stdout: one message per line,
 * no embedded newlines. That is the whole transport for stdio, so this module
 * is small on purpose — the alternative is a 7 MB dependency for a frame.
 *
 * Two revisions matter. `2026-07-28` removed the `initialize` handshake: every
 * request carries its protocol version and the client's capabilities in
 * `_meta`, and a server must implement `server/discover`. `2025-11-25` and
 * earlier establish a session with `initialize` first. A server that answers
 * both is what the specification calls *dual-era*, and it is what this one is:
 * a client that predates the change should not have to be upgraded to be
 * measured.
 */

/** The revision with per-request metadata and no handshake. */
export const MCP_MODERN_VERSION = '2026-07-28';

/** The last revision with the `initialize` handshake. */
export const MCP_LEGACY_VERSION = '2025-11-25';

/**
 * Both revisions this server answers, modern first.
 *
 * The order is the answer to "which should a client pick": a client that reads
 * this list without a preference takes the first entry, and the modern era
 * carries more information per request.
 */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_MODERN_VERSION, MCP_LEGACY_VERSION];

/** JSON-RPC 2.0 error codes, by the names the specification gives them. */
export const MCP_PARSE_ERROR = -32700;
export const MCP_INVALID_REQUEST = -32600;
export const MCP_METHOD_NOT_FOUND = -32601;
export const MCP_INVALID_PARAMS = -32602;
/** JSON-RPC 2.0: the server failed while handling a request it did accept. */
export const MCP_INTERNAL_ERROR = -32603;
/** MCP-specific: the request named a protocol version this server does not speak. */
export const MCP_UNSUPPORTED_VERSION = -32022;

/**
 * A JSON-RPC id: the spec allows a string, a number, or `null`.
 *
 * `null` is the one an error response uses when the request it answers had no
 * readable id — a document that did not parse — so the type has to admit it.
 */
export type RequestId = string | number | null;

/**
 * One parsed line: a request to answer, a notification to absorb, or garbage.
 *
 * `id` on an invalid document is the id it carried, when that is readable —
 * JSON-RPC distinguishes "could not parse" (`-32700`, no id) from "parsed but
 * not a request" (`-32600`, id echoed), and a client waiting on that id gets
 * an answer instead of silence.
 */
export type ParsedMessage =
  | { readonly kind: 'request'; readonly id: RequestId; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: 'notification'; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: 'invalid'; readonly reason: string; readonly id?: RequestId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is RequestId {
  return value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Parse one line into a message, never throwing.
 *
 * A malformed line is a message the caller must answer with an error and keep
 * serving: an agent's session dies with the process, and one bad byte should
 * not end it. That is why this returns a verdict instead of raising.
 */
export function parseMessage(line: string): ParsedMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(value)) {
    return { kind: 'invalid', reason: 'not a JSON-RPC 2.0 message' };
  }
  // Parsed, but not a request: the id is still readable, so it is answered.
  const readableId = isId(value['id']) ? value['id'] : undefined;
  const invalid = { kind: 'invalid' as const, reason: 'not a JSON-RPC 2.0 message', ...(readableId === undefined ? {} : { id: readableId }) };
  if (value['jsonrpc'] !== '2.0') return invalid;
  const method = value['method'];
  if (typeof method !== 'string' || method === '') return invalid;
  const rawParams = value['params'];
  const params = isRecord(rawParams) ? rawParams : {};
  const id = value['id'];
  // A message with no id is a notification, and the spec forbids answering it.
  if (id === undefined) return { kind: 'notification', method, params };
  if (!isId(id)) return { kind: 'invalid', reason: 'not a JSON-RPC 2.0 message' };
  return { kind: 'request', id, method, params };
}

/**
 * A successful response, framed.
 *
 * The trailing newline is the transport's delimiter, so it belongs here rather
 * than at each call site: a response written without it would be glued to the
 * next one and neither would parse.
 */
export function ok(id: RequestId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

/** A failed response, framed. `data` carries what a client retries on. */
export function fail(id: RequestId, code: number, message: string, data?: unknown): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  })}\n`;
}
