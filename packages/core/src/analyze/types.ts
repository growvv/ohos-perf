import type { CapabilityId, CapabilityMatrix } from '../device/capability';
import type { HidumperCapture } from '../collectors/hidumper';
import type { ProcfsSample } from '../collectors/procfs';
import type { ThermalCapture } from '../collectors/thermal';
import type { QueryHandle } from '../db/driver';
import type { RgbaImage } from '../image/png';
import type { SceneMetadata } from '../ingest/metadata';
import type { HilogLine } from '../hilog/parse';
import type { HilogRule } from '../hilog/rules';
import type { BinderQuery } from '../query/binder';
import type { BinderAnalysis } from './binder';
import type { CallstackQuery } from '../query/callstack';
import type { FrameQuery } from '../query/frames';
import type { MemMeasureQuery } from '../query/mem-measure';
import type { PerfQuery } from '../query/perf';
import type { ProcessQuery, ThreadQuery } from '../query/process';
import type { InstantQuery, SchedQuery } from '../query/sched';
import type { StartupQuery } from '../query/startup';
import type { ThreadStateQuery } from '../query/thread-state';
import type { Evidence } from '../report/evidence';
import type { Metric } from '../report/metric';
import type { AppIdentity, TimeRange } from '../types';
import type { UiNode } from '../query/ui';

/**
 * Everything an analyzer needs, assembled by the orchestration layer.
 *
 * The query handles are already opened over the trace database; an analyzer
 * performs no IO of its own. `app` identifies the subject under analysis,
 * `window` is the caller's requested interval, `caps` is the device capability
 * matrix (the engine decides whether `requires` is satisfied before calling
 * `run`), and `deviceId` is copied into every metric's provenance.
 *
 * The additional query fields are optional so the context can be assembled
 * incrementally while analyzers that need them are added: an analyzer may
 * declare a capability requirement that guarantees its handle is present, but
 * the type stays optional until every caller supplies it. `procfs` is present
 * only when a procfs capture accompanied the trace (the memory analyzer
 * reports `no_data` without it); `metadata` is the scene's `scene.json` when
 * the caller read one, and the startup analyzer's fallback branch needs it.
 *
 * `db` is the raw trace database handle. It exists for analyzers whose SQL the
 * typed query layer does not expose yet (the fault tree joins `process`,
 * `thread`, `callstack` and `perf_sample` in ways no query class covers). It is
 * optional because callers built before it existed still compile; an analyzer
 * that requires it must emit a `no_data` evidence when it is absent rather
 * than reporting its zero values as measurements.
 */
export interface AnalyzeContext {
  db?: QueryHandle;
  frames: FrameQuery;
  processes: ProcessQuery;
  threads?: ThreadQuery;
  sched?: SchedQuery;
  instant?: InstantQuery;
  threadStates?: ThreadStateQuery;
  callstacks?: CallstackQuery;
  perf?: PerfQuery;
  binder?: BinderQuery;
  /**
   * The binder analysis, when a caller already computed it.
   *
   * The fault tree's `ipc_binder` section is derived from this typed result
   * rather than from a shared JSON file the way HapRay does it — at its own
   * revision HapRay's registry order makes that file stale, so the section
   * reports nothing. When absent the fault tree computes the analysis itself
   * from `db`, so the section never depends on analyzer ordering.
   */
  binderAnalysis?: BinderAnalysis;
  startup?: StartupQuery;
  /**
   * The memory-plugin tables (`process_measure` joined to its filter). Present
   * only when the scene was captured with `hiprofiler: { plugins: ['memory'] }`;
   * the analyzer degrades with a reason when it is absent.
   */
  memMeasure?: MemMeasureQuery;
  procfs?: ProcfsSample[];
  /** RenderService counter snapshots; present only when a hidumper capture ran. */
  hidumper?: HidumperCapture;
  /**
   * The scene's parsed hilog rows. Absent when the scene carries no
   * `hilog.log`; the analyzer degrades with a reason rather than reporting
   * zero matches for a capture that never logged.
   */
  hilog?: HilogLine[];
  /**
   * The rule set to evaluate. Defaults to HapRay's ported rules, so a capture
   * with no user configuration still produces HapRay's numbers.
   */
  hilogRules?: readonly HilogRule[];
  /**
   * The raw `redundant_file.txt` a scene carried, when it did. HapRay's
   * cold-start redundant-file I/O reads this file; the analyzer reports
   * `no_data` with a reason when it is absent rather than three zeros.
   */
  /**
   * The scene's parsed thermal samples, when it carried a `thermal.jsonl`.
   * Absent when the scene captured no thermal data; the analyzer degrades with
   * a reason naming `--thermal` rather than reporting a cold device.
   */
  thermal?: ThermalCapture;
  redundantFile?: string;
  /**
   * The raw `coverageReport.json` a scene carried, when it did.
   *
   * Written by an external instrumented build and the `bjc` toolchain, never by
   * this package. The analyzer reports `no_data` with a reason when it is
   * absent rather than a zero — HapRay silently skips the section, which makes
   * "not measured" and "0% covered" the same absence.
   */
  coverage?: string;
  /**
   * The raw `jsheap.heapsnapshot` a scene carried, when it did.
   *
   * Captured by `collect --jsheap`, which needs a debug-signed or profilerable
   * app. The analyzer parses it into heap metrics and reports `no_data` with a
   * reason when it is absent, rather than a zero-byte heap — the device route
   * is unavailable on the hardware measured so far, so a scene is the only way
   * in and its absence has to be visible.
   */
  jsheap?: string;
  /**
   * An edge ceiling for the snapshot's dominator graph, overriding the
   * reader's default ({@link MAX_GRAPH_EDGES}).
   *
   * Retained attribution materializes the graph, so a constrained caller — one
   * analysing on a small device or alongside other work — can lower the
   * ceiling and still get the heap totals. Past the ceiling the analysis
   * reports the size and omits attribution rather than risking an OOM.
   */
  jsheapMaxGraphEdges?: number;
  /**
   * The scene's flattened UI tree, when it carried a `ui.json`. The `ui`
   * analyzer decides from what it is given rather than declaring `ui.tree` as a
   * requirement: a scene can carry a dump captured on a different device, and a
   * missing artifact is a degradation with a reason, not a skipped analyzer.
   */
  ui?: readonly UiNode[];
  /**
   * The scene's decoded screenshot, when it carried a `screenshot.png`. Decoded
   * by the caller so the analyzer performs no IO; a decode failure reaches it
   * as an absent field plus a reason.
   */
  screenshot?: RgbaImage;
  /**
   * Why a `screenshot.png` that exists could not be decoded. Present only when
   * the file was there and the decoder refused it, so the image half degrades
   * with the decoder's own message instead of claiming no capture happened.
   */
  screenshotError?: string;
  metadata?: SceneMetadata;
  app: AppIdentity;
  window: TimeRange;
  caps: CapabilityMatrix;
  deviceId: string;
}

/**
 * An analyzer's output.
 *
 * Both arrays are explicitly sorted by the analyzer (D5: output must be
 * byte-stable for identical input). `metrics` is sorted by `id`; `evidence`
 * by `(kind, startNs, id)`.
 */
export interface AnalyzeResult {
  metrics: Metric[];
  evidence: Evidence[];
}

/**
 * One analysis pass over a trace.
 *
 * `requires` is checked against the capability matrix by the caller, not by
 * `run`: an analyzer never has to decide what "unsupported device" means.
 */
export interface Analyzer {
  readonly id: string;
  readonly requires: CapabilityId[];
  run(ctx: AnalyzeContext): Promise<AnalyzeResult>;
}
