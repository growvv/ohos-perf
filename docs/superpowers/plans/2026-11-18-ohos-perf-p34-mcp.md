# P34 — MCP server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ohos-perf mcp` runs a stdio MCP server that exposes every CLI command as a tool, so an agent calls measurements as tools instead of shelling out and parsing text.

**Architecture:** three new CLI modules with no new dependency. `mcp-protocol.ts` owns JSON-RPC framing (newline-delimited, one message per line), the two protocol eras, and the error codes. `mcp-catalog.ts` derives the tool list from the commander program itself, so the surface cannot drift from the CLI. `mcp-server.ts` dispatches `tools/list`, `tools/call`, `server/discover` and `initialize`, executes a call by running the same CLI with `--machine-json`, and maps the P33 envelope onto `CallToolResult`. `program.ts` registers `mcp`; `deps.ts` supplies the real runner.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9, commander 12. No new dependencies — the JSON-RPC layer is ~150 lines and the alternative is a 7 MB package.

**Spec:** the MCP specification revision `2026-07-28` (`schema.json` in `modelcontextprotocol/modelcontextprotocol`, `docs/specification/2026-07-28/basic/versioning.mdx`): every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and `_meta["io.modelcontextprotocol/clientCapabilities"]`; `server/discover` is mandatory; every result carries `resultType: "complete"`; there is no `initialize`. Revision `2025-11-25` is the legacy era: `initialize` request → result with `protocolVersion`, `capabilities`, `serverInfo`, then `notifications/initialized`. `Tool` requires `name` and `inputSchema`; `CallToolResult` requires `content`. P33's envelope (`docs/superpowers/plans/2026-11-18-ohos-perf-p33-tool-result.md`) is the payload a tool call returns.

## Global Constraints

- ESM only; **no new runtime dependency**. `@modelcontextprotocol/server` is 7 MB unpacked and would be the package's first non-trivial dependency; the framing it provides is newline-delimited JSON.
- `npm run verify` must pass before every commit; run `npm run build -w packages/cli` before `verify` after any `packages/cli/src` edit.
- **Nothing but MCP messages on stdout.** The spec: "The server **MUST NOT** write anything to its `stdout` that is not a valid MCP message." Diagnostics go to stderr.
- **Dual-era.** Accept `initialize` (legacy) *and* per-request `_meta` (modern), advertising `supportedVersions: ['2026-07-28', '2025-11-25']`. An unknown requested version is JSON-RPC error `-32022` naming the supported list.
- **The tool list is derived, never hand-written.** Every leaf command in `buildProgram`'s tree becomes one tool; a command added later appears without editing this module.
- **A tool call is the envelope.** Each call runs the CLI with `--machine-json` and returns P33's envelope as `structuredContent`; `isError` is `envelope.error !== undefined`, *not* `!envelope.success`, so a failed `gate` budget (exit 2, no `error`) is a successful tool call reporting bad news.
- Tool names are `ohos-perf_<path>` with dots flattened to `_` (`ohos-perf_emulator_list`), because MCP names are programmatic identifiers.
- Deterministic: the tool list is sorted by name, so a client's prompt cache is stable.
- New codes: `MCP_BAD_MESSAGE`, `MCP_UNKNOWN_TOOL`, `MCP_BAD_ARGUMENTS`, `MCP_UNSUPPORTED_VERSION`.
- Parity ledger unchanged — 38 ported / 0 partial / 0 missing / 1 out. HapRay ships no MCP surface at all; README says "beyond the inventory".
- Version `0.29.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **A malformed line on stdin** — not JSON, or JSON that is not an object with `jsonrpc: "2.0"` — must produce one JSON-RPC error (or `-32700` for a parse failure) and leave the server running; a crash would end an agent's session mid-task.
2. **A tool call that fails at its seam** (exit 1) → `isError: true`, `content` still present, `structuredContent` still the envelope; the agent must be able to read the code, not just "error".
3. **`gate` with a failed budget** (exit 2, `success: false`, no `error`) → `isError: false`. A tool that reports bad news is not a broken tool.
4. **An unknown tool name**, and **arguments that are not an object** → a JSON-RPC error naming the value, never a silent empty result.
5. **A request with no `_meta` version on the modern era**, and an `initialize` naming an unknown version → `-32022` with the supported list, so a client can retry rather than guess.

---

## File Structure

- Create: `packages/cli/src/mcp-protocol.ts` — framing, eras, error shapes.
- Create: `packages/cli/src/mcp-catalog.ts` — the tool list derived from a `Command`.
- Create: `packages/cli/src/mcp-server.ts` — dispatch, execution, envelope mapping.
- Modify: `packages/cli/src/program.ts` — the `mcp` command.
- Modify: `packages/cli/src/deps.ts` — the real runner (spawn the built CLI).
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`.
- Tests: `packages/cli/test/mcp-protocol.test.ts`, `mcp-catalog.test.ts`, `mcp-server.test.ts`; additions to `index.test.ts`; `skill.test.ts` `COMMANDS`.

---

### Task 1: JSON-RPC framing and the two eras

**Files:**
- Create: `packages/cli/src/mcp-protocol.ts`
- Test: `packages/cli/test/mcp-protocol.test.ts`

**Interfaces:**
- Produces: `MCP_MODERN_VERSION = '2026-07-28'`, `MCP_LEGACY_VERSION = '2025-11-25'`, `MCP_SUPPORTED_VERSIONS`, `parseMessage(line: string): ParsedMessage`, `ok(id, result)`, `fail(id, code, message, data?)`, `rpcError(code, message, data?)`, `MCP_METHOD_NOT_FOUND = -32601`, `MCP_INVALID_PARAMS = -32602`, `MCP_PARSE_ERROR = -32700`, `MCP_INVALID_REQUEST = -32600`, `MCP_UNSUPPORTED_VERSION = -32022`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/mcp-protocol.test.ts
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

  it('rejects a document that is not a JSON-RPC message', () => {
    expect(parseMessage('{"id":1}')).toEqual({ kind: 'invalid', reason: 'not a JSON-RPC 2.0 message' });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/mcp-protocol.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mcp-protocol"`.

- [ ] **Step 3: Implement `packages/cli/src/mcp-protocol.ts`**

`parseMessage` returns a discriminated union: `{kind:'request', id, method, params}` / `{kind:'notification', method, params}` / `{kind:'invalid', reason}`. An id may be a string or a number; `params` defaults to `{}`. A message is a JSON-RPC 2.0 message when it is a non-array object whose `jsonrpc` is the string `"2.0"` and whose `method` is a non-empty string. `ok`/`fail` return `JSON.stringify(...) + '\n'` (the framing is the trailing newline, so no caller adds one).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit packages/cli/test/mcp-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp-protocol.ts packages/cli/test/mcp-protocol.test.ts
git commit -m "feat(mcp): newline-delimited JSON-RPC framing for both protocol eras"
```

---

### Task 2: The tool catalog, derived from the program

**Files:**
- Create: `packages/cli/src/mcp-catalog.ts`
- Test: `packages/cli/test/mcp-catalog.test.ts`

**Interfaces:**
- Consumes: `Command` from commander.
- Produces: `interface McpTool { name: string; title: string; description: string; inputSchema: McpInputSchema; annotations: McpAnnotations; argv: (args: Record<string, unknown>) => string[] }`, `interface McpInputSchema { type: 'object'; properties: Record<string, { type: 'string' | 'boolean' | 'number'; description?: string }>; required: string[]; additionalProperties: false }`, `interface McpAnnotations { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }`, `buildCatalog(program: Command): McpTool[]`, `toolName(path: readonly string[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/mcp-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildCatalog, toolName } from '../src/mcp-catalog';

function sample(): Command {
  const p = new Command('ohos-perf').name('ohos-perf');
  p.command('analyze')
    .description('analyze a captured scene directory')
    .argument('<scene-dir>', 'directory containing trace.db')
    .option('--app <packageName>', 'app package name')
    .option('--json', 'print the analysis result as JSON')
    .action(() => {});
  const emulator = p.command('emulator').description('manage emulator instances');
  emulator.command('list').description('list instances').option('--json', 'JSON').action(() => {});
  return p;
}

describe('buildCatalog', () => {
  it('makes one tool per leaf command, never for a group', () => {
    const names = buildCatalog(sample()).map((t) => t.name);
    expect(names).toEqual(['ohos-perf_analyze', 'ohos-perf_emulator_list']);
  });

  it('flattens the path so the name is an identifier', () => {
    expect(toolName(['emulator', 'list'])).toBe('ohos-perf_emulator_list');
  });

  it('turns a required argument into a required string property', () => {
    const tool = buildCatalog(sample())[0]!;
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties['scene-dir']).toMatchObject({ type: 'string' });
    expect(schema.properties['scene-dir']!.description).toContain('trace.db');
    expect(schema.required).toEqual(['scene-dir']);
  });

  it('turns an option into an optional property, and a boolean into a flag', () => {
    const tool = buildCatalog(sample())[0]!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.app).toMatchObject({ type: 'string', description: 'app package name' });
    expect(props.json).toMatchObject({ type: 'boolean' });
    expect((tool.inputSchema as { required: string[] }).required).not.toContain('app');
  });

  it('leaves --json and --machine-json out: a tool call always speaks JSON', () => {
    const tool = buildCatalog(sample())[0]!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.json).toBeUndefined();
    expect(props.machineJson).toBeUndefined();
  });

  it('turns arguments into argv, options first so a negative positional is not a flag', () => {
    const tool = buildCatalog(sample())[0]!;
    expect(tool.argv({ 'scene-dir': '/scene', app: 'com.demo' }))
      .toEqual(['analyze', '--app', 'com.demo', '/scene']);
  });

  it('omits an option that was not supplied, rather than passing undefined', () => {
    const tool = buildCatalog(sample())[0]!;
    expect(tool.argv({ 'scene-dir': '/scene' })).toEqual(['analyze', '/scene']);
  });

  it('marks a scene reader read-only and a device driver not', () => {
    const [analyze] = buildCatalog(sample());
    expect(analyze!.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    });
  });

  it('sorts by name so a client prompt cache is stable', () => {
    const p = new Command('ohos-perf').name('ohos-perf');
    for (const name of ['zeta', 'alpha']) p.command(name).description(name).action(() => {});
    expect(buildCatalog(p).map((t) => t.name)).toEqual(['ohos-perf_alpha', 'ohos-perf_zeta']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/mcp-catalog.test.ts`
Expected: FAIL — cannot resolve `../src/mcp-catalog`.

- [ ] **Step 3: Implement `packages/cli/src/mcp-catalog.ts`**

Walk `program.commands` depth-first, skipping `help` and any group with children. Per leaf: `name = toolName(path)`; `title = path.join(' ')`; `description` = the command's description plus, when present, its `registeredArguments` descriptions. `inputSchema` = `{type:'object', properties, required, additionalProperties:false}`; a registered argument becomes a `string` property (`required` when `argument.required`), an option becomes `string` (or `boolean` when it has no value placeholder and is not negated); `--json`/`--machine-json`/`--result-file`/`--help` are skipped. `argv(args)` emits `--flag value` for valued options, `--flag` for booleans that are `true`, then positionals in declaration order. Annotations: `readOnlyHint` is true for a fixed set of scene-reading commands (`analyze`, `caps`, `compare`, `doctor`, `gate`, `hap`, `opt`, `query`, `render`, `report`, `root-cause`, `tools`, `trend`, `ui-compare`); `openWorldHint`/`destructiveHint` are true for the ones that touch a device (`agent`, `collect`, `explore`, `gesture`, `run`, `emulator`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit packages/cli/test/mcp-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp-catalog.ts packages/cli/test/mcp-catalog.test.ts
git commit -m "feat(mcp): derive the tool catalog from the commander program"
```

---

### Task 3: The server — dispatch, execute, map the envelope

**Files:**
- Create: `packages/cli/src/mcp-server.ts`
- Test: `packages/cli/test/mcp-server.test.ts`

**Interfaces:**
- Consumes: `McpTool`, `buildCatalog`, `parseMessage`, `ok`, `fail`.
- Produces: `type McpRunner = (argv: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }>`, `interface McpServerOptions { tools: readonly McpTool[]; run: McpRunner; version: string; serverName?: string }`, `createMcpServer(options: McpServerOptions): { handle(line: string): Promise<string | undefined> }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/mcp-server.test.ts
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

  it('refuses an unknown method', async () => {
    const out = await server(async () => ({ stdout: '', stderr: '', code: 0 })).handle(JSON.stringify({
      jsonrpc: '2.0', id: 13, method: 'resources/list', params: { _meta: MODERN_META },
    }));
    expect(JSON.parse(out!).error.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/mcp-server.test.ts`
Expected: FAIL — cannot resolve `../src/mcp-server`.

- [ ] **Step 3: Implement `packages/cli/src/mcp-server.ts`**

`handle(line)` parses, then dispatches on `method`: `initialize`, `server/discover`, `tools/list`, `tools/call`; a notification returns `undefined`; an unknown method is `-32601`. Version check: read the requested version from `params._meta['io.modelcontextprotocol/protocolVersion']` (modern) or `params.protocolVersion` (`initialize`, legacy); absent means the legacy default; unknown is `-32022`. Every modern result carries `resultType: 'complete'`. A call appends `--machine-json` to the tool's argv, runs it, `JSON.parse`s stdout, and requires an object with a `schemaVersion`; a failure to parse returns `isError: true` with a text block saying the run produced no envelope (and the first stderr line). `isError` is `envelope.error !== undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit packages/cli/test/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp-server.ts packages/cli/test/mcp-server.test.ts
git commit -m "feat(mcp): dispatch tool calls through the tool-result envelope"
```

---

### Task 4: The `mcp` command and the real runner

**Files:**
- Modify: `packages/cli/src/program.ts`, `packages/cli/src/deps.ts`
- Test: `packages/cli/test/index.test.ts`

**Interfaces:**
- Consumes: `buildCatalog`, `createMcpServer`.
- Produces: `CliDeps.runCli(argv: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/index.test.ts — appended to the existing built-binary describe
it('serves MCP over stdio and answers tools/list', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
  ].join('\n') + '\n';
  const r = spawnSync(process.execPath, [cliDist, 'mcp'], { encoding: 'utf8', input });
  expect(r.status).toBe(0);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  // Nothing but MCP messages: one JSON-RPC response per request.
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).result.supportedVersions).toContain('2026-07-28');
  const names = JSON.parse(lines[1]!).result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain('ohos-perf_analyze');
  expect(names).toContain('ohos-perf_emulator_list');
  expect(names).toContain('ohos-perf_gesture_click');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build -w packages/cli && npx vitest run --project unit packages/cli/test/index.test.ts -t "serves MCP"`
Expected: FAIL — `error: unknown command 'mcp'`, exit 1.

- [ ] **Step 3: Implement**

`deps.ts`: `runCli(argv)` spawns `process.execPath` with `process.argv[1]` (the CLI entry) plus `argv`, resolves `{stdout, stderr, code}`; it must not inherit the parent's stdio. `program.ts`: register `mcp` with a description, and its action builds the catalog from the program, calls `createMcpServer` with `deps.runCli`, then reads stdin line by line (`readline` over `process.stdin`), writing each non-`undefined` answer to stdout and ending when stdin closes. Diagnostics go to `io.writeErr`, never stdout.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build -w packages/cli && npx vitest run --project unit packages/cli/test/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/program.ts packages/cli/src/deps.ts packages/cli/test/index.test.ts
git commit -m "feat(cli): ohos-perf mcp serves the catalog over stdio"
```

---

### Task 5: Docs, skill, version 0.29.0

**Files:**
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`, `packages/*/package.json`, `package-lock.json`
- Test: `packages/cli/test/skill.test.ts` (`COMMANDS`), `doc-counts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/skill.test.ts`'s `COMMANDS` set: `'mcp'`. Add to the skill-adapter describe:

```ts
it('tells an agent how to reach the tools over MCP', () => {
  for (const needle of ['ohos-perf mcp', 'tools/list', 'tools/call', '--machine-json']) {
    expect(skill).toContain(needle);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/skill.test.ts`
Expected: FAIL — `expect(skill).toContain('ohos-perf mcp')`.

- [ ] **Step 3: Write the docs**

README: a "Calling the measurements as tools" subsection under the tool-result section — `ohos-perf mcp` over stdio, one tool per command named `ohos-perf_<path>`, the envelope as `structuredContent`, `isError` meaning "the command could not run", a failed `gate` being `isError: false`; the dual-era note (modern `2026-07-28` with `server/discover`, legacy `2025-11-25` with `initialize`); the zero-dependency note. Roadmap row P34. SKILL.md: a section on reaching the same commands over MCP, and that a tool call returns the envelope. CHANGELOG: 0.29.0. Site: P1–P34 and the counts.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify`
Expected: PASS, all counts consistent.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(p34): MCP as the tool surface, and 0.29.0"
```
