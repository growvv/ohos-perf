import { describe, it, expect } from 'vitest';
import {
  MCP_MODERN_VERSION, MCP_LEGACY_VERSION, MCP_SUPPORTED_VERSIONS,
  parseMessage, ok, fail,
} from '../src/mcp-protocol';

describe('parseMessage', () => {
  it('reads one newline-delimited request', () => {
    const m = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(m).toEqual({ kind: 'request', id: 1, method: 'tools/list', params: {} });
  });

  it('keeps a string id, because JSON-RPC allows one', () => {
    const m = parseMessage('{"jsonrpc":"2.0","id":"a-1","method":"tools/list"}');
    expect(m.kind === 'request' && m.id).toBe('a-1');
  });

  it('reads a notification, which has no id', () => {
    const m = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(m).toEqual({ kind: 'notification', method: 'notifications/initialized', params: {} });
  });

  it('reports a parse failure instead of throwing', () => {
    expect(parseMessage('{not json')).toEqual({ kind: 'invalid', reason: 'not JSON' });
  });

  it('keeps a recoverable id when the document is JSON but not a request', () => {
    // `-32700` means "I could not parse this"; `-32600` means "I parsed it and
    // it is not a request". A document with an id still has an id to answer,
    // so dropping it makes the client wait on a reply it could have had.
    expect(parseMessage('{"jsonrpc":"2.0","id":5}')).toEqual({
      kind: 'invalid', reason: 'not a JSON-RPC 2.0 message', id: 5,
    });
    expect(parseMessage('{"jsonrpc":"2.0","id":5}')).toMatchObject({ id: 5 });
  });

  it('rejects a document that is not a JSON-RPC message', () => {
    // The id is carried when it is readable: a client that sent one gets an
    // answer under it (-32600) rather than silence.
    expect(parseMessage('{"id":1}')).toEqual({ kind: 'invalid', reason: 'not a JSON-RPC 2.0 message', id: 1 });
    expect(parseMessage('[]')).toEqual({ kind: 'invalid', reason: 'not a JSON-RPC 2.0 message' });
  });
});

describe('the two protocol eras', () => {
  it('names the modern revision first, so a client picks it', () => {
    expect(MCP_SUPPORTED_VERSIONS).toEqual([MCP_MODERN_VERSION, MCP_LEGACY_VERSION]);
  });
});

describe('responses', () => {
  it('echoes the id and carries the result', () => {
    expect(JSON.parse(ok(7, { a: 1 }))).toEqual({ jsonrpc: '2.0', id: 7, result: { a: 1 } });
  });

  it('carries a code and the data a client retries on', () => {
    expect(JSON.parse(fail(7, -32022, 'Unsupported protocol version', { supported: ['x'] }))).toEqual({
      jsonrpc: '2.0', id: 7,
      error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['x'] } },
    });
  });
});
