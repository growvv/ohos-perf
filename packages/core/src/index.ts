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
  EmulatorCommandError,
  EmulatorImageMissingError,
  EmulatorNotFoundError,
} from './errors';

// Base types
export type { TimeRange, AppIdentity } from './types';

// Transport
export { Hdc } from './transport/hdc';
export type { Env, HdcOptions, HdcTarget, HdcResult } from './transport/hdc';

// Device and capabilities
export { connect, Device, HIPROFILER_PLUGIN_NAMES } from './device/device';
export type {
  ConnectOptions,
  CollectOptions,
  CollectSession,
  // `Device`'s public constructor takes `DeviceDeps`, so callers who construct
  // a Device (offline analysis, tests) need the type to name what they pass.
  DeviceDeps,
  HiprofilerCollectRequest,
  HiprofilerPluginName,
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

// UI gesture injection
export { GestureDriver } from './device/gesture';
export type { Gesture, GestureResult } from './device/gesture';

// Emulator lifecycle
export { EmulatorClient, EmulatorLifecycle } from './device/emulator';
export type {
  CreateEmulatorRequest,
  EmulatorBackend,
  EmulatorClientOptions,
  EmulatorImage,
  EmulatorInstance,
  EmulatorLifecycleOptions,
  EmulatorStartResult,
  EmulatorStopResult,
  HdcSlice,
} from './device/emulator';

// Collection
export { HitraceCollector, HITRACE_DEFAULT_CATEGORIES } from './collectors/hitrace';
export {
  HiperfCollector, DEVICE_PERF_PATH, hiperfRecordCommand, parseHiperfSummary,
} from './collectors/hiperf';
export type { HiperfCapture, HiperfCollectOptions } from './collectors/hiperf';
export { HiprofilerCollector } from './collectors/hiprofiler';
export type { HiprofilerCollectOptions } from './collectors/hiprofiler';
export { buildHiprofilerConfig, MIN_BUFFER_PAGES } from './collectors/hiprofiler/config';
export type { HiprofilerConfigOptions, HiprofilerPlugin } from './collectors/hiprofiler/config';
export {
  PLANE_A_PLUGINS,
  FTRACE_CATEGORIES,
  ftracePlugin,
  gpuPlugin,
  memoryPlugin,
  nativehookPlugin,
  xpowerPlugin,
} from './collectors/hiprofiler/templates';
export type {
  FtraceOptions, MemoryPluginOptions, NativehookOptions,
} from './collectors/hiprofiler/templates';
export {
  ProcfsCollector,
  parseProcfsStatus,
  parseSmapsRollup,
  readProcfsSamples,
  writeProcfsSamples,
} from './collectors/procfs';
export type { ProcfsSample, ProcfsStatus, SmapsRollup } from './collectors/procfs';
export {
  HidumperCollector,
  FPS_COMMAND,
  HITCH_COMMAND,
  parseFpsCounts,
  parseHitches,
  readHidumperCapture,
} from './collectors/hidumper';
export type {
  FpsBucket,
  WindowHitches,
  HidumperSnapshot,
  HidumperCapture,
} from './collectors/hidumper';
export { UitestCollector, DEVICE_UI_PATH } from './collectors/uitest';
export { ScreenshotCollector, DEVICE_SCREENSHOT_PATH } from './collectors/screenshot';
export type { ScreenshotCapture } from './collectors/screenshot';
export { HilogCollector, HILOG_COMMAND, readHilogText } from './collectors/hilog';
export {
  ThermalCollector,
  THERMAL_COMMAND,
  DEFAULT_THERMAL_INTERVAL_MS,
  MIN_THERMAL_INTERVAL_MS,
  readThermalRecords,
} from './collectors/thermal';
export type {
  ThermalCapture,
  ThermalCollectorDeps,
  ThermalRecord,
} from './collectors/thermal';
export { parseThermalOutput } from './thermal/parse';
export type { ThermalReading, ThermalUnit } from './thermal/parse';
export { parseHilogLine, parseHilogText } from './hilog/parse';
export type { HilogLevel, HilogLine, HilogParseOptions } from './hilog/parse';
export {
  compileRules, matchRules, DEFAULT_HILOG_RULES,
} from './hilog/rules';
export type { CompiledRule, HilogMatch, HilogRule } from './hilog/rules';
export { flattenUiTree, readUiTree, parseBounds } from './query/ui';
export type { UiNode } from './query/ui';
export { decodePng, encodePng } from './image/png';
export type { RgbaImage } from './image/png';
export { compareImages, dhash, markRegions } from './image/diff';
export type { ImageComparison, Rect } from './image/diff';
export { diffTrees, nodeIdentity, IGNORED_ATTRIBUTES, GEOMETRY_TOLERANCE_PX } from './ui/diff';
export type { UiTreeDiff, UiTreeDifference } from './ui/diff';
export { compareSceneDirs, UI_DIFF_FILES } from './ui/compare';
export type { UiDiff, UiDiffSide, UiCompareOptions } from './ui/compare';
export {
  ANIMATION_BANDS, MIN_HASH_PIXELS, analyseAnimations, animationSeverity, compareRegion,
  cropRegion,
} from './ui/animation';
export type {
  AnimationAnalysis, AnimationLabel, AnimationSeverity, PixelOnlyChange, RegionPixelChange,
  UnmeasuredRegion,
} from './ui/animation';
export { renderUiDiffHtml } from './report/ui-html';
export type { Collector, TraceCollectOptions } from './collectors/types';

// Ingestion
export { Streamer } from './ingest/streamer';
export type { StreamerOptions } from './ingest/streamer';
export { Scene, createSceneLayout, ingestScene } from './ingest/scene';
export type { SceneLayout } from './ingest/scene';
export { readSceneMetadata, writeSceneMetadata } from './ingest/metadata';
// Scenario runner (P13)
export { parseScenario, COLLECTOR_NAMES } from './scenario/schema';
export { discoverCases, loadCases } from './scenario/cases';
export { matchSelector, parseSelector, resolveSelector } from './scenario/selector';
export { PARITY_ROWS, paritySummary } from './parity';
export { parseRedundantFile, RedundantFileAnalyzer } from './analyze/redundant-file';
export { JsheapCollector, readJsheapSnapshot } from './collectors/jsheap';
export { buildDepGraph } from './hap/depgraph';
export type {
  SceneStep, ScenesComparison, StepComparison, StepStatus,
} from './report/scenes';
export { compareScenes, renderScenesComparison, sortSteps } from './report/scenes';
export { buildTrend, renderTrendHtml, renderTrendJson, trendRunFromReport } from './report/trend';
export { BUNDLE_RENDERED_FILES, renderBundle } from './report/rerender';
export type { BundleRerenderInput } from './report/rerender';
export type {
  Trend, TrendOrder, TrendPoint, TrendRun, TrendSeries,
} from './report/trend';
export { buildMovement } from './report/movement';
export type {
  MovementEvidenceRow, MovementInput, MovementRow, MovementSide, MovementStatus,
  RootCauseMovement,
} from './report/movement';
export { CoverageAnalyzer, parseCoverageReport } from './analyze/coverage';
export type { CoverageCounts, CoverageFile, CoverageRatio, CoverageReport } from './analyze/coverage';
export { ThermalAnalyzer, thermalSensorSlug } from './analyze/thermal';
export {
  BUDGET_SCHEMA_VERSION,
  deltaBudgetIds,
  evaluateGate,
  parseBudgetDocument,
  renderGateJson,
} from './gate';
export type {
  BudgetBound, BudgetDocument, BudgetEntry, GateResult, GateStatus, GateVerdict,
} from './gate';
export { executeAction } from './scenario/actions';
export {
  explore, deviceExplorationHost, explorationDevice, hashPageShape, hashTree, planNextAction,
} from './scenario/explore';
export type {
  ExplorationAction, ExplorationCandidate, ExplorationChoiceContext, ExplorationChooser,
  ExplorationClock, ExplorationDevice, ExplorationDeviceOptions, ExplorationHost,
  ExplorationOptions, ExplorationOutcome, ExplorationProposal, ExplorationResult,
  ExplorationState, ExplorationStep, ExplorationStepKind, ExplorationStrategy,
  ExplorationTargetDevice, ScrollDirection,
} from './scenario/explore';
export { ScenarioRunner, writeRunFiles, evaluateExpectation } from './scenario/runner';
export {
  agentPrompt, describeDecision, IRREVERSIBLE_PATTERNS, irreversibleReason,
  parseDecision, renderTree, replayAgent, runAgent,
} from './scenario/agent';
export {
  addressOfOffset, functionAt, measureNaming, normaliseName, recoverSymbols, symbolIndex,
} from './hap/symbols-recovery';
export type {
  AddressRef, FunctionRange, NamingAnswer, NamingCase, NamingQuestion, NamingReport,
  RecoveredSymbol, RecoveryResult, UnresolvedAddress,
} from './hap/symbols-recovery';
export { GUI_TURN, httpAgentModel, httpChatModel, readAgentConfig } from './scenario/agent-client';
export type {
  AgentConfig, AgentFetch, AgentTurnShape, ChatModel, HttpAgentModelOptions,
  HttpModelOptions,
} from './scenario/agent-client';
export { explorationPrompt, llmChooser, parseStrategyAnswer } from './scenario/llm-strategy';
export type {
  StrategyAnswer, StrategyElement, StrategyRefusal, StrategyTurn,
} from './scenario/llm-strategy';
export type {
  AgentDecision, AgentDevice, AgentHistoryEntry, AgentModel, AgentOptions,
  AgentTurn, AgentResult, AgentStatus, AgentStep, AgentStepStatus,
  AgentTranscript, IrreversiblePattern, ReplayResult,
} from './scenario/agent';
export type {
  Scenario, ScenarioAction, ScenarioStep, StepCapture, CollectorName,
  ExpectPresent, StepExpectation,
} from './scenario/schema';
export type { ActionContext, ActionDevice } from './scenario/actions';
export type { Selector, SelectorRect } from './scenario/selector';
export type { CaseLoad, DiscoveredCase } from './scenario/cases';
export type { ParityRow, ParityStatus } from './parity';
export type { RedundantFileEntry, RedundantFileReport } from './analyze/redundant-file';
export type { JsheapCapture } from './collectors/jsheap';
export type {
  DepGraph, DepGraphEdge, DepGraphFile, HarEdge, ModuleDecl, TimingCycle,
} from './hap/depgraph';
export type {
  ActionOutcome, ExpectationOutcome, RunResult, RunStepResult, RunnerCollectOptions,
  RunnerDevice, RunOptions,
} from './scenario/runner';
export type { SceneMetadata, SceneStepRef } from './ingest/metadata';

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
export { MemMeasureQuery } from './query/mem-measure';
export type { ProcessMeasure, ProcessMeasureFilter } from './query/mem-measure';
export { CallstackQuery } from './query/callstack';
export type { CallstackEvent, CallstackEventWithArgs } from './query/callstack';
export { PerfQuery } from './query/perf';
export { NativeHookQuery } from './query/native-hook';
export type {
  NativeHookEvent,
  NativeHookFrame,
  NativeHookStatistic,
} from './query/native-hook';
export { isUnresolvedSymbol } from './query/perf';
export type {
  FoldedStack,
  PerfCallchain,
  PerfFunction,
  PerfLeafAttribution,
  PerfSampleRow,
  PerfThread,
  SymbolStat,
} from './query/perf';
export { BinderQuery } from './query/binder';
export type { BinderEvent } from './query/binder';
export {
  DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, lookupQuery, queryDefinitions,
  resolveQueryLimit, runDrillDown, runNamedQuery, unknownQueryError,
} from './query/registry';
export type {
  NamedQueryDefinition, NamedQueryInfo, NamedQueryResult, QueryArgument, QueryContext,
} from './query/registry';
export { StartupQuery } from './query/startup';
export type { StartupRecord } from './query/startup';

// Analysis
export { FrameAnalyzer } from './analyze/frames';
export { FrameLoadAnalyzer, FrameLoadIndex } from './analyze/frame-load';
export type {
  FrameLoadIndexInput,
  FrameLoadThread,
  PerfFileAttribution,
} from './analyze/frame-load';
export { computeFpsWindows } from './analyze/fps';
export type { FpsWindow } from './analyze/fps';
export { FaultTreeAnalyzer, computeFaultTree } from './analyze/fault-tree';
export type { FaultTreeSignals } from './analyze/fault-tree';
export { BinderAnalyzer, computeBinderAnalysis } from './analyze/binder';
export type {
  BinderAnalysis,
  BinderEndpoint,
  BinderInterfaceStat,
  BinderProcessStat,
  BinderThreadStat,
  BinderTransaction,
} from './analyze/binder';
export { analyzeThreadWakeup } from './analyze/threads-wakeup';
export type {
  ThreadWakeupResult,
  ThreadWakeupThread,
} from './analyze/threads-wakeup';
export { ThreadAnalyzer, computeThreadAnalysis } from './analyze/threads-score';
export { MemoryAnalyzer } from './analyze/memory';
export { MemoryMeasureAnalyzer } from './analyze/mem-measure';
export {
  NativeMemoryAnalyzer,
  pairNativeMemory,
  aggregateUnreleased,
  buildNativeTimeline,
  nativeEventKind,
} from './analyze/native-memory';
export type {
  ActiveAlloc,
  NativeEventKind,
  NativeMemoryResult,
  NativeNames,
  NativeTimelineBucket,
  UnreleasedRow,
} from './analyze/native-memory';
export { classifyNativePath } from './analyze/native-kinds';
export type { NativeCategory } from './analyze/native-kinds';
export { StartupAnalyzer } from './analyze/startup';
export { RenderAnalyzer } from './analyze/render';
export { HilogAnalyzer } from './analyze/hilog';
export { UiAnalyzer } from './analyze/ui';
export { GcAnalyzer, computeGc } from './analyze/gc';
export type { GcSignals } from './analyze/gc';
export { VsyncAnalyzer, computeVsyncAnomalies } from './analyze/vsync';
export type {
  VsyncAnalysis,
  VsyncPeriod,
  VsyncPeriodKind,
  VsyncSeverity,
} from './analyze/vsync';
export { EmptyFrameAnalyzer, filterEmptyFrames } from './analyze/empty-frame';
export type { EmptyFrameFilter } from './analyze/empty-frame';
export { RsSkipAnalyzer, computeRsSkip } from './analyze/rs-skip';
export type { RsSkipFrame, RsSkipResult, RsSkipTraceMethod } from './analyze/rs-skip';
export { FlamegraphAnalyzer } from './analyze/flamegraph';
export { SymbolsAnalyzer } from './analyze/symbols';
export {
  ComponentReuseAnalyzer,
  computeComponentReuse,
  round2HalfEven,
} from './analyze/components';
export type { ComponentReuse } from './analyze/components';
export type {
  BelowThresholdPattern,
  CallchainSample,
  OptimizationPotential,
  RedundancyLevel,
  RedundancyType,
  RedundantThreadPattern,
  RedundantThreadsSummary,
  ThreadAnalysis,
  ThreadAnalysisSummary,
} from './analyze/threads-score';
export {
  runAnalyzers,
  runAnalyzerSections,
  defaultAnalyzers,
  type AnalyzerRun,
  type AnalyzerSection,
} from './analyze/engine';
export { resolveAppIdentity, resolveAppIpids } from './analyze/context';
export type { Analyzer, AnalyzeContext, AnalyzeResult } from './analyze/types';

// Static package inspection (offline)
export { openZip, isZip } from './hap/zip';
export type { ZipArchive, ZipEntry } from './hap/zip';
export { readElf, classifyInstruction, countInstructions, EM_AARCH64 } from './hap/elf';
export {
  analyzeBinaries, classifyOptimization, extractBinaries, inspectBinary, optimizationSection,
} from './hap/optimization';
export type {
  BinaryFacts, BinaryInput, BinaryReport, OptimizationAnalysis, OptimizationBasis,
  OptimizationLevel, OptimizationVerdict,
} from './hap/optimization';
export type {
  ElfFile, ElfSection, ElfSymbol, InstructionClass, InstructionCounts,
} from './hap/elf';
export {
  CATEGORY_EXTENSIONS, CATEGORY_MAX_BYTES, buildInventory, categorize,
} from './hap/inventory';
export type { FileCategory, InventoryFile } from './hap/inventory';
export { EXCLUDE_PATTERNS, TECH_RULES, matchHapRules, validateRules } from './hap/rules';
export type {
  ContentPattern, FileRule, MetadataPattern, RuleMatch, RuleMatchKind, TechRule,
} from './hap/rules';
export { analyzeHap, hapSection } from './hap/analyze';
export type {
  CategoryTotal, DuplicateGroup, HapAnalysis, HapPackage, OversizedFile,
} from './hap/analyze';

// Reports
export { metric } from './report/metric';
export type { Metric, MetricUnit, Provenance } from './report/metric';
export { compareResults, METRIC_DIRECTIONS } from './report/compare';
export type {
  BaselineComparison, DeltaStatus, MetricDelta, MetricDirection,
} from './report/compare';
export { evidence } from './report/evidence';
export type { Evidence, EvidenceKind, DrillDownHandle } from './report/evidence';
export {
  REPORT_SCHEMA_VERSION,
  SECTION_TITLES,
  buildReport,
  summarizeReport,
  renderReportJson,
  renderSummaryJson,
} from './report/model';
export type {
  ReportGenerator,
  ReportInput,
  ReportModel,
  ReportScenario,
  ReportSection,
  ReportSummary,
  ReportTotals,
} from './report/model';
export { renderEvidenceCsv, renderMetricsCsv } from './report/csv';
export { renderReportHtml } from './report/html';
export { renderReportXlsx } from './report/xlsx';
export { escapeHtml } from './report/escape';
export { FLAMEGRAPH_FILES, renderFlamegraphSvg } from './report/flamegraph-svg';
export { renderFlamegraphHtml } from './report/flamegraph-html';
export type { FlamegraphPageInput } from './report/flamegraph-html';
export {
  ROOT_CAUSE_SCHEMA_VERSION,
  buildRootCauseDocument,
  rankObservations,
} from './report/root-cause';
export type {
  RootCauseAnalysis,
  RootCauseDocument,
  RootCauseGenerator,
  RootCauseInput,
  RootCauseObservation,
  RootCauseScene,
  RootCauseSummary,
  RootCauseSuspect,
} from './report/root-cause';
export {
  PROMPT_EVIDENCE_LIMIT,
  ROOT_CAUSE_TURN,
  askRootCause,
  groundingVocabulary,
  parseRootCauseAnswer,
  rootCausePrompt,
  ungroundedNames,
} from './report/root-cause-model';
export { renderRootCauseMarkdown } from './report/root-cause-markdown';

// Machine-readable tool result (P33)
export {
  TOOL_ID,
  TOOL_RESULT_FILE,
  TOOL_RESULT_SCHEMA_VERSION,
  buildToolResult,
  parseToolResult,
  renderToolResultFile,
  renderToolResultLine,
} from './machine/tool-result';
export type { ToolResult, ToolResultError, ToolResultInput } from './machine/tool-result';
