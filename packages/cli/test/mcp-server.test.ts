import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildCatalog } from '../src/mcp-catalog';
import { createMcpServer } from '../src/mcp-server';

function catalog() {
  const p = new Command('ohos-perf').name('ohos-perf');
  p.command('analyze').description('analyze a scene').argument('<scene-dir>')
    .option('--json').action(() => {});
  p.command('gate').description('judge a budget').argument('<budget>').argument('<input>')
    .option('--json').action(() => {});
  return buildCatalog(p);
}

const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: '1.0', toolId: 'ohos-perf', toolVersion: '0.29.0',
  command: 'analyze', success: true, exitCode: 0, outputs: { payload: { metrics: [] } }, ...over,
});

function server(run: Parameters<typeof createMcpServer>[0]['run']) {
  return createMcpServer({ tools: catalog(), run, version: '0.29.0' });
}

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

describe('createMcpServer — tools/list', () => {
  it('lists the catalog as MCP tools, sorted', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 }))
      .handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } }));
    const { result } = JSON.parse(out!);
    expect(result.resultType).toBe('complete');
    expect(result.tools.map((t: { name: string }) => t.name))
      .toEqual(['ohos-perf_analyze', 'ohos-perf_gate']);
    expect(result.tools[0]).toMatchObject({
      name: 'ohos-perf_analyze',
      title: 'analyze',
      description: 'analyze a scene',
      inputSchema: { type: 'object' },
    });
  });
});

describe('createMcpServer — tools/call', () => {
  it('runs the CLI and returns the envelope as structuredContent', async () => {
    const seen: string[][] = [];
    const out = await server(async (argv) => {
      seen.push([...argv]);
      return { stdout: envelope(), stderr: '', code: 0 };
    }).handle(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/scene' } },
    }));
    const { result } = JSON.parse(out!);
    // `--machine-json` is what makes the answer one envelope.
    expect(seen[0]).toEqual(['analyze', '/scene', '--machine-json']);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.command).toBe('analyze');
    expect(result.structuredContent.outputs.payload).toEqual({ metrics: [] });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text).command).toBe('analyze');
  });

  it('reports a failed run as isError, keeping the code readable', async () => {
    const failed = envelope({
      success: false, exitCode: 1,
      outputs: {}, error: { code: 'SCENE_NO_INPUT', message: 'nothing to ingest' },
    });
    const out = await server(async () => ({ stdout: failed, stderr: '', code: 1 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/x' } },
    }));
    const { result } = JSON.parse(out!);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('SCENE_NO_INPUT');
    expect(result.content[0].text).toContain('SCENE_NO_INPUT');
  });

  it('does not call a failed gate a tool error', async () => {
    // Exit 2 with no `error` is a successful measurement reporting bad news.
    const verdict = envelope({ success: false, exitCode: 2, outputs: { payload: { status: 'fail' } } });
    const out = await server(async () => ({ stdout: verdict, stderr: '', code: 2 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_gate', arguments: { budget: 'b.json', input: '/scene' } },
    }));
    const { result } = JSON.parse(out!);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.success).toBe(false);
  });

  it('passes the warnings through as a second text block', async () => {
    const out = await server(async () => ({
      stdout: envelope(), stderr: 'warning: risk — a model chooses every gesture\n', code: 0,
    })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/s' } },
    }));
    const { result } = JSON.parse(out!);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain('risk');
  });

  it('refuses an unknown tool by name', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_nope', arguments: {} },
    }));
    expect(JSON.parse(out!).error).toMatchObject({ code: -32602 });
    expect(JSON.parse(out!).error.message).toContain('ohos-perf_nope');
  });

  it('refuses arguments that are not an object', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: 'nope' },
    }));
    expect(JSON.parse(out!).error.code).toBe(-32602);
  });

  it('refuses a call whose stdout is not an envelope', async () => {
    const out = await server(async () => ({ stdout: 'not json\n', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/s' } },
    }));
    const { result } = JSON.parse(out!);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('envelope');
  });
});

describe('createMcpServer — the two eras', () => {
  it('answers server/discover with the supported versions', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 }))
      .handle(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover', params: { _meta: MODERN_META } }));
    const { result } = JSON.parse(out!);
    expect(result.supportedVersions).toEqual(['2026-07-28', '2025-11-25']);
    expect(result.resultType).toBe('complete');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('answers the legacy initialize handshake', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 10, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    }));
    const { result } = JSON.parse(out!);
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo).toMatchObject({ name: 'ohos-perf', version: '0.29.0' });
    expect(result.capabilities.tools).toBeDefined();
  });

  it('refuses an unknown protocol version with the supported list', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 11, method: 'tools/list',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '1900-01-01',
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }));
    expect(JSON.parse(out!).error).toMatchObject({
      code: -32022, data: { supported: ['2026-07-28', '2025-11-25'], requested: '1900-01-01' },
    });
  });

  it('answers a notification with nothing', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 }))
      .handle('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(out).toBeUndefined();
  });

  it('answers an invalid line with a parse error and keeps serving', async () => {
    const s = server(async () => ({ stdout: '', stderr: '', code: 0 }));
    expect(JSON.parse((await s.handle('{oops'))!).error.code).toBe(-32700);
    const after = await s.handle(JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/list', params: { _meta: MODERN_META },
    }));
    expect(JSON.parse(after!).result.tools).toHaveLength(2);
  });

  it('answers a call the runner could not start, instead of dropping the id', async () => {
    // The CLI is spawned per call, so a spawn failure is a real path: a bad
    // entry script, a fork limit, an antivirus lock. If `handle` threw, the
    // stdio loop would print to stderr and answer nothing — and the client
    // would wait on that id until it gave up.
    const s = server(async () => { throw new Error('spawn EAGAIN'); });
    const out = await s.handle(JSON.stringify({
      jsonrpc: '2.0', id: 14, method: 'tools/call',
      params: { _meta: MODERN_META, name: 'ohos-perf_analyze', arguments: { 'scene-dir': '/s' } },
    }));
    const answer = JSON.parse(out!);
    expect(answer.id).toBe(14);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain('spawn EAGAIN');
  });

  it('refuses an unknown method', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 13, method: 'resources/list', params: { _meta: MODERN_META },
    }));
    expect(JSON.parse(out!).error.code).toBe(-32601);
  });
});
