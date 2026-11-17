# P28 — Root-cause narrative from measured evidence

HapRay parity row 36 (`root-cause`), added after the pinned revision `9386e4e`.
Re-pin the inventory to HapRay `bd5c98a` (2026-11-18).

## Why this exists

HapRay's `root-cause` action reads a report directory and asks an LLM to write a
Markdown root-cause report. It is the only HapRay capability that produces
*prose a human reads* rather than numbers. Everything it consumes, this package
already produces:

| HapRay input file | Ours |
| --- | --- |
| `trace_frames.json` | `frames` analyzer metrics + `jank` evidence |
| `trace_frameLoads.json` | `frame-load` analyzer |
| `trace_componentReuse.json` | `components` analyzer |
| `trace_ipc_binder.json` | `binder` analyzer |
| `so_file_load.json` | `symbols` analyzer |
| `redundant_thread_analysis.json` | `threads` / `threads-score` analyzers |
| `hapray_report.db` memory_records | `native-memory` / `memory` analyzers |
| `trace_emptyFrame.json` | `empty-frame` analyzer |
| hilog rules | `hilog` analyzer |
| UI animation | `ui-animate` analyzer |

So the port is not "reimplement the extractors" — it is "feed our `Evidence`
array to the model and render what comes back".

## What HapRay does, and what we do differently

Measured on the shipped source at `bd5c98a`.

1. **HapRay re-reads its own JSON files.** `signal_extractors.py` has ten
   extractors, each of which opens a report JSON and re-derives a summary. Those
   files are already summaries of the analysis, so the model is shown a summary
   of a summary and cannot see the measured numbers. We pass `Evidence` items
   directly: each carries `signals` (the measured facts), `explain` (what the
   analyzer concluded), and `drillDown` (the query that would produce the raw
   rows). The model sees the same numbers the report shows, not a paraphrase.

2. **HapRay's confidence is a model-supplied string.** `confidence: "high" |
   "medium" | "low"` is whatever the model wrote. Nothing checks it. Here the
   evidence set is filtered by *our* severities first, and a suspect that cites
   an evidence id we did not supply is rejected — the same discipline as
   `symbols recover --measure`, where a name is scored against the file.

3. **HapRay cannot run without an endpoint and cannot be inspected without
   one.** `--skip-llm` writes a "Pending Agent Inference" placeholder. Here the
   deterministic half is a real artifact: `root-cause --offline` writes the
   evidence bundle (the exact prompt input, as JSON) and a ranked, prose-free
   summary from our own severities. The model is an *optional enrichment*, and
   when it is absent the command still produces something a reader can use.

4. **HapRay's output is one file.** `root_cause.md` plus `_evidence.md`. We
   write the Markdown *and* a typed `root-cause.json` (schema-versioned, like
   every other artifact) so an agent can consume the suspects without parsing
   prose — which is the whole reason this package exists.

5. **HapRay has no grounding check.** A model can invent a file, a line number
   or a symbol. Every suspect that names a `file`/`symbol` is checked against
   what the evidence actually carried (process names, thread names, library
   names, frame symbols) and an ungrounded one is marked `ungrounded` rather
   than presented as a finding. This is the same move as `replayAgent`'s screen
   hash: the model's claim is data to be checked, not a conclusion to accept.

## Design

### Command

```
ohos-perf root-cause <scene-dir|report.json> [--offline] [--model <name>]
                      [--out <path>] [--json] [--max-suspects <n>]
```

- Input is a scene directory (analyzed on the fly, like `report`) or a saved
  `report.json` bundle (no re-analysis).
- `--offline` never calls a model: writes `root-cause.evidence.json` (the exact
  payload a model would receive) and `root-cause.md` from the deterministic
  ranking.
- Without `--offline`, a configured endpoint adds a `## Model analysis` section
  and a `suspects` array; with no endpoint configured it **falls back to
  offline** and says so on stderr, rather than failing — the evidence is the
  product, the model is the extra.
- `--json` prints the typed document.

### Artifacts (next to `report.json`)

| File | Content |
| --- | --- |
| `root-cause.json` | `RootCauseDocument` — schema-versioned |
| `root-cause.md` | human report |
| `root-cause.evidence.json` | the exact model input (always written) |

### Types

```ts
export interface RootCauseDocument {
  schemaVersion: 1;
  generator: { name: string; version: string };
  scene: { app: string; device: string; window: TimeRange };
  /** Deterministic, from our severities. Always present. */
  summary: {
    totals: { info: number; warn: number; critical: number };
    /** The one-line verdict, from the highest-severity evidence. */
    verdict: string;
  };
  /** Ranked by severity, then evidence id — deterministic without a model. */
  observations: RootCauseObservation[];
  /** Present only when a model answered. */
  analysis?: {
    model: string;
    summary: string;
    suspects: RootCauseSuspect[];
    caveats: string[];
    needsMoreData: string[];
  };
}

export interface RootCauseObservation {
  evidenceId: string;
  kind: EvidenceKind;
  severity: 'info' | 'warn' | 'critical';
  /** The analyzer's own sentence, verbatim. */
  explain: string;
  subject: { process: string; thread?: string; frameNo?: number };
  /** The measured facts, copied so a reader needs no other file. */
  signals: Record<string, number | string | readonly string[]>;
}

export interface RootCauseSuspect {
  rank: number;
  /** The evidence ids this suspect is grounded in; empty means ungrounded. */
  evidenceIds: string[];
  rootCause: string;
  fix: string;
  confidence: 'high' | 'medium' | 'low';
  /** Names the model cited that no evidence carried. Non-empty = rejected. */
  ungrounded: string[];
  triggerChain?: string;
}
```

### Model contract

Reuses `httpAgentModel` and the `AgentModel` seam — one `decide()` call, not a
loop. The prompt is a single JSON-in/JSON-out turn:

- system-ish preamble: "you are given measured evidence; cite evidence ids"
- user: the `RootCauseDocument` minus `analysis`, serialized
- expected answer: `{ summary, suspects: [{ evidenceIds, rootCause, fix,
  confidence, triggerChain? }], caveats, needsMoreData }`

`parseRootCauseAnswer` validates it: unknown evidence ids are stripped into
`ungrounded`, a suspect with no surviving id is kept but marked `ungrounded`
(so the reader sees the model tried and what it invented), and a non-JSON
answer is a typed `ROOT_CAUSE_BAD_RESPONSE` naming the first 200 chars.

### Grounding

For each suspect, the names it mentions (`file`, `symbol`, `thread`, `library`)
are extracted with a conservative regex and checked against the union of:
- every `subject.process` / `subject.thread` in the evidence,
- every `signals` value that is a string,
- every `drillDown.args` string value.

Anything not found goes to `ungrounded`. This is deliberately *not* a semantic
check — it answers one question: "did the model name something this run
measured?"

## Tasks

### Task 1 — The deterministic half

- Failing test: `buildRootCauseDocument({ analysis })` ranks evidence by
  severity then id, produces a verdict from the highest-severity item, and
  copies `signals` verbatim.
- Implement `packages/core/src/report/root-cause.ts` (types + builder).
- No model, no I/O. Pure function over `{ app, device, window, evidence }`.

### Task 2 — The model turn

- Failing test: `parseRootCauseAnswer` rejects non-JSON with a typed error,
  strips unknown evidence ids into `ungrounded`, keeps a fully-ungrounded
  suspect marked as such, and never throws on a well-formed answer with zero
  suspects.
- Failing test: `askRootCause(model, document)` builds the prompt from the
  document, calls `decide` exactly once, and returns the parsed analysis.
- Implement in `packages/core/src/report/root-cause-model.ts`.

### Task 3 — The Markdown renderer

- Failing test: sections appear in a fixed order (summary, observations,
  suspects by rank, caveats, needs-more-data); an ungrounded suspect is
  rendered with an explicit warning line; the same document renders
  byte-identically twice.
- Implement `renderRootCauseMarkdown(document)`.

### Task 4 — The command

- Failing test: `runRootCause` writes all three artifacts; `--offline` never
  touches the model seam; a missing endpoint falls back to offline and says so
  on stderr; `--json` prints the document and nothing else; an unreadable scene
  is exit 1 with one line.
- Wire `root-cause` in `program.ts` and `deps.ts` (new `rootCause` seam).

### Task 5 — Ledger, docs, release

- Re-pin `parity.ts` to `bd5c98a`, add rows 36 (`root-cause`), 37 (`build`),
  38 (LLM exploration strategy), and keep the existing 35 numbered as they are.
- Update `README.md`, `site/index.html` (en + zh), `CHANGELOG.md` for 0.23.0.
- Full `npm run verify`, device suite, tag, publish, smoke test.

## Deliberately not in this phase

- `--source-dir` / `--index-dir` (line-level code citations). HapRay needs a
  source tree and a symbol index it builds itself; our evidence has no source
  mapping, and inventing one is a separate workstream.
- `build` (row 37) — wraps `devecocli`, which is a build tool, not a
  measurement. It will be assessed on its own.
- Thermal collection (`ThermalAnalyzer`, new in `bd5c98a`) — a collector plus an
  analyzer, so it is a parity row of its own rather than part of the narrative.
