import type { CapabilityId, CapabilityMatrix } from '../device/capability';
import type { HidumperCapture } from '../collectors/hidumper';
import type { ProcfsSample } from '../collectors/procfs';
import type { QueryHandle } from '../db/driver';
import type { SceneMetadata } from '../ingest/metadata';
import type { HilogLine } from '../hilog/parse';
import type { HilogRule } from '../hilog/rules';
import type { BinderQuery } from '../query/binder';
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
