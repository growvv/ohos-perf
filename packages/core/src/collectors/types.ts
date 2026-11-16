import type { CapabilityId } from '../device/capability';

/**
 * A data-acquisition unit. A collector names itself and declares exactly which
 * capabilities its output can serve; callers use `provides` to decide whether a
 * capture is worth starting for a requested metric.
 */
export interface Collector {
  readonly id: string;
  readonly provides: CapabilityId[];
}

export interface TraceCollectOptions {
  /**
   * Application under test. Recorded with the scene; not a hitrace filter.
   * Optional because a device-wide capture (`hidumper`/`uitest`, or a plain
   * hitrace) needs no app; collectors that resolve a pid require it and the
   * orchestration rejects a request without one before any device call.
   */
  app?: string;
  /** Capture duration. The host times the capture and then finishes it. */
  durationMs: number;
  /** hitrace ring buffer size in KB. Defaults to the HapRay value (204800). */
  bufferKb?: number;
  /** Trace categories. Defaults to {@link HITRACE_DEFAULT_CATEGORIES}. */
  categories?: string[];
}
