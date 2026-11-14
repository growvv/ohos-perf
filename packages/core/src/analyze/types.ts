import type { CapabilityId, CapabilityMatrix } from '../device/capability';
import type { FrameQuery } from '../query/frames';
import type { ProcessQuery } from '../query/process';
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
 */
export interface AnalyzeContext {
  frames: FrameQuery;
  processes: ProcessQuery;
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
