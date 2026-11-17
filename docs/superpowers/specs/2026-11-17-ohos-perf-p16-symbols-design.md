# P16 — Symbol intelligence (HapRay parity W8)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.11.0`
**Builds on:** P15 static HAP inspection (`0.10.0`); HapRay `9386e4e`
**Gap-analysis rows:** 22 (flamegraph generation), 23 (symbol statistics),
28 (symbol recovery — the lightweight alternative only)

## Why this phase

P10 and P11 already read symbols: `frame.load.*` attributes sampled-event
weight to a leaf symbol, `flamegraph.*` folds stacks into `a;b;c N`, and
native-memory callchains carry a symbol per frame. All of it resolves frames
through `perf_files`, and all of it was written against synthetic fixtures.

A real `perf.db` from a HarmonyOS capture shows that resolution is wrong in a
way no fixture revealed. Measured on `_tmp_perf_node_sync/perf.db`
(26,013 samples, 484,630 callchain frames, 215 files, 9,681 `perf_files`
rows, 10.55 G summed `event_count`):

- `perf_callchain.name` is **not** a symbol. It is a `data_dict` id. Every one
  of the 484,630 frames resolves through `data_dict` (`name = 488` →
  `"start"`); none holds a name.
- 46,863 frames carry `symbol_id = -1`: the recorder found no symbol there.
  The other 437,767 resolve **exactly** through `(file_id, serial_id)` — a
  100% hit rate, with no null symbols.
- `query/perf.ts` falls back to *the first `perf_files` row of the file* when
  the exact pair misses. That fallback invents symbols: on this capture 1,972
  leaf frames (753 M weight, **7.14%** of all samples) get the name of
  whichever symbol happens to be first in their file. `dlopen` is reported
  with 6.33 M weight where its genuine weight is 0.16 M; `dladdr` is the top
  hotspot at 495 M and that one is real, which is exactly why the defect is
  invisible without checking.
- Unresolved leaves (2,295 frames, 994 M, **9.43%**) emit the raw `name`
  column — a numeric id like `14538` — as the symbol. `data_dict` holds the
  honest answer for those: `libjdimage.so+0x1cce24`.

So this phase has two jobs: fix the resolution so the numbers P10/P11/P6
already report are true, and finish the W8 deliverables (symbol statistics, an
offline flamegraph artifact, `--so-dir`, unresolved-symbol evidence).

## Scope

**In scope**

- **Correct symbol resolution** (`src/query/perf.ts`). A frame's symbol comes
  from, in order: the exact `perf_files (file_id, serial_id)` row; the
  `data_dict` text for `perf_callchain.name` when the exact row is missing or
  its symbol is empty; the raw name only when neither exists. The file-only
  **symbol** fallback is deleted — it is the defect. The file-only **path**
  lookup stays: a path is a property of the file, and a real capture has
  exactly one path per `file_id`, so resolving it from `file_id` alone invents
  nothing. `symbol_id = -1` frames therefore still report their file and are
  reported as unresolved, never given a neighbour's symbol name.
- **`PerfQuery.symbolStats(threadIds, range)`** — summed `event_count` per
  `(symbol, filePath)`, the typed table HapRay's `symbol_statistics.xlsx`
  carries, plus `PerfQuery.unresolvedSymbols(threadIds, range)` returning the
  unresolved leaves by `(name, filePath, samples)` so an agent can see what
  the recorder could not name.
- **A `symbols` analyzer** (`src/analyze/symbols.ts`, id `symbols`). Emits
  `symbol.samples.count`, `symbol.unresolved.count`, `symbol.unresolved.share`,
  `symbol.files.count`, and one `symbol_stats` evidence item per top-N symbol;
  one `unresolved_symbol` item per unresolved leaf group. Degrades with a
  reason when there are no samples, like `flamegraph`.
- **An offline flamegraph artifact.** `src/report/flamegraph-svg.ts` renders
  folded stacks to a self-contained SVG (no script, no CDN, no d3), and
  `src/report/flamegraph-html.ts` wraps it in the existing page style with the
  symbol-source and unresolved counts stated in the page. `ohos-perf report`
  gains `flamegraph.svg` and `flamegraph.html` when the scene has samples.
- **`--so-dir` on `ohos-perf collect --hiperf`.** The path is passed to
  `trace_streamer` as `--So_dir`, which the 4.3.7 binary accepts (verified: it
  is in the binary's option table and a conversion with it succeeds). The
  directory must exist on the **host**; it is validated before the device is
  touched. `scene.json` records whether symbolization was requested, so a
  reader can tell why symbols are missing.
- **A `symbol.stats` query** so the statistics table is queryable, not only an
  artifact: rows `{symbol, filePath, samples, share}`.
- **Documentation and a release**: README, site, skill, CHANGELOG, notices.

**Out of scope, deliberately**

- **radare2 / capstone / LLM symbol recovery.** Heavy native tooling,
  nondeterministic naming, no DWARF/dSYM path, no measured accuracy. The
  lightweight alternative in the do-not-port list is what this phase builds.
- **`arkanalyzer`, `sql.js`, `demangle-wasm`.** A 100 KB WASM demangler and a
  SQLite WASM build to do what `node:sqlite` already does. HapRay demangles
  with `__cxa_demangle`; the symbols in a real capture are already demangled
  (`base::Thread::ThreadMain()`), so there is nothing to recover and no
  fidelity to gain.
- **`hiperf_report.html` parity.** HapRay embeds a pako+d3 bundle and a
  `perf.json` it does not compute. Our SVG is derived from typed folded
  stacks and opens with no network.
- **HapRay's `--symbol-statistic` pattern-file mode.** It matches callstack
  event *names* (trace events, not perf symbols) against wildcard patterns,
  then sums `perf_sample.event_count` inside those time ranges — a different
  question from per-symbol weight, and only reachable through HapRay's
  update/SIMPLE path. The query layer can already answer it with
  `callstack.matching` plus a range; a dedicated mode would add a second
  definition of "symbol" to the package.

## Semantics

### Symbol resolution

`perf_callchain` has two independent naming channels and the schema does not
say which wins:

| Channel | Column | Real-capture evidence |
| --- | --- | --- |
| `perf_files` lookup | `file_id` + `symbol_id` → `serial_id` | 437,767/437,767 frames hit exactly; every hit has a non-empty symbol |
| `data_dict` lookup | `name` → `data_dict.data` | 484,630/484,630 frames resolve; text is `file+0xoffset` when unsymbolized |

Both agree wherever both exist: across 200,000 sampled frames the
`data_dict` text and the `perf_files` symbol were identical, 0 differences.
The rule is therefore:

1. Exact `(file_id, serial_id)` row with a non-empty `symbol` → that symbol.
2. Otherwise `data_dict[name]` → that text (which may be `libfoo.so+0x1cce24`,
   an honest "here, unsymbolized").
3. Otherwise the raw `name` column.

The **file path** is a separate lookup: the `perf_files` path for the frame's
`file_id`, from any row of that file, since a capture has one path per
`file_id` (measured: 0 of 215 `file_id`s carry more than one path). A frame
with no `file_id` reports an empty path.

A frame whose `symbol_id` is `-1` skips step 1 by construction and lands on
step 2. A frame is **unresolved** when its resolved symbol still looks like a
`file+0xoffset` reference (matching `/^[^ ]+\+0x[0-9a-f]+$/`) or is empty.
That is the definition the metrics count, so "unresolved" means "the recorder
had no symbol", not "our lookup missed" — a distinction the numbers above make
visible. A path is never part of that test: an unresolved frame still names
the library it ran in, which is what makes the evidence actionable.

The `data_dict` table is optional: a hand-built database may omit it, and a
query that needs it must fall back rather than fail.

### Symbol statistics

`symbolStats` returns one row per `(symbol, filePath)` pair with summed
`event_count`, sorted by `(-samples, symbol, filePath)`. Rows are the same
population `leafAttribution` uses — leaf frames only — so the two agree, and
the sum of the rows plus the unresolved weight equals `eventCount`. That
identity is the test.

### The flamegraph artifact

Folded stacks (`a;b;c N`) are laid out as a classic flame graph: each stack is
a path from a root, and a frame's width is the summed weight of every stack
passing through it. Depth is frame position; no time axis. The SVG carries:

- A `<title>` per rectangle with the frame, its weight and its share, so a
  hover reads the same numbers the JSON does.
- Widths rounded to 2 decimals of a percent of the total; a frame too narrow
  to see (under 0.01%) is still emitted, so the SVG's rectangles sum to the
  total rather than silently dropping the tail.
- The palette derived from depth, not from a hash of the name, so identical
  inputs give identical bytes.
- No `<script>`, no external reference. Text is escaped with the existing
  `escapeHtml`, and long symbol names are truncated in the label but complete
  in the `<title>`.

### `--so-dir`

`trace_streamer FILE -e OUT --So_dir DIR` is the conversion HapRay runs. The
4.3.7 binary lists `--So_dir` among its options and a conversion with it
succeeds (measured). The path is a **host** path: trace_streamer runs on the
host and reads the `.so` files there while converting `perf.data`. Validation:

- The directory must exist and be a directory → otherwise
  `COLLECT_BAD_SO_DIR`, before any device call.
- `scene.json` records `capture.hiperf.symbolized: true` when it was passed,
  so a later reader can distinguish "no symbols in the trace" from "we never
  asked for symbols". `isCapture` in `src/ingest/metadata.ts` currently accepts
  only `hiperf.samples` through `isCountRecord`, so it gains a
  `symbolized?: boolean` clause; without it `writeSceneMetadata` could emit a
  document `readSceneMetadata` refuses.

Passing `--so-dir` to a capture that did not request `--hiperf` is an error,
not a silently ignored flag.

### Metrics and evidence

`symbols` section, all `exact`, provenance `collector: 'hiperf'`,
`table: 'perf_callchain'`:

| Metric | Meaning |
| --- | --- |
| `symbol.samples.count` | summed leaf weight that resolved to a symbol |
| `symbol.unresolved.count` | summed leaf weight still `file+0xoffset` |
| `symbol.unresolved.share` | unresolved weight over all leaf weight, % |
| `symbol.files.count` | distinct `filePath` values among resolved leaves |
| `symbol.top.symbol` | the heaviest symbol |
| `symbol.top.samples` | its weight |

Evidence:

- `symbol_stats` per top-10 symbol: `signals` `{symbol, file, samples,
  share}`; explain names the file and the weight.
- `unresolved_symbol` per top-10 unresolved leaf: `signals` `{name, file,
  samples}`; explain says the recorder had no symbol for that address and
  names the fix (`--so-dir` on the next capture).

Both carry `drillDown: [{ tool: 'symbol.stats', ... }]`, and the unresolved
item additionally points at the existing `frame.load.symbols`.

## CLI

No new command. Changes to existing ones:

- `collect --hiperf --so-dir <dir>` — validates the directory, passes
  `--So_dir`, records it in `scene.json`.
- `report --out <dir>` — also writes `flamegraph.svg` and `flamegraph.html`
  when the scene has perf samples; the manifest lists them.
- `query <scene> symbol.stats --args '{"startNs":0,"endNs":…}'` — the new
  named query.
- `tools` lists `symbol.stats` with its arguments.

## Capability handling

No new capability id. Symbol work is derived from `perf.samples`, which
already gates every analyzer that reads it. `--so-dir` improves what that
capability yields; it does not change whether it is available.

## Testing

- **Resolution**: exact hit wins; a miss falls back to `data_dict`; a
  `symbol_id = -1` frame never inherits a neighbour's name (the regression
  test for the measured defect, written from the real capture's shape); a
  missing `data_dict` table falls back to the raw name; an empty `symbol`
  string falls through to `data_dict`; the path still resolves from
  `file_id` alone for an unresolved frame.
- **Statistics**: rows sum with unresolved weight to `eventCount`; sorted
  deterministically; empty thread list and missing tables yield `[]`.
- **Analyzer**: metrics and evidence on a fixture; degraded proxy without
  samples; the unresolved share arithmetic.
- **SVG**: a two-stack fixture renders rectangles summing to the total; no
  `<script>`; escaped names; byte-identical reruns; a single-frame stack.
- **`--so-dir`**: argv includes `--So_dir`; a missing directory is refused
  before the device is touched; the flag without `--hiperf` is refused;
  `scene.json` records the flag.
- **Query**: `symbol.stats` argument validation, ordering, and that it agrees
  with `frame.load.symbols`.

## Exit criteria

1. On a fixture shaped like the real capture, no unresolved leaf is given a
   neighbour's symbol; the fabricated-weight metric is 0 where the fixture has
   no fabrication, and each unresolved frame still reports its library path.
2. Symbol-statistics rows plus unresolved weight equal the window's sample
   weight exactly.
3. `report` on a scene with samples writes `flamegraph.svg` with no
   `<script>`, and two runs are byte-identical.
4. `collect --hiperf --so-dir` passes `--So_dir` to trace_streamer and records
   it in `scene.json`; a nonexistent directory exits 1 before any device call.
5. A capture without symbols reports a non-zero `symbol.unresolved.share` and
   an `unresolved_symbol` evidence item naming the fix.
