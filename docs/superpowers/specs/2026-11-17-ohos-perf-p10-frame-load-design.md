# P10 — Frame load, stutter levels and FPS windows (HapRay parity W2)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.5.0`
**Builds on:** P9 report artifact layer (`0.4.0`); HapRay `9386e4e`
**Gap-analysis rows:** 8 (frame stutter / FPS), 10 (empty frames), part of 12
(frame loads / trace frames JSON)

## Why this phase

The frame analyzer currently answers "how many frames, how many were flagged
late, how many were empty, mean duration, whole-span FPS". HapRay's frame
surface answers three further questions that dominate real triage:

1. **Where did the time go in a frame?** HapRay sums `perf_sample.event_count`
   for every app thread inside each frame window and reports per-frame load,
   top loaded frames, and per-thread / per-file / per-symbol attribution.
2. **How bad is a stutter?** HapRay pairs each late frame with the first
   expected frame in its vsync group and grades the excess (mild < 2 frames,
   moderate < 6 frames, severe otherwise), split across ui / render /
   sceneboard processes.
3. **Was the frame rate steady?** HapRay computes 1-second FPS windows; our
   `frame.fps` is a deliberately approximate whole-span average and the gap
   analysis flags the two as incomparable.

P9 gave every analyzer a place to put this data; P10 fills in the frame
family, without inventing units or porting HapRay's broken percentage.

## Scope

**In scope**

- `frame-load` analyzer: per-frame sampled-event load, summary metrics,
  top-10 evidence, degraded result without perf samples.
- `FrameLoadIndex`: one batched sample read shared by the analyzer, the empty
  frame analyzer and the named queries.
- `PerfQuery.leafAttribution()`: leaf symbol/file attribution weighted by
  `event_count`.
- Stutter grading in `FrameAnalyzer`: expected/actual pairing, excess, levels
  1–3, unpaired count, per-process ui/render/sceneboard counts and rates.
- 1-second FPS windows in `FrameAnalyzer` (`computeFpsWindows`) and four
  window metrics.
- Empty-frame load, load share and the documented severity ladder, using the
  exact frame windows (no ±1 ms expansion).
- Named queries: `frames.fpsSeries`, `frame.load.threads`,
  `frame.load.symbols`, `frame.load.files`.
- Report section title `frame-load`, docs, skill query list, site/roadmap at
  release.

**Out of scope, deliberately**

- HapRay's ±1 ms time-window expansion. It makes overlapping frames inflate
  load and is the stated reason upstream percentages can exceed 100. Our
  windows are the frame's own `[ts, ts + dur]`, inclusive at both ends,
  matching the exit criterion in the gap analysis.
- HapRay's `high_load_frames` (`frame_load > 80`, an instruction count compared
  against a percentage). It is a unit error: on every measured trace every
  frame with any sample exceeds 80. We report `frame.load.top10.share` — a
  documented load-concentration metric — instead.
- HapRay's unvalidated browser power estimate (`instructions × 456372767`).
- Empty-frame wakeup-chain attachment, Flutter detector and RS-skip detection
  breakdown. They belong to W6/W3; P10 only attaches exact load to the frames
  the existing two filters already confirm.
- Per-frame attribution persistence in the report model. Attribution is an
  on-demand drill-down (`frame.load.*` queries) behind every top-frame
  evidence item; the report stays bounded.

## Semantics

### Per-frame load

A frame's load is the summed `perf_sample.event_count` of every app-process
thread whose `timestamp_trace` falls inside the frame's own **inclusive**
`[ts, ts + dur]` window. `event_count` is sample weight, not a row count and
not an assumed instruction unit; every metric names the collector `hiperf`
and the table `perf_sample`.

- App processes are `ctx.app.pids`; app threads are `perf_thread` rows with
  `process_id` in that set (pids, not ipids — the same number space HapRay
  uses).
- Per-frame load is a **window aggregate**. When app frames from several
  processes overlap in time (ui and render frames in one vsync period), the
  same sample contributes to each frame's load, exactly as HapRay's batch
  path does. `frame.load.span.weight` exposes the non-double-counted total,
  so a consumer can see the difference.
- A frame with `dur <= 0` uses the point window `[ts, ts]`; a sample exactly at
  `ts` counts.

### Frame sets

- `frame.load.*` summary and top-10: app actual frames (`type = 0`,
  `ipid` in the app's trace ipids) that are **rendered** (`flag !== 2`), the
  same set as the jank denominator. Expect frames are predictions and empty
  frames are measured separately.
- Empty-frame load: confirmed empty frames from the existing two filters.
  The share denominator is the summed per-frame load of **all** app actual
  frames (including empty ones), on the same per-frame basis, so numerator and
  denominator are one definition.
- Stutter levels and FPS windows: the frames `FrameQuery.all(ctx.window)`
  returns, matching the existing `frames` analyzer (HapRay's stutter path is
  also trace-wide, not app-scoped).

### Stutter pairing and levels

For each `vsync` value, the expected frame is the first `type = 1` row in that
group ordered by `(ts, id)`. The `(ts, id)` tie-break is ours; upstream reads
un-ordered rows. A stuttered frame (`type = 0`, `flag = 1`) is paired with the
expected frame of its vsync group, whatever process owns it — upstream does
not require the same ipid either.

- `excessNs = frame.dur - expected.dur`; `excessFrames = excessNs / 16.67 ms`.
- Level 1 when `excessFrames < 2`, level 2 when `< 6`, level 3 otherwise.
  Negative excess is level 1. The constants are `FRAME_BUDGET_MS = 16.67`,
  `STUTTER_LEVEL_1_FRAMES = 2`, `STUTTER_LEVEL_2_FRAMES = 6`, copied from
  HapRay.
- A stuttered frame with no expected frame in its group has no level; it is
  counted by `frame.stutter.unpaired.count`, so
  `level1 + level2 + level3 + unpaired = frame.stutter.count`.
- Process classes: `render_service` → render, `ohos.sceneboard` → sceneboard,
  anything else (including an unresolved ipid) → ui, matching HapRay's
  fallback. A duplicate ipid resolves to the lowest `process.id`.
- The unreachable upstream clause that grades `flag = 3` as mild is not
  ported: the stutter loop only examines `flag = 1`, so the clause can never
  fire. Flag-3 frames remain in counts but receive no stutter level.

### FPS windows

`computeFpsWindows(frames, windowMs = 1000)`:

- Input frames are actual rendered frames (`type = 0`, `flag !== 2`),
  de-duplicated and sorted by `ts` (then `id`).
- The first window starts at the first frame's `ts`. Windows tile forward by
  `windowMs` and are always exactly `windowMs` long, including the last one,
  matching HapRay's `FPS_WINDOW_SIZE_MS = 1000`. A frame at exactly a window
  boundary belongs to the next window. Gaps longer than one second produce
  explicit zero-frame windows.
- FPS is `frames / (windowMs / 1000)`. A capture that ends mid-second
  therefore under-reports its final window — the standard tumbling-window
  artifact, stated in the query description.
- Metrics: `frame.fps.window.count`, `.min`, `.max`, `.mean` (fps). They are
  omitted when there are no rendered frames rather than emitted as zero, and
  `frame.fps` keeps its whole-span, `approximate` fidelity.

### Empty-frame load and severity

- `empty_frame.load.total` — summed per-frame load of confirmed empty frames.
- `empty_frame.load.share` — that total over the summed per-frame load of all
  app actual frames × 100. It is a load share, hence its id says load; the
  existing frames-based `empty_frame.rate` keeps its own name. With exact
  non-expanded windows the share is normally ≤ 100; overlapping app frames
  can still push it above, and the metric documentation says so.
- `empty_frame.load.severity` — `normal` (< 3%), `moderate` (< 10%),
  `severe` (≤ 100%), `extreme` (> 100%), the upstream ladder applied to our
  exact share. The metric value is the label, unit `none`, fidelity `exact`.
- Without perf samples the three metrics are replaced by one
  `empty_frame.load.degraded` proxy naming the capture requirement; the
  frame-count metrics stay measured.

### Attribution

- `PerfQuery.leafAttribution(threadIds, range)` groups samples by
  `callchain_id`, resolves each chain through the existing symbol lookup, and
  attributes the full sample weight to the **last** function in depth order
  (the leaf). Rows are `{ symbol, filePath, samples }`, sorted by `samples`
  descending, then symbol, then filePath. A chain with no frames, or with no
  resolved symbol, contributes nothing.
- `FrameLoadIndex.threadLoads(frame)` reports the same per-frame window split
  by app thread, with `threadName` from `perf_thread` (`''` for a named-empty
  thread, `unknown` when no `perf_thread` row exists).
- Shares in the named query rows are over the window's summed app-thread
  weight, so unattributed samples remain visible as rows not summing to 100%.

## Library surface

```ts
// packages/core/src/analyze/frame-load.ts
export interface FrameLoadThread { threadId: number; threadName: string; samples: number; }
export class FrameLoadIndex {
  static build(input: {
    perf: PerfQuery;
    pids: readonly number[];
    range: TimeRange;
  }): FrameLoadIndex | undefined;   // undefined: no perf tables/rows/threads
  readonly sampleRows: number;      // perf_sample rows read
  readonly threadCount: number;     // distinct app thread ids
  readonly spanWeight: number;      // sum(event_count) over the span

  load(frame: Pick<Frame, 'ts' | 'dur'>): number;
  threadLoads(frame: Pick<Frame, 'ts' | 'dur'>): FrameLoadThread[];
}
export class FrameLoadAnalyzer implements Analyzer { /* id: 'frame-load' */ }

// packages/core/src/analyze/fps.ts
export interface FpsWindow { startNs: number; endNs: number; frames: number; fps: number; }
export function computeFpsWindows(
  frames: readonly Frame[], windowMs?: number,
): FpsWindow[];

// packages/core/src/query/perf.ts
export interface PerfLeafAttribution { symbol: string; filePath: string; samples: number; }
leafAttribution(threadIds: readonly number[], range: TimeRange): PerfLeafAttribution[];
```

`FrameLoadAnalyzer.requires` is `['trace.frames', 'perf.samples']`. When the
capability is absent the engine emits its usual degraded section; when the
capability is present but the scene has no usable samples, the analyzer emits
`frame.load.degraded` (fidelity `proxy`, reason naming `--hiperf` / debuggable
app) plus a `no_data` evidence with a `frames.all` drill-down. No load metric
is ever a fabricated zero.

A third degraded case guards a silent wrong answer: `spanWeight > 0` but the
summed per-frame load is `0`. That means samples exist yet none fall inside
any frame window — most plausibly the two tables use different time bases.
Reporting exact zeros would look like a workload-free app, so the analyzer
emits `frame.load.degraded` with a reason that names the time-base
possibility. The empty-frame analyzer applies the same guard.

## Metric families

| id | unit | set |
| --- | --- | --- |
| `frame.load.frames.count` | count | rendered app frames |
| `frame.load.total` | count | sum of per-frame load |
| `frame.load.avg` / `.min` / `.max` | count | per-frame load |
| `frame.load.top10.share` | % | top-10 load / total |
| `frame.load.span.weight` | count | unique sample weight in span |
| `frame.load.degraded` | count | proxy when no samples |
| `frame.stutter.count` | count | stuttered frames |
| `frame.stutter.unpaired.count` | count | stuttered without expected |
| `frame.stutter.level1.count` / `2` / `3` | count | graded stutter |
| `frame.stutter.ui.count` / `.render.count` / `.sceneboard.count` | count | stuttered by class |
| `frame.stutter.ui.rate` / `.render.rate` / `.sceneboard.rate` | % | stuttered / rendered in class |
| `frame.fps.window.count` / `.min` / `.max` / `.mean` | count/fps | 1 s windows |
| `empty_frame.load.total` | count | confirmed empty frames |
| `empty_frame.load.share` | % | load definition above |
| `empty_frame.load.severity` | none (string) | ladder label |
| `empty_frame.load.degraded` | count | proxy when no samples |

Provenance: frame metrics keep `{ collector: 'hitrace+streamer', table:
'frame_slice', rows: frames.length }`; load metrics use `{ collector:
'hiperf', table: 'perf_sample', rows: sampleRows }`.

## Named queries

| name | args | rows |
| --- | --- | --- |
| `frames.fpsSeries` | `startNs`, `endNs` | `FpsWindow[]` |
| `frame.load.threads` | `startNs`, `endNs` | `{threadId, threadName, samples, share}[]` |
| `frame.load.symbols` | `startNs`, `endNs` | `{symbol, filePath, samples, share}[]` |
| `frame.load.files` | `startNs`, `endNs` | `{filePath, samples, share}[]` |

All four return `[]` when the perf tables are absent rather than throwing.
Every top-frame evidence item drills down to `frames.get`,
`frame.load.threads`, `frame.load.symbols` and `callstack.range`; every empty
frame evidence item drills down to `frames.get` and `frame.load.symbols`.

## Fidelity and honesty rules

- `event_count` is sample weight; no metric claims instructions, CPU time or
  power. The report's unit column reads `count` and the explain says
  "sampled events".
- `frame.fps` stays `approximate` (whole-span). Window metrics are `exact`
  under the documented tiling rule.
- `frame.load.*` and `empty_frame.load.*` are `exact` when samples exist and
  the index was built; a degraded proxy otherwise.
- Empty-frame severity is `exact` as a classification of the measured share,
  not as an external judgment.
- All new arrays are sorted deterministically; evidence uses the engine's
  `(kind, window.startNs, id)` order, and the top-frame rank is carried as a
  signal because the evidence array itself is chronological.

## Testing

- Unit fixtures over a temporary SQLite database:
  - frame load equals the summed `event_count` of app-process samples inside
    `[ts, ts+dur]`, inclusive at both ends, and excludes non-app threads and
    samples outside the window;
  - overlapping app frames double-count per frame while `span.weight` does
    not;
  - a zero-duration frame counts a sample exactly at `ts`;
  - levels 1/2/3 at the 33.34 ms and 100.02 ms excess boundaries, unpaired
    frames, negative excess, per-class counts/rates, and the sum invariant;
  - FPS windows: boundary frame goes to the next window, idle gaps produce
    zero windows, every window is exactly 1 s, and the series is stable
    across runs;
  - leaf attribution resolves symbols/files and orders ties
    deterministically;
  - empty-frame load/share/severity on a fixture where the frame-window sums
    are known, plus the degraded path;
  - no perf samples → `frame.load.degraded`, never zeros.
- Named-query tests for all four tools, including absent-table behaviour and
  deterministic ordering.
- Engine test: default analyzer list includes `frame-load`; every analyzer's
  drill-down tools are registered; report section title exists.
- Full suite, both typechecks, both builds. Recorded-trace e2e assertions
  stay unchanged (it has no perf tables, so `frame-load` degrades and the
  frames metrics keep their measured values).

## Exit criteria

1. On a trace with perf samples, an app frame's `load` equals the summed
   `event_count` of app-process samples in its inclusive `[ts, ts+dur]`.
2. Stutter levels match the documented excess thresholds on fixtures and the
   level/unpaired/count invariant holds.
3. A trace without perf samples emits `frame.load.degraded` with a reason and
   `empty_frame.load.degraded`, not zeros.
4. `frames.fpsSeries`, `frame.load.threads`, `frame.load.symbols` and
   `frame.load.files` are queryable, deterministic and listed by
   `ohos-perf tools`.
5. `report` renders a `Frame load` section and the new metrics without
   breaking byte-identical reruns.
6. Full test suite and both typechecks are green; release `0.5.0` updates the
   changelog, README, skill docs, site and roadmap.

## Later workstreams (roadmap context)

`0.6.0` W3 native memory · `0.7.0` W4 hilog · `0.8.0` W5 scenario runner ·
`0.9.0` W6 UI capture/diff · `0.10.0` W7 static HAP · `0.11.0` W8 symbols.
