# ohos-perf P4 Remaining Interfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: complete (verified 2026-11-16).** All 7 tasks shipped, plus a whole-branch review fix pass and real-device acceptance. Re-verified: `compare` reports 17 unchanged / 21 incomparable over two identical analyses; the `ui.tree` capability rule and the `scene.json` gate are pinned by tests; the three new collectors now have real-device coverage (`collect-capture.device.test.ts`, `analyze-capture.device.test.ts`) — and that run found a real defect, the hiperf not-debuggable marker, which is fixed.

**Goal:** Close the last functional gaps against HapRay and DevEco Studio — the `hiperf`, `hidumper` and `uitest` collectors and baseline comparison — and finish the residue the P3 review deferred.

**Architecture:** Three new collectors follow the existing `Collector` contract: validate everything before the first device call, capture to a fixed device path, require the tool's own success marker, then `recv` into the scene layout. `hiperf` produces a `perf.data` that `trace_streamer` converts into a second database (`perf.db`), so `Scene` grows an optional `perfDb` handle and `ingestScene` converts it. `hidumper` and `uitest` produce scene artifacts (`hidumper.json`, `ui.json`) that a new `RenderAnalyzer` and a new `ui.get` named query consume. Baseline comparison is a pure function over two `AnalyzeResult` values plus a `compare` CLI command.

**Tech Stack:** TypeScript (ESM), Vitest, `node:sqlite`, commander, npm workspaces.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` — §D1 (six parallel collectors), §D3 (fidelity and provenance), §3.3 (collector layout), §7 (capability matrix rows for `perf.samples`, `perf.pmu`, `render.fps_live`, `render.hitch`, `ui.tree`), §8 (CLI), L6 (Baseline comparison).

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- Determinism contract (D5): identical inputs produce byte-identical JSON; every output array has an explicit, documented order.
- CLI contract: human-readable by default; `--json` equals the API structure; any failure produces **empty stdout, one stderr line, exit 1**.
- Collectors perform no analysis: they validate, capture, and `recv`. Parsing and metric derivation live in pure functions the analyzer calls.
- Every collector removes its fixed device path before recording and requires the tool's own success marker; `hdc` exit 0 is never evidence of success.
- The public value surface of core is pinned by `packages/core/test/types.test.ts`; every new value export must be added to `VALUE_EXPORTS`, and every declared type must be exported.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Measured device facts (HUAWEI Mate 60, BRA-AL00, HarmonyOS 7.0.0.111)

These were verified on the attached device while writing this plan; the tasks depend on them verbatim.

| Fact | Evidence |
| --- | --- |
| `hiperf record --app <pkg> -d <sec> -o <path> -f <hz> [-s fp]` records for a **debuggable** app | `com.example.image` (`debug: true`) → `[ Sample records: 150, Non sample records: 4115 ]`, 0.49 MB |
| A release app is refused | `--app option only support debug application`; system apps are `debug: false` |
| `hiperf record -a` needs root | `-a option needs root privilege for system wide profiling` |
| An **idle** app yields **0 samples** and still exits 0 | app at 0% CPU → `[ Sample records: 0, Non sample records: 4107 ]` |
| `trace_streamer perf.data -e perf.db` works | exit 0; 80 tables including `perf_sample` (53 rows), `perf_callchain` (180), `perf_thread` (21), `perf_files` (19) |
| `hiperf report --json` exists but is **not** needed for ingest | `recordSampleInfo[0].processes[].threads[].CallOrder.callStack` is empty without `-s fp`; `SymbolMap` keys symbol indices |
| hitrace and hiperf **run concurrently** | begin hitrace, record hiperf 3 s, finish hitrace → both artifacts valid |
| `hidumper -s RenderService -a fpsCount` | `-- RefreshRateCounts:` then `Refresh Rate:60, Count:5534553;` per bucket; **cumulative since boot** |
| `hidumper -s RenderService -a hitchs` | `window [] Id[6343666696194]:` then `more than 66 ms 0`, `more than 33 ms 0`, `more than 16.67 ms 0`; **cumulative per window** |
| `uitest dumpLayout -p <path>` | `DumpLayout saved to:<path>`; the file is a JSON tree `{attributes, children}` |
| `dumpLayout` attributes | `type`, `bundleName`, `abilityName`, `bounds` (`[x1,y1][x2,y2]`), `text`, `id`, `accessibilityId`, `clickable`, `enabled`, `scrollable`, plus empty-string fields |
| The dump is **not** app-filtered | the root's first child is `com.ohos.sceneboard`; the app's nodes appear deeper |

## Out of scope

The spec also lists `ohos-perf emulator {list,start,stop,create}` (§8) and `device/emulator.ts` (§3.3), plus the `ui.gesture`, `coverage` and `js.heap` capabilities (§7). None of them is part of this plan: they are emulator lifecycle management and ArkTS-side instrumentation, not the four remaining data interfaces. A later plan owns them; the README keeps them listed as gaps.

## Review Focus

1. **A capture that produces nothing must say so.** hiperf exits 0 with 0 samples when the app is idle; `dumpLayout` can succeed against a blank screen; `fpsCount` deltas can be 0. Each collector must return a count the caller records and the CLI prints, and an empty artifact must never read as "the app was quiet". Owned by Tasks 2, 4, 5.
2. **Baseline comparison must not invent a direction.** An unknown metric id has no better/worse; `deltaPct` at baseline 0 must be absent, never `Infinity`/`NaN`; added and removed metrics are reported as such. Owned by Task 6.
3. **`perf.db` is never mistaken for the trace database.** Absent `perf_*` tables degrade through the capability matrix; no analyzer throws `no such table`. Owned by Task 3.
4. **Scene artifacts are trusted only when this capture produced them.** A stale `perf.data`, `ui.json` or `hidumper.json` from an earlier capture must not be analysed as this capture's, mirroring the existing `procfs.jsonl` gate. Owned by Tasks 3, 4, 5, 7.
5. **One `collect` either captures everything requested or fails loudly.** hitrace, hiperf, hidumper and uitest run concurrently; a failure restores the previous scene's artifacts and never presents a partial scene as complete. Owned by Task 7.

---

### Task 1: Close the P3 review residue

**Files:**
- Create: `.gitattributes`
- Modify: `packages/core/test/drilldown-e2e.test.ts` (honour `OHOS_PERF_E2E_REQUIRED`; assert non-empty rows)
- Modify: `packages/core/src/query/registry.ts` (argument error wording)
- Modify: `packages/cli/src/query.ts` (`parseLimit` names the offending value)
- Modify: `packages/cli/test/deps.test.ts` (`--app` precedence over a conflicting `scene.json`)
- Modify: `packages/cli/test/index.test.ts` (subprocess-level `query --json`)

**Interfaces:**
- Consumes: `runNamedQuery`, `MAX_QUERY_LIMIT` (`src/query/registry.ts`); the recorded fixture path convention from `e2e-offline.test.ts:29-40`.
- Produces: nothing later tasks import. This task only hardens what P3 shipped.

- [x] **Step 1: Write the failing tests**

In `packages/core/test/drilldown-e2e.test.ts`, replace the warn-and-skip block with the `REQUIRED` pattern already used by `e2e-offline.test.ts`:

```ts
const REQUIRED = process.env.OHOS_PERF_E2E_REQUIRED === '1';

if (!HAVE_DB && REQUIRED) {
  throw new Error(
    `OHOS_PERF_E2E_REQUIRED=1 but the drill-down fixture is missing at ${DB}. ` +
      'Run the spike conversion or unset the variable.',
  );
}
if (!HAVE_DB) {
  console.warn(`[drilldown-e2e] skipped: fixture not found at ${DB}`);
}
```

In the same file, inside the resolve loop, replace the `total >= rows.length` assertion with per-tool non-empty assertions for the tools the fixture is known to populate:

```ts
// The fixture is known to populate these; an empty result would mean the
// analyzer or the query regressed while the envelope stayed valid.
const NON_EMPTY = new Set([
  'binder.processStats', 'callstack.matching', 'callstack.range', 'frames.get',
]);
if (NON_EMPTY.has(handle.tool)) {
  expect(r.total, `${handle.tool} returned no rows`).toBeGreaterThan(0);
}
```

In `packages/cli/test/deps.test.ts`, replace the `fromFlag` case so a *conflicting* `scene.json` exists:

```ts
it('prefers an explicit --app over a conflicting scene.json', async () => {
  // scene.json names com.other, whose pid is 9999 and which the trace does
  // not contain; the explicit flag must win and resolve com.demo's pid.
  writeFileSync(join(dir, 'scene.json'), JSON.stringify({
    version: 1,
    app: { packageName: 'com.other', processNames: ['com.other'] },
    pids: [9999],
    deviceId: 'test',
    capture: { startedAtMs: 0, durationMs: 1, collectors: ['hitrace'] },
  }));
  const r = await realDeps().query({ sceneDir: dir, name: 'frames.all',
    app: 'com.demo', args: { window: { startNs: 0, endNs: 1000 } } });
  expect(r.total).toBeGreaterThan(0);
});
```

In `packages/cli/test/index.test.ts`, add a subprocess test next to the existing `analyze` one:

```ts
it('runs query against a scene with --json', () => {
  const out = execFileSync(process.execPath, [
    entry, 'query', sceneDir, 'frames.all',
    '--args', '{"window":{"startNs":0,"endNs":1000}}', '--limit', '2', '--json',
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out) as { query: string; rows: unknown[]; total: number; truncated: boolean };
  expect(parsed.query).toBe('frames.all');
  expect(parsed.rows.length).toBeLessThanOrEqual(2);
  expect(parsed.truncated).toBe(parsed.total > parsed.rows.length);
});
```

- [x] **Step 2: Run the tests to verify the expected failures**

Run: `npx vitest run packages/cli/test/deps.test.ts packages/cli/test/index.test.ts`
Expected: **`index.test.ts` FAILS** — the new subprocess test is the RED one, because `query` has never been exercised through the built entry point and the built bundle predates the test (the suite's "bundle is not older than sources" check may also fire; rebuild with `npm run build -w @ohos-perf/cli` before judging the assertion itself).
Expected: **`deps.test.ts` PASSES immediately.** That is deliberate: `deps.query` already applies `--app` before the descriptor (`if (app !== undefined)` at the top of the branch), so this test is a **pin** on correct behaviour, not a reproduction of a bug. Record it as a pin in the commit message; do not weaken it to make it red.

- [x] **Step 3: Write the argument-wording tests**

In `packages/core/test/query-registry.test.ts`:

```ts
it('names a wrongly typed argument as wrong, not missing', () => {
  try {
    runNamedQuery(ctx, 'frames.get', { id: '2' });
    expect.unreachable();
  } catch (err) {
    expect((err as OhosPerfError).code).toBe('QUERY_BAD_ARGS');
    expect((err as OhosPerfError).message).toContain('must be a finite number');
    expect((err as OhosPerfError).message).not.toContain('missing');
  }
  try {
    runNamedQuery(ctx, 'frames.all', { window: { startNs: 1, endNs: 'x' } });
    expect.unreachable();
  } catch (err) {
    expect((err as OhosPerfError).message).toContain('must be a finite number');
  }
});

it('reports an absent required argument as missing', () => {
  try {
    runNamedQuery(ctx, 'frames.get', {});
    expect.unreachable();
  } catch (err) {
    expect((err as OhosPerfError).message).toContain('missing');
  }
});
```

In `packages/cli/test/query-cli.test.ts`:

```ts
it('names the offending --limit value', () => {
  expect(() => parseLimit('abc')).toThrowError(/got "abc"/);
  expect(() => parseLimit('0')).toThrowError(/got "0"/);
});
```

- [x] **Step 4: Run to verify the wording tests fail**

Run: `npx vitest run packages/core/test/query-registry.test.ts packages/cli/test/query-cli.test.ts`
Expected: FAIL — `frames.get` with `{id:'2'}` currently says `missing number argument "id"`, and `parseLimit('abc')` says `got NaN`.

- [x] **Step 5: Implement**

`packages/core/src/query/registry.ts` — split the type check from the presence check in `numberArg` and `stringArg`:

```ts
function numberArg(query, args, name): number {
  const value = args[name];
  if (value === undefined) throw badArgs(query, `missing number argument "${name}"`);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badArgs(query, `argument "${name}" must be a finite number`);
  }
  return value;
}
```

Apply the same split to `stringArg` (`missing string argument` / `argument "x" must be a string`). Keep `nameArg` (the empty-name-tolerant variant added in P3) and `optionalStringArg` as they are.

`packages/cli/src/query.ts` — validate before coercing:

```ts
export function parseLimit(raw: string): number {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new OhosPerfError(
      `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}, got ${JSON.stringify(raw)}`,
      { code: 'QUERY_BAD_LIMIT' },
    );
  }
  return resolveQueryLimit(Number(text));
}
```

(`resolveQueryLimit` still owns the range rule and its message; `parseLimit` only rejects non-integers and names the raw text.)

Create `.gitattributes`:

```
# Repository storage is LF; the working tree follows core.autocrlf. Tests that
# read files normalise line endings themselves (see cli/test/skill.test.ts).
* text=auto

*.db binary
*.data binary
*.htrace binary
*.jpg binary
*.png binary
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/query-registry.test.ts packages/cli/test/query-cli.test.ts packages/cli/test/deps.test.ts packages/cli/test/index.test.ts`
Expected: PASS.

- [x] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, 44+ files green.

- [x] **Step 8: Commit**

```bash
git add .gitattributes packages/core/test/drilldown-e2e.test.ts packages/core/src/query/registry.ts packages/core/test/query-registry.test.ts packages/cli/src/query.ts packages/cli/test/query-cli.test.ts packages/cli/test/deps.test.ts packages/cli/test/index.test.ts
git commit -m "chore: close the P3 review residue

Add .gitattributes so the repository stores LF and the working tree follows
core.autocrlf. Make drilldown-e2e honour OHOS_PERF_E2E_REQUIRED and assert
non-empty rows for the tools the fixture populates. Distinguish a missing
argument from a wrongly typed one, and name the offending --limit value.
Pin --app precedence over a conflicting scene.json and exercise query
through the built CLI entry point."
```

---

### Task 2: `HiperfCollector`

**Files:**
- Create: `packages/core/src/collectors/hiperf.ts`
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)
- Test: `packages/core/test/collector-hiperf.test.ts`

**Interfaces:**
- Consumes: `Collector`, `CapabilityId`, `SceneLayout`, `Hdc`, `HdcResult`, `OhosPerfError`, `parseSize` (`src/collectors/hitrace.ts`).
- Produces (imported by Tasks 3 and 7):

```ts
export interface HiperfCollectOptions {
  readonly durationMs: number;
  /** Debuggable app whose processes are sampled (`hiperf record --app`). */
  readonly app: string;
  /** Sampling frequency in Hz; default 1000, range [1, 100000]. */
  readonly frequency?: number;
  /** Events to sample; default `['hw-cpu-cycles']`. Bare names only. */
  readonly events?: readonly string[];
  /** Record frame-pointer call stacks (`-s fp`); default true. */
  readonly callStacks?: boolean;
}

/** What the device reported for one recording. */
export interface HiperfCapture {
  /** `Sample records`. 0 is a valid capture of an idle app, not a failure. */
  readonly samples: number;
  readonly nonSamples: number;
  readonly lost: number;
  /** Size of the transferred `perf.data` in bytes. */
  readonly bytes: number;
}

export function parseHiperfSummary(text: string): Omit<HiperfCapture, 'bytes'> | undefined;
export function hiperfRecordCommand(opts: HiperfCollectOptions, devicePath: string): string;

export class HiperfCollector implements Collector {
  readonly id = 'hiperf';
  readonly provides: CapabilityId[]; // ['perf.samples', 'perf.pmu']
  async collect(
    hdc: Hdc, target: string, opts: HiperfCollectOptions, layout: SceneLayout,
  ): Promise<HiperfCapture>;
}
```

- [x] **Step 1: Write the failing test**

Create `packages/core/test/collector-hiperf.test.ts`. Use the structural fake-hdc pattern from `collector-hitrace.test.ts` (an object with `shell`/`recv` recording every call):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiperfCollector, hiperfRecordCommand, parseHiperfSummary } from '../src/collectors/hiperf';
import { createSceneLayout } from '../src/ingest/scene';
import { OhosPerfError } from '../src/errors';
import type { Hdc } from '../src/transport/hdc';

const DEVICE_PATH = '/data/local/tmp/ohosperf_perf.data';

/** A recording fake: every shell call is answered from `script`, else exits 0. */
function fakeHdc(script: Array<{ match: RegExp; stdout?: string; code?: number }>) {
  const calls: string[] = [];
  let perfBytes = 4096;
  const hdc = {
    async shell(_target: string, cmd: string) {
      calls.push(cmd);
      if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.startsWith('ls -l')) {
        return { stdout: `-rw-r--r-- 1 shell shell ${perfBytes} ${DEVICE_PATH}`, stderr: '', code: 0 };
      }
      for (const step of script) {
        if (step.match.test(cmd)) {
          return { stdout: step.stdout ?? '', stderr: '', code: step.code ?? 0 };
        }
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    async recv(_t: string, _from: string, to: string) {
      writeFileSync(to, Buffer.alloc(perfBytes));
    },
  };
  return { hdc: hdc as unknown as Hdc, calls, setBytes: (n: number) => { perfBytes = n; } };
}

const RECORDED = '[ Sample records: 150, Non sample records: 4115 ]\n' +
  '[ Sample lost: 0, Non sample lost: 0 ]\n' +
  '[ hiperf record: Captured 0.492 MB perf data. ]\n';

const layoutFor = (root: string) => createSceneLayout(root);
const tmp = () => mkdtempSync(join(tmpdir(), 'ohosperf-hiperf-'));

describe('parseHiperfSummary', () => {
  it('reads the sample, non-sample and lost counts', () => {
    expect(parseHiperfSummary(RECORDED)).toEqual({ samples: 150, nonSamples: 4115, lost: 0 });
  });

  it('accepts a zero-sample capture of an idle app', () => {
    const idle = '[ Sample records: 0, Non sample records: 4107 ]\n' +
      '[ Sample lost: 0, Non sample lost: 0 ]\n';
    expect(parseHiperfSummary(idle)).toEqual({ samples: 0, nonSamples: 4107, lost: 0 });
  });

  it('returns undefined without the sample marker', () => {
    expect(parseHiperfSummary('hiperf: permission denied')).toBeUndefined();
  });
});

describe('hiperfRecordCommand', () => {
  it('builds the measured invocation', () => {
    expect(hiperfRecordCommand({ durationMs: 3000, app: 'com.example.image' }, DEVICE_PATH))
      .toBe(`hiperf record --app com.example.image -d 3 -o ${DEVICE_PATH} -f 1000 -s fp`);
  });

  it('omits -s when call stacks are off and renders events', () => {
    expect(hiperfRecordCommand({
      durationMs: 1500, app: 'com.demo', frequency: 500,
      events: ['hw-cpu-cycles', 'sw-task-clock'], callStacks: false,
    }, DEVICE_PATH)).toBe(
      `hiperf record --app com.demo -d 1.5 -o ${DEVICE_PATH} -f 500 -e hw-cpu-cycles,sw-task-clock`,
    );
  });
});

describe('HiperfCollector', () => {
  it('removes the stale path, records, recvs and reports the summary', async () => {
    const root = tmp();
    const { hdc, calls } = fakeHdc([{ match: /^hiperf record /, stdout: RECORDED }]);
    try {
      const capture = await new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.example.image' }, layoutFor(root),
      );
      expect(capture).toEqual({ samples: 150, nonSamples: 4115, lost: 0, bytes: 4096 });
      expect(calls[0]).toBe(`rm -f ${DEVICE_PATH}`);
      expect(existsSync(join(root, 'perf.data'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('succeeds with zero samples and reports them', async () => {
    const root = tmp();
    const { hdc } = fakeHdc([{ match: /^hiperf record /, stdout:
      '[ Sample records: 0, Non sample records: 4107 ]\n[ Sample lost: 0, Non sample lost: 0 ]\n' }]);
    try {
      const capture = await new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.example.image' }, layoutFor(root),
      );
      expect(capture.samples).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a release app with an actionable code', async () => {
    const root = tmp();
    const { hdc } = fakeHdc([{ match: /^hiperf record /,
      stdout: 'hiperf: --app option only support debug application\n', code: 1 }]);
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.system.app' }, layoutFor(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NOT_DEBUGGABLE' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the file is missing or empty', async () => {
    const root = tmp();
    const { hdc, setBytes } = fakeHdc([{ match: /^hiperf record /, stdout: RECORDED }]);
    setBytes(0);
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.demo' }, layoutFor(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NO_OUTPUT' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates before touching the device', async () => {
    const root = tmp();
    const { hdc, calls } = fakeHdc([]);
    const cases: Array<[Partial<Parameters<HiperfCollector['collect']>[2]>, string]> = [
      [{ durationMs: 0 }, 'HIPERF_BAD_DURATION'],
      [{ durationMs: 3000, app: 'bad name' }, 'HIPERF_BAD_APP'],
      [{ durationMs: 3000, app: 'com.demo', frequency: 0 }, 'HIPERF_BAD_FREQUENCY'],
      [{ durationMs: 3000, app: 'com.demo', events: ['hw cycles'] }, 'HIPERF_BAD_EVENT'],
    ];
    try {
      for (const [patch, code] of cases) {
        await expect(new HiperfCollector().collect(
          hdc, 'dev', { durationMs: 3000, app: 'com.demo', ...patch } as never, layoutFor(root),
        )).rejects.toMatchObject({ code });
      }
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/collector-hiperf.test.ts`
Expected: FAIL — `Cannot find module '../src/collectors/hiperf'`.

- [x] **Step 3: Implement `packages/core/src/collectors/hiperf.ts`**

Rules the implementation must satisfy:
- Fixed device path `export const DEVICE_PERF_PATH = '/data/local/tmp/ohosperf_perf.data'`.
- `hiperfRecordCommand` renders seconds with `String(ms / 1000)` so `1500` becomes `1.5` (hiperf accepts a float) and `3000` becomes `3`; `-f` is **always** emitted with the effective frequency (`opts.frequency ?? 1000`); `-e` only when `events` is supplied; `-s fp` only when `callStacks !== false`.
- Validation before any device call: `durationMs` finite in `(0, 2^31-1]` → `HIPERF_BAD_DURATION`; `app` matching `/^[A-Za-z0-9_.]+$/` → `HIPERF_BAD_APP`; `frequency` a safe integer in `[1, 100000]` → `HIPERF_BAD_FREQUENCY`; every event matching `/^[a-z0-9-]+$/` → `HIPERF_BAD_EVENT`.
- `events` defaults to `['hw-cpu-cycles']`. Task 7 selects the default from the capability matrix; this collector only renders what it is given, so its unit tests stay device-independent.
- Order: `rm -f <device path>` → run the record command → parse `[ Sample records: N, Non sample records: M ]` and `[ Sample lost: L, Non sample lost: ... ]` → if the combined output contains `only support debug application`, throw `HIPERF_NOT_DEBUGGABLE` (before the generic marker failure) → if the marker is absent throw `HIPERF_RECORD_FAILED` with `detail(...)` → `ls -l` and require size > 0 (`HIPERF_NO_OUTPUT`) → `hdc.recv`.
- `parseHiperfSummary` returns `undefined` unless both markers parse; `lost` comes from the first number of the `Sample lost` line.
- Reuse the `detail()` and `combined()` helpers by copying the five-line form used in `hitrace.ts` (do not export them from there; they are per-collector).

- [x] **Step 4: Export from `packages/core/src/index.ts`**

Add next to the other collectors:

```ts
export {
  HiperfCollector, DEVICE_PERF_PATH, hiperfRecordCommand, parseHiperfSummary,
} from './collectors/hiperf';
export type { HiperfCapture, HiperfCollectOptions } from './collectors/hiperf';
```

Add `'HiperfCollector'`, `'DEVICE_PERF_PATH'`, `'hiperfRecordCommand'`, `'parseHiperfSummary'` to `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.

- [x] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/collector-hiperf.test.ts packages/core/test/types.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/collectors/hiperf.ts packages/core/src/index.ts packages/core/test/collector-hiperf.test.ts packages/core/test/types.test.ts
git commit -m "feat(core): capture hiperf samples as perf.data"
```

---

### Task 3: `perf.db` ingest and the `perf.samples` capability

**Files:**
- Modify: `packages/core/src/ingest/scene.ts` (`Scene.perfDb`, perf conversion)
- Modify: `packages/cli/src/deps.ts` (offline `perf.samples`, `PerfQuery` over `perfDb`)
- Modify: `packages/core/src/index.ts` (no new values; `Scene` shape changes)
- Test: `packages/core/test/scene.test.ts`, `packages/cli/test/deps.test.ts`

**Interfaces:**
- Consumes: `Streamer.convert` (already converts any trace-like input), `SceneLayout.perfFile`/`perfDb` (already declared), `PerfQuery.hasSamples()`.
- Produces (used by Task 7 and by the CLI analyze path):

```ts
export class Scene {
  readonly dir: string;
  readonly traceDb: QueryHandle;
  /** Present only when this scene carries a converted `perf.db`. */
  readonly perfDb?: QueryHandle;
  close(): void; // closes both handles
}
```

- [x] **Step 1: Write the failing test**

In `packages/core/test/scene.test.ts` add a case using the existing stub-streamer pattern:

```ts
it('converts perf.data into perf.db and opens both handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-scene-perf-'));
  const layout = createSceneLayout(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(layout.traceFile, 'trace');
  writeFileSync(layout.perfFile!, 'perf');
  const converted: string[] = [];
  const streamer = {
    async convert(input: string, output: string) {
      converted.push(output);
      // A real conversion produces a database; the stub writes a minimal one.
      const raw = new DatabaseSync(output);
      raw.exec('CREATE TABLE perf_sample(id INT); INSERT INTO perf_sample VALUES (0);');
      raw.close();
    },
  } as unknown as Streamer;
  try {
    const scene = await ingestScene(streamer, layout);
    try {
      expect(converted).toEqual([layout.traceDb, layout.perfDb]);
      expect(scene.perfDb).toBeDefined();
      expect(scene.perfDb!.query('SELECT COUNT(*) AS n FROM perf_sample')[0]).toEqual({ n: 1 });
    } finally {
      scene.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('leaves perfDb undefined when the scene has no perf.data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-scene-noperf-'));
  const layout = createSceneLayout(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(layout.traceFile, 'trace');
  const streamer = { async convert(_i: string, output: string) {
    const raw = new DatabaseSync(output);
    raw.exec('CREATE TABLE frame_slice(id INT);');
    raw.close();
  } } as unknown as Streamer;
  try {
    const scene = await ingestScene(streamer, layout);
    try {
      expect(scene.perfDb).toBeUndefined();
    } finally {
      scene.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

In `packages/cli/test/deps.test.ts`, assert `offlineCapabilities` directly — it is already exported from `deps.ts` and takes the two databases:

```ts
it('claims perf.samples only when perf_sample has rows', () => {
  const withRows = fakeDb({ tables: ['perf_sample'], rows: { perf_sample: 1 } });
  expect(offlineCapabilities(fakeDb({ tables: ['frame_slice'] }), [], withRows)
    .has('perf.samples')).toBe(true);

  // The table exists but is empty: no samples were ever recorded, so the
  // capability must stay absent rather than claim an empty capture.
  const emptyTable = fakeDb({ tables: ['perf_sample'], rows: { perf_sample: 0 } });
  expect(offlineCapabilities(fakeDb({ tables: ['frame_slice'] }), [], emptyTable)
    .has('perf.samples')).toBe(false);
});

it('leaves perf.samples absent when the scene has no perf.db', () => {
  expect(offlineCapabilities(fakeDb({ tables: ['frame_slice'] }), [])
    .has('perf.samples')).toBe(false);
});
```

`fakeDb({ tables, rows })` is a local helper in the test file: it answers the `sqlite_master` query from `tables` and `SELECT 1 FROM <t> LIMIT 1` from `rows`. Add it next to the existing helpers; it replaces nothing.

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/scene.test.ts packages/cli/test/deps.test.ts`
Expected: FAIL — `scene.perfDb` is `undefined`, and `converted` holds only `[layout.traceDb]`.

- [x] **Step 3: Implement**

`packages/core/src/ingest/scene.ts`:

```ts
export class Scene {
  readonly dir: string;
  readonly traceDb: QueryHandle;
  readonly perfDb?: QueryHandle;

  constructor(layout: SceneLayout, db: QueryHandle, perfDb?: QueryHandle) {
    this.dir = layout.root;
    this.traceDb = db;
    this.perfDb = perfDb;
  }
  // close(): close both; the trace handle first, then perf. Both are idempotent.
}
```

In `ingestScene`, after the trace conversion and before `openDb`:

```ts
// A scene may carry a perf capture beside the trace. Convert it the same way
// and open it as a second handle; a scene without perf.data simply has none.
let perfDb: QueryHandle | undefined;
if (layout.perfDb !== undefined && layout.perfFile !== undefined) {
  if (!existsSync(layout.perfDb)) {
    if (!existsSync(layout.perfFile)) {
      perfDb = undefined;
    } else {
      mkdirSync(layout.root, { recursive: true });
      await streamer.convert(layout.perfFile, layout.perfDb);
      perfDb = openDb(layout.perfDb);
    }
  } else {
    perfDb = openDb(layout.perfDb);
  }
}
```

`packages/cli/src/deps.ts`:
- Add `{ id: 'perf.samples', collector: 'hiperf', tables: ['perf_sample'] }` to `TABLE_RULES`, with a rows check: the rule must require at least one row, not merely the table. Extend the rule shape with `minRows?: { table: string }` and count it in `offlineCapabilities` (`SELECT 1 FROM <table> LIMIT 1`).
- `offlineCapabilities` currently takes one db. Give it an optional second db: `offlineCapabilities(db, procfsSamples, perfDb?)`, and evaluate `perf.*` rules against `perfDb ?? db`.
- In `openOfflineScene`, keep the opened `perfDb` and expose it on `OpenedScene`.
- In `analyze`, `perf: new PerfQuery(opened.perfDb ?? db)`.
- In `query`, pass the same `perfDb` through `QueryContext` only if a later task needs it (Task 5 adds `uiTree`; leave `QueryContext` unchanged here).

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/core/test/scene.test.ts packages/cli/test/deps.test.ts`
Expected: PASS.

- [x] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing scene tests must still pass with `perfDb` absent.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/ingest/scene.ts packages/cli/src/deps.ts packages/core/test/scene.test.ts packages/cli/test/deps.test.ts
git commit -m "feat: ingest perf.data into a second scene database"
```

---

### Task 4: `HidumperCollector` and the render analyzer

**Files:**
- Create: `packages/core/src/collectors/hidumper.ts`
- Create: `packages/core/src/analyze/render.ts`
- Modify: `packages/core/src/analyze/engine.ts` (`defaultAnalyzers`)
- Modify: `packages/core/src/analyze/types.ts` (`hidumper?: HidumperCapture`)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)
- Test: `packages/core/test/collector-hidumper.test.ts`, `packages/core/test/analyze-render.test.ts`

**Interfaces:**
- Consumes: `Collector`, `SceneLayout`, `Hdc`, `metric`, `evidence`, `CapabilityMatrix`.
- Produces (used by Task 7):

```ts
export interface FpsBucket { readonly refreshRate: number; readonly count: number; }
export interface WindowHitches {
  readonly windowId: string;
  readonly over16_67: number;
  readonly over33: number;
  readonly over66: number;
}
export interface HidumperSnapshot {
  /** Host `Date.now()` when the snapshot was taken. */
  readonly ts: number;
  readonly fpsCounts: FpsBucket[];
  readonly hitches: WindowHitches[];
}
/** Two snapshots `intervalMs` apart; deltas come from the pair. */
export interface HidumperCapture {
  readonly version: 1;
  readonly intervalMs: number;
  readonly samples: [HidumperSnapshot, HidumperSnapshot];
}

export function parseFpsCounts(text: string): FpsBucket[];
export function parseHitches(text: string): WindowHitches[];
export function readHidumperCapture(path: string): HidumperCapture | undefined;

export class HidumperCollector implements Collector {
  readonly id = 'hidumper';
  readonly provides: CapabilityId[]; // ['render.fps_live', 'render.hitch']
  async collect(
    hdc: Hdc, target: string,
    opts: { durationMs: number; intervalMs?: number },
    layout: SceneLayout,
  ): Promise<HidumperCapture>;
}

export class RenderAnalyzer implements Analyzer {
  readonly id = 'render';
  readonly requires: CapabilityId[]; // ['render.fps_live']
}
```

- [x] **Step 1: Write the parser tests first**

Create `packages/core/test/collector-hidumper.test.ts` with the **measured** device output quoted verbatim:

```ts
const FPS_TEXT = `
-------------------------------[ability]-------------------------------


----------------------------------RenderService----------------------------------

-- RefreshRateCounts: 
Refresh Rate:30, Count:1202377;
Refresh Rate:60, Count:5534553;
Refresh Rate:90, Count:35829;
Refresh Rate:120, Count:396586;
`;

const HITCH_TEXT = `
----------------------------------RenderService----------------------------------

-- The recently window hitchs records info of screens:


 window [] Id[6343666696194]:
more than 66 ms       0
more than 33 ms       0
more than 16.67 ms    0

-----RSProcessDump-----

RSProcessDump pid:1477 screenId:12884901887
`;
```

Assertions:

```ts
it('parses every refresh-rate bucket in device order', () => {
  expect(parseFpsCounts(FPS_TEXT)).toEqual([
    { refreshRate: 30, count: 1202377 },
    { refreshRate: 60, count: 5534553 },
    { refreshRate: 90, count: 35829 },
    { refreshRate: 120, count: 396586 },
  ]);
});

it('returns [] for output without the RefreshRateCounts header', () => {
  expect(parseFpsCounts('hidumper: service not found')).toEqual([]);
});

it('parses one window hitch record', () => {
  expect(parseHitches(HITCH_TEXT)).toEqual([
    { windowId: '6343666696194', over16_67: 0, over33: 0, over66: 0 },
  ]);
});

it('keeps buckets with non-zero counts', () => {
  const busy = HITCH_TEXT.replace('more than 16.67 ms    0', 'more than 16.67 ms    7');
  expect(parseHitches(busy)[0].over16_67).toBe(7);
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/collector-hidumper.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the analyzer tests**

Create `packages/core/test/analyze-render.test.ts` with a `HidumperCapture` literal whose two snapshots differ. Add one local helper, `ctxWith(capture?: HidumperCapture): AnalyzeContext`, which builds the minimal context the analyzer reads (an empty `CapabilityMatrix`, `window: { startNs: 0, endNs: 1 }`, `deviceId: 'test'`, and `hidumper` only when `capture` is defined) — every test below calls it:

```ts
const capture: HidumperCapture = {
  version: 1,
  intervalMs: 10_000,
  samples: [
    { ts: 0, fpsCounts: [{ refreshRate: 60, count: 1000 }, { refreshRate: 120, count: 0 }],
      hitches: [{ windowId: 'w1', over16_67: 3, over33: 1, over66: 0 }] },
    { ts: 10_000, fpsCounts: [{ refreshRate: 60, count: 1600 }, { refreshRate: 120, count: 600 }],
      hitches: [{ windowId: 'w1', over16_67: 9, over33: 2, over66: 1 }] },
  ],
};

it('derives live fps from the delta between the two snapshots', async () => {
  const r = await new RenderAnalyzer().run(ctxWith(capture));
  const fps = r.metrics.find((m) => m.id === 'render.fps.live');
  // (600 + 600) frames over 10 s = 120 fps
  expect(fps?.value).toBe(120);
  expect(fps?.unit).toBe('fps');
  expect(fps?.fidelity).toBe('proxy');
  expect(fps?.provenance.collector).toBe('hidumper');
});

it('derives the hitch count as an exact delta', async () => {
  const r = await new RenderAnalyzer().run(ctxWith(capture));
  const hitch = r.metrics.find((m) => m.id === 'render.hitch.count');
  expect(hitch?.value).toBe(6);          // 9 - 3
  expect(hitch?.fidelity).toBe('exact');
});

it('emits evidence for a window whose hitches grew', async () => {
  const r = await new RenderAnalyzer().run(ctxWith(capture));
  const e = r.evidence.find((x) => x.kind === 'fps_baseline');
  expect(e?.signals).toMatchObject({ over16_67: 6, over33: 1, over66: 1 });
});

it('reports zero rather than throwing when the app rendered nothing', async () => {
  const idle: HidumperCapture = { ...capture, samples: [capture.samples[0], capture.samples[0]] };
  const r = await new RenderAnalyzer().run(ctxWith(idle));
  expect(r.metrics.find((m) => m.id === 'render.fps.live')?.value).toBe(0);
});

it('degrades without a hidumper capture', async () => {
  const r = await new RenderAnalyzer().run(ctxWith(undefined));
  expect(r.metrics).toEqual([expect.objectContaining({
    id: 'render.degraded', fidelity: 'proxy',
  })]);
});

it('does not claim a capability the matrix lacks', async () => {
  // The engine, not the analyzer, gates this; the analyzer must still be
  // callable with an empty capture and produce only the degraded metric.
  expect(new RenderAnalyzer().requires).toEqual(['render.fps_live']);
});
```

- [x] **Step 4: Run to verify they fail**

Run: `npx vitest run packages/core/test/analyze-render.test.ts`
Expected: FAIL — module not found.

- [x] **Step 5: Implement the collector**

`packages/core/src/collectors/hidumper.ts` rules:
- Two commands, measured verbatim: `hidumper -s RenderService -a 'fpsCount'` and `hidumper -s RenderService -a 'hitchs'`. The single quotes are part of the command; the service name is validated against `/^[A-Za-z0-9_.]+$/` before interpolation.
- `collect` takes a snapshot, sleeps `intervalMs ?? durationMs`, takes a second. Both snapshots must parse; a missing `RefreshRateCounts` header in *either* → `HIDUMPER_PARSE_FAILED` (an unparseable histogram is not an empty one). An empty `hitches` list is valid (no windows drawn) and yields `[]`.
- `intervalMs` must be a safe integer ≥ 100 → `HIDUMPER_BAD_INTERVAL`; `durationMs` finite in `(0, 2^31-1]` → `HIDUMPER_BAD_DURATION`.
- Writes `layout.root/hidumper.json` (add `hidumperFile` to `SceneLayout`) with `JSON.stringify(capture, null, 2) + '\n'`, creating the directory first. It removes a stale file before the first snapshot so a failed capture leaves none.
- Export `readHidumperCapture(path)` that returns `undefined` for a missing file, invalid JSON, `version !== 1`, or a `samples` array that is not exactly two snapshots.

- [x] **Step 6: Implement the analyzer**

`packages/core/src/analyze/render.ts` rules:
- `id = 'render'`, `requires = ['render.fps_live']`.
- Without `ctx.hidumper`, return exactly one metric `render.degraded` (value 0, `fidelity: 'proxy'`, `degraded: { reason: 'no hidumper capture', fallback: 'analyzer skipped' }`) and no evidence.
- Otherwise, for each refresh-rate bucket present in either snapshot: `delta = max(0, end.count - start.count)`; `frames = Σ delta`; `seconds = intervalMs / 1000`; `render.fps.live = frames / seconds`, `unit: 'fps'`, `fidelity: 'proxy'`, `provenance: { collector: 'hidumper', device: ctx.deviceId }`, `rows: number of buckets`.
- Hitches: join by `windowId`; per window `d16 = max(0, end - start)`; `render.hitch.count = Σ d16`, `unit: 'count'`, `fidelity: 'exact'`, `provenance: { collector: 'hidumper', device }`.
- Evidence: one `fps_baseline` item per window whose `d16 > 0`, with `signals: { over16_67: d16, over33: d33, over66: d66 }`, `severity: 'warn'`, `explain: 'window rendered frames over the 16.67 ms budget'`, `drillDown: [{ label: 'Hitch counters', tool: 'caps.get', args: { ids: ['render.hitch'] }, returns: 'CapabilityState[]' }]`, `key: windowId`.
- Sort metrics by `id`; evidence by `(kind, window.startNs, id)` using `ctx.window` for the window.
- Negative deltas (a counter that went backwards, e.g. the service restarted) clamp to 0 — document that in the metric's doc comment.

- [x] **Step 7: Wire it**

- `packages/core/src/ingest/scene.ts`: add `hidumperFile: join(root, 'hidumper.json')` to `SceneLayout` and `createSceneLayout`.
- `packages/core/src/analyze/types.ts`: `hidumper?: HidumperCapture;`.
- `packages/core/src/analyze/engine.ts`: `new RenderAnalyzer()` in `defaultAnalyzers()`.
- `packages/core/src/index.ts`: export `HidumperCollector`, `parseFpsCounts`, `parseHitches`, `readHidumperCapture`, `RenderAnalyzer`; types `FpsBucket`, `WindowHitches`, `HidumperSnapshot`, `HidumperCapture`.
- `packages/core/test/types.test.ts`: add the five value names to `VALUE_EXPORTS`.

- [x] **Step 8: Run to verify everything passes**

Run: `npx vitest run packages/core/test/collector-hidumper.test.ts packages/core/test/analyze-render.test.ts packages/core/test/types.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS. `analyze-engine` must still pass with the new analyzer in the default list.

- [x] **Step 9: Commit**

```bash
git add packages/core/src/collectors/hidumper.ts packages/core/src/analyze/render.ts packages/core/src/analyze/engine.ts packages/core/src/analyze/types.ts packages/core/src/ingest/scene.ts packages/core/src/index.ts packages/core/test/collector-hidumper.test.ts packages/core/test/analyze-render.test.ts packages/core/test/types.test.ts
git commit -m "feat(core): sample hidumper render counters and analyze them"
```

---

### Task 5: `UitestCollector` and the `ui.get` query

**Files:**
- Create: `packages/core/src/collectors/uitest.ts`
- Create: `packages/core/src/query/ui.ts`
- Modify: `packages/core/src/ingest/scene.ts` (`uiFile` in the layout)
- Modify: `packages/core/src/query/registry.ts` (`ui.get`; `QueryContext.uiTree`)
- Modify: `packages/cli/src/deps.ts` (load `ui.json` into the query context)
- Modify: `packages/core/src/index.ts`, `packages/core/test/types.test.ts`
- Test: `packages/core/test/collector-uitest.test.ts`, `packages/core/test/query-ui.test.ts`

**Interfaces:**
- Consumes: `Collector`, `SceneLayout`, `Hdc`, `NamedQueryDefinition`, `QueryContext`, `badArgs`-style errors.
- Produces (used by Task 7 and by agents):

```ts
/** One node of a `uitest dumpLayout` tree, flattened for querying. */
export interface UiNode {
  readonly depth: number;
  readonly type: string;
  readonly bundleName: string;
  readonly abilityName: string;
  readonly text: string;
  readonly id: string;
  readonly bounds: string;
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly scrollable: boolean;
  readonly children: number;   // direct child count
}
export function flattenUiTree(root: unknown): UiNode[];   // depth-first, document order
export function readUiTree(path: string): UiNode[] | undefined;

export class UitestCollector implements Collector {
  readonly id = 'uitest';
  readonly provides: CapabilityId[]; // ['ui.tree']
  async collect(
    hdc: Hdc, target: string, opts: { timeoutMs?: number }, layout: SceneLayout,
  ): Promise<UiNode[]>;
}
```

- [x] **Step 1: Write the flattening test with the measured shape**

Create `packages/core/test/query-ui.test.ts`:

```ts
const ROOT = {
  attributes: { type: '', bundleName: '', bounds: '[0,0][1216,2688]' },
  children: [
    {
      attributes: {
        type: 'WindowScene', bundleName: 'com.ohos.sceneboard', abilityName: '',
        bounds: '[0,107][1216,2688]', text: '', id: 'session176',
        clickable: '', enabled: 'true', scrollable: 'false',
      },
      children: [
        {
          attributes: {
            type: 'Image', bundleName: 'com.example.image', abilityName: 'EntryAbility',
            bounds: '[10,200][300,500]', text: '', id: '',
            clickable: 'true', enabled: 'true', scrollable: 'false',
          },
          children: [],
        },
      ],
    },
  ],
};

it('flattens depth-first in document order', () => {
  const nodes = flattenUiTree(ROOT);
  expect(nodes.map((n) => n.type)).toEqual(['', 'WindowScene', 'Image']);
  expect(nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
});

it('keeps the measured attribute subset and coerces flags', () => {
  const image = flattenUiTree(ROOT)[2];
  expect(image).toEqual({
    depth: 2, type: 'Image', bundleName: 'com.example.image',
    abilityName: 'EntryAbility', text: '', id: '', bounds: '[10,200][300,500]',
    clickable: true, enabled: true, scrollable: false, children: 0,
  });
});

it('tolerates a node with no attributes or children', () => {
  expect(flattenUiTree({})).toEqual([]);
});

it('returns [] for a document that is not a tree', () => {
  expect(flattenUiTree({ not: 'a tree' })).toEqual([]);
  expect(flattenUiTree(null)).toEqual([]);
});
```

Also in `packages/core/test/query-registry.test.ts`:

```ts
it('returns the flattened UI tree filtered by bundle', () => {
  const ctxWithTree = { ...ctx, uiTree: [
    { depth: 1, type: 'WindowScene', bundleName: 'com.ohos.sceneboard', abilityName: '',
      text: '', id: '', bounds: '', clickable: false, enabled: true, scrollable: false, children: 1 },
    { depth: 2, type: 'Image', bundleName: 'com.demo', abilityName: 'EntryAbility',
      text: '', id: '', bounds: '', clickable: true, enabled: true, scrollable: false, children: 0 },
  ] };
  expect(runNamedQuery(ctxWithTree, 'ui.get', {}).total).toBe(2);
  expect(runNamedQuery(ctxWithTree, 'ui.get', { bundleName: 'com.demo' }).rows)
    .toEqual([expect.objectContaining({ type: 'Image' })]);
  expect(runNamedQuery(ctx, 'ui.get', {}).total).toBe(0);
});
```

And the registry name list test gains `'ui.get'` in sorted position (`threads.pattern`, `ui.get`).

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/query-ui.test.ts packages/core/test/query-registry.test.ts`
Expected: FAIL — module not found, and `queryDefinitions()` does not yet list `ui.get`.

- [x] **Step 3: Implement `packages/core/src/query/ui.ts`**

`flattenUiTree(root)` walks `children` recursively; a node without an `attributes` object is skipped **with its subtree**; numeric/string attributes are read through `str()`-style coercion; the three flags are `=== 'true'`. Depth is the tree depth, starting at 0 for the root. `readUiTree(path)` returns `undefined` for a missing/invalid file and `[]` for a document that is not a tree.

- [x] **Step 4: Add the query**

In `packages/core/src/query/registry.ts`:
- `QueryContext` gains `readonly uiTree?: readonly UiNode[];`.
- New definition `ui.get`, `returns: 'UiNode[]'`, args: `bundleName` (optional string, non-empty), `maxDepth` (optional finite number ≥ 0).
- `run` filters `ctx.uiTree ?? []` by `bundleName` (exact match) and `depth <= maxDepth` when given. Document that rows are already in document order.

- [x] **Step 5: Implement the collector**

`packages/core/src/collectors/uitest.ts`:
- Device path `export const DEVICE_UI_PATH = '/data/local/tmp/ohosperf_ui.json'`.
- Command: `uitest dumpLayout -p <path>`; success marker `DumpLayout saved`.
- Order: `rm -f <path>` → run → require the marker (`UITEST_DUMP_FAILED`) → `ls -l` and require size > 0 (`UITEST_NO_OUTPUT`) → `recv` → parse with `readUiTree` → a parse failure is `UITEST_PARSE_FAILED` and the local file is removed.
- `timeoutMs` optional, default 10_000, validated as a safe integer ≥ 1.
- Writes to `layout.root/ui.json` via the `uiFile` layout field.
- Return the flattened nodes so the caller can report `nodes: N`.

- [x] **Step 6: Wire**

- `SceneLayout` gains `uiFile: join(root, 'ui.json')`.
- `deps.ts` `openOfflineScene` reads `readUiTree(layout.uiFile)` and exposes it; `query` passes `uiTree` into `QueryContext`.
- Exports + `VALUE_EXPORTS`: `UitestCollector`, `DEVICE_UI_PATH`, `flattenUiTree`, `readUiTree`.

- [x] **Step 7: Run to verify it passes**

Run: `npx vitest run packages/core/test/query-ui.test.ts packages/core/test/query-registry.test.ts packages/core/test/collector-uitest.test.ts packages/core/test/types.test.ts`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/core/src/collectors/uitest.ts packages/core/src/query/ui.ts packages/core/src/query/registry.ts packages/core/src/ingest/scene.ts packages/cli/src/deps.ts packages/core/src/index.ts packages/core/test/query-ui.test.ts packages/core/test/query-registry.test.ts packages/core/test/collector-uitest.test.ts packages/core/test/types.test.ts
git commit -m "feat(core): capture the UI tree and expose it as ui.get"
```

---

### Task 6: Baseline comparison

**Files:**
- Create: `packages/core/src/report/compare.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test/types.test.ts`
- Modify: `packages/cli/src/commands.ts` (`runCompare`), `packages/cli/src/deps.ts`, `packages/cli/src/program.ts`
- Test: `packages/core/test/compare.test.ts`, `packages/cli/test/compare-cli.test.ts`

**Interfaces:**
- Consumes: `AnalyzeResult`, `Metric`, `MetricUnit`, `Fidelity`.
- Produces:

```ts
export type MetricDirection = 'lower' | 'higher';
/** Known metric directions. An id absent here has no better/worse. */
export const METRIC_DIRECTIONS: Readonly<Record<string, MetricDirection>>;

export type DeltaStatus =
  | 'improved' | 'regressed' | 'unchanged' | 'added' | 'removed' | 'incomparable';

export interface MetricDelta {
  readonly id: string;
  readonly unit: MetricUnit;
  readonly baseline: number | string | null;
  readonly current: number | string | null;
  /** Numeric difference (current - baseline); absent for non-numeric or added/removed. */
  readonly delta?: number;
  /** Percent change; absent when baseline is 0 or either side is non-numeric. */
  readonly deltaPct?: number;
  readonly fidelity: Fidelity;
  readonly status: DeltaStatus;
}

export interface BaselineComparison {
  readonly rows: MetricDelta[];
  /** Count of rows per status; all six keys are always present. */
  readonly totals: Record<DeltaStatus, number>;
}

export function compareResults(
  baseline: AnalyzeResult,
  current: AnalyzeResult,
): BaselineComparison;
```

- [x] **Step 1: Write the failing test**

Create `packages/core/test/compare.test.ts`:

```ts
const metricOf = (id: string, value: number | string, fidelity: Fidelity = 'exact'): Metric =>
  ({ id, value, unit: 'count', fidelity, provenance: { collector: 'test', device: 'd' } });

it('marks a lower-is-better metric that fell as improved', () => {
  const c = compareResults(
    { metrics: [metricOf('frame.jank.rate', 40)], evidence: [] },
    { metrics: [metricOf('frame.jank.rate', 30)], evidence: [] },
  );
  expect(c.rows).toEqual([{
    id: 'frame.jank.rate', unit: 'count', baseline: 40, current: 30,
    delta: -10, deltaPct: -25, fidelity: 'exact', status: 'improved',
  }]);
  expect(c.totals.improved).toBe(1);
});

it('marks a higher-is-better metric that rose as improved', () => {
  const c = compareResults(
    { metrics: [metricOf('frame.fps', 30)], evidence: [] },
    { metrics: [metricOf('frame.fps', 45)], evidence: [] },
  );
  expect(c.rows[0].status).toBe('improved');
  expect(c.rows[0].deltaPct).toBe(50);
});

it('omits deltaPct when the baseline is zero', () => {
  const c = compareResults(
    { metrics: [metricOf('frame.count', 0)], evidence: [] },
    { metrics: [metricOf('frame.count', 5)], evidence: [] },
  );
  expect(c.rows[0].delta).toBe(5);
  expect(c.rows[0].deltaPct).toBeUndefined();
});

it('reports added and removed metrics without a delta', () => {
  const c = compareResults(
    { metrics: [metricOf('frame.count', 5)], evidence: [] },
    { metrics: [metricOf('mem.rss.max', 100)], evidence: [] },
  );
  expect(c.rows.map((r) => [r.id, r.status])).toEqual([
    ['frame.count', 'removed'], ['mem.rss.max', 'added'],
  ]);
  expect(c.rows.every((r) => r.delta === undefined)).toBe(true);
});

it('refuses to invent a direction for an unknown metric', () => {
  const c = compareResults(
    { metrics: [metricOf('custom.thing', 1)], evidence: [] },
    { metrics: [metricOf('custom.thing', 2)], evidence: [] },
  );
  expect(c.rows[0].status).toBe('incomparable');
  expect(c.rows[0].delta).toBe(1);
});

it('treats a string metric as incomparable but reports both values', () => {
  const c = compareResults(
    { metrics: [metricOf('startup.mode', 'cold')], evidence: [] },
    { metrics: [metricOf('startup.mode', 'warm')], evidence: [] },
  );
  expect(c.rows[0]).toMatchObject({ baseline: 'cold', current: 'warm', status: 'incomparable' });
  expect(c.rows[0].delta).toBeUndefined();
});

it('is byte-identical across runs and sorted by id', () => {
  const a = compareResults(
    { metrics: [metricOf('b', 1), metricOf('a', 2)], evidence: [] },
    { metrics: [metricOf('b', 3), metricOf('a', 1)], evidence: [] },
  );
  expect(a.rows.map((r) => r.id)).toEqual(['a', 'b']);
  expect(JSON.stringify(a)).toBe(JSON.stringify(compareResults(
    { metrics: [metricOf('b', 1), metricOf('a', 2)], evidence: [] },
    { metrics: [metricOf('b', 3), metricOf('a', 1)], evidence: [] },
  )));
});
```

Create `packages/cli/test/compare-cli.test.ts`:

```ts
it('renders one line per metric with the status', async () => {
  const r = await runCompare(depsWith(comparison), { baseline: 'a.json', current: 'b.json' }, {});
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe(
    'frame.jank.rate  40 -> 30  (-25%)  improved\n',
  );
});

it('renders JSON identical to the API structure', async () => {
  const r = await runCompare(depsWith(comparison), { baseline: 'a.json', current: 'b.json' }, { json: true });
  expect(JSON.parse(r.stdout)).toEqual(comparison);
});

it('fails with one stderr line and empty stdout when an input is unreadable', async () => {
  const r = await runCompare(depsFailing(), { baseline: 'a.json', current: 'b.json' }, {});
  expect(r).toEqual({ stdout: '', stderr: expect.stringMatching(/^.+$/), exitCode: 1 });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/compare.test.ts packages/cli/test/compare-cli.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement `compareResults`**

Rules:
- Rows are the union of both metric id sets, sorted by id (`<`/`>` comparison, no locale).
- `METRIC_DIRECTIONS` covers the ids the analyzers emit: `frame.*` → lower is better except `frame.fps`, `frame.rendered.count`, `frame.count` (higher is better); `binder.*` latency/interval → lower, `binder.transactions.count` → lower, `binder.*.qps` → higher; `thread.*` redundant/patterns → lower, `thread.*.ratio` → lower; `mem.*` → lower; `startup.duration` → lower, `startup.count` → lower. Unknown ids are absent → `incomparable`.
- A metric present on one side only is `added`/`removed`; `delta` and `deltaPct` are omitted.
- Both numeric: `delta = current - baseline`; `deltaPct = baseline === 0 ? undefined : (delta / Math.abs(baseline)) * 100`, rounded to 3 decimals; `status` from direction (`delta === 0` → `unchanged`; direction `lower` and `delta < 0` → `improved`; `higher` and `delta > 0` → `improved`; else `regressed`).
- Any non-numeric side, or an unknown id → `incomparable` with no `deltaPct`.
- `fidelity` is the current side's; for `removed` it is the baseline's.
- `totals` counts every status, all six keys always present.

- [x] **Step 4: Implement the CLI**

`packages/cli/src/commands.ts`:

```ts
export interface CompareRequest { baseline: string; current: string; }
export async function runCompare(deps: CliDeps, req: CompareRequest, opts: { json?: boolean }): Promise<CliResult>;
```

Human line: `` `${id}  ${baseline} -> ${current}${pct}  ${status}\n` `` where `pct` is `  (-25%)` only when `deltaPct` is defined. `--json` prints the whole `BaselineComparison`. Failures follow the standard contract.

`deps.ts` gains `compare(req)`:
- Resolve each argument: a directory → run the same code path as `analyze` and use its `AnalyzeResult`; a file → `JSON.parse` and validate it has `metrics` and `evidence` arrays (`COMPARE_BAD_INPUT` naming the path when it does not).
- Validation happens before any scene is opened.

`program.ts` gains:

```ts
program.command('compare')
  .description('compare a current analysis against a baseline')
  .argument('<baseline>', 'scene directory or analyze --json file')
  .argument('<current>', 'scene directory or analyze --json file')
  .option('--json', 'print the comparison as JSON')
  .action(async (baseline, current, opts) => { io.emit(await runCompare(deps, { baseline, current }, { json: opts.json })); });
```

- [x] **Step 5: Exports and tests**

`index.ts`: export `compareResults`, `METRIC_DIRECTIONS`; types `MetricDelta`, `BaselineComparison`, `DeltaStatus`, `MetricDirection`. Add the two value names to `VALUE_EXPORTS`.

- [x] **Step 6: Run to verify it passes**

Run: `npx vitest run packages/core/test/compare.test.ts packages/cli/test/compare-cli.test.ts packages/cli/test/program.test.ts packages/core/test/types.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/core/src/report/compare.ts packages/core/src/index.ts packages/cli/src/commands.ts packages/cli/src/deps.ts packages/cli/src/program.ts packages/core/test/compare.test.ts packages/cli/test/compare-cli.test.ts packages/core/test/types.test.ts
git commit -m "feat: compare an analysis against a baseline"
```

---

### Task 7: Orchestrate the new collectors and ship the docs

**Files:**
- Modify: `packages/core/src/device/device.ts` (`CollectOptions`, orchestration, metadata)
- Modify: `packages/core/src/ingest/metadata.ts` (optional `capture.hiperf`)
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/program.ts` (`--hiperf`, `--hidumper`, `--uitest`)
- Modify: `skill/ohos-perf/SKILL.md`, `README.md`, `site/index.html`
- Test: `packages/core/test/device.test.ts`, `packages/cli/test/program.test.ts`, `packages/cli/test/skill.test.ts`

**Interfaces:**
- Consumes: `HiperfCollector`, `HidumperCollector`, `UitestCollector` (Tasks 2, 4, 5).
- Produces: the final `collect` surface.

- [x] **Step 1: Write the failing device test**

In `packages/core/test/device.test.ts`, with fake collectors injected through `DeviceDeps`:

```ts
it('runs hitrace, hiperf, hidumper and uitest concurrently and records what each captured', async () => {
  const started: string[] = [];
  const device = new Device('dev', snapshot(), {
    hdc: fakeHdc,
    streamer: fakeStreamer,
    hiperf: { async collect() { started.push('hiperf'); return { samples: 150, nonSamples: 1, lost: 0, bytes: 9 }; } },
    hidumper: { async collect() { started.push('hidumper'); return capture; } },
    uitest: { async collect() { started.push('uitest'); return nodes; } },
  });
  const session = await device.collect({
    app: 'com.demo', durationMs: 3000, sceneRoot: root,
    hiperf: {}, hidumper: true, uitest: true,
  });
  await session.ingest();
  expect(started.sort()).toEqual(['hidumper', 'hiperf', 'uitest']);
  const meta = readSceneMetadata(createSceneLayout(root));
  expect(meta?.capture?.collectors).toEqual(['hitrace', 'hiperf', 'hidumper', 'uitest']);
  expect(meta?.capture?.hiperf).toEqual({ samples: 150 });
});

it('rejects a hiperf request without an app before any device call', async () => {
  await expect(device.collect({ app: '', durationMs: 1000, sceneRoot: root, hiperf: {} }))
    .rejects.toMatchObject({ code: 'COLLECT_APP_REQUIRED' });
});

it('restores the previous scene when a collector fails', async () => {
  // Previous perf.data + ui.json + hidumper.json exist; hiperf throws. All
  // three must be byte-identical afterwards.
});
```

Also in `packages/cli/test/program.test.ts`: `collect --hiperf` without `--app` → exit 1; `--hidumper` and `--uitest` are accepted and forwarded; help mentions `compare`.

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/device.test.ts packages/cli/test/program.test.ts`
Expected: FAIL — `hiperf`/`hidumper`/`uitest` are not `CollectOptions` fields and `DeviceDeps` has no such slots.

- [x] **Step 3: Extend `CollectOptions` and `DeviceDeps`**

```ts
export interface CollectOptions extends TraceCollectOptions {
  sceneRoot: string;
  procfs?: boolean | { intervalMs?: number };
  coldStart?: { ability: string };
  hiprofiler?: HiprofilerCollectRequest;
  /** Also record a hiperf perf.data for `app` (requires a debuggable app). */
  hiperf?: { frequency?: number; events?: readonly string[]; callStacks?: boolean };
  /** Also sample RenderService fpsCount/hitchs for `durationMs`. */
  hidumper?: boolean;
  /** Also dump the UI tree. */
  uitest?: boolean;
}
```

`DeviceDeps` gains `hiperf?: HiperfCollector`, `hidumper?: HidumperCollector`, `uitest?: UitestCollector` (typed structurally: `{ collect(...): Promise<unknown> }` is enough for the fakes, so type the slots as the minimal method shape).

- [x] **Step 4: Implement the orchestration**

- Validation before any device call: `hiperf`/`hidumper`/`uitest` all require `app` when they need a pid — only `hiperf` does; `hidumper` and `uitest` do not (they dump the whole screen). `hiperf` reuses the existing `COLLECT_APP_REQUIRED` and `COLLECT_BAD_APP` gates. `uitest` requires `ui.tree` in the matrix and `hidumper` requires `render.fps_live`; a missing capability throws `MISSING_CAPABILITY` naming the id and reason, before capture.
- **Gate `hiperf` on `perf.samples` only, never on `perf.pmu`.** `perf.pmu` is false wherever the hardware has no PMU (the emulator) while `perf.samples` is true on any device whose `hiperf` binary exists. When `perf.pmu` is false the collector defaults `events` to a software event (`sw-task-clock`); an explicitly requested hardware event on a PMU-less device is rejected with `HIPERF_BAD_EVENT` naming the software events the probe found, rather than recording nothing and reporting a quiet app.
- Run every requested collector in one `Promise.all` with the trace capture. Order the array so a failure message names the trace first: `[runTrace(), procfs?, hiperf?, hidumper?, uitest?]`.
- `hidumper` needs no separate duration; pass `durationMs`.
- `hidumper` samples cumulative counters, so its two snapshots must straddle the *same* window the trace covers. Take the first snapshot **after** the trace begins and the second **after** the trace finishes, inside the same `Promise.all` turn that resolves the trace capture — a snapshot pair outside the capture window would attribute frames to a period the trace never saw.
- On any rejection, restore every artifact the previous scene held (`procfs.jsonl`, `perf.data`, `perf.db`, `hidumper.json`, `ui.json`) byte-for-byte, mirroring `restorePreviousProcfs`. Factor that into one `restoreArtifacts(layout, previous)` helper taking a `Map<string, Buffer|undefined>`.
- Convert `perf.data` before writing metadata: extend the existing try/catch around `streamer.convert` so a perf conversion failure restores artifacts and does not write `scene.json`.
- Metadata: `capture.collectors` lists them in fixed order `['hitrace'|'hiprofiler', ...(procfs), ...(hiperf), ...(hidumper), ...(uitest)]`; `capture.hiperf = { samples }` when a hiperf capture ran. `SceneMetadata.capture.hiperf` is optional and validated (`samples` a finite number ≥ 0) by `readSceneMetadata`; a malformed value drops the whole descriptor, consistent with the existing rules.
- Remove a stale `perf.data`/`perf.db`/`hidumper.json`/`ui.json` on the success path when that collector did not run, exactly like `removeStaleProcfs`.

- [x] **Step 5: Extend the CLI**

`CollectRequest` gains `hiperf?: { frequency?: number }`, `hidumper?: boolean`, `uitest?: boolean`. `program.ts` gains `--hiperf`, `--hidumper`, `--uitest` flags; `--hiperf` without `--app` is rejected in the action with the standard contract (empty stdout, one line, exit 1). `runCollect`'s human output gains the capture summary:

```
scene  <dir>
collectors  hitrace, hiperf, hidumper, uitest
samples  hiperf 150, ui 76
```

Only the lines for collectors that ran are printed; `hiperf 0` is printed explicitly (Review Focus 1). `--json` returns `{ sceneDir, device, collectors, hiperf?: { samples }, ui?: { nodes } }`.

- [x] **Step 6: Update the skill and the docs**

`skill/ohos-perf/SKILL.md`:
- Add the four collectors to the workflow's collect step (`--procfs`, `--hiprofiler`, `--hiperf`, `--hidumper`, `--uitest`).
- Add `ohos-perf compare <baseline> <current> --json` under a new "Comparing against a baseline" heading, with the rule that `incomparable` means the direction is unknown, not that nothing changed.
- Add `ui.get` to the drill-down section as an example of a query that reads a scene artifact rather than the trace database.
- Keep every command name within `doctor|caps|collect|analyze|query|tools|compare` and update `COMMANDS` in `packages/cli/test/skill.test.ts` accordingly.

`README.md`: move `hiperf`, `hidumper`, `uitest` and baseline comparison out of "Not implemented yet" (leaving `ui.gesture`, `coverage`, `js.heap` as the remaining gaps); add the new CLI flags and `compare`; update the status counts.

`site/index.html`: update the agent card, the collector list and the stats in both languages, keeping the `data-en`/`data-zh` counts balanced.

- [x] **Step 7: Run the whole suite and both typechecks**

Run: `npm test && npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: PASS. Update the README/site counts to the new total.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: orchestrate the hiperf, hidumper and uitest collectors

Collect runs every requested collector concurrently, records what each
captured in scene.json (including a zero-sample hiperf capture), restores
the previous scene's artifacts when any collector fails, and removes stale
artifacts for collectors that did not run. The CLI gains --hiperf,
--hidumper, --uitest and a capture summary, and the skill and site document
the new surface."
```

---

## Execution notes

- Tasks 2, 4 and 5 each add a fixed device path under `/data/local/tmp/`; the collector removes it before recording, exactly like `hitrace.ts` and `hiprofiler/index.ts`.
- `hidumper` and `uitest` need no app argument, so their capture is device-wide. The UI tree therefore contains `com.ohos.sceneboard` and other processes; `ui.get --bundleName` is how a caller narrows it, and the analyzer never assumes the app's nodes are at the root.
- The device has **one** debuggable app that launches (`com.example.image`); `com.example.example`, `com.example.reload` and `com.lfr.uitest` are refused with `Error Code:10106105`. Device-level tests must use the app that works and skip when no device is attached, following `collect-hiprofiler.device.test.ts`.
- `hiperf` on an idle app yields 0 samples with exit 0. That is a valid capture and the summary must reach the user; it is never a failure and never a silent zero.
