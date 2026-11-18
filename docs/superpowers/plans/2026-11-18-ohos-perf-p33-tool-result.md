# P33 — Machine-readable tool-result contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give every `ohos-perf` command one versioned, validated result envelope — `--result-file <path>` and `--machine-json` — so an agent reads a typed answer instead of guessing from an exit code and a stderr line.

**Architecture:** a new core module `machine/tool-result.ts` owns the envelope: `ToolResult` (schema version, tool id, tool version, command, success, exit code, outputs, optional error), a builder, a strict parser, and a one-line renderer. The CLI gains `CliResult.result` (the command's structured payload) and `CliResult.error` (a typed code plus message), filled by two helpers so the 25 JSON branches and 24 failure paths stop hand-writing the same shape. `program.ts` adds the two global flags, forces `--json` when `--machine-json` is set, and emits the envelope — to a file via an injected `writeFile`, to stdout as exactly one line. `index.ts` does the same for commander's own usage errors.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9, commander 12. No new dependencies.

**Spec:** this package's own `report/report.ts` artifact conventions (a versioned, byte-stable JSON document written by the CLI, never by core), `commands.ts`'s `CliResult` contract ("stdout is what a human reads, `--json` is what a tool reads"), and `doctor.ts`'s `failureLine` ("the code is the token a caller branches on"). HapRay at `bd5c98a` is the reference for the *shape* only: `perf_testing/hapray/core/common/machine_output.py` builds `{schema_version, tool_id, success, exit_code, outputs, error, tool_version}` and `finish_perf_testing_contract` writes it to `hapray-tool-result.json` beside the report dir, or prints one line under `--machine-json`; `perf_testing/plugin.json` advertises it as `tool_contract: {enabled, result_file, machine_json}`. Nothing in that tree validates the envelope when reading it back, and its default is to write a file the caller never asked for.

## Global Constraints

- ESM only; no new runtime dependencies.
- `npm run verify` (build core, both typechecks, unit suite) must pass before every commit; run `npm run build -w packages/cli` before `verify` after any `packages/cli/src` edit (a test asserts the bundle is not older than its sources).
- **The envelope is a wire format, so it is camelCase and versioned**, matching this package's own artifacts (`schemaVersion`, `startedAtNs`) rather than HapRay's snake_case. `TOOL_RESULT_SCHEMA_VERSION = '1.0'`. Changing the shape later bumps it; adding a key under `outputs` does not.
- **`success` is exactly `exitCode === 0`.** A `gate` verdict of `fail` is exit 2 — a successful measurement reporting bad news — so it is `success: false` with `error` absent and `outputs.payload.status === 'fail'`. A reader that needs "did the tool run?" reads `error`; one that needs "is the news good?" reads `outputs.payload`.
- **No default result file.** HapRay writes `hapray-tool-result.json` into the report directory even when nobody asked; this package writes only where `--result-file` says. A measurement tool must not add a file to a scene directory a reader will diff.
- **stdout is exactly one line in `--machine-json` mode**, and that line is the envelope. stderr keeps its warnings (the offline fallback notice, the agent risk warning): diagnostics are not results. Human output and a bare `--json` document are unchanged.
- Determinism: key order is fixed by construction, JSON is two-space indented with a trailing newline in a file, and the stdout line is `JSON.stringify` with no spaces. The same invocation produces the same bytes.
- `outputs` is `{ payload }` and nothing else: `payload` is the command's own structured result, already carrying its artifacts (`files`, `outDir`) where it has them. The envelope never invents a second artifact list.
- Every new error is an `OhosPerfError` whose message names the value that failed. New CLI codes: `TOOL_RESULT_BAD_PATH`, `TOOL_RESULT_BAD_DOCUMENT`.
- New core value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.
- The parity ledger does not change — 38 ported / 0 partial / 0 missing / 1 out. This capability is not one of the 39 rows (HapRay ships it as a plugin manifest field, not an action); README says "beyond the inventory" in the roadmap.
- Version `0.28.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. `--machine-json` on a command that **fails at its seam** (exit 1) → stdout is exactly one envelope line, `error.code` carries the `OhosPerfError` code, `outputs` is empty, and the process exit code is still 1. No half-written document, no second stdout line.
2. `--machine-json` on a command whose **human path has no JSON branch** (a gesture subcommand, `emulator list` with no instances) → still one envelope, `payload` present, nothing printed twice.
3. `--result-file` pointing into a **directory that does not exist**, or an unwritable path → parents are created when they can be, and a genuine failure is exit 1 with the path named — never a success line beside a file that was not written.
4. `--machine-json` combined with **`--json`**, and `--machine-json` on a command that **exits 2** (`gate` with a failed budget) → one envelope only; `success: false`, `error` absent, `outputs.payload.status === 'fail'`.
5. A **commander usage error** (missing required option, unknown option) under `--machine-json` → one envelope with `error.code === 'CLI_USAGE'` and exit 1; `--help` under `--machine-json` still prints help as text, because help is not a result.

---

## File Structure

- Create: `packages/core/src/machine/tool-result.ts` — the envelope type, builder, parser, one-line renderer, file-name constant.- Modify: `packages/core/src/index.ts` — re-export the surface.
- Modify: `packages/cli/src/commands.ts` — `CliResult.result` / `.error`, `jsonResult()` / `failureResult()` helpers, all JSON branches and catch sites.
- Modify: `packages/cli/src/doctor.ts` — `errorOf(err)` beside `failureLine`.
- Modify: `packages/cli/src/program.ts` — global `--machine-json` / `--result-file`, `preAction` forcing `--json`, envelope emission, `ProgramIo.writeFile`.
- Modify: `packages/cli/src/index.ts` — `writeFile` wiring, usage-error envelope.
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`.
- Modify: `packages/core/package.json`, `packages/cli/package.json`, lockfile — version.
- Tests: `packages/core/test/machine-tool-result.test.ts`; additions to `packages/cli/test/commands.test.ts`, `program.test.ts`, `index.test.ts`, `types.test.ts`.

---

### Task 1: The envelope in core

**Files:**
- Create: `packages/core/src/machine/tool-result.ts`
- Test: `packages/core/test/machine-tool-result.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test/types.test.ts`

**Interfaces:**
- Produces: `TOOL_RESULT_SCHEMA_VERSION: '1.0'`, `TOOL_RESULT_FILE: 'ohos-perf-tool-result.json'`, `ToolResult`, `ToolResultError`, `buildToolResult(input)`, `parseToolResult(value: unknown): ToolResult`, `renderToolResultLine(result: ToolResult): string`, `renderToolResultFile(result: ToolResult): string`.

```ts
export interface ToolResultError {
  /** The `OhosPerfError` code when the failure had one; `CLI_USAGE` for a commander error. */
  readonly code?: string;
  readonly message: string;
}

export interface ToolResult {
  readonly schemaVersion: '1.0';
  /** Always `ohos-perf`; a second tool reading these files branches on it. */
  readonly toolId: 'ohos-perf';
  readonly toolVersion: string;
  /** The command path with dots: `analyze`, `emulator.list`, `gesture.click`. */
  readonly command: string;
  /** Exactly `exitCode === 0`. */
  readonly success: boolean;
  readonly exitCode: number;
  readonly outputs: { readonly payload?: unknown };
  readonly error?: ToolResultError;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/machine-tool-result.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOL_RESULT_FILE,
  TOOL_RESULT_SCHEMA_VERSION,
  buildToolResult,
  parseToolResult,
  renderToolResultFile,
  renderToolResultLine,
} from '../src/machine/tool-result';

describe('buildToolResult', () => {
  it('stamps the schema, the tool identity and the version', () => {
    const result = buildToolResult({
      toolVersion: '0.28.0', command: 'analyze', exitCode: 0, payload: { metrics: [] },
    });
    expect(result).toEqual({
      schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
      toolId: 'ohos-perf',
      toolVersion: '0.28.0',
      command: 'analyze',
      success: true,
      exitCode: 0,
      outputs: { payload: { metrics: [] } },
    });
  });

  it('calls a non-zero exit unsuccessful', () => {
    expect(buildToolResult({ toolVersion: '1', command: 'gate', exitCode: 2 }).success).toBe(false);
    expect(buildToolResult({ toolVersion: '1', command: 'gate', exitCode: 1 }).success).toBe(false);
  });

  it('carries an error only when one was given', () => {
    const ok = buildToolResult({ toolVersion: '1', command: 'analyze', exitCode: 0 });
    expect(ok).not.toHaveProperty('error');
    expect(ok).not.toHaveProperty('outputs.payload');
    const bad = buildToolResult({
      toolVersion: '1', command: 'analyze', exitCode: 1,
      error: { code: 'SCENE_NO_INPUT', message: 'nothing to ingest' },
    });
    expect(bad.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(bad.success).toBe(false);
  });

  it('drops an undefined code rather than writing a null', () => {
    const result = buildToolResult({
      toolVersion: '1', command: 'analyze', exitCode: 1, error: { message: 'boom' },
    });
    expect(JSON.parse(JSON.stringify(result)).error).toEqual({ message: 'boom' });
  });

  it('rejects an empty command and a non-integer exit code', () => {
    expect(() => buildToolResult({ toolVersion: '1', command: '', exitCode: 0 }))
      .toThrow(/command/);
    expect(() => buildToolResult({ toolVersion: '1', command: 'analyze', exitCode: 1.5 }))
      .toThrow(/exitCode/);
  });
});

describe('parseToolResult', () => {
  const good = {
    schemaVersion: '1.0', toolId: 'ohos-perf', toolVersion: '0.28.0',
    command: 'analyze', success: true, exitCode: 0, outputs: { payload: { a: 1 } },
  };

  it('round-trips a document the builder produced', () => {
    expect(parseToolResult(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('refuses an unknown schema version, naming the value', () => {
    expect(() => parseToolResult({ ...good, schemaVersion: '2.0' }))
      .toThrow(/2\.0/);
  });

  it('refuses another tool\'s envelope', () => {
    expect(() => parseToolResult({ ...good, toolId: 'hapray' })).toThrow(/hapray/);
  });

  it('refuses a success flag that contradicts the exit code', () => {
    // A reader must never have to decide which of the two fields to believe.
    expect(() => parseToolResult({ ...good, exitCode: 1 })).toThrow(/success/);
  });

  it('refuses a missing required field, naming it', () => {
    const { command: _drop, ...rest } = good;
    expect(() => parseToolResult(rest)).toThrow(/command/);
  });

  it('refuses a non-object', () => {
    expect(() => parseToolResult([])).toThrow(/object/);
  });
});

describe('rendering', () => {
  const result = buildToolResult({
    toolVersion: '0.28.0', command: 'analyze', exitCode: 0, payload: { metrics: [1, 2] },
  });

  it('renders one line with no interior whitespace', () => {
    const line = renderToolResultLine(result);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(line).not.toContain(': ');
    expect(JSON.parse(line)).toEqual(result);
  });

  it('renders a file with two-space indent and a trailing newline', () => {
    const text = renderToolResultFile(result);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": "1.0"');
    expect(JSON.parse(text)).toEqual(result);
  });

  it('names the file this package writes', () => {
    expect(TOOL_RESULT_FILE).toBe('ohos-perf-tool-result.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/machine-tool-result.test.ts`
Expected: FAIL — cannot resolve `../src/machine/tool-result`.

- [ ] **Step 3: Implement `packages/core/src/machine/tool-result.ts`**

Doc comment states the three rules: `success` is `exitCode === 0`; `outputs` holds the payload and nothing invented; the envelope is camelCase and versioned, diverging from HapRay's snake_case on purpose so it matches this package's own artifacts.

```ts
import { OhosPerfError } from '../errors';

export const TOOL_RESULT_SCHEMA_VERSION = '1.0';
export const TOOL_RESULT_FILE = 'ohos-perf-tool-result.json';
export const TOOL_ID = 'ohos-perf';

export interface ToolResultError { readonly code?: string; readonly message: string }
export interface ToolResult {
  readonly schemaVersion: typeof TOOL_RESULT_SCHEMA_VERSION;
  readonly toolId: typeof TOOL_ID;
  readonly toolVersion: string;
  readonly command: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly outputs: { readonly payload?: unknown };
  readonly error?: ToolResultError;
}

export interface ToolResultInput {
  readonly toolVersion: string;
  readonly command: string;
  readonly exitCode: number;
  readonly payload?: unknown;
  readonly error?: ToolResultError;
}
```

`buildToolResult` throws `OhosPerfError` (code `TOOL_RESULT_BAD_DOCUMENT`) for an empty command or a non-integer exit code, omits `outputs.payload` when payload is `undefined`, and omits `error` unless given (dropping an `undefined` code).

`parseToolResult(value: unknown)` is strict and throws `OhosPerfError('TOOL_RESULT_BAD_DOCUMENT')` naming the offending value for: a non-object; `schemaVersion` not `'1.0'`; `toolId` not `'ohos-perf'`; a non-string/empty `command` or `toolVersion`; a non-integer `exitCode`; `success !== (exitCode === 0)`; an `outputs` that is not an object; an `error` that is not an object or has a non-string `message`. It returns a fresh object (never the input reference).

`renderToolResultLine` → `JSON.stringify(result) + '\n'`; `renderToolResultFile` → `JSON.stringify(result, null, 2) + '\n'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/machine-tool-result.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the surface and pin it**

Add to `packages/core/src/index.ts` a `// Machine-readable tool result` block exporting the three constants and the two functions plus the three types. Add `'TOOL_RESULT_SCHEMA_VERSION', 'TOOL_RESULT_FILE', 'TOOL_ID', 'buildToolResult', 'parseToolResult', 'renderToolResultLine', 'renderToolResultFile'` to `VALUE_EXPORTS`.

- [ ] **Step 6: Run the core typecheck and the export test**

Run: `npm run build -w packages/core && npx vitest run --project unit packages/core/test/types.test.ts`
Expected: PASS — every new value export is listed and every new type is re-exported.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/machine/tool-result.ts packages/core/src/index.ts packages/core/test/machine-tool-result.test.ts packages/core/test/types.test.ts
git commit -m "feat(machine): a versioned tool-result envelope, built and validated in core"
```

---

### Task 2: Every command carries its payload and its error

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the CLI builds the envelope; core only validates it).
- Produces: `CliResult.result?: unknown`, `CliResult.error?: ToolResultError`-shaped `{ code?: string; message: string }`, `jsonResult(payload: unknown, exitCode?: number): CliResult`, `failureResult(err: unknown, exitCode?: number): CliResult`, `errorOf(err: unknown): { code?: string; message: string }` in `doctor.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/commands.test.ts — appended
import { errorOf } from '../src/doctor';
import { OhosPerfError } from '@ohos-perf/core';

describe('CliResult carries the structured answer', () => {
  it('jsonResult returns the payload as stdout and as result', async () => {
    const r = await runAnalyze(deps(), '/scene', { json: true });
    expect(r.result).toEqual({ metrics: [], evidence: [] });
    expect(JSON.parse(r.stdout)).toEqual(r.result);
    expect(r.error).toBeUndefined();
  });

  it('jsonResult keeps the command\'s own exit code', async () => {
    const r = await runGate(deps({ gate: async () => ({
      result: { name: 'b', status: 'fail', verdicts: [], totals: { pass: 0, fail: 1, missing: 0 } },
      files: [],
    }) }), { budget: 'b.json', input: '/scene' }, { json: true });
    expect(r.exitCode).toBe(2);
    expect(r.result).toMatchObject({ status: 'fail' });
  });

  it('a failure carries the typed code and the message, and no result', async () => {
    const r = await runAnalyze(
      deps({ analyze: async () => { throw new OhosPerfError('nothing to ingest', { code: 'SCENE_NO_INPUT' }); } }),
      '/scene',
      { json: true },
    );
    expect(r.exitCode).toBe(1);
    expect(r.result).toBeUndefined();
    expect(r.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(r.stderr).toBe('SCENE_NO_INPUT: nothing to ingest\n');
  });

  it('a failure with no code still names the message', async () => {
    const r = await runAnalyze(
      deps({ analyze: async () => { throw new Error('plain'); } }), '/scene', {},
    );
    expect(r.error).toEqual({ message: 'plain' });
  });

  it('every command with a --json branch returns a result in that branch', async () => {
    // The envelope is only as complete as this list. A command added later
    // without `result:` shows up here as a missing key.
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['caps', async () => runCaps(deps(), { json: true })],
      ['tools', async () => runTools(deps(), { json: true })],
      ['emulator.list', async () => runEmulatorList(deps(), { json: true })],
      ['emulator.start', async () => runEmulatorStart(deps(), { name: 'e' }, { json: true })],
    ];
    for (const [name, run] of cases) {
      expect((await run() as { result?: unknown }).result, name).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/commands.test.ts`
Expected: FAIL — `result`/`error` are `undefined` (`jsonResult` does not exist yet, so the test file will not typecheck; that is the failure).

- [ ] **Step 3: Add the two helpers and the fields**

In `commands.ts`:

```ts
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * The command's structured answer, when it has one. `--json` renders it to
   * stdout; `--machine-json` wraps it in the tool-result envelope. Present only
   * in the branch that produced it, so a human-mode run carries no payload.
   */
  result?: unknown;
  /** The failure, when the command could not produce an answer. */
  error?: { code?: string; message: string };
}

/** A successful `--json` answer: the payload is both stdout and `result`. */
export function jsonResult(payload: unknown, exitCode = 0): CliResult {
  return { stdout: json(payload), stderr: '', exitCode, result: payload };
}

/**
 * A failure: the one stderr line, plus the same code and message as data.
 *
 * Exported because `program.ts` builds the same shape for a result file it
 * could not write — a failure is a failure whichever layer produced it.
 */
export function failureResult(err: unknown, exitCode = 1): CliResult {
  return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode, error: errorOf(err) };
}
```

In `doctor.ts`, beside `failureLine`:

```ts
/** The failure as data: the code a caller branches on, and the message it prints. */
export function errorOf(err: unknown): { code?: string; message: string } {
  return {
    ...(err instanceof OhosPerfError && err.code !== undefined ? { code: err.code } : {}),
    message: safeMessage(err),
  };
}
```

- [ ] **Step 4: Convert every JSON branch and every catch**

Replace each `if (opts.json) return { stdout: json(X), stderr: '', exitCode: 0 };` with `if (opts.json) return jsonResult(X);`, and `exitCode` variants with `jsonResult(X, exitCode)` (gate). Convert the multi-line JSON branches (`caps` at ~755, `hap` at ~1525, `opt` at ~1639, `run` at ~1733, `symbols`/`recover` at ~1870, `emulator create` if it has one) by adding `result:` with the same value they stringify. Replace every `return { stdout: '', stderr: `${failureLine(err)}\n`, exitCode: 1 };` with `return failureResult(err);`.

Two failure returns are **not** `OhosPerfError`s and keep their exact wording: `hdc unavailable: ...` (doctor, ~752) and `symbols: no such library: ...` (~1436). Give them a typed failure through `failureResult` with an explicit code so a machine reader branches on a token — `DOCTOR_HDC_UNAVAILABLE` and `SYMBOLS_NO_SUCH_LIBRARY` — and update the tests that pin the printed line, which now reads `CODE: message`.

- [ ] **Step 5: Run the CLI tests and fix the exact-equality assertions**

Run: `npx vitest run --project unit packages/cli/test`
Expected: the new tests pass; assertions that compare a whole `CliResult` with `toEqual` now see the extra `result` key and must be widened to `toMatchObject` (or given the key) — `commands.test.ts:295`, `gesture.test.ts:53`, `query-cli.test.ts:44`, plus the `emitted[0]` sites in `program.test.ts`. Widening is the right fix: those tests are about what a human reads, not about the absence of a payload.

- [ ] **Step 6: Run the full verify**

Run: `npm run build -w packages/cli && npm run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands.ts packages/cli/src/doctor.ts packages/cli/test
git commit -m "feat(cli): every command carries its payload and its typed failure"
```

---

### Task 3: The two global flags and the envelope

**Files:**
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/test/program.test.ts`

**Interfaces:**
- Consumes: `buildToolResult`, `renderToolResultLine`, `renderToolResultFile` from `@ohos-perf/core`; `CliResult.result` / `.error` and `failureResult` from Task 2.
- Produces: `ProgramIo.writeFile(path: string, contents: string): void`; global options `--machine-json` and `--result-file <path>`; the envelope on stdout (one line) and/or in the file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/program.test.ts — appended
describe('--machine-json and --result-file', () => {
  function machineHarness(overrides: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const emitted: CliResult[] = [];
    const files: Array<{ path: string; contents: string }> = [];
    const program = buildProgram(deps(overrides), {
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      emit: (r) => emitted.push(r),
      writeFile: (path, contents) => files.push({ path, contents }),
    }, { exitOverride: true });
    return { program, out, err, emitted, files };
  }

  async function run(argv: string[], overrides: Partial<CliDeps> = {}) {
    const h = machineHarness(overrides);
    try { await h.program.parseAsync(['node', 'ohos-perf', ...argv]); } catch { /* exitOverride */ }
    return h;
  }

  it('replaces the bare payload with one envelope line on stdout', async () => {
    const { out } = await run(['analyze', '/scene', '--machine-json']);
    const lines = out.join('').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!);
    expect(envelope).toMatchObject({
      schemaVersion: '1.0', toolId: 'ohos-perf', toolVersion: manifest.version,
      command: 'analyze', success: true, exitCode: 0,
    });
    expect(envelope.outputs.payload).toEqual({ metrics: [], evidence: [] });
  });

  it('names a nested command with dots', async () => {
    const { out } = await run(['emulator', 'list', '--machine-json']);
    expect(JSON.parse(out.join('')).command).toBe('emulator.list');
  });

  it('prints one envelope even when --json is also given', async () => {
    const { out } = await run(['analyze', '/scene', '--json', '--machine-json']);
    expect(out.join('').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.join('')).outputs.payload).toBeDefined();
  });

  it('wraps a failure with its code and keeps the exit code', async () => {
    const { out, emitted } = await run(['analyze', '/scene', '--machine-json'], {
      analyze: async () => { throw new OhosPerfError('nothing to ingest', { code: 'SCENE_NO_INPUT' }); },
    });
    const envelope = JSON.parse(out.join(''));
    expect(envelope.success).toBe(false);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(emitted[0]!.exitCode).toBe(1);
  });

  it('reports a gate verdict as an unsuccessful exit with no error', async () => {
    const { out } = await run(['gate', 'b.json', '/scene', '--machine-json'], {
      gate: async () => ({
        result: { name: 'b', status: 'fail', verdicts: [], totals: { pass: 0, fail: 1, missing: 0 } },
        files: [],
      }),
    });
    const envelope = JSON.parse(out.join(''));
    expect(envelope.exitCode).toBe(2);
    expect(envelope.success).toBe(false);
    expect(envelope.error).toBeUndefined();
    expect(envelope.outputs.payload.status).toBe('fail');
  });

  it('writes the envelope to --result-file and leaves stdout as the --json document', async () => {
    const { out, files } = await run(['analyze', '/scene', '--json', '--result-file', 'r.json']);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(resolve('r.json'));
    const written = JSON.parse(files[0]!.contents);
    expect(written.command).toBe('analyze');
    expect(written.outputs.payload).toEqual({ metrics: [], evidence: [] });
    expect(JSON.parse(out.join(''))).toEqual({ metrics: [], evidence: [] });
  });

  it('writes the file and prints one line when both flags are given', async () => {
    const { out, files } = await run(['analyze', '/scene', '--machine-json', '--result-file', 'r.json']);
    expect(files).toHaveLength(1);
    expect(JSON.parse(out.join(''))).toEqual(JSON.parse(files[0]!.contents));
  });

  it('fails the command when the result file cannot be written, naming the path', async () => {
    // A success line beside a file that was not written is the failure mode
    // this test exists for: the exit code has to say so.
    const out: string[] = [];
    const emitted: CliResult[] = [];
    const program = buildProgram(deps(), {
      writeOut: (t) => out.push(t),
      writeErr: () => {},
      emit: (r) => emitted.push(r),
      writeFile: () => { throw new Error('EACCES: permission denied'); },
    }, { exitOverride: true });
    try { await program.parseAsync(['node', 'ohos-perf', 'analyze', '/scene', '--result-file', 'r.json']); }
    catch { /* exitOverride */ }
    expect(emitted[0]!.exitCode).toBe(1);
    expect(emitted[0]!.stderr).toContain('r.json');
    expect(emitted[0]!.error?.code).toBe('TOOL_RESULT_BAD_PATH');
  });
});
```

The last test above needs the emitted result; give that harness an `emitted` array and assert `emitted[0]!.exitCode === 1` and `emitted[0]!.stderr` containing `r.json`.

Imports the test needs: `resolve` from `node:path`, `OhosPerfError` from `@ohos-perf/core`, and `type CliResult` (already imported).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/program.test.ts -t "machine-json"`
Expected: FAIL — `--machine-json` is an unknown option.

- [ ] **Step 3: Add `writeFile` to `ProgramIo` and the flags to the program**

```ts
export interface ProgramIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  emit(result: CliResult): void;
  /**
   * Write the tool-result file. Injected so tests never touch the disk.
   *
   * Optional: twenty-odd test harnesses build this object, and a required
   * member would turn every one of them red for a path they never take. When
   * it is absent, `--result-file` is a `TOOL_RESULT_BAD_PATH` failure rather
   * than a silent no-op.
   */
  writeFile?(path: string, contents: string): void;
}
```

In `buildProgram`, before any command:

```ts
program
  .option('--machine-json', 'print one tool-result envelope line on stdout instead of the command output')
  .option('--result-file <path>', 'write the tool-result envelope to this file');
```

Then a `preAction` hook that forces the command's own `--json`:

```ts
program.hook('preAction', (_program, action) => {
  // `--machine-json` is the envelope form of `--json`: the payload has to be
  // the structured answer, so the command is asked for it here rather than in
  // twenty-five branches.
  if (action.optsWithGlobals()['machineJson'] === true) action.setOptionValue('json', true);
});
```

- [ ] **Step 4: Emit the envelope**

Add a `finalize(action: Command, result: CliResult): CliResult` used by every `io.emit(...)` call — the cleanest form is to make `emit` a closure in `buildProgram` that takes the command:

```ts
const commandPath = (command: Command): string => {
  const parts: string[] = [];
  for (let node: Command | null = command; node !== null && node.parent !== null; node = node.parent) {
    parts.unshift(node.name());
  }
  return parts.join('.');
};

const finish = (command: Command, result: CliResult): CliResult => {
  const globals = command.optsWithGlobals() as { machineJson?: boolean; resultFile?: string };
  if (globals.machineJson !== true && globals.resultFile === undefined) return result;
  const envelope = buildToolResult({
    toolVersion: deps.version,
    command: commandPath(command),
    exitCode: result.exitCode,
    ...(result.result === undefined ? {} : { payload: result.result }),
    ...(result.error === undefined ? {} : { error: result.error }),
  });
  let written: CliResult = result;
  if (globals.resultFile !== undefined) {
    const path = resolve(globals.resultFile);
    try {
      if (io.writeFile === undefined) {
        throw new Error('no file writer is wired for this invocation');
      }
      io.writeFile(path, renderToolResultFile(envelope));
    } catch (err) {
      return failureResult(new OhosPerfError(
        `could not write the tool result to ${path}: ${safeMessage(err)}`,
        { code: 'TOOL_RESULT_BAD_PATH' },
      ));
    }
    written = result;
  }
  return globals.machineJson === true
    ? { ...written, stdout: renderToolResultLine(envelope) }
    : written;
};
```

Every action's `io.emit(await runX(...))` becomes `io.emit(finish(cmd, await runX(...)))`, taking the trailing `Command` commander passes to an action (add `cmd` as the last action parameter; commander supplies it). Import `resolve` from `node:path`, and `buildToolResult`, `renderToolResultFile`, `renderToolResultLine`, `OhosPerfError` from `@ohos-perf/core`.

Note: `--result-file` does **not** create parents. A missing directory is a `TOOL_RESULT_BAD_PATH` failure naming the path, because a silently created directory is a second surprise beside the first. `index.ts` supplies a `writeFile` that calls `mkdirSync(dirname(path), { recursive: true })` first — parents are created in production, and a genuine permission failure still surfaces as the same typed error.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project unit packages/cli/test/program.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/program.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): --machine-json and --result-file emit one versioned envelope"
```

---

### Task 4: Usage errors, help, and the executable

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/index.test.ts`

**Interfaces:**
- Consumes: `buildToolResult`, `renderToolResultLine` from core; `CliResult.error` from Task 2.
- Produces: an envelope for commander's own failures (`error.code === 'CLI_USAGE'`), `writeFile` wired to `node:fs`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/index.test.ts — appended
describe('tool-result contract from the built binary', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cliDist, ...args], {
    encoding: 'utf8', timeout: 30_000,
  });

  it('prints one envelope for a missing required option', () => {
    const r = run(['root-cause', '--machine-json']);
    expect(r.status).toBe(1);
    const lines = r.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: '1.0', toolId: 'ohos-perf', command: 'root-cause',
      success: false, exitCode: 1, error: { code: 'CLI_USAGE' },
    });
  });

  it('writes the envelope to --result-file and keeps stdout empty on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-contract-'));
    const path = join(dir, 'nested', 'result.json');
    const r = run(['root-cause', '--machine-json', '--result-file', path]);
    expect(r.status).toBe(1);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.error.code).toBe('CLI_USAGE');
  });

  it('still prints help as text under --machine-json', () => {
    // Help is not a result: an agent asking for it wants the text.
    const r = run(['--help', '--machine-json']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: ohos-perf');
    expect(r.stdout).not.toContain('"schemaVersion"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build -w packages/cli && npx vitest run --project unit packages/cli/test/index.test.ts -t "tool-result contract"`
Expected: FAIL — stdout is empty for the usage error (commander writes it to stderr).

- [ ] **Step 3: Wire `writeFile` and the usage-error envelope**

In `index.ts`, pass `writeFile` (creating parents) and wrap the parse:

```ts
const program = buildProgram(deps, {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  emit,
  writeFile: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  },
});
```

For usage errors, catch the `CommanderError` from `parseAsync`:

```ts
program.parseAsync(process.argv).catch((err: unknown) => {
  const result = usageFailure(process.argv.slice(2), err, deps.version);
  if (result !== undefined) { emit(result); return; }
  process.stderr.write(`${failureLine(err)}\n`);
  process.exitCode = 1;
});
```

`usageFailure(argv, err, version)` lives in `index.ts` (it needs argv): it returns `undefined` unless `err` is a `CommanderError` with `code !== 'commander.helpDisplayed'` **and** argv contains `--machine-json` or `--result-file`; otherwise it builds `{ stdout: '', stderr: '', exitCode: 1, error: { code: 'CLI_USAGE', message: err.message } }`, resolves the command path from argv (the first token that is not a flag, then its subcommand when the first is `emulator`, `symbols`, `gesture`), and applies the same `finish` logic — print one line and/or write the file. Commander has already printed its own message to stderr through `writeErr`; keep it, and add the envelope on stdout.

- [ ] **Step 4: Run the built-binary tests**

Run: `npm run build -w packages/cli && npx vitest run --project unit packages/cli/test/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full verify and the device suite**

Run: `npm run verify && npm run test:device`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/index.test.ts
git commit -m "feat(cli): a usage error is a tool result too, under --machine-json"
```

---

### Task 5: Docs, skill, version

**Files:**
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`
- Modify: `packages/core/package.json`, `packages/cli/package.json`, `package-lock.json`

- [ ] **Step 1: Skill guidance**

Add this section to `skill/ohos-perf/SKILL.md`, after the root-cause one (the heading below is the section's own heading, verbatim):

```markdown
## Reading a result as an agent

`--machine-json` replaces a command's output with one JSON line; `--result-file
<path>` writes the same document to a file (parents are created). Both are
global, so they go anywhere on the command line.

- `schemaVersion` is `"1.0"`. Refuse a document whose version or `toolId` is
  not what you expect rather than reading it hopefully — `parseToolResult`
  in `@ohos-perf/core` does exactly that check.
- `success` is exactly `exitCode === 0`. A `gate` verdict of `fail` is exit 2:
  `success: false`, **no** `error`, and `outputs.payload.status === 'fail'`.
  Never report that as the tool breaking.
- `error` is present only when the command could not run. Its `code` is the
  same token `stderr` prints first, so quote the code, not the prose.
- `outputs.payload` is the command's own document — the same object `--json`
  prints. Artifacts are inside it (`files`, `outDir`); the envelope adds none.
- There is no default result file. If you want the contract on disk, pass
  `--result-file`.
```

- [ ] **Step 2: README**

- A new subsection after the root-cause one, with the envelope shape, the two flags, the `success`/exit-code rule, and the divergence from HapRay (camelCase, versioned, validated on read, no default file).
- Roadmap row `| P33 | beyond the inventory | ... | shipped in 0.28.0 |`.
- Test counts after measuring.

- [ ] **Step 3: Site, CHANGELOG, versions**

- `site/index.html`: the P1–P33 card and the stat tiles; measure the counts, do not guess.
- `CHANGELOG.md`: `## 0.28.0 — 2026-11-18`, stating the envelope, the two flags, the exit-code rule, the validation, and the parity ledger staying 38/0/0/1.
- `npm version 0.28.0 -w packages/core -w packages/cli --no-git-tag-version`, update the CLI's core pin by hand, `npm install --package-lock-only`, delete a stale `packages/cli/node_modules/@ohos-perf` copy if npm materializes one.

- [ ] **Step 4: Measure the counts**

Run: `npm run verify` and the clean-checkout measurement (rename `spike/out/*.db` with a restore trap, run `npm run test:unit`). Write the measured numbers into README, site and CHANGELOG.

- [ ] **Step 5: Commit**

```bash
git add README.md site/index.html CHANGELOG.md skill/ohos-perf/SKILL.md packages/*/package.json package-lock.json
git commit -m "docs(p33): the tool-result contract, skill guidance and 0.28.0"
```
