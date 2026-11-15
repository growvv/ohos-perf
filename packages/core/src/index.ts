/**
 * Public API surface of `@ohos-perf/core`.
 *
 * This file is the package's only entry point, so every symbol listed here is
 * a compatibility promise. Exports are explicit and named on purpose: never
 * `export *`, which would silently promote internal seams (row normalizers,
 * probe parsers, argv builders, the sqlite test shim) into published API.
 *
 * Policy: a symbol belongs here only if a consumer has a reason to depend on
 * it. Injection seams stay private — callers pass the injected object
 * structurally, without naming its type.
 */

// Errors
export {
  OhosPerfError,
  HdcNotFoundError,
  DeviceNotFoundError,
  StreamerNotFoundError,
  IngestError,
} from './errors';

// Base types
export type { TimeRange, AppIdentity } from './types';

// Transport
export { Hdc } from './transport/hdc';
export type { Env, HdcOptions, HdcTarget, HdcResult } from './transport/hdc';

// Device and capabilities
export { connect, Device } from './device/device';
export type {
  ConnectOptions,
  CollectOptions,
  CollectSession,
  // `Device`'s public constructor takes `DeviceDeps`, so callers who construct
  // a Device (offline analysis, tests) need the type to name what they pass.
  DeviceDeps,
} from './device/device';
export { CapabilityMatrix, buildMatrix } from './device/capability';
export type {
  CapabilityId,
  CapabilityState,
  CapabilityInputs,
  Fidelity,
  ProbeResult,
} from './device/capability';
export { runProbe } from './device/probe';
export type { ProbeSnapshot, DeviceIdentity, ProbeRunner } from './device/probe';

// Collection
export { HitraceCollector, HITRACE_DEFAULT_CATEGORIES } from './collectors/hitrace';
export type { Collector, TraceCollectOptions } from './collectors/types';

// Ingestion
export { Streamer } from './ingest/streamer';
export type { StreamerOptions } from './ingest/streamer';
export { Scene, createSceneLayout, ingestScene } from './ingest/scene';
export type { SceneLayout } from './ingest/scene';

// Database
export { openDb, tableRowCounts } from './db/driver';
export type { QueryHandle } from './db/driver';

// Queries
export { FrameQuery } from './query/frames';
export type { Frame, FrameStats, FrameFlag, FrameType } from './query/frames';
export { ProcessQuery, ThreadQuery } from './query/process';
export type { ProcessInfo, ThreadInfo } from './query/process';
export { InstantQuery, SchedQuery } from './query/sched';
export type { SchedSlice, WakeupEvent } from './query/sched';
export { ThreadStateQuery } from './query/thread-state';
export type { ThreadState } from './query/thread-state';
export { CallstackQuery } from './query/callstack';
export type { CallstackEvent, CallstackEventWithArgs } from './query/callstack';
export { PerfQuery } from './query/perf';
export type {
  PerfCallchain,
  PerfFunction,
  PerfSampleRow,
  PerfThread,
} from './query/perf';
export { BinderQuery } from './query/binder';
export type { BinderEvent } from './query/binder';
export { StartupQuery } from './query/startup';
export type { StartupRecord } from './query/startup';

// Analysis
export { FrameAnalyzer } from './analyze/frames';
export { FaultTreeAnalyzer, computeFaultTree } from './analyze/fault-tree';
export type { FaultTreeSignals } from './analyze/fault-tree';
export { runAnalyzers, defaultAnalyzers } from './analyze/engine';
export { resolveAppIdentity } from './analyze/context';
export type { Analyzer, AnalyzeContext, AnalyzeResult } from './analyze/types';

// Reports
export { metric } from './report/metric';
export type { Metric, MetricUnit, Provenance } from './report/metric';
export { evidence } from './report/evidence';
export type { Evidence, EvidenceKind, DrillDownHandle } from './report/evidence';
