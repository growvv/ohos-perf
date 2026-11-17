# P18 — Closing the remaining HapRay capability gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Take the 35-row HapRay capability inventory from 21/6/8 to every row either ported or explicitly out with a measured reason, and make that arithmetic reproducible by a test.

**Architecture:** A machine-readable parity ledger (`parity.ts`) becomes the single source of truth for all 35 rows. It is checked by a test against the analyzers that actually exist, so a stale claim fails CI. Each ported capability is a new analyzer or collector following the existing `Analyzer` interface; nothing new is invented at the engine level.

**Tech Stack:** TypeScript (ESM), Vitest, `node:sqlite`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p18-parity-completion-design.md`

## Global Constraints

- No new runtime dependencies. Pure TypeScript, `node:*` built-ins only.
- Deterministic output: byte-identical JSON across runs, no clock, no absolute host path in any document.
- Every public type declared in `src` is exported from `index.ts` (enforced by `types.test.ts`); the built module's value exports must equal `VALUE_EXPORTS`.
- Core resolves from `dist`: `npm run build -w @ohos-perf/core` before tests.
- Every analyzer degrades with a named reason, never a silent zero.

## Review Focus

- A scene captured **without** the input a new analyzer needs (no `redundant_file.txt`, no heapsnapshot, no dependency graph) must emit `no_data` with a reason, not zeros.
- A malformed input file (truncated JSON, wrong shape) must be a typed refusal naming the file, not a crash.
- The parity ledger must fail when a row's declared status disagrees with the code — that is the whole point.

---

### Task 1: The parity ledger

**Files:**
- Create: `packages/core/src/parity.ts`
- Test: `packages/core/test/parity.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `PARITY_ROWS: readonly ParityRow[]`, `paritySummary(): { ported: number; partial: number; out: number; total: number }`, `type ParityStatus = 'ported' | 'partial' | 'out'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { PARITY_ROWS, paritySummary } from '../src/parity';

describe('the parity ledger', () => {
  it('has one row per HapRay capability', () => {
    expect(PARITY_ROWS).toHaveLength(35);
    expect(PARITY_ROWS.map((r) => r.row)).toEqual(
      Array.from({ length: 35 }, (_, i) => i + 1),
    );
  });

  it('gives every row a status and a reason when it is not ported', () => {
    for (const row of PARITY_ROWS) {
      expect(['ported', 'partial', 'out']).toContain(row.status);
      if (row.status !== 'ported') expect(row.reason.length).toBeGreaterThan(20);
    }
  });

  it('counts what it contains', () => {
    const s = paritySummary();
    expect(s.total).toBe(35);
    expect(s.ported + s.partial + s.out).toBe(35);
  });
});
```

- [ ] **Step 2: Run it — expect failure on the missing module**

Run: `npx vitest run --project unit packages/core/test/parity.test.ts`

- [ ] **Step 3: Implement `parity.ts`**

Each row: `{ row, name, status, reason, analyzer? }` where `analyzer` is the analyzer class name when ported. Fill from the gap analysis, applying every move P9–P18 claims. Rows 5, 27, 28 and 4 are `out` with their measured reasons.

- [ ] **Step 4: Add a test that the ledger matches the code**

```ts
it('names an analyzer that the engine actually registers, for every ported row', () => {
  const registered = new Set(defaultAnalyzers().map((a) => a.constructor.name));
  for (const row of PARITY_ROWS) {
    if (row.status === 'ported' && row.analyzer !== undefined) {
      expect(registered.has(row.analyzer)).toBe(true);
    }
  }
});
```

- [ ] **Step 5: Run, commit**

### Task 2: Row 15 — fault tree `ipc_binder` section

**Files:**
- Modify: `packages/core/src/analyze/fault-tree.ts`
- Test: `packages/core/test/analyze-fault-tree.test.ts`

**Interfaces:**
- Consumes: `BinderAnalysis` from `analyze/binder.ts`.
- Produces: `fault.ipc_binder.transactions.count`, `fault.ipc_binder.latency.avg`, `fault.ipc_binder.latency.max`, plus an `ipc_binder` object on the payload.

- [ ] **Step 1: Failing test** — a fixture with two completed binder transactions asserts the three `fault.ipc_binder.*` metrics and that the payload carries `{ transactions, avgLatencyMs, maxLatencyMs }`.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — `computeFaultTree` gains an optional `binder?: BinderAnalysis`; when present, add the section. Absent → no section and no metrics (a fault tree over a trace with no binder events must not claim zero).
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.**

### Task 3: Row 21 — cold-start redundant-file I/O

**Files:**
- Create: `packages/core/src/analyze/redundant-file.ts`
- Test: `packages/core/test/analyze-redundant-file.test.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/analyze/types.ts`, `packages/core/src/ingest/scene.ts`

**Interfaces:**
- Produces: `parseRedundantFile(text): RedundantFileReport`, `RedundantFileAnalyzer`.
- Metrics: `redundant_file.reads.count`, `redundant_file.files.used`, `redundant_file.files.unused`.

- [ ] **Step 1: Failing test** for the parser (a documented line format: one path per line, `USED`/`UNUSED` marker) and for the analyzer's `no_data` branch when the scene carries no file.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** parser + analyzer; add `redundantFile?: string` to `AnalyzeContext`; read `redundant_file.txt` in scene ingest when present.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.**

### Task 4: Row 20 — JS heap snapshot capture

**Files:**
- Create: `packages/core/src/collectors/jsheap.ts`
- Test: `packages/core/test/collector-jsheap.test.ts`
- Modify: `packages/core/src/device/device.ts`, `packages/core/src/device/capability.ts`, `packages/core/src/ingest/scene.ts`

**Interfaces:**
- Produces: `JsheapCollector.collect(hdc, target, opts, layout): Promise<JsheapCapture>`.

- [ ] **Step 1: Failing test** — with an injected hdc, `collect` runs `hidumper --mem-jsheap <pid> -T <pid>`, polls the leak directory, pulls the newest `.heapsnapshot` into `layout.jsheapFile`, and returns `{ path, bytes }`. A device where the command fails is a typed refusal naming the command.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.**

### Task 5: Row 29 — HapFlow dependency graph

**Files:**
- Create: `packages/core/src/hap/depgraph.ts`
- Test: `packages/core/test/hap-depgraph.test.ts`

**Interfaces:**
- Produces: `buildDepGraph(files: readonly string[], modules: readonly ModuleDecl[]): DepGraph`, `DepGraph { files, edges, harEdges, timingCycles }`.

- [ ] **Step 1: Failing test** — file→HAR ownership by path segment and basename, an edge per import, cross-HAR edge counts, and a `timing_cycles` value.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.**

### Task 6: Finish the closeable partial rows

**Files:**
- Modify: `packages/core/src/analyze/frames.ts` (row 8), `empty-frame.ts` (row 10), `rs-skip.ts` (row 12)

- [ ] **Step 1: Failing tests** for the named missing metrics: stutter levels 1–3 with expected/actual excess (8), empty-frame load share and severity ladder (10), `rs_skip.cpu_waste` and detection breakdown (12).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.**

### Task 7: Docs, site, roadmap, release

- [ ] **Step 1:** Update the README parity section from the ledger (`paritySummary()`), replacing the stale 18/9/8 with the ledger's numbers and the full out-with-reason list.
- [ ] **Step 2:** Update `site/index.html` roadmap card and counts; both `data-en`/`data-zh` **and** visible text.
- [ ] **Step 3:** CHANGELOG 0.13.0; bump both packages and the root; refresh the lockfile.
- [ ] **Step 4:** Full suite, both typechecks, both builds.
- [ ] **Step 5:** Tag `v0.13.0`, push, `gh release create`, publish both with the token, install the published pair into an empty directory and run it.
