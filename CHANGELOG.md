# Changelog

## 0.30.1 — 2026-11-18

**The snapshot reader now actually beats `JSON.parse`, and the numbers say so.**
0.30.0's reader materialized both number arrays into a `Float64Array` and then
aggregated. That is 8 bytes a slot — the same order as what `JSON.parse`
allocates for them — so measured against a fair baseline it was *worse* than
the parse it exists to replace (29.6 MB against 19.6 MB on a 9.4 MB snapshot),
and the 14.3 MB figure in the 0.30.0 notes was not reproducible.

- **`nodes` and `edges` are streamed, never materialized.** A counting pass
  validates each array's length against the header before any aggregate is
  built, then a cursor feeds the aggregate pass slot by slot. Nothing per node
  or per edge is retained.
- **Measured, peak RSS above a baseline taken after the text is read**: 12.3 MB
  against 19.6 MB on a 9.4 MB snapshot, 30.1 MB against 106.5 MB on a 50 MB one.
  The gap widens with size, which is where a real app's heap lives.
- **The comparative test measures fairly.** Both child processes import the
  module before taking a baseline; charging the 769 KB bundle to the scan alone
  was enough to reverse the comparison on a small fixture.

## 0.30.0 — 2026-11-18

**The captured JS heap is analyzed, not just saved.** HapRay's row 20 asks the
device for a `.heapsnapshot`, pulls it, and stops — on both sides of the
inventory a heap is a file a person opens in DevEco Studio, and no report
mentions it exists. `analyze` now reads it.

- **A snapshot reader that does not parse the whole document.** A `.heapsnapshot`
  is a small header, two flat number arrays and a string table. The header is
  parsed from its own bounded slice; `nodes` and `edges` are streamed slot by
  slot and never materialized, so only the aggregates and the string table are
  retained. Measured peak RSS above a baseline taken after the text is read: a
  9.4 MB snapshot peaks at 12.3 MB against 19.6 MB for `JSON.parse`, and a 50 MB
  one at 30.1 MB against 106.5 MB — the gap widens with size, which is where a
  real app's heap lives. Holding the two arrays instead measured *worse* than
  the parse (29.6 MB against 19.6 MB), which is why they are streamed.
- **The layout comes from the file, never from an offset.** V8's field list has
  changed (`detachedness` was added), so every field is located through
  `snapshot.meta.node_fields` / `edge_fields`. A missing field this reader needs
  is a refusal naming it; a missing `detachedness` is not, and the detached
  metric is then simply absent rather than counting every node as attached.
- **`to_node` is a node-slot offset**, `index * node_field_count`, not an index.
  Reading it as an index mis-attributes every edge; a value past the end of
  `nodes` is a typed refusal naming the edge and the value.
- **Truncation is a refusal, not a partial heap.** Both array lengths are
  checked against the header's counts before anything is read, so a dump killed
  mid-write cannot be reported as a complete heap.
- **Four `exact` metrics and one evidence item.** `jsheap.total.bytes`,
  `jsheap.nodes.count`, `jsheap.detached.count`, `jsheap.objects.count`, plus
  the largest constructor by self size — with the detached count raising its
  severity, because a detached node is the shape of a leak and no other capture
  in this package can show one. The evidence names `selfSize`, not retained
  size: a dominator pass is a separate algorithm and no label here claims it.
- **A scene without a snapshot gets a `no_data` naming `--jsheap`.** `js.heap`
  stays unavailable in the device matrix for a reason that is now measured, not
  inferred: on the Mate 60, with a debug-signed app running,
  `hidumper --mem-jsheap <pid>` exits 0 and writes no file anywhere under the
  app's data directory.
- **The collector was asking for the wrong thing.** `hidumper -h` documents
  `--mem-jsheap pid [-T tid]` — `-T` is a *thread* id, and the collector passed
  the pid. It now dumps the whole process heap.
- **Only a declared capture is read.** A snapshot is a collector artifact, so
  `analyze` reads `jsheap.heapsnapshot` only when `scene.json` lists the
  `jsheap` collector; a file an earlier capture left behind is not reported as
  this scene's heap.

The parser is checked against a snapshot this engine writes, and against a
whole-document `JSON.parse` of the same bytes: same total, same type counts.

## 0.29.0 — 2026-11-18

**Every command is an MCP tool.** An agent with an MCP client should not have
to spawn a process and parse a line. `ohos-perf mcp` serves the CLI over stdio:
one JSON-RPC 2.0 message per line in, at most one out, and the answer is the
envelope P33 defined — as data.

- **The tool list is the CLI.** `tools/list` returns one tool per leaf command,
  named `ohos-perf_<path>` (`ohos-perf_analyze`, `ohos-perf_emulator_list`),
  built from the commander program at startup: each tool's `inputSchema` is
  that command's own options, its description is the command's own, and its
  annotations come from what the command reaches. There is no second list to
  drift, and a new command is a new tool with no change here. `--json`,
  `--machine-json`, `--result-file`, `--help` and `--version` are not exposed,
  and neither is `mcp` itself: a tool that spawned a second server reading a
  stdin nobody writes would hang the client.
- **A tool call is a CLI run.** The server spawns `ohos-perf <command>
  --machine-json` and returns what came back, so an MCP answer is byte-identical
  to the shell answer. Nothing re-implements a command or reshapes a payload;
  this module is a transport.
- **A required option is required in the schema.** `collect` cannot run without
  `--duration` and `--out`; the schema used to say nothing was required, so a
  client built the call without them and got a commander usage error on its
  first attempt. Every `requiredOption` is now in `inputSchema.required`.
- **A list is a list.** A variadic positional (`symbols recover <library>
  [addresses...]`) and a repeatable option (`trend --label`, once per report)
  are declared as arrays of strings, and an array passed to a repeatable option
  becomes one flag per item instead of `String(['a','b'])`'s single `"a,b"`.
  Commander exposes no "is this repeatable" flag, so the catalog asks the
  option's own parser whether it returns a list.
- **A value cannot become a flag.** Positionals are separated by `--`, so
  `{"scene-dir": "--result-file=/tmp/x.json"}` is a path, not an option: before
  this, a client-chosen string was consumed as the global `--result-file` and
  wrote a file the client named. A value like `-5` is now a value too.
- **The schema's types are enforced, not just its keys.** `{"procfs": "true"}`
  is `-32602` naming the property and the type; before, the flag was silently
  omitted and `collect` reported a capture missing a collector as a success.
  An object where a string belongs is refused the same way, which also means a
  value that cannot be stringified never reaches argv.
- **Every request with an id is answered.** A throw anywhere in a call path is
  `-32603` under that id; the stdio loop's stderr line is not an answer, and a
  client waiting on an id waits forever.
- **`initialize` negotiates instead of refusing.** A client on `2025-06-18` or
  `2024-11-05` gets `2025-11-25` and continues — the handshake is the only
  thing that changed. `-32022` is kept for a per-request `_meta` version the
  server does not speak.
- **`ping` is answered**, as both revisions require; a liveness probe that got
  `-32601` could make a client drop the connection.
- **`-32600` for a document that parsed but is not a request**, with its id
  echoed. `-32700` is now only for bytes that were not JSON.
- **Tool names are identifiers.** `ui-compare` is `ohos-perf_ui_compare`,
  which is what the docs already said; the hyphen was the only one.
- **The annotations tell the truth.** `report`, `render`, `trend`, `gate`,
  `ui-compare` and `root-cause` write artifacts, so they are no longer
  `readOnlyHint`; `emulator list` reads, so it is no longer `destructiveHint`.
- **The schema is enforced.** `inputSchema` declares
  `additionalProperties: false`, so an undeclared argument is `-32602` naming
  it rather than a silent no-op: a one-letter `basline` would otherwise run a
  comparison with no baseline and report success, and the agent would read a
  measurement it never asked for.
- **A call that cannot start still answers.** A spawn failure is
  `isError: true` with the message, not a dropped request id — a client waiting
  on an id it never hears back about hangs, which is worse than an error.
- **`isError` is the tool, not the news.** A call fails as `isError: true` only
  when the command could not run — no envelope on stdout, or an envelope with
  `error`. A failed `gate` is `isError: false` with
  `structuredContent.outputs.payload.status === "fail"`: the measurement ran
  and the news is bad, which is what the agent needs to know. Warnings stay a
  second text block beside the result, never inside it.
- **Both protocol eras, deliberately.** The modern revision `2026-07-28`
  removed the `initialize` handshake — every request carries its version in
  `_meta` and `server/discover` is mandatory — and this server answers it.
  `2025-11-25` and earlier open with `initialize`, and it answers those too. A
  client that predates the change should not have to be upgraded to be
  measured. An unknown version is `-32022` with `data.supported` and
  `data.requested`, so the client can retry rather than guess.
- **A bad line does not end the session.** A line that is not JSON-RPC is a
  `-32700` error with a `null` id and the loop continues; a notification is
  answered with silence, as the spec requires; an unknown method is `-32601`
  listing the four the server implements. stdout carries only JSON-RPC, and
  diagnostics go to stderr.
- **No dependency.** Newline-delimited JSON-RPC 2.0 framing is about 150 lines
  of our own code rather than a 7 MB SDK, because this package's promise is no
  native build step and no bundled binary.
- **The skill says how to use it.** `skill/ohos-perf/SKILL.md` gained a section
  on reaching the same commands over MCP, including the `isError` rule, so an
  agent that attaches the server reads a result the same way one that shells
  out does.

HapRay has no MCP surface at all, so this is beyond the inventory rather than a
parity row. 2391 unit tests (2341 + 50 skipped on a clean checkout after `npm install && npm run build`); the device
suite is unchanged.

## 0.28.0 — 2026-11-18

**One envelope for every command.** An agent driving this CLI had to read a
bare JSON document, an exit code and a stderr line, and infer the rest. Now
`--machine-json` prints one versioned tool-result line and `--result-file
<path>` writes the same document, on every command, with no per-command flag.

- **The envelope.** `{schemaVersion, toolId, toolVersion, command, success,
  exitCode, outputs: {payload}, error?}` — built by `buildToolResult` and
  validated by `parseToolResult`, both exported from `@ohos-perf/core`.
  `schemaVersion` is `"1.0"`; the envelope is camelCase to match this
  package's own artifacts rather than HapRay's snake_case.
- **`success` is derived, never accepted.** It is exactly `exitCode === 0`, so
  a caller cannot describe a failed run as a successful one, and a reader never
  has to decide which of the two fields to believe.
- **Bad news is not a broken tool.** A `gate` verdict of fail is exit 2:
  `success: false`, **no** `error`, `outputs.payload.status === 'fail'`. The
  measurement ran. `error` is present only when the command could not run, and
  its `code` is the token stderr prints first — including `CLI_USAGE` for
  commander's own refusals, which is the one failure class that never reaches a
  command.
- **Validated on the way back in.** `parseToolResult` refuses an unknown
  `schemaVersion`, another tool's `toolId`, and a `success` that contradicts
  `exitCode`, naming the value. HapRay's `machine_output.py` only writes, so a
  consumer cannot notice the contract changing under it.
- **No default result file.** HapRay drops `hapray-tool-result.json` into the
  report directory whether or not anyone asked; this CLI writes only where
  `--result-file` says, so a scene directory a reader will diff stays clean.
  Parent directories are created; a genuine write failure is
  `TOOL_RESULT_BAD_PATH` and exit 1, never a success line beside a missing file.
- **Typed codes for two paths that lacked them.** `caps` with no hdc now fails
  as `DOCTOR_HDC_UNAVAILABLE` and `symbols` on an unknown library as
  `SYMBOLS_NO_SUCH_LIBRARY`, so their stderr leads with a token a caller can
  branch on. Both printed lines change accordingly.
- **Every refusal is a typed result.** The validation paths that used to
  return a stderr line alone now carry a code, so `success: false` is never
  indistinguishable from a crash: `TREND_TOO_FEW_REPORTS`, `HAP_BAD_PATH`,
  `OPT_BAD_PATH`, `SCENARIO_BOTH_INPUTS`, `SCENARIO_BAD_ROUNDS`,
  `SCENARIO_BAD_ONLY`, `AGENT_EMPTY_TASK`, `EMULATOR_FLAGS_REQUIRED`,
  `CASES_INDEX_BAD_PATH`, `COLLECT_PLUGINS_WITHOUT_HIPROFILER`,
  `COLLECT_THERMAL_INTERVAL_WITHOUT_THERMAL`, and `UITEST_BAD_GESTURE` for a
  bad coordinate, velocity, key or text. Their stderr lines lead with the code.
- **`agent` keeps its exit code under `--json`.** Only a verified walk is 0;
  an unverified, refused or exhausted run is 1 in both output forms. Before,
  the JSON branch defaulted to 0, so `--machine-json` reported a failed walk as
  a successful tool result.
- **A usage error prints once.** Commander writes its own message; the entry
  point no longer repeats it, and its `(outputHelp)` placeholder no longer
  leaks for the `help` subcommand or a bare group.
- **Help and version stay text.** `--help` and `--version` under
  `--machine-json` print what they always printed: they are a request for
  text, not a result.

The parity ledger is unchanged — 38 ported, 0 partial, 0 missing, 1 out
(`build`): HapRay ships this as a plugin manifest field, not an action, so it
is not one of the 39 rows. 2336 unit tests (2308 + 28 skipped on a clean
checkout); the device suite is unchanged.

## 0.27.0 — 2026-11-18

**A root cause that knows what changed.** `root-cause` explained one run.
After a regression the reader's question is what *changed*, and answering it
needs two runs: `root-cause --baseline <run>` now compares the input against a
baseline — a scene directory, a `report.json` or a report bundle on either side
— and writes the movement into the document, the Markdown and the model turn.

- **The movement.** `buildMovement` (exported from `@ohos-perf/core`) returns
  one row per metric id with `regressed` / `improved` / `unchanged` /
  `incomparable` / `gap`, plus a per-kind count of evidence items on both runs.
  Rows are in a total order — status group, then magnitude, then id — so the
  same two runs produce byte-identical output.
- **A gap is never a movement.** A metric one run did not emit, or emitted as a
  skipped analyzer's degraded zero, is `gap` with a reason and no delta.
  `*.degraded` proxy metrics are counted and excluded from the rows. A jank
  rate that disappeared must not read as "improved from 12% to 0".
- **The caller owns the direction.** `from` is always the baseline and `to` the
  input, whatever the capture times say — unlike `trend`, whose x axis is time.
  A baseline captured later therefore cannot invert the verdicts.
- **The model may cite what moved.** The prompt carries the movement, and a
  suspect's new `metrics` array is checked against the movement's rows exactly
  like `evidenceIds`; an id that did not move is recorded in `ungrounded`. Only
  `regressed`, `improved` and `incomparable` rows are citable — an `unchanged`
  row is the same value on both sides and a `gap` row was never measured on one
  of them, so neither supports "this changed and caused the regression".
- **Fidelity travels with the movement.** Each row carries both sides'
  `fidelity`; when they differ the Markdown table and the prompt print
  `approximate → exact`. A percentage read from a weaker baseline is a weaker
  claim, and `compare` has always said so per row.
- **Refusals and artifacts.** Two runs for different apps are refused naming
  both (`ROOT_CAUSE_BAD_BASELINE`), before any model is asked; `--app` selects
  the process in the input only, so it cannot relabel the baseline's app and
  slip past the refusal. The Markdown gains a **What moved** section before the
  verdict, the terminal summary gains a `movement` line, and
  `root-cause.evidence.json` carries the movement the model was shown.
  `ROOT_CAUSE_SCHEMA_VERSION` is now `2`.

The parity ledger is unchanged — 38 ported, 0 partial, 0 missing, 1 out
(`build`): HapRay's multi-version page leaves the comparison to a human and its
root cause reads one run, so this is a capability the inventory does not
contain. 2294 unit tests; the device suite is unchanged.

## 0.26.0 — 2026-11-18

**A budget that fails a build on a metric nobody measured.** `compare` says
what moved between two runs; a budget says how much movement is allowed, and
the new `gate` command turns that into an exit code a CI job reads. HapRay has
no threshold, verdict or exit code anywhere in its tree at the pinned
revision — its regression story is a chart a person reads.

- **The document.** `gate budgets.json <scene-dir|analyze.json> [--baseline
  <input>] [--out <dir>] [--json]` reads a versioned JSON document with one
  bound per metric id: `max`/`min` absolute limits in the metric's own unit,
  `maxDelta`/`maxDeltaPct` on movement from the baseline (a negative delta
  limit is legal — the metric must fall). It is validated whole before a scene
  is opened: an unknown key, a duplicate metric id, an entry with zero or two
  bounds, and a delta budget with no baseline each name the JSON path — the
  missing-baseline error names the budget ids and the flag to add.
- **Not measured is not a pass.** A metric the run never emitted, a degraded
  proxy, a non-numeric value and a percentage against a zero baseline are all
  `missing` — the gate fails and the verdict says why. A green build can no
  longer mean an analyzer stopped running.
- **Exit codes.** `0` every budget passed, `2` a budget failed or was not
  measurable, `1` the gate could not run. `--json` still exits 2 on a
  violation; `--out` writes `gate.json`.
- **Library.** `parseBudgetDocument`, `deltaBudgetIds`, `evaluateGate` and
  `renderGateJson` are exported from `@ohos-perf/core`, so a test harness can
  gate without a subprocess.

The parity ledger is unchanged — 38 ported, 0 partial, 0 missing, 1 out
(`build`) — because a budget is a capability the inventory does not contain.
2234 unit tests; the device suite is unchanged.

## 0.25.0 — 2026-11-18

**Thermal capture and analysis close the parity ledger's last missing row.**
HapRay samples `hidumper -s ThermalService -a '-t'` in a background thread per
step and returns `None` from its analyzer when a step produced no
`thermal_data.jsonl` — so "never measured" and "the device stayed cool" read
the same. This release samples the same service, keeps the raw evidence, and
names the absence.

- **Capture.** `collect --thermal` writes `thermal.jsonl` for the capture
  window: one record per sample (`{elapsedMs, readings}`), sampled at 0 ms and
  then once per interval. `--thermal-interval <seconds>` overrides the 5 s
  default (0.1–3600, whole milliseconds). A capture shorter than the interval
  gets exactly one sample rather than waiting past its own window, and a dump
  with no sensor readings fails the capture (`THERMAL_NO_OUTPUT`) instead of
  writing an empty artifact that would analyze as a cold device.
- **Readings keep their provenance.** HapRay normalizes by magnitude (≥ 1000
  is millidegrees) and discards the original number. Each reading here carries
  `raw`, the inferred `unit`, and the normalized `celsius` value, so the
  inference is visible. The rule is applied per reading, not per device:
  measured devices report all sensors in millidegrees, and one reports `modem`
  in plain Celsius. The sensor set is whatever the device printed.
- **Analysis.** The `thermal` analyzer emits `thermal.samples.count`,
  `thermal.sensors.count`, `thermal.duration.ms`, `thermal.interval.median.ms`
  (with at least two samples) and `thermal.records.invalid`, plus start, end,
  peak, mean and rise per sensor (`thermal.<sensor>.*.celsius`) with one
  `thermal` evidence item per sensor. A sensor absent from a sample
  contributes no value — never a zero or a carried-forward reading. A scene
  with no capture emits `thermal.degraded` and a `no_data` item naming
  `--thermal`.
- **Scenarios.** A step may list `thermal` in `capture.collectors`, so a run
  gets one thermal curve per step, like HapRay's per-step worker.
- **Output.** The `collect` text summary prints `hilog <n>` and
  `thermal <n>` in its samples line.

Parity row 39 is `ported`: 38 ported, 0 partial, 0 missing, 1 out (37,
`build`). 2180 unit tests; the device suite is unchanged.

## 0.24.0 — 2026-11-18

**`explore --model` lets a model choose the walk, and checks every choice
against the screen it was shown.** HapRay's `haptest` asks a vision model which
numbered element to tap and trusts the answer: an index past the end of its
list clicks element 0, an unparseable answer clicks the first element, and a
failed call clicks the first button. It then spends a second model call per
transition deciding whether the screen counts as a new page, and that opinion
decides whether the step counted.

`ohos-perf explore <app> --model <name>` keeps the decision and makes it
checkable:

- **The offer is the screen.** The prompt carries the rendered tree, the
  clickable elements the dump produced with their indexes and bounds, the last
  eight steps, and only the actions the screen allows. An answer naming an
  index outside the list is a recorded refusal naming both numbers; a non-JSON
  answer, an unknown action or a malformed field is a refusal too. That step
  then falls back to the deterministic order, and `--json` reports every
  refusal with its step and reason — no silent element 0.
- **Page identity is a digest, not an opinion.** `hashPageShape` hashes each
  node's bundle, ability, depth, type and boolean traits; labels and bounds are
  excluded, so a ticking clock or a scroll that moves existing content does not
  read as a new page. Comparing it across a step yields `navigated`, `updated`
  or `no change`, and the screen count, page count and trail are all computed
  from it. There is no second model call to trust.
- **Navigation is measured and bounded.** `explore` scrolls the first
  scrollable node of the target app — up to three times on one screen — and
  goes back once per screen when nothing unvisited is tappable, rebuilding the
  trail from the page each move actually produced. A scroll that changes no
  page is not progress; a screen belonging entirely to another bundle is not
  acted on at all (no tap, no swipe), and the walk backs out or stops with
  `left_app`. The caps apply to model-chosen scroll and back too, so a model
  cannot loop them.
- **Safety.** The model never supplies coordinates: it names an offered
  element and the tap goes to that element's measured bounds. When a model
  steers, irreversible targets (payment, ordering, transfer, sign-in, delete)
  are filtered out of the offer, and the deterministic fallback draws from the
  same filtered set.
- **Output.** `explore` reports `screens`, `pages`, `moved` (navigated,
  updated, no change), `nav` (scrolls, backs), the reason the walk stopped
  (budget, exhausted, model, left app), and the model's used/refused counts
  with each refusal. With `--model` and no endpoint, the CLI refuses before
  touching a device, naming the variable to set.

The endpoint is the same OpenAI-compatible one `agent` and `root-cause` use
(`OHOS_PERF_AGENT_BASE_URL`/`_API_KEY`/`_MODEL`, falling back to `GLM_*`); the
chat client was extracted as `httpChatModel` so all three turns share it.
Without `--model`, `explore` stays offline and deterministic; the walk itself
now scrolls, goes back and stays inside the target app.

Parity row 38 is `ported`: 37 ported, 0 partial, 1 missing (39, thermal), 1 out
(37, `build`). 2133 unit tests; the device suite is unchanged.

## 0.23.0 — 2026-11-18

**`root-cause` turns measured evidence into a report a person reads — and
checks what a model claims about it.** HapRay's `root-cause` reads its own
report JSON, hands the summaries to a model and writes Markdown, so the model
sees a summary of a summary and never the measured numbers. It also cannot run
without an endpoint: `--skip-llm` writes "Pending Agent Inference"
placeholders, which is an empty artifact rather than an offline one.

`ohos-perf root-cause <scene-dir|report.json> --out <dir>` feeds the `Evidence`
items directly and writes three artifacts: `root-cause.json` (schema-versioned),
`root-cause.md`, and `root-cause.evidence.json` (the exact prompt a model would
receive, so the turn can be replayed by hand). A scene directory is analyzed
with the same code `report` uses; a saved `report.json` is read without
re-analysis, so a document about an old run describes what that run measured.

- **The deterministic half is the product.** Observations are ranked by our own
  severities in a total order (severity, then evidence id), so two runs of one
  capture produce identical bytes. The verdict is the highest finding's own
  sentence. `--offline` never consults an endpoint; a host with no endpoint
  configured gets the same report plus a notice on stderr rather than a failure.
- **Gaps are not findings.** A sparse capture produces a wall of
  `degraded_capability` and `no_data` items. A first version opened its verdict
  with "hilog skipped: capability not probed", which says nothing about
  performance. Observations that report a gap in the capture — either of those
  kinds, or any item carrying no measured signal — are now counted separately,
  kept out of the verdict, and named in the totals line. A run where every
  observation is a gap says it measured nothing.
- **Citations are checked.** An `evidenceId` the run did not produce is moved
  to `ungrounded` and never presented as measured; a suspect left with no real
  citation is kept, marked in place in the Markdown, because a footnote is read
  after the fix has been applied.
- **Names are checked.** A suspect naming a file, symbol, thread or library is
  checked against what the evidence actually carried: process and thread names,
  string signal values, and the identifiers the analyzers printed in their own
  explanations. Neither check is semantic, and the limit is stated.

Three defects were found by running the command rather than by reading it:

- The HTTP client rendered every turn with `agentPrompt` and parsed every
  answer with `parseDecision`, so a root-cause turn told the model to answer
  with a gesture and then rejected the JSON it had asked for. The client now
  takes an `AgentTurnShape` — prompt and parser as one value — with `GUI_TURN`
  as the default.
- The grounding check flagged names the analyzers themselves printed
  (`ui.json`, `startedAtNs`, `thread_state`) and ordinary hyphenated prose
  ("Re-run", "app-level"). The vocabulary now includes the analyzers' own
  identifiers, and a hyphen alone no longer makes a token a name.
- The whole-capture window marker rendered as a 285-year span, and the prompt
  read "app unknown on offline".

**The parity ledger is re-pinned from HapRay `9386e4e` to `bd5c98a`** — 428
commits later. Rows 1–35 keep the original inventory's numbers; four rows are
appended: 36 `root-cause` (ported), 37 `build` (out — it wraps `deveco-cli` to
compile a debug HAP, which is a build tool, not a measurement), 38 the LLM
exploration strategy and state comparator (missing; P29), and 39 thermal
analysis (missing; a collector plus an analyzer, and the collector is the part
that must be measured on a device first). 36 ported, 0 partial, 2 missing, 1 out.

2080 unit tests. The device suite is unchanged.

## 0.22.4 — 2026-11-18

**`agent` now warns about the risk before it drives a real device.** A model
chooses every gesture, so a run acts on whatever account is already signed in.
The guard refuses a tap whose *label* is irreversible, but a label is not
intent: an app can word a destructive action in ways the pattern table does not
cover, and a model can reach a screen a person would not have chosen. Every run
prints a three-line warning to stderr naming that, and telling the user to
review the walk and prefer a test account or a disposable build. The warning
also appears in `agent --help`, and it is kept out of stdout so `--json`
stays parseable.

No behaviour change: the exit code, the transcript and the guard are the same.
2015 unit tests.

## 0.22.3 — 2026-11-17

**The irreversible-action guard let a near-miss tap through.** The guard reads
the node a tap lands on and refuses it if the label is a payment, order,
transfer, sign-in, delete or publish action. It used strict containment, so a
tap a few pixels *outside* the button's rect landed on the screen's padding,
found no labelled node, and was performed.

This was found by measuring a real model, not by inspection. Given a checkout
screen whose only control was `Pay now` at `[0,1800][1080,1950]`, one model
answered `click {x:540, y:1965}` — 15 px below the button — on two of six
attempts. A device's hit region normally includes some of that padding, so the
tap would have reached the button.

A tap that misses every irreversible label is now checked against a 24 px
margin. A tap that lands on a *different* clickable control is still performed:
buttons stack with no gap, so a tap 15 px inside `Back` is also 15 px from
`Pay now`, and the landed-on control wins unless it is an ancestor of the
labelled one. 2013 unit tests.

## 0.22.2 — 2026-11-17

Two defects behind the device suite's intermittent failures. Both were found by
reproducing the failure, not by re-running until it passed.

**A device capture that recorded nothing was accepted as a measurement.** A
session that runs its whole `-t` window without recording still writes a valid
`OHOSPROF` container of 1098 bytes — a 1024-byte header, a length word and a
70-byte config echo, with no event section — and still prints `DONE`. The
collector only rejected `size <= 0`, so that file passed, trace_streamer
converted it into an 88-table database whose only non-empty tables were
metadata, and every analyzer reported zero on data it never saw. The capture now
fails with `HIPROFILER_NO_OUTPUT` and says the file holds no events, so a quiet
run says "nothing was recorded" rather than "nothing was slow". The threshold
is 2048 bytes against a measured skeleton of 1098 and a measured two-second
`ftrace` capture of 523 KB.

**The device suite's serial requirement lived in a command-line flag.** The
seven device files share one device, and hitrace and hiprofiler are both
single-session: running two at once produces `OpenRecording failed,
errorCode(1103)`, `CreateSession FAIL` and a session that is silently cut short
mid-write. `vitest.workspace.ts` documented this and `npm run test:device`
passed `--fileParallelism=false`, but any other invocation —
`npx vitest run --project device`, which is what the docs and the habit use —
ran them in parallel and failed six of seven files. Setting `fileParallelism` on
the workspace entry does nothing in Vitest 2.1 (measured: still six failures);
`poolOptions.forks.singleFork` is honoured per project, so the project now pins
itself to one fork and every invocation is serial. Removing the option fails
six files again, which is what makes this a regression test rather than a hope.

2010 unit tests (1982 passed + 28 skipped on a clean checkout), 11 device tests.

## 0.22.1 — 2026-11-17

The build has been red since 0.19.0 and this release fixes it. No behaviour
changes; the fixes are to how the project verifies itself.

- **CI typecheck runs again.** `npm test` transpiles with esbuild, which strips
  types without checking them, and the local habit was `tsc -p tsconfig.json` —
  the `src`-only config. CI runs `tsconfig.test.json`, which also compiles the
  tests, and it had been failing since 0.19.0: 73 errors in the CLI and 3 in
  core. The CLI's test config also set `rootDir` to the package, so every test
  that imports a core source or a core test helper was an error before its own
  content was read; `rootDir` is now the repo root with core's sources and
  helpers included.
- **One `CliDeps` fixture instead of seventeen.** Each command test file copied
  the whole injected-deps object, so adding a seam to `CliDeps` turned fifteen
  files red at once — which is how the breakage went unnoticed for five
  releases. `packages/cli/test/helpers/deps.ts` now holds it, with every seam
  throwing `<name> not stubbed` unless a test overrides it, and
  `helpers-deps.test.ts` pins both halves of that contract: an unstubbed seam
  refuses by name, and an override patches one seam rather than replacing the
  object.
- **`npm run verify`** runs what CI runs — build, both typechecks, unit suite —
  so the two can no longer drift apart.
- Three test-side type errors fixed where the code was right and the fixture was
  stale: a `.dynsym` entry missing `type`, two `SceneLayout` literals missing
  `coverageFile`, and two `trend` stubs missing `unmeasured`.

2009 unit tests (1981 passed + 28 skipped on a clean checkout).

## 0.22.0 — 2026-11-17

Parity row 28 is ported: symbol recovery. Every HapRay row is now ported —
35 ported, 0 partial, 0 missing, 0 out.

HapRay's `symbol_recovery` answers "which function is `libquick.so+0xc8a7c`?"
by shelling out to radare2 (`aflj`, `afij`, `pdfj`, a decompiler plugin) and
asking an LLM to name what it finds. Its own documentation records the
heuristic it rests on — a function over 100 KB is "unreasonable, skip", and a
lookup it misses gets a default size of 2000 bytes — and nothing measures
whether the name it prints is right.

- **The boundary is a lookup, not a heuristic.** Every `STT_FUNC` symbol in an
  ELF records `st_value` and `st_size`, so the containing function is found
  over sorted symbols. The recorded size is authoritative: a function followed
  by padding is not extended to the next symbol, and an offset past every
  function is `unresolved` rather than attributed to the nearest preceding one.
- **A stripped file says so.** With no symbol table there are no boundaries to
  read, and `recoverSymbols` reports that per address instead of guessing.
- **`symbols recover <lib.so> <address...>`** reports each address with its
  name and range, and names the ones it could not place. `--json` prints the
  document.
- **`--measure` reports the accuracy HapRay never states.** The names the file
  records are held out, the model is asked to infer them from the function's
  instruction mix and bytes — never its name — and the report says how many it
  got right. Names are compared after absorbing the noise a model adds (a
  `sym.` prefix, an argument list, a return annotation), so formatting does not
  score as a mistake. A file with nothing to hold out reports an undefined
  accuracy rather than 0%, which would read as a broken model.
- **The ELF reader now exposes `st_value`**, which the optimization detector
  did not need and symbol recovery does.
- 32 new unit tests (24 for recovery, 8 for the command), two typechecks, two
  builds. All 16 mutations of the recovery module were killed.

## 0.21.0 — 2026-11-17

Parity row 5 is ported: the LLM GUI agent. The ledger drops to one refused row.

HapRay's `gui-agent` wraps the external `phone_agent` package: the model sees a
screenshot, answers with one action, and says `finished` when it believes the
task is done. Three things make that unusable as a measurement tool, and each
is fixed here rather than reproduced.

- **`finished` is checked, not trusted.** A `done` answer must carry an
  expectation; it is evaluated against the screen, and a claim the screen
  contradicts is `unverified` — a failed step naming the clause that missed.
  A bare `done` with no assertion is also `unverified`, because a model that
  asserts nothing has proven nothing. Only a verified claim exits 0.
- **The guard is code, not a prompt sentence.** HapRay tells the model to
  avoid payment and ordering. Here a tap or text entry is resolved to the node
  it lands on — reading both the node's text and its id, with `_`/`-` read as
  word breaks, so `pay_button` is caught — and an irreversible target is
  refused before the gesture reaches the device. `--allow-irreversible` opts
  out, deliberately.
- **The transcript replays.** Every step records the gesture and the screen
  hash either side of it. `replayAgent` re-walks a transcript with no model,
  stops at the first step whose recorded screen no longer matches, and skips
  steps that never touched the device.
- **The loop is native and the client is injected.** `runAgent` takes a
  one-method `AgentModel`; `httpAgentModel` implements it over an
  OpenAI-compatible `/chat/completions` endpoint with an injected `fetch`, and
  parses the answer inside the client so an unparseable reply names the answer
  rather than the step. `agentPrompt` and `parseDecision` are exported, so a
  caller can drive any endpoint with its own transport.
- **No endpoint is guessed.** The client reads
  `OHOS_PERF_AGENT_BASE_URL`/`_API_KEY`/`_MODEL`, falling back to HapRay's
  `GLM_BASE_URL`/`GLM_API_KEY`/`GLM_MODEL`; with neither set, the command
  refuses and names the variables instead of sending a task to an unnamed host.
- **`agent <app> <task>`** with `--max-steps` (default 50, HapRay's),
  `--model`, `--allow-irreversible`, `--target` and `--json`.
- 1973 unit tests (41 for the loop, 14 for the client, 7 for the command),
  two typechecks, two builds.

## 0.20.0 — 2026-11-17

Parity row 27 is ported: optimization detection. The ledger drops to two
refused rows.

HapRay's `opt-detector` answers "which `-O` level was this built at, and was LTO
on?" by feeding raw `.text` bytes to a ~2 GB TensorFlow LSTM and a 551-feature
SVM, then printing the guess as a percentage. Its own source records the cost:
16.7% false positives on low-optimization binaries, at the threshold it ships.

- **`opt <package|lib.so>` reads the ELF instead.** LTO is exact — `lto_priv.*`
  symbols and `.gnu.lto_*` sections prove it, and their absence from a file
  that still has a symbol table proves the opposite. A stripped file reports
  `unknown` rather than `absent`, because the markers may have been removed.
- **A recorded `-O` flag wins over any inference.** When the toolchain left one
  in `.comment`, that is the compiler's own statement.
- **Otherwise the instruction mix decides**, and the verdict says so:
  `basis: inferred` with the signals named (`vector_density`, `no_vector_code`,
  `debug_sections`). A binary with no instructions is `unknown`, not a guess.
- **Calibrated against real libraries, not guessed.** Three release builds
  measured 15.7%, 20.4% and 23.5% SIMD; HapRay calls the last `libflutter.so`
  "O3 dominant", and this tool agrees on both its verdict and its "No LTO".
- **A small ELF reader**, written for this and nothing more: section headers,
  symbol tables, and an AArch64 classifier for the instruction classes whose
  density shifts with optimization. Every read is bounds-checked, and a bad
  magic, a short header or a section table past the end is a typed refusal
  naming the field.
- **Refusals instead of empty reports.** A package with no arm64 libraries, an
  `.a` archive, and a file that is not an ELF are all named failures; an empty
  result would read as "nothing to report".
- 1908 unit tests (53 for the reader and analyzer, 7 for the command),
  two typechecks, two builds.

## 0.19.0 — 2026-11-17

Parity row 24 is ported: coverage ingestion. The ledger drops to three refused
rows.

HapRay does not measure coverage. It shells out to `bjc`, which needs an
instrumented build (`ohos-test-coverage=true`, `coverage-mode=black`), a debug
HAP, an on-device cache, `aa dump` and a matching project source path — and when
any of that is missing its analyzer returns `None`, so the section silently
disappears from the report. A reader cannot tell "coverage was never measured"
from "0% of lines ran", which are opposite conclusions.

- **`analyze` reads a scene's `coverageReport.json`.** That is the document
  `bjc` writes and HapRay's own HTML template renders: `{ date, summary, files }`
  with `lines`, `functions` and `branches` counts. The package still does not
  ship `bjc` — an instrumented build is a property of how the app was compiled —
  but the analysis of its output is now here, offline, with no Node toolchain.
- **Six metrics, marked `approximate`.** `coverage.lines.percent`,
  `coverage.lines.covered`, `coverage.lines.total`, `coverage.functions.percent`,
  `coverage.branches.percent` and `coverage.files.count`. `approximate`, not
  `exact`: the counts are exact about the instrumented build, which is not the
  app a user runs.
- **Percentages are recomputed, not trusted.** Keeping bjc's `pct` would make
  the report a function of a tool this package does not control, and a `total`
  of zero has to be 0% rather than `NaN`.
- **A missing report is `no_data` with a reason**, naming the instrumented build
  and `bjc` — the distinction HapRay's silent skip cannot make.
- **The least-covered file is named**, with its line, function and branch
  ratios, rather than repeating the report's file list as evidence.
- **Refusals instead of guesses.** Malformed JSON, a missing `summary`, a
  non-integer count and `covered > total` are all typed errors naming the
  section; a report claiming 120% of lines ran cannot reach a reader.
- 1844 unit tests (11 for the parser and analyzer, 2 end-to-end through
  `analyze`), two typechecks, two builds.

## 0.18.1 — 2026-11-17

One fix to what 0.18.0 printed.

- **`explore --help` no longer states each default twice.** Commander appends
  `(default: "30")` to an option with an initial value, and the description
  also said `(default: 30)`, so the help read
  `stop after this many taps (default: 30) (default: "30")`. The same defect
  `trend --label` had in 0.16.0; a test now parses `explore --help` and fails
  if a default appears in both places.
- 1831 unit tests (1 new), two typechecks, two builds.

## 0.18.0 — 2026-11-17

Parity row 4 is ported: autonomous UI exploration, and the ledger drops to four
refused rows. HapRay's `haptest` was never blocked by a prerequisite this
package lacks — it was a defect in the implementation, and a port could fix it.

- **`explore <app>`** dumps the screen, hashes it, and taps an unvisited
  clickable until `--max-steps` (default 30, HapRay's) runs out or the screen
  has nothing left. `--strategy depth_first|breadth_first|random`.
- **Every order is a total order.** Depth-first is the dump's pre-order,
  breadth-first sorts by depth and is stable within a depth, and `random` is a
  seeded Fisher–Yates permutation. HapRay's `random` walks an unseeded RNG, so
  two runs of the same build explore different screens and neither replays;
  here the seed is reported and the walk reproduces.
- **A tap that changed nothing is `no_change`.** HapRay counts every tap as a
  step forward. The report leads with states reached — distinct screen hashes —
  and splits the taps into those that navigated and those that did not, so a
  walk that tapped a dead button thirty times no longer looks like one that
  opened thirty screens.
- **Visited is per screen.** A node id is unique within one dump, not across
  the run; two screens can both have `button1`. A global visited set would skip
  the second screen's element and call the screen covered.
- **The settle is change-triggered.** HapRay spends a fixed 5 s on every
  action. After each tap this re-dumps until the hash changes, capped at 5 s,
  so a live element costs one poll and only a dead one pays the window.
- **Refusals instead of guesses.** An unparseable rect is skipped rather than
  tapped at (0,0); a tap whose bounds are no longer on the screen fails instead
  of clicking whatever moved into place; a `--strategy` typo is an invocation
  error before any device is touched.
- 1830 unit tests (27 of them for the walk and its settle, 9 for the command),
  two typechecks, two builds.

## 0.17.2 — 2026-11-17

One reporting fix to `trend`, found by running it on two real saved bundles.

- **"not measured" is counted apart from "no known direction".** The summary
  line folded both into one number, so a two-run trend over a scene without a
  binder capture reported 23 series "without a known direction" when 16 of
  them had no values at all. A metric nobody measured has no direction
  *because* it has no values — a different statement, and the one that
  overstates how much was compared. `TrendOutput` gained `unmeasured`, and the
  line now reads `14 unchanged, 7 without a known direction, 16 not measured`.
- 1797 tests (1786 unit, 11 device), two typechecks, two builds.

## 0.17.1 — 2026-11-17

One fix to what 0.17.0 shipped.

- **`render` now carries the bundle's screenshot across.** The page links
  `assets/screenshot.png` whenever the model says one was captured, but that
  file is a copy rather than a value, so a re-render reproduced the `<img>`
  and not the file — a page pointing at an image that was not there. The
  source bundle's copy is carried across when the model names one; a bundle
  without a screenshot renders the page it always did, with no `<img>`.
- 1795 tests (1784 unit, 11 device), two typechecks, two builds.

## 0.17.0 — 2026-11-17

Parity row 33 is fully ported: a saved bundle can be re-rendered from its own
`report.json`. This is the last `partial` row — the ledger is now 30 ported,
0 partial, 0 missing and 5 refused with a named prerequisite.

- **`ohos-perf render <report.json> --out <dir>`.** HapRay's `update` re-runs
  the whole pipeline from the scene directory, so an old report becomes a
  function of today's code: two people opening the same saved run on different
  versions see different numbers. Here `report.json` is a typed model, and
  every artifact except the flamegraph is a pure function of it. The re-render
  reads no scene, no device and no analyzer, and reproduces `report.html`,
  `report.json`, `summary.json`, `metrics.csv`, `evidence.csv` and
  `report.xlsx` byte for byte — verified against a bundle whose source scene
  was deleted first.
- **No flamegraph, deliberately.** The drawing comes from folded stacks that
  live in `perf_sample`, not in the model. A re-render writes no flamegraph
  rather than an empty canvas, which would be a picture of a capture in which
  nothing ran. The screenshot is carried across instead: it is a copied file
  rather than a value, so `render` copies the source bundle's
  `assets/screenshot.png` when the model says one was captured, and a bundle
  without one renders the page it always did — no `<img>`, nothing missing.
- **The output says which it was.** `render` prints
  `source  <path> (re-rendered, not re-analyzed)` so a reader who expected a
  fresh analysis is told none happened.
- New public API: `renderBundle` and `BUNDLE_RENDERED_FILES`.
- The ledger moves to **30 ported / 0 partial / 0 missing / 5 out**.
- 1795 tests (1784 unit, 11 device), two typechecks, two builds.

## 0.16.0 — 2026-11-17

Parity row 35 is fully ported: `trend` aggregates any number of saved reports
into one page, instead of only comparing two.

- **`ohos-perf trend <report...> --out <dir> [--label <name>]`.** HapRay's
  multi-version page accepts any report HTML files, pulls the embedded JSON
  out of each, and asks a human to filter by app and version afterwards —
  because the page has no model that could refuse. Here the refusals come
  first: fewer than two reports is an invocation error, and the aggregation
  refuses runs under a duplicate label or from two different apps.
- **A gap is a gap.** A run that did not emit a metric gets `null`, not 0 —
  and so does a *degraded* metric, whose zero is the engine's stand-in for
  "there was nothing to read". A series counts its measured points, the page
  says `not measured` instead of drawing a line, and the delta is taken
  between the first and last run that actually measured it.
- **A verdict only where one is possible.** `improved` / `regressed` /
  `unchanged` come from the same metric-direction table `compare` uses;
  a metric with no known direction carries a delta and no verdict, and the
  command's summary line counts those separately.
- **The ordering is stated.** Runs are ordered by capture start time when
  every run recorded one, and in argument order otherwise — never a partial
  time order, which would place an undated run first and make the x axis a
  lie. `trend.json` records which rule applied.
- **Offline, like every other artifact.** `trend.html` carries an inline SVG
  sparkline per metric, no scripts, no external resources; `trend.json` is
  the same model, byte-identical for the same runs in the same order.
- New public API: `buildTrend`, `trendRunFromReport`, `renderTrendHtml`,
  `renderTrendJson` and the `Trend` / `TrendRun` / `TrendSeries` /
  `TrendPoint` / `TrendOrder` types.
- The ledger moves to **29 ported / 1 partial / 0 missing / 5 out**. The one
  partial row is 33, and its remaining clause is re-rendering a bundle from
  saved inputs.
- 1779 tests (1768 unit, 11 device), two typechecks, two builds.

## 0.15.0 — 2026-11-17

Parity row 31 is fully ported: a start/end capture pair now produces animation
labels, not only a tree diff and a pixel diff.

- **A label needs both halves to agree.** A region is an animation when its
  pixels moved *and* the tree reports a change inside it. HapRay labels on
  pixels alone, which also fires on a blinking cursor, a video frame or a
  system clock — the app never re-rendered those. `ui-diff.json` therefore
  carries three lists: `animations`, `pixelOnly` and `unmeasuredRegions`.
- **HapRay's severity bands**, kept so its numbers read the same here: major
  under 50% similar, moderate under 70%, minor under 85%, and no label at or
  above 85%.
- **A region smaller than the 9×8 dHash grid is named, not guessed.** Two
  three-pixel regions hash identically whatever they contain, so those regions
  are reported as unmeasured with the reason.
- **The HTML report and `ui-compare` say which of the three happened.** The
  human line reads `animations  1 labelled, 2 pixel-only, 0 unmeasured`, and
  a tree-only comparison says the labels were not measured rather than
  printing three zeros.
- New public API: `analyseAnimations`, `compareRegion`, `cropRegion`,
  `animationSeverity`, `ANIMATION_BANDS`, `MIN_HASH_PIXELS` and their types.
- The ledger moves to **28 ported / 2 partial / 0 missing / 5 out**.
- 1741 tests (1730 unit, 11 device), two typechecks, two builds.

## 0.14.0 — 2026-11-17

Parity row 12 is fully ported: RenderService skip reverse tracing now runs
both of HapRay's backtracking paths, not only the NativeWindow one.

- **The system-API path.** `frame_rs_skip_backtrack_api.py` is ported. An
  `UnMarsh RSTransactionData` event on a RenderService IPC thread names the
  pid that submitted the transaction (`recv data from <pid>`), and the thread
  that woke that IPC thread — or one up to five wakeup hops behind it — is the
  app thread whose frame was submitted. This is what makes ArkUI, RN and KMP
  skips traceable; the buffer path alone could not see them. `rs-skip.ts` now
  tries this path first and falls back to NativeWindow, as HapRay does.
- **`rs_skip.cpu_waste.instructions`.** HapRay charges the waste in sampled
  instruction weight, not only in frame duration. The weight is summed over
  the app process's threads inside each traced frame, the same scope the
  frame-load analyzer measures, so a busy worker thread counts.
- **`rs_skip.traced.rs_api.count` and `rs_skip.traced.nativewindow.count`.**
  Which method produced each trace. A reader whose run shows zero `rs_api`
  frames is on a NativeWindow framework; one whose run shows neither has no
  sampling to trace at all.
- Every trace now records its method, and the evidence sentence names it.
- **Absent, never zero.** The instruction metric and the method breakdown are
  omitted when there is nothing to measure — no perf capture, no sample in a
  traced window, or no traced frame. A `0` would claim a measurement the
  capture never made.
- The ledger moves to **27 ported / 3 partial / 0 missing / 5 out**, and
  `parity.test.ts` now checks that no `ported` row carries a reason.
- 1734 tests (1723 unit, 11 device), two typechecks, two builds.

## 0.13.3 — 2026-11-17

Two correctness fixes to what 0.13.0 shipped, and the ledger's own prose.

- **A `--jsheap` capture can no longer record the previous run's snapshot.**
  The collector polled for the newest `.heapsnapshot` under the app's data
  directory. The dump is asynchronous so polling is necessary, but it also
  meant a second capture with a slow dump took the earlier session's heap and
  reported it `exact`. It now lists the snapshots before asking for a dump and
  accepts only a path that was not already there.
- **Row 12 no longer claims a metric the code emits.** `parity.ts` said the
  row was missing the CPU-waste metric while `rs-skip.ts` has emitted
  `rs_skip.cpu_waste.ms` since 0.13.0. `parity.test.ts` now checks a partial
  row's missing clause against the metrics, not just its analyzer against the
  registry.
- The jsheap capture record in `scene.json` gained unit coverage, including
  the two refusals a zero-byte or fractional snapshot deserves.
- 1723 tests (1712 unit, 11 device), two typechecks, two builds.

## 0.13.2 — 2026-11-17

Documentation only. The 0.13.1 tarball still shipped a core README that said
"eight collectors"; npm publishes `packages/core/README.md` as the package's
landing page, so that is what a reader on npmjs saw.

- The core README now says nine, and `doc-counts.test.ts` reads it too. The
  first version of that check missed it for a reason worth keeping: the prose
  is hard-wrapped, so "nine" and "collectors" sat on different lines and a
  regex over the raw text could not see across the newline. Every check now
  normalizes whitespace before matching.
- 1723 tests (1712 unit, 11 device), two typechecks, two builds.

## 0.13.1 — 2026-11-17

0.13.0's release note promised a flag that did not exist, and its doc counts
were one release behind. Nothing about the analysis changed.

- **`collect --jsheap` now exists.** 0.13.0 advertised it, but the flag was
  never registered — the heap-snapshot capability was reachable only from the
  core API. It requires `--app` (the dump targets one process), the capture is
  recorded in `scene.json` under `capture.jsheap`, and a re-capture without
  the flag removes a stale `jsheap.heapsnapshot` rather than leaving it beside
  the new trace.
- **Doc counts match the code.** The README, the site and the core package
  description said "nineteen analyzers, eight collectors" while P18 had made
  it twenty and nine. Two tests now read the docs and fail when a count or an
  analyzer's metric prefix stops matching the registry. The README's metric
  table also gained `hilog.*` and `redundant_file.*`, which were emitted but
  undocumented.

## 0.13.0 — 2026-11-17

P18 closed the last four capabilities with no implementation, and made the
parity claim checkable.

- **A parity ledger, checked against the code.** `packages/core/src/parity.ts`
  holds all 35 inventory rows with a status and, when not ported, the reason;
  `paritySummary()` computes the counts and `parity.test.ts` fails if a ported
  row names an analyzer the engine does not register. The honest recount is
  **26 ported / 4 partial / 0 missing / 5 out**. The README's previous
  18 / 9 / 8 was prose written before 0.10.0 and never recounted.
- **Fault tree `ipc_binder` (row 15).** Derived from the typed binder analysis
  rather than from a shared file HapRay's own ordering makes stale. Absent, not
  zero, when the trace has no binder data.
- **`collect --jsheap` (row 20).** Pulls a heap snapshot; every refusal is
  typed — no pid, not debuggable, nothing written before the deadline. The
  flag needs `--app` (the dump targets one process), and the capture is
  recorded in `scene.json` under `capture.jsheap` so a later analyze can
  attribute the file to a capture. A re-capture without `--jsheap` removes a
  stale snapshot rather than leaving it beside a new trace.
- **Redundant-file I/O (row 21).** A `redundant_file.txt` in a scene is parsed
  into read/used/unused counts. The format is documented here because HapRay's
  producer is not in its pipeline; a line that does not fit is refused by line
  number.
- **File-to-HAR dependency graph (row 29).** `buildDepGraph` takes files,
  modules and edges and returns the graph, cross-module counts and timing
  cycles — no Homecheck checkout, no 16 GiB heap. Ownership is segment-aware
  and longest-match.
- **`rs_skip.cpu_waste.ms` (row 12).** The CPU a skipped frame wasted, summed
  over the app frames RS discarded. Absent when nothing was traced.
- **`compareScenes` (row 35).** Compares multi-step runs step by step instead
  of merging them, so a change is attributed to the step that moved.

The five `out` rows keep their measured reasons: HapTest exploration, the LLM
GUI agent, coverage, the TensorFlow opt-detector and radare2 symbol recovery.

- 1723 tests (1712 unit, 11 device), two typechecks, two builds.

## 0.12.1 — 2026-11-17

A release-day defect in 0.12.0's packaging, and nothing else.

- `@ohos-perf/cli@0.12.0` declared `"@ohos-perf/core": "0.11.0"` — the pin was
  written by hand and never bumped. Installing the published CLI pulled the
  previous core and died on its first import (`does not provide an export
  named 'discoverCases'`). Inside the workspace the dependency resolves to the
  local package, so no test consulted the range. `packages/cli/test/package-manifest.test.ts`
  now fails when the pin and `packages/core/package.json` disagree, and
  requires an exact pin.
- Both packages republished at 0.12.1 so the pair installs together.

## 0.12.0 — 2026-11-17

P17 (HapRay parity W5, step DSL): a scenario that says what it means, and a
status that means something.

A scenario action used to be a raw coordinate — `{"kind":"click","x":540,"y":1170}`
— which is three failures at once: it does not survive a different resolution,
it cannot say what should have been on screen afterwards, and it has no way to
reach a list item below the fold. HapRay's DSL selects a component and derives
the coordinate; ours now does the same, and goes one further: its `verify` is
parsed and never run, and ours runs.

### Features

- **Selector language** (`scenario/selector.ts`): ten kinds over the flattened
  UI tree — `text` (case-insensitive substring, or equal with `exact`), `id`,
  `type`, `clickable`, `all`, `any`, `not`, `index`, `bounds`, `relative`.
  Every selector is validated as data at load time, with its JSON path in the
  message (`steps[0].actions[0].target.of[1]`). `not` is the complement of its
  own candidate set, so `all: [text OK, not id x]` reads "an OK node that is
  not x". Matching order is document order, then top/left/right/bottom, then
  identity, so two runs over the same tree agree.
- **Four selector actions**: `tap` (with `scrollTo` and `timeoutMs`),
  `tapText` (the short form), `swipeArea` (inside a component's bounds, for a
  carousel or an inner list), and `inputInto` (tap then type, one intent).
  A target resolves to the centre of its bounds; a node whose `bounds` did not
  parse is a typed refusal, never a tap at `(0,0)`.
- **Scroll-to-find**: `scrollTo` names a scrollable container; when the target
  is absent, the runner swipes it from 70% to 30% of its height, re-dumping
  after each swipe, up to five times. It stops at the list's edge — a swipe
  that changes nothing — and the refusal reports how many swipes it actually
  spent, so "1" and "5" diagnose different problems. A non-scrollable
  container is refused before any swipe.
- **Step assertions**: an optional `expect` block — `present` with `min`/`max`,
  `absent`, `foreground` — evaluated against a fresh dump after the actions
  and before cleanup. Every clause is evaluated even after one fails; each
  outcome is recorded in `steps.json` as `{label, ok, actual, detail?}`. A
  failed clause marks the step `failed` and keeps its scene.
- **`run --cases <dir>`**: discovers `*.scenario.json`, runs each into
  `<out>/<case-id>/`, and writes `<out>/cases.json`. `--filter` is an anchored
  regex over case ids. An empty directory or a filter that matches nothing is
  a refusal naming what was found; a malformed case fails that case only.
- **`Device.uiTree()`**: a fresh `dumpLayout` into a temporary directory that
  is removed afterwards, so a step that dumps five times leaves no scene
  artifact behind.

### Notes

- Coordinate actions are unchanged and still valid: a blank canvas has no node
  to select. A version-1 scenario written before this release loads and runs
  exactly as before.
- Every swipe checks `uitest uiInput`'s `No Error` marker. The host exit code
  is 0 even when the device refuses a gesture, so the marker is the only proof
  of acceptance.
- 1664 tests (1653 unit, 11 device). The device suite on the attached emulator
  reports four environmental failures — no `hiprofiler_cmd`, a non-debuggable
  app, no PMU — in files this phase does not touch.

## 0.11.0 — 2026-11-17

P16 (HapRay parity W8): symbols that are real, and a flamegraph that opens
offline.

A real `perf.db` from a Mate 60 capture (26,013 samples, 484,630 callchain
frames, 215 files, 9,681 `perf_files` rows) showed that frame resolution was
wrong in a way no synthetic fixture revealed. `perf_callchain.name` is not a
symbol — it is a `data_dict` id — and `query/perf.ts` fell back to *the first
`perf_files` row of the file* when the exact `(file_id, symbol_id)` pair
missed. That fallback invented symbols: 1,972 leaf frames (753 M weight,
**7.14%** of all samples) got the name of whichever symbol happened to be
first in their file. `dlopen` was reported with 6.33 M weight where its
genuine weight is 0.16 M; `dladdr` at 495 M was real, which is exactly why
the defect stayed invisible. Unresolved leaves (2,295 frames, 994 M,
**9.43%**) emitted a raw numeric id as the symbol.

### Fixes

- **Frame symbols resolve exactly or not at all.** The order is now the exact
  `(file_id, symbol_id → serial_id)` row, then the `data_dict` text for
  `name` (which is `libfoo.so+0x1cce24` when the recorder saw the address but
  could not name it, and `''` for a dangling id), then the raw `name` column
  only for a database with no `data_dict` at all. The neighbour fallback is
  gone. On the measured capture every one of the 437,767 resolvable frames
  hits exactly.

### Features

- **`symbols` analyzer** (`symbol.*`, all `exact`): `symbol.samples.count`,
  `symbol.unresolved.count`, `symbol.unresolved.share`, `symbol.files.count`
  and, when a resolved row exists, `symbol.top.symbol` / `symbol.top.samples`.
  The first two sum to the window's weight, so nothing goes missing. Evidence:
  up to ten `symbol_stats` items naming the heaviest resolved rows and up to
  ten `unresolved_symbol` items naming the heaviest unnamed ones, each
  drilling into `symbol.stats`. The analyzer degrades with a reason naming
  `--hiperf` when the scene has no samples.
- **`symbol.stats` query**: `{symbol, filePath, samples, share, unresolved}`
  per leaf over a nanosecond range, sorted by weight, with `share` totalling
  100% over the window's app-thread weight.
- **`collect --so-dir <dir>`** passes a host directory of shared objects to the
  perf conversion as `--So_dir`, so the frames it can name come out named at
  capture time; the rest stay `file+0xoffset` and are reported as unresolved.
  Refused before the capture starts when the flag cannot mean anything
  (`COLLECT_SO_DIR_WITHOUT_HIPERF`) or the path is not a directory here
  (`COLLECT_BAD_SO_DIR`). `scene.json` records
  `capture.hiperf.symbolized: true`.
- **Offline flamegraph artifact**: `report` now writes `flamegraph.svg` and
  `flamegraph.html` after the six document artifacts when the scene has perf
  samples. The SVG is one rectangle per distinct frame path, siblings ordered
  by descending weight, the full path and share in each `<title>`, and no
  script, link or fetch of any kind. The page states the unresolved share and
  whether symbolization ran — or that the capture did not record it. The pair
  is byte-identical across runs, and a scene with no samples writes neither
  file and does not fail.

### Fixes — symbol statistics

- **A frame-less chain's weight stays in the table.** A `perf_sample` whose
  `callchain_id` has no `perf_callchain` rows — a truncated conversion, or a
  kernel chain the recorder dropped — used to vanish from `symbol.stats`, so
  the documented identity (`symbol.samples.count` + `symbol.unresolved.count`
  = the window's weight) was false and the unresolved share read better than
  the capture was. That weight names nothing, so it is now the unresolved
  `('', '')` row.
- **A sample with no call chain at all is counted too.** The same gap existed
  for `perf_sample` rows whose `callchain_id` is NULL — the recorder could not
  unwind, but `eventCount` counts the weight. Those rows are now part of the
  unresolved `('', '')` row as well, so `symbol.stats` shares sum to 100%
  over any capture, not only one whose chains are all present.

### Fixes — honest claims

- **The flamegraph says symbolization was requested, not that it worked.**
  `scene.json` records that `--so-dir` was passed, and nothing records how many
  frames the symbolizer named; the page said "Symbols were resolved from the
  capture", which a capture whose symbol directory lacked the app's libraries
  would print directly above its own non-zero unresolved share. The field is
  now `symbolizationRequested` and the sentence says what it means.
- **A `--So_dir` conversion failure names the flag.** The human error line
  prints the error's message alone, so the converter's own "unknown option"
  text never reached the reader: a toolchain that rejects `--So_dir` reported
  only that the conversion failed, after a capture that had succeeded. The
  message now names the flag and the directory, and says what to do.

### Fixes — report windows

- **A whole-capture window is stated as words.** `analyze` over a scene with
  no `trace_range` windows the analyzers over `0 … MAX_SAFE_INTEGER`, and the
  report HTML printed that sentinel as a span — 23 times on a hand-built
  scene, reading as 285 years. `flamegraph.html` printed it too. One
  formatter now serves both pages: a measured span stays `1000 – 2000 ns`, and
  the marker reads `the whole capture`.

### Fixes — static HAP inspection

Corrections to the static HAP inspection released in 0.10.0. Each was found
by checking the shipped behaviour against a real package, and each is pinned
by a test that failed first.

- **The per-file inventory is in the document.** `HapAnalysis.files` carries
  every entry (path, sizes, CRC32, extension, category). The spec's "no
  `hap.files` query" argument and the promise that `hap.json` holds every file
  both rested on this; the document had the totals but not the rows.
- **Every entry is CRC-checked, not only the ones a rule reads.** Rule
  matching excludes `resources/base/`, so a corrupt entry there — the largest
  part of a typical package — was never verified. A corrupted archive now
  fails with `HAP_CRC_MISMATCH` naming the entry.
- **A malformed ZIP header is a typed refusal.** An offset pointing past the
  end of the archive threw a bare `RangeError` from `DataView`; it is now a
  `HAP_NOT_ZIP` naming the block (central directory, local header, entry name
  or entry data).
- **`--json` prints the `HapAnalysis` document `hap.json` writes**, plus the
  one-row `static.hap` capability matrix the spec requires. It previously
  printed a separate summary shape and omitted both. The caller's `--out`
  path is not in the document.
- **A package of assets is no longer inflated end to end.** The bare magic
  rule in `RN bundles` — HapRay's shape — was offered every entry in the
  archive; it is now gated on the extensions a Hermes bundle ships under, and
  `and` short-circuits. Inflated bytes are released per file rather than
  cached for the whole archive, which previously peaked near 500 MB RSS on a
  100 MB package.
- **Rules are validated before they run.** `matchHapRules` calls
  `validateRules`, so an unknown rule kind is `HAP_BAD_RULE` naming the rule
  instead of a detection that silently never fires.
- **A failing command prints `CODE: message`.** The refusal code is the token
  the skill tells an agent to report; the CLI printed only the message.

## 0.10.0 — 2026-11-17

P15 (HapRay parity W7): the package on disk, read without a device.

### Features

- **`ohos-perf hap <package.hap> [--out <dir>] [--json]`** inspects a HAP, HSP
  or ZIP package offline. `--json` prints the typed document; `--out` writes
  `hap.json` (the same document, including every file) and an offline
  `hap.html` rendered through the existing report model as one `static-hap`
  section. The human line names the app, the file count and both sizes, one
  line per detected technology with the rule that decided it, the duplicate
  groups and wasted bytes, the oversized count and the ten largest files. A
  missing path, a directory, or a file without `.hap`/`.hsp`/`.zip` exits 1
  naming it before any IO, and nothing is written.
- **A pure-TypeScript ZIP reader** (`openZip`, `isZip`) over Node's
  `zlib.inflateRawSync`: stored and deflated entries, the central directory
  read whole, and a CRC check on every read. It refuses by name what it cannot
  describe honestly — `HAP_NOT_ZIP`, `HAP_ZIP64_UNSUPPORTED`,
  `HAP_ENCRYPTED_ENTRY`, `HAP_UNSUPPORTED_METHOD`, `HAP_UNSAFE_PATH` (an
  absolute name, a drive letter or a `..` segment) and `HAP_CRC_MISMATCH` (a
  corrupt deflate stream is never padded into a plausible wrong file). Nothing
  is extracted to disk; the archive is read in memory, so a hostile entry name
  cannot escape anywhere.
- **A deterministic inventory** (`buildInventory`): per file the path,
  uncompressed and compressed size, CRC32 as 8 hex chars, the lowercase
  extension and a category from HapRay's own `FILE_CATEGORIES` table (images,
  videos, audio, fonts, scripts, styles, binaries, bytecode, data, other),
  sorted by path. Directory entries are counted in neither the file count nor
  the size. `CATEGORY_MAX_BYTES` carries HapRay's per-category thresholds.
- **Technology-stack detection as data** (`TECH_RULES`, `matchHapRules`,
  `validateRules`): HapRay's `techstack-config.yaml` ported to typed rules over
  six kinds — `filename`, `path`, `extension`, `magic`, `content` and
  `combined` (with `and`, `or` and `not`). Shipped detections are HapRay's own
  ids: Flutter, Flutter Assets, React Native, Hermes, RN bundles, KMP, Compose
  Multiplatform, Lynx, Qt, Unity, Taro, Weex, Cangjie and the third-party
  library rules (logan, leveldb, libpag, mmkv, ijkplayer, …). A match records
  the rule that decided it, every matching file and their summed bytes;
  confidence is `rule.confidence × match confidence`. A `requireMetadata` rule
  matches only when its own matched file yields the metadata, so Flutter is a
  `libflutter.so` that also carries a Dart version string. An invalid regex or
  an unknown kind is `HAP_BAD_RULE` naming the rule at load time.
- **Duplicate and oversized assets**: duplicates are grouped by
  `(size, crc32)` first and only groups with two or more members are inflated
  and hashed with SHA-256, so equal-size-different-content pairs never reach
  the hash and a CRC collision is separated by it. Oversized is strictly above
  the category threshold. `Duplicates` reports `sha256`, `size`, `copies`,
  `wastedBytes` and the sorted paths.
- **`analyzeHap` / `hapSection`**: one `static-hap` section with `exact`
  metrics (`hap.files.count`, `hap.size.bytes`, `hap.size.compressed.bytes`,
  `hap.techstack.count`, `hap.techstack.<type>.files`,
  `hap.duplicates.groups`, `hap.duplicates.wasted.bytes`,
  `hap.oversized.count`, `hap.category.<name>.bytes`) and `tech_stack`,
  `duplicate_asset` and `oversized_asset` evidence items keyed by rule id,
  SHA-256 and path so two items never collide on one id.
- **New capability id `static.hap`** with no device rule: a device cannot make
  a file on disk readable, so `buildMatrix` never emits it and the device
  matrix keeps its 23 rows.
- **Public surface**: `openZip`, `isZip`, `buildInventory`, `categorize`,
  `CATEGORY_EXTENSIONS`, `CATEGORY_MAX_BYTES`, `EXCLUDE_PATTERNS`, `TECH_RULES`,
  `matchHapRules`, `validateRules`, `analyzeHap`, `hapSection` and their types.

### Semantics worth naming

- **Determinism.** `hap.json` is a function of the archive's bytes: files by
  path, categories by name, technologies by `(type, ruleId)`, duplicates by
  hash, largest by `(-size, path)`. There is no clock and no absolute path —
  the package is named by its basename — and two runs over the same package
  produce byte-identical `hap.json` and `hap.html`.
- **No verdict.** There is no "primary technology" and no score: a guess
  printed beside measurements reads like one of them. `hap.techstack.count` 0
  means nothing matched, not "native app".
- **The name collision that was fixed before it shipped.** The hilog matcher
  already exported `matchRules`; the HAP matcher is `matchHapRules`, so the
  public surface has one meaning per name.
- **HapRay's `excludes` is kept.** Entries under `resources/base/.*` are
  invisible to every rule, so the same package yields the same detections here
  as upstream. ELF-backed metadata (`soDependencies`, `soExports`, `Key`,
  `openSourcePackages`) is not ported — P16's work — and those fields are
  absent rather than guessed.

## 0.9.0 — 2026-11-17

P14 (HapRay parity W6): the screen itself, captured, analyzed and compared.

### Features

- **`collect --screenshot`** runs `uitest screenCap`, pulls the PNG into
  `screenshot.png` beside `ui.json`, and records
  `capture.screenshot: { width, height, bytes }` in `scene.json`. It needs no
  `--app` (the whole screen is captured) and is independent of `--uitest`: a
  screenshot without a tree is a valid capture. `--json` reports
  `screenshot: { width, height }`; the human line prints
  `screenshot 1260x2720`. Success is the device tool's `ScreenCap saved to`
  marker — `hdc` exits 0 even when the device refuses — and the pulled bytes
  must carry the PNG signature, so a truncated transfer is
  `SCREENSHOT_BAD_PNG` rather than a scene artifact.
- **New capability row `ui.capture`** (23 rows total), gated on the `uitest`
  binary and the measured marker, so an agent can ask "can this device
  screenshot?" before asking for one.
- **A pure-TypeScript PNG codec** (`decodePng`, `encodePng`) over Node's
  `zlib`: decodes the 8-bit, non-interlaced colour types the device produces
  (0 grey, 2 RGB, 4 grey+alpha, 6 RGBA) and encodes RGBA. Palette, 16-bit and
  interlaced images are refused with a typed error naming which, never
  silently mis-decoded. No OpenCV, no Pillow, no native build.
- **`UiAnalyzer`** (`ui` section) emits `ui.nodes.count`, `ui.nodes.clickable`,
  `ui.nodes.text`, `ui.tree.depth.max`, `ui.screenshot.width`,
  `ui.screenshot.height` and `ui.screenshot.dhash` (16 hex chars,
  `unit: 'hash'`, `fidelity: 'exact'` — a computed value, not a measurement),
  plus one `ui_tree` evidence item with a `ui.tree` drill-down. It requires no
  capability and decides from the artifacts it is given: tree only or
  screenshot only reports the present half exact and the missing half degraded
  with a reason, never zeros for both; neither emits `ui.degraded` and a
  `no_data` evidence item.
- **`ohos-perf ui-compare <a> <b> --out <dir> [--json]`** writes
  `ui-diff.json`, `ui-diff.html`, `ui-diff-marked-a.png` and
  `ui-diff-marked-b.png`. Exit 0 whenever the comparison was made — including
  identical screens — and 1 when it could not be: `UI_MISSING_ARTIFACT` names
  the artifact and the side, `UI_SIZE_MISMATCH` names both sizes and refuses
  rather than rescaling.
- **Identity-based tree comparison** (`diffTrees`, `nodeIdentity`): nodes are
  matched by `bundleName|type|id|text` (`id` and `text` only when non-empty),
  siblings sharing an identity paired in document order. An inserted node is
  one `added` instead of shifting every later comparison — the defect HapRay's
  index matching has. Attribute diffs apply HapRay's renderer-state ignore
  list and a 5 px geometry tolerance; every difference records which rule
  decided it.
- **Two image comparators** (`diffImages`, `dHash64`): a 64-bit dHash over a
  9×8 box-averaged greyscale (similarity `1 - hamming/64`) and a bounded pixel
  diff over a ≤256 px-wide downscale at per-channel tolerance 8. Both numbers
  and the tolerance are in the output, because they answer different
  questions.
- **`ui.tree` query** returns the captured tree whole — every attribute the
  diff compares, in document order — so a difference is drillable. `ui.get` is
  unchanged.
- **The report's `ui` section** embeds the screenshot: `report` copies it to
  `<out>/assets/screenshot.png` and the HTML shows it with
  `<img src="assets/screenshot.png">`. A scene without one renders the
  degraded reason and no `<img>`; the page stays script-free and offline.
- **Public surface:** `decodePng`, `encodePng`, `diffTrees`, `nodeIdentity`,
  `IGNORED_ATTRIBUTES`, `GEOMETRY_TOLERANCE_PX`, `compareSceneDirs`,
  `UI_DIFF_FILES`, `renderUiDiffHtml`, `UiAnalyzer`, `ScreenshotCollector`,
  and the `UiNode` / `RgbaImage` / `UiDiff` / `UiDiffSide` / `UiCompareOptions`
  types.

### Semantics worth naming

- **Everything is a function of the captured bytes.** `ui-diff.json` and the
  marked PNGs are byte-identical for identical inputs: the encoder writes no
  `tEXt`/`tIME` chunk, dHash and the pixel diff are integer arithmetic over a
  fixed downscale, and the diff carries no clock of its own — the two scenes'
  `capture.startedAtMs` are copied in as inputs.
- **A missing screen is not an unchanged screen.** The comparison fails with a
  typed error naming the artifact and the side rather than reporting an empty
  diff.
- **Fixed a positional-unpacking bug found only on a real device.**
  `Device.collect` reads collector results positionally; the screenshot was
  pushed before hidumper/uitest and unpacked after them, which put the UI
  tree's node count under `capture.screenshot` in `scene.json`. The push now
  happens after the uitest block, and a unit test pins both keys.
- **Not ported, deliberately:** HapRay's `ui_animate.json` artifact (an
  animation is a start/end pair of scenes, so it is `ui-compare a b` — one
  code path, not two), its animation labels (dHash thresholds are unvalidated
  and resolution dependent, and "this region animated" is not a performance
  measurement), `inspector_page_<i>.json` (Hypium's own tree dump; `ui.json`
  stays the single tree source), and cross-resolution rescaling.

## 0.8.0 — 2026-11-17

P13 (HapRay parity W5): declarative scenarios, measured from the inside.

### Features

- **`ohos-perf run <scenario.json> --out <dir>`** runs a versioned JSON
  scenario and writes one complete scene per `(round, step)` at
  `<out>/<id>/round-<n>/`, alongside `steps.json`, `testInfo.json` and
  `pids.json`. Each step directory is an ordinary scene: `analyze`, `report`,
  `query` and `compare` work on it unchanged.
- **Three phases per step, all executed:** `setup` before the capture starts,
  `actions` inside the capture window concurrently with the collectors, and
  `cleanup` after it — always, including after a failed action. (HapRay's DSL
  parses `setup`/`cleanup` and never runs them.)
- **Actions:** `launch`, `forceStop`, `click`, `swipe`, `key`, `text`,
  `inputText`, `wait`, `marker`. Gestures reuse the measured `uitest uiInput`
  path; `launch`/`forceStop` are `aa start`/`aa force-stop` and a non-zero
  device exit fails the action with the device's own message.
- **`marker`** records a named instant (`atMs`, host clock; `atNs` device
  uptime when the device allows `cat /proc/uptime`) with no device call, so a
  gesture can be lined up with the scene's `capture.startedAtMs`.
- **Per-step collectors:** `hitrace` (default), `hiprofiler` (with `plugins`),
  `procfs`, `hiperf`, `hidumper`, `uitest`, `hilog`.
- **`--rounds <n>`, `--only <ids>`, `--keep-going`, `--json`, `--target`.**
  Fail-fast is the default; the exit code is 1 when any step failed.
- **`scene.json` gains an optional `step: { round, index, id }` block**, so a
  scene copied out of a run is still self-describing. The version stays `1`
  and every existing reader keeps working.
- **Public surface:** `parseScenario`, `executeAction`, `ScenarioRunner`,
  `writeRunFiles`, `COLLECTOR_NAMES`, and the `Scenario` / `ScenarioStep` /
  `ScenarioAction` / `StepCapture` / `CollectorName` / `ActionDevice` /
  `ActionOutcome` / `RunResult` / `RunStepResult` / `RunOptions` /
  `RunnerCollectOptions` / `RunnerDevice` / `SceneStepRef` types.

### Semantics worth naming

- **Validation precedes the first device call.** Unknown keys, a duplicate
  step `id`, an `id` outside `^[a-z][a-z0-9_-]*$`, an empty or duplicated
  `collectors` list, `hitrace` with `hiprofiler`, `plugins` without
  `hiprofiler`, a duration outside `(0, 2^31-1]`, an unknown action kind or an
  unknown key on one — each is a typed `SCENARIO_BAD_INPUT` /
  `SCENARIO_BAD_STEP` naming the JSON path. A scenario that would fail on step
  3 never fails after two captures have run.
- **A failed action keeps its scene.** The trace is a real measurement of what
  the device did while the action was attempted; the step is marked `failed`
  with the action's error and `sceneDir` still names it. A failed *setup* or a
  failed capture names no `sceneDir`, because there is no scene to point at.
- **`steps.json` is structurally deterministic.** Same scenario, device and
  outcomes produce identical ids, order, paths and statuses; exactly three
  fields are host clock and vary — the run's `startedAtMs`/`durationMs` and
  each action's `atMs`.
- **Measured limitation:** both the Mate 60 and the HarmonyOS emulator answer
  `cat /proc/uptime` with `Permission denied` from an ordinary shell, so
  `atNs` is absent on every device this package has been measured on. The
  field is omitted rather than fabricated as a zero (a zero would address the
  trace origin).
- **Not ported, deliberately:** Hypium/xdevice and executable Python
  testcases, metric assertions inside a scenario (that is `compare`'s
  question), device pools, and HapRay's retry-until-non-empty behavior —
  silently re-running until something appears is how an empty capture becomes
  a plausible number.

## 0.7.0 — 2026-11-17

P12 (HapRay parity W4): the device log, captured and evaluated.

### Features

- **`collect --hilog`** streams the device log for the capture window into
  `hilog.log`, plus `hilog.jsonl` — one typed row per line. The capture is
  device-wide, so no `--app` is required. An empty stream is a failed capture
  (`HILOG_NO_OUTPUT`), never a quiet app: hdc exits 0 even when the device tool
  fails, so content is the only honest success signal. `hilog.stream` joins the
  capability matrix, gated on the `hilog` binary.
- **`HilogAnalyzer`** (`hilog` section) evaluates the log against a typed rule
  set. Metrics: `hilog.lines.count`, `hilog.parsed.count`,
  `hilog.unparsed.count`, `hilog.rule.<name>.count` per rule, and
  `hilog.rules.matched.count` / `.unmatched.count`. One `hilog_match` evidence
  item per matching rule, carrying the count, the first and last line, up to
  five sample messages and drill-downs.
- **Rule set without `eval`.** `HilogRule` is `{ name, regex, groups,
  conditions, scope }`; conditions are either per-group comparisons or an
  expression over `$1`, `$2`, … parsed into an AST and evaluated. A malformed
  regex or expression is a typed error naming the rule. HapRay's four
  `CreatePixelMap` rules ship as `DEFAULT_HILOG_RULES`.
- **Three named queries:** `hilog.matches` (optionally one rule),
  `hilog.rules` (the effective rule set with counts), and `hilog.around` (lines
  in an inclusive nanosecond window, for correlating with a frame). Each returns
  `[]` when the scene has no log.
- **Public surface:** `parseHilogLine`, `parseHilogText`, `compileRules`,
  `matchRules`, `DEFAULT_HILOG_RULES`, `HilogAnalyzer`, `HilogCollector`,
  `readHilogText`, and the `HilogLine` / `HilogRule` / `HilogMatch` /
  `CompiledRule` / `HilogParseOptions` types.

### Semantics worth naming

- A log line that does not parse is a `raw` row (`parsed: false`), counted in
  `hilog.lines.count` and `hilog.unparsed.count` — never dropped.
- A scene with no `hilog.log` yields one `hilog.degraded` proxy naming the
  capture flag. A log with no rule matches is a real zero, not a degradation.
- The year is not in the log. It comes from `scene.json`'s capture time, and a
  month/day after the capture is read as the previous year — the one reading
  that cannot invent a future log. A scene with no descriptor keeps every line
  raw rather than guessing an instant.
- Not ported, deliberately: `hilogtool` decryption (this package captures
  plaintext over `hdc shell hilog`), on-device persistent log rotation, and
  log-based crash classification.

## 0.6.2 — 2026-11-17

### Fixes

- **`native_memory` evidence aborted the whole analysis on a real capture.**
  `pointEvidence` passed no `key`, so every row at one point hashed to the same
  id — same window, usually same process, thread and pid. Two live rows on one
  thread, or a capture whose peak falls at the last event (peakTs === endTs),
  failed `analyze`, `report` and `compare` with `DUPLICATE_EVIDENCE_ID`. The
  spec's `native-memory:<point>:<callchainId>:<pid>:<tid>` key is now passed.
- **The peak's unreleased set was replayed past the peak.** `unreleasedAt(ts)`
  stopped on the timestamp alone, so a free sharing the peak's instant was
  already applied and `mem.native.unreleased.peak` reported the post-free
  state — often zero. The replay now stops at the peak event's `(ts, id)`
  position, and `peakId` travels on the result.
- **The statistic fallback fabricated a zero for the wrong app.** The presence
  check was table-wide: with `native_hook` empty and statistic rows only for
  another pid, the analyzer reported "0 bytes across 0 callchains" as a proxy
  measurement. The check is app-scoped now, so that scene degrades with a
  reason.
- **`native-memory` never ran on a nativehook-only scene.** The offline
  capability rule required the memory plugin's `process_measure` tables, so the
  capture `collect --hiprofiler --plugins nativehook` produces — the
  analyzer's own primary input — was reported as `native-memory.degraded` with
  the data in the database. Either table family (`process_measure*` or
  `native_hook*`) now satisfies `mem.native_hook`.
- **A real capture could abort the query layer.** `frames()` and `dataDict()`
  bound one `IN (?, …)` per id list and exceeded SQLite's 32 766-variable
  limit; id lists are chunked at 500 now, as upstream does.
- **A partial trace threw `no such table: process`** from `events()` and
  `statistics()`, breaking the documented "returns `[]` when a table is
  absent" contract. Both accessors guard the join.
- **A duplicated `process.ipid` multiplied every event.** A merged trace with
  two `process` rows for one ipid returned each `native_hook` row twice,
  doubling alloc/free bytes and the peak. Both joins now select `DISTINCT`.
- **A NULL `event_type` counted as an allocation.** `event_type ?? 0` inflated
  the running total with bytes whose direction is unknown; `null` now reaches
  the pairing layer as `other`.
- **A zero-size free was counted as unpaired**, inflating
  `mem.native.free.unpaired.count` with a free that consumed nothing.
- **APP classification covered only `bundle/`.** Upstream's `APP_ABC` rule
  covers the whole `/proc/<pid>/data/storage/` sandbox, so a cache db or a
  hap's own `.so` was reported as `SYS_SDK`. Those paths are `APP` now.
- **The site's statistics disagreed with its own text** — the analyzers stat
  read 14 while the page said sixteen, and the Chinese test count read 1076
  against the English 1126.

## 0.6.1 — 2026-11-17

### Fixes

- **`frame.load.*` drill-downs returned nothing on a real `--hiperf` scene.**
  A perf capture converts into `perf.db`, so `perf_sample` and `perf_thread`
  are not in `trace.db`; every `frame.load.threads`, `.symbols` and `.files`
  query read the trace handle and answered `[]`, while `analyze` reported a
  non-zero `frame.load.total` and offered those very handles. `QueryContext`
  gains `perfDb`, the four queries go through one resolver, and the CLI query
  path passes `scene.perfDb`. Measured on a split scene: `[]` before, the
  attributed rows after.
- **Empty-frame evidence no longer fabricates load.** Without perf samples, or
  with samples that fall in no frame window, each `empty_frame` item reported
  `load: 0`, `loadShare: 0` and a `loadRank` of 1..n while the same result
  carried `empty_frame.load.degraded`. The load signals and the
  `frame.load.symbols` drill-down now appear only when a load was measured.
- **Frame load read samples only up to the last-by-`ts` frame's end**, so a
  frame that started earlier but ended later lost its tail. The read now ends
  at the maximum frame end.
- **`compare` reported every 0.5.0 and 0.6.0 metric family as `incomparable`.**
  `frame.load.*`, `frame.stutter.*`, `frame.fps.window.*`,
  `empty_frame.load.*` and the retained-memory `mem.native.*` figures now have
  directions; activity volumes (`mem.native.events.count`, `.peak.offset`,
  `frame.fps.window.count`, `frame.load.span.weight`) deliberately keep none.
- **The empty-frame degraded reason always claimed `--hiperf` was missing**,
  even when the capture had samples for another process. It now names the real
  gap.
- **A long capture could crash the empty-frame and `rs_skip` analyzers.**
  `Math.min(...frames)` spreads one argument per frame and throws past V8's
  argument limit (~124k); the three sites use a reduce.
- **Two `frame_load` evidence items could share an id.** `frame_no` is 0 on
  every real row, so same-process frames with equal `(ts, dur)` hashed
  identically and the engine failed the whole analysis with
  `DUPLICATE_EVIDENCE_ID`; the row id now separates them.

## 0.6.0 — 2026-11-17

### Added

- **Native memory** (`native-memory` analyzer, `mem.native.*`) from
  hiprofiler's `nativehook` plugin. `NativeHookQuery` gives typed, batched
  access to `native_hook`, `native_hook_frame` and `native_hook_statistic`,
  returning `[]`/`false` rather than throwing when a table is absent.
  - Events are alloc for `AllocEvent`/`MmapEvent`/`0` and free for
    `FreeEvent`/`MunmapEvent`/`1`; `heap_size` is read as a magnitude and the
    direction comes from the event type. Anything else is counted but moves
    nothing.
  - Frees are paired **per address, LIFO** with partial-free remainders,
    because a runtime can reuse an address before releasing the previous
    block. The running total carries its peak (earliest event on a tie),
    trough and end. A trough far below zero means the capture started
    mid-lifetime and every absolute figure is a lower bound.
  - Metrics: `mem.native.events.count`, `.alloc.count/.bytes`,
    `.free.count/.bytes`, `.total.peak/.trough/.end`,
    `.unreleased.peak/.end`, `.unreleased.unattributed.bytes`,
    `.alloc.unaddressed.count`, `.free.unpaired.count`,
    `.callchains.count` and `.peak.offset`.
  - Live allocations at the peak and at the end are aggregated per callchain,
    process and thread (`aggregateUnreleased`), with the file and symbol
    resolved from the leaf frame through `data_dict`, and become
    `native_memory` evidence: top 10 at each point, `warn` at or above 5% of
    that point's live total, drilling down to `mem.native.callchain`,
    `mem.native.unreleased` and `frames.all`.
  - `buildNativeTimeline` buckets alloc/free bytes and the running total at a
    fixed width anchored at the first event, omitting empty buckets and
    flagging the peak bucket.
- **Component classification** (`classifyNativePath`, `native-kinds.ts`).
  HapRay's `kind.json` table — 7 kinds, 22 components, 125 path rules and 25
  thread rules — ported as a checked-in constant, with exact-path, regex,
  app-bundle, basename, `SYS_SDK` and thread fallbacks. A symbol refines an
  ArkTS `.abc` frame to its package and a KMP frame to its Kotlin package.
- **Named queries**: `mem.native.unreleased` (`point: peak | end`),
  `mem.native.callchain`, `mem.native.timeline` (`bucketMs`) and
  `mem.native.categories`, all returning `[]` when the native tables are
  absent.

### Honesty and divergences from upstream

- "Unreleased" means still allocated when the capture stopped — it is not a
  leak claim. No leak labels are emitted.
- A capture with only `native_hook_statistic` reports
  `mem.native.statistic.fallback` and `mem.native.unreleased.end` as proxies
  with a reason, and emits no peak, timeline or per-thread split: those rows
  carry no per-allocation timestamp, thread or address.
- Upstream loads one rule list into both an exact dict and a regex list, so a
  rule containing a metacharacter matches both ways and exact precedence is
  accidental. Here each rule is exactly one of the two, decided once by
  upstream's own metacharacter test.
- `all_heap_size` and `current_size_dur` are read but never interpreted:
  their semantics are undocumented upstream and the report does not use them.
- No `native_hook` rows and no statistics yield one `mem.native.degraded`
  proxy naming `hiprofiler --plugins nativehook` and the debuggable-app
  requirement — never a zero. Both recorded traces have empty `native_hook`
  tables, so `native-memory` degrades there: `emu_big` reports 74 metrics and
  94 evidence items, `real_device` 73 and 180.

## 0.5.0 — 2026-11-17

### Added

- **Frame load** (`frame-load` analyzer, `FrameLoadIndex`). A frame's load is
  the summed `perf_sample.event_count` of every app-process thread inside the
  frame's own **inclusive** `[ts, ts + dur]` window — sample weight, never
  instructions, CPU time or power. One batched sample read answers every
  frame, so a 10k-frame trace does not run 10k table scans. Metrics:
  `frame.load.frames.count`, `.total`, `.avg`, `.min`, `.max`,
  `.top10.share` and `.span.weight`; the top-10 loaded frames become
  `frame_load` evidence with rank, share, duration, offset, vsync, flag and
  the heaviest thread, each drilling down to `frames.get`,
  `frame.load.threads`, `frame.load.symbols` and `callstack.range`.
  Overlapping app frames (ui and render in one vsync period) each count a
  sample, so per-frame totals can exceed `span.weight`, the unique weight read
  for the span; both numbers are reported so the difference is visible.
- **Stutter grading** in the frame analyzer. Each stuttered frame
  (`type = 0`, `flag = 1`) is paired with the first expected frame
  (`type = 1`) of its vsync group ordered by `(ts, id)`, and the excess
  (`actual.dur - expected.dur`) is graded level 1 (< 2 frames), level 2
  (< 6) or level 3, using integer nanosecond math against a 16.67 ms budget.
  Metrics: `frame.stutter.count`, `.unpaired.count`, `.level1/2/3.count`,
  plus `.ui/.render/.sceneboard.count` and `.rate`; a stuttered frame with no
  expected frame in its group has no level and is counted as unpaired, so the
  levels plus unpaired always sum to the stutter count.
- **1-second FPS windows** (`computeFpsWindows`). Fixed tumbling windows
  anchored at the first rendered frame, every window exactly 1 s, a frame on a
  boundary belongs to the next window, and idle gaps appear as explicit zero
  windows. Metrics: `frame.fps.window.count`, `.min`, `.max`, `.mean`. The
  whole-span `frame.fps` stays `approximate` and keeps its own id.
- **Empty-frame load** in the empty-frame analyzer:
  `empty_frame.load.total`, `.share` (empty load over the summed load of all
  app actual frames) and `.severity` (`normal` < 3%, `moderate` < 10%,
  `severe` ≥ 10%). Each confirmed empty frame's evidence gains `load`,
  `loadShare` and `loadRank`, plus a `frame.load.symbols` drill-down.
- **Leaf attribution**: `PerfQuery.leafAttribution(threadIds, range)`
  attributes each sample's full weight to the deepest frame of its callchain,
  sorted by weight then symbol then file path.
- **Named queries**: `frames.fpsSeries`, `frame.load.threads`,
  `frame.load.symbols` and `frame.load.files`, all returning `[]` when the
  perf tables are absent. Shares are of the window's summed app-thread
  weight, so unattributed samples remain visible as rows not summing to 100%.

### Honesty and divergences from upstream

- No ±1 ms window expansion. Upstream widens every frame window by a
  millisecond, which inflates load for overlapping frames and is why its empty
  share can exceed 100%. With exact windows the empty numerator is a subset of
  the denominator, so `empty_frame.load.severity` stops at `severe`; upstream's
  unreachable `extreme` label is deliberately not ported.
- `high_load_frames` (`frame_load > 80`) is not ported: it compares an
  instruction count against a percentage. `frame.load.top10.share` answers the
  same question with a defined unit.
- No perf samples, no app perf threads, or samples that exist but fall inside
  no frame window all yield one `frame.load.degraded` /
  `empty_frame.load.degraded` proxy naming the cause — the last case names the
  likely time-base mismatch. No load metric is ever a fabricated zero.

## 0.4.0 — 2026-11-17

### Added

- `ohos-perf report <scene> --out <dir> [--baseline <input>]` — one analysis
  pass rendered as a typed, deterministic artifact bundle: `report.html`
  (self-contained, no scripts, no network), `report.json` (versioned report
  model), `summary.json` (per-section roll-up), `metrics.csv`, `evidence.csv`
  and `report.xlsx` (dependency-free stored-ZIP workbook with `Summary`,
  `Metrics`, `Evidence` and, with a baseline, `Compare` sheets).
- `runAnalyzerSections()` in the core engine: the same merged `AnalyzeResult`
  as `runAnalyzers()` plus one section per analyzer, so a report can attribute
  every metric to its source and label a skipped analyzer `degraded` with the
  device's own reason.
- Every metric in the HTML and CSV keeps its `fidelity` and `provenance`;
  degraded sections are named in the report-wide banner, the summary and the
  CLI's `sections` line.
- Identical scene and package version produce byte-identical files across
  platforms: no timestamps, no host paths, fixed ordering and a ZIP epoch
  timestamp in the workbook.

## 0.3.0 — 2026-11-17

### Added

- `GestureDriver` and `ohos-perf gesture {click,swipe,key,input,text}` — UI
  injection through `uitest uiInput`, so a scene can be driven into the state
  worth measuring. `ui.gesture` is now a capability the package can actually
  drive: success is the device tool's `No Error` marker, because `hdc` returns
  0 even when the device tool fails. Coordinates, velocity (200–40000) and key
  names are validated before the device is touched; text is shell-quoted and
  control characters are refused.
- `Device.gesture()` gates on `ui.gesture`, and the CLI gesture commands honour
  `--target` and `--json` like the other device commands.
- `ohos-perf emulator {list,start,stop,create}` — the HarmonyOS emulator
  lifecycle, so CI and an agent can boot their own target instead of relying on
  an attached device.
  - `list` reports each instance and the `hdc` TCP target it owns; `--json`
    prints that `target`, which `collect --target` consumes directly. A target
    is attributed only when exactly one running instance maps to exactly one
    connected TCP target, and the reason is reported when it is not.
  - `start` blocks until `bootevent.boot.completed` reads `true` on the guest
    and reports the boot time. `--timeout <seconds>` bounds the wait (default
    180); starting an already-running instance is a safe no-op. A timeout never
    kills the emulator — the message names the `stop` command.
  - `stop` waits until the instance reports `isRunning: false`, because
    `-stop` returns success before the state changes.
  - `create` builds an instance from an **already-downloaded** image. It never
    downloads one: a missing image exits 1 with the exact `-install` command to
    run first, and the name, duplicate and memory/storage ranges are all
    validated before anything is spawned.
- `EmulatorClient` and `EmulatorLifecycle` exported from `@ohos-perf/core`,
  split so spawn-and-parse is testable against recorded output and the waiting
  logic is testable with a plain object. Instance and image roots follow
  `--instance-path`/`--image-root` → `OHOS_PERF_EMULATOR_INSTANCE`/
  `OHOS_PERF_EMULATOR_ROOT` → DevEco's `.emu_config` → `%LOCALAPPDATA%`.
- `EmulatorCommandError`, `EmulatorImageMissingError` and
  `EmulatorNotFoundError`, so a failure the binary reports with exit code 0 is
  still a typed error.

### Fixes

- The emulator's exit code usually carries no information: a rejected `-create`
  or an unknown option exits 0. Success is proven by re-reading state, a
  failure line outranks the exit code (the one measured non-zero failure,
  `Unable to start the emulator`, still reports its own sentence), and a
  `-start` that keeps running (the process becomes the emulator) is no longer
  mistaken for a hang.
- `coverage` no longer reports available merely because `hiprofiler_cmd`
  exists. The probe now checks `bjc_cov` — measured absent on the Mate 60, where
  `aa` also prints nothing over plain shell — and the capability stays
  unavailable because no collector in this package consumes its output.

### Changed

- `js.heap`'s reason now names the measured `hidumper --mem-jsheap` gate
  (`needs a debug-signed or profilerable app`) in addition to the missing
  analyzer, so an agent does not chase a build that still would not work.

### Removed

- The claim that `ui.gesture` needs the AAMS test framework. That gate belongs
  to `uitest uiRecord`, a different command; `uitest uiInput` works over the
  plain shell.

## 0.2.0 — 2026-11-16

### Analyzers

- Six analyzers ported from ArkAnalyzer-HapRay rev `9386e4e`, taking the
  analyzer count from eight to fourteen:
  - `gc` — `gc.*`: invocations per phase (full, partial, shared) over the whole
    `callstack` span, `gc.rate`, and the app's share of perf samples from GC
    threads. Degrades `gc.perf.share` to a proxy when `perf_sample` is empty.
  - `vsync` — `vsync.*`: cadence mismatches and high/low-frequency periods,
    scoped to the app's own vsync groups.
  - `empty-frame` — `empty_frame.*`: frames that rendered nothing, with
    HapRay's two false-positive filters.
  - `rs-skip` — `rs_skip.*`: RenderService `DisplayNode skip` events
    reverse-traced through NativeWindow, plus a trace-accuracy figure.
  - `flamegraph` — `flamegraph.*`: folded stacks weighted by
    `perf_sample.event_count`; needs `--hiperf` on a debuggable app.
  - `components` — `components.*`: ArkUI component builds and recycle-pool
    reuse from `H:CustomNode:Build*` events.
- `round2HalfEven` reproduces Python's `round(x, 2)` (half-even on the exact
  double) so component-reuse ratios match HapRay at `0.125`.

### Capabilities

- New `trace.ark` capability (Ark-runtime trace events: GC phases and
  `H:CustomNode` builds). It is a hitrace row gated offline on `callstack`,
  `thread` and `process`, taking the matrix from 20 to 21 verdicts.

### Library

- `CallstackQuery` gains an `ipids` scope for per-process counts and matching.
- `PerfQuery` gains `eventCount`, `threadIdsNamed` and `foldedStacks`, so
  folded-stack aggregation is weighted by `event_count` rather than row count.
- `resolveAppIpids` is now exported from `@ohos-perf/core`; it maps pids to
  trace ipids, which are different number spaces.

### Fixes

- `analyze` reports 56 metrics and 92 evidence items on the recorded emulator
  trace and 55 / 178 on the recorded Mate 60 trace, still byte-identical across
  runs.

## 0.1.0 — 2026-11-16

First public release of `@ohos-perf/core` and `@ohos-perf/cli`.

### Capabilities

- One-shot device probe producing 20 capability verdicts; an unavailable
  capability is a value with a reason, never a silent zero. Measured on a
  Mate 60: 19 / 20, with `js.heap` reporting that no analyzer in this package
  consumes the `js_heap_*` tables.
- Six collectors: hitrace, procfs, hiprofiler (`ftrace`, `gpu`, `xpower`,
  `nativehook`, `memory` plugins), hiperf, hidumper and uitest. `--hidumper`,
  `--uitest` and `--hiprofiler --plugins memory` capture device-wide without
  `--app`; pid-resolving modes are gated before the first device call.
- `trace_streamer` ingest into a scene directory, with `scene.json` recording
  the device, pids, collectors and app.
- Typed queries over the 88-table trace database, including `MemMeasureQuery`
  over the memory plugin's `process_measure` tables.
- Eight analyzers: frames, fault tree, binder, threads, memory, memory measure,
  startup and render. Metrics carry `fidelity` and `provenance`; evidence
  carries drill-down handles.
- `mem.measure.rss.peak` / `mem.measure.rss.avg`: exact per-process RSS in
  bytes from the hiprofiler memory plugin, attributed by trace ipid.
- Named drill-down queries (`ohos-perf tools`, `ohos-perf query`), baseline
  comparison (`ohos-perf compare`), and the `ohos-perf` agent skill.

### Guarantees

- Deterministic JSON: metrics sorted by `id`, evidence by
  `(kind, window.startNs, id)`; the same input produces byte-identical output.
- Zero runtime dependencies in `@ohos-perf/core`; Node's built-in `node:sqlite`
  instead of a native module.
- Collector contract: validate before the first device call, remove fixed
  device paths, require the tool's own success marker; `hdc` exit 0 is never
  evidence.

### Known gaps

- `ui.gesture` requires the AAMS test framework and stays unavailable over
  plain shell.
- `coverage` has no known plugin and reports the binary-only verdict.
- `js.heap` analysis is not implemented; the capability reports why.
- HapRay's UI animation diff is not ported: it needs per-step `pages.json`,
  element trees and screenshots that no collector in this package produces.
  The `ohos-perf emulator` lifecycle commands are planned.
