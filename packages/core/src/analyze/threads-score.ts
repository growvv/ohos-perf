// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';
import {
  analyzeThreadWakeup,
  type ThreadWakeupResult,
  type ThreadWakeupThread,
} from './threads-wakeup';

/** HapRay's `wakeup_pattern` values, the keys of the label map. */
export type RedundancyType =
  | 'normal'
  | 'frequent_immediate_sleep'
  | 'never_woken'
  | 'busy_waiting'
  | 'busy_wait';

/**
 * HapRay `REDUNDANCY_TYPE_LABELS`, verbatim from `thread_analyzer.py:25-31`.
 *
 * The keys are HapRay's `wakeup_pattern` values; the values are the Chinese
 * explanations emitted both as the payload's `redundancy_types` map and as each
 * redundant thread's `type_label`. Kept private: callers read the labels from
 * the analysis payload, so a public constant would only duplicate the surface.
 */
const REDUNDANCY_TYPE_LABELS: Record<RedundancyType, string> = {
  normal: '未命中下述唤醒模式，多为高等待或混合行为。',
  frequent_immediate_sleep: '被频繁唤醒但立即进入等待，典型无效调度。',
  never_woken: '从未被唤醒，可能未被使用或孤立线程。',
  busy_waiting: '短运行周期占比高或状态切换极频繁（跑一下就睡、跑一下就睡）。',
  busy_wait: '高指令数但运行占比极低或含大量yield，属忙等浪费CPU。',
};

export type RedundancyLevel = 'high' | 'medium' | 'low' | 'none';
export type OptimizationPotential = 'high' | 'medium' | 'low';

/** One `callchain_sample` entry, in HapRay's snake_case shape. */
export interface CallchainSample {
  symbol: string;
  file_path: string;
  count: number;
}

/**
 * One entry of `redundant_threads_summary.redundant_threads`.
 *
 * HapRay builds this in `thread_analyzer.py:96-118`; the snake_case keys are
 * kept verbatim so the golden comparison is direct. `thread_name` is the
 * display name HapRay derives from the variants (`<name>` for one variant,
 * `<pattern>_*` for several).
 */
export interface RedundantThreadPattern {
  thread_name: string;
  thread_name_variants: string[];
  type: RedundancyType;
  type_label: string;
  total_thread_count: number;
  redundant_count: number;
  redundant_instructions: number;
  redundant_instructions_ratio: number;
  estimated_memory_mb: number;
  redundancy_score: number;
  score_breakdown: Record<string, number>;
  redundancy_level: RedundancyLevel;
  leak_score: number;
  leak_level: RedundancyLevel;
  waiting_ratio: number;
  wakeup_pattern: RedundancyType;
  all_thread_ids: number[];
  redundant_thread_ids: number[];
  callchain_sample: CallchainSample[];
}

/** `thread_analyzer.py:75-83` summary payload, snake_case verbatim. */
export interface RedundantThreadsSummary {
  redundancy_types: Record<RedundancyType, string>;
  total_redundant_thread_patterns: number;
  total_redundant_threads: number;
  total_cpu_instructions: number;
  total_redundant_instructions: number;
  redundant_instructions_ratio: number;
  redundant_threads: RedundantThreadPattern[];
}

/** `analyze_optimization_opportunities`'s `summary` payload, verbatim. */
export interface ThreadAnalysisSummary {
  total_memory_savings_mb: number;
  total_cpu_savings_instructions: number;
  high_priority_patterns_count: number;
  total_cpu_instructions: number;
  total_redundant_instructions: number;
  redundant_instructions_ratio: number;
}

/** One `below_threshold_patterns` entry, verbatim from `thread_optimization.py`. */
export interface BelowThresholdPattern {
  thread_name: string;
  thread_name_variants: string[];
  total_thread_count: number;
  all_thread_ids: number[];
  redundant_count: number;
  max_score: number;
  avg_score: number;
}

/**
 * The three payloads HapRay's `ThreadAnalyzer` returns for one step.
 *
 * Only the three top-level names are camelCased; every nested key keeps
 * HapRay's snake_case spelling (`redundancy_types`, `total_redundant_threads`,
 * `max_score`, ...) so the parity fixtures compare field by field.
 */
export interface ThreadAnalysis {
  redundantThreadsSummary: RedundantThreadsSummary;
  summary: ThreadAnalysisSummary;
  belowThresholdPatterns: BelowThresholdPattern[];
}

/** HapRay `thread_utils.YIELD` keyword list, used by both score passes. */
const YIELD_KEYWORDS = [
  'yield',
  'sched_yield',
  '__itt_thread_yield',
  'itt_thread_yield',
];

const KIB = 1024;
const MIB = 1024 * 1024;

/** HapRay `thread_optimization` thresholds, verbatim. */
const REDUNDANT_SCORE_THRESHOLD = 40;
const REDUNDANT_SCORE_THRESHOLD_SINGLE_THREAD = 60;
const HIGH_INST_LOW_WORK_RUNNING_RATIO = 0.02;
const HIGH_INST_LOW_WORK_SHORT_CYCLES = 10;
const BUSY_WAIT_MIN_PERIODS = 20;
const BUSY_WAIT_SHORT_RATIO = 0.9;
const HIGH_FREQ_TRANSITIONS_PER_SEC = 2000;
const FREQUENT_SLEEP_WAKEUP_MIN = 8;
const FREQUENT_SLEEP_SHORT_CYCLES_MIN = 5;
const FREQUENT_SLEEP_RATIO = 0.7;
const FREQUENT_SLEEP_ALT_PERIODS = 20;
const FREQUENT_SLEEP_ALT_CYCLES = 10;
/** State names HapRay treats as waiting (`thread_optimization.py`). */
const WAITING_STATES = ['S', 'D', 'T'];

/**
 * HapRay `thread_utils.num`: a safe `int()` with a default.
 *
 * Python truncates toward zero and falls back to the default on `None` or an
 * unconvertible value; the same rules are applied here so a malformed row
 * cannot smuggle `NaN` into a score.
 */
function num(value: unknown, defaultValue = 0): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : defaultValue;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : defaultValue;
  }
  return defaultValue;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * HapRay `thread_utils.pattern_key`: strip one trailing `_<digits>` suffix.
 *
 * An empty name becomes `Unknown`; a name that is only whitespace trims to the
 * empty string and is returned as such, exactly as in Python.
 */
export function patternKey(threadName: string): string {
  if (!threadName) return 'Unknown';
  const stripped = threadName.trim();
  const match = /^(.+)_(\d+)$/.exec(stripped);
  return match === null ? stripped : match[1];
}

/** HapRay `thread_utils.should_ignore_system_pattern`: `OS_` prefix. */
export function shouldIgnoreSystemPattern(pattern: string): boolean {
  if (!pattern) return false;
  return pattern.trim().startsWith('OS_');
}

/** HapRay's yield scan over every wakeup thread and every callchain frame. */
function hasYieldCallchain(wakeupThreads: ThreadWakeupThread[]): boolean {
  for (const wakeupThread of wakeupThreads) {
    for (const callchain of wakeupThread.callchains) {
      if (!callchain) continue;
      for (const func of callchain.functions) {
        const rawName = func.name || func.symbol || '';
        const rawPath = func.filePath || '';
        const haystack = `${rawName} ${rawPath}`.toLowerCase();
        if (YIELD_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * HapRay `thread_utils.collect_callchain_sample` with its default
 * `user_space_only=True`.
 *
 * Only frames whose raw path contains `/proc/` are counted. The sample keeps
 * first-seen order on ties (Python's stable `sorted`) and truncates the symbol
 * to 200 and the path to 300 characters.
 */
export function collectCallchainSample(
  threadList: ThreadWakeupResult[],
  maxEntries = 10,
): CallchainSample[] {
  const counts = new Map<
    string,
    { symbol: string; filePath: string; count: number }
  >();
  for (const thread of threadList) {
    for (const wakeupThread of thread.wakeupThreads) {
      for (const callchain of wakeupThread.callchains) {
        if (!callchain) continue;
        for (const func of callchain.functions) {
          const rawName = func.name || func.symbol || '';
          const rawPath = func.filePath || '';
          const symbol = rawName.trim();
          const filePath = rawPath.trim();
          if (symbol === '' && filePath === '') continue;
          if (!rawPath.includes('/proc/')) continue;
          const key = JSON.stringify([symbol, filePath]);
          const entry = counts.get(key);
          if (entry === undefined) {
            counts.set(key, { symbol, filePath, count: 1 });
          } else {
            entry.count += 1;
          }
        }
      }
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  return sorted.slice(0, maxEntries).map((entry) => ({
    symbol: entry.symbol.slice(0, 200),
    file_path: entry.filePath.slice(0, 300),
    count: entry.count,
  }));
}

/** HapRay `thread_utils.count_callchain_frames`: (frames, chains). */
export function countCallchainFrames(
  threadList: ThreadWakeupResult[],
): [number, number] {
  let totalFrames = 0;
  let totalCallchains = 0;
  for (const thread of threadList) {
    for (const wakeupThread of thread.wakeupThreads) {
      for (const callchain of wakeupThread.callchains) {
        if (!callchain) continue;
        totalCallchains += 1;
        totalFrames += callchain.functions.length;
      }
    }
  }
  return [totalFrames, totalCallchains];
}

/**
 * HapRay `thread_utils.calculate_thread_memory_estimate`: a conservative
 * stack + bookkeeping estimate per thread.
 */
export function calculateThreadMemoryEstimate(
  threadCount: number,
  avgStackSize = MIB,
): number {
  const perThreadMemory = avgStackSize + 8 * KIB + 16 * KIB;
  return threadCount * perThreadMemory;
}

/** Python `round(x, 6)` as called on the summary ratio fields. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Python `round(x, 1)` as called on `avg_score` and `waiting_ratio`. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Python `round(x, 2)` as called on `estimated_memory_mb`. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Python `{value:.0f}` / `{ratio:.0%}` (the `%` suffix is added by callers). */
function formatPercent0(ratio: number): number {
  return Math.round(ratio * 100);
}

/**
 * HapRay `per_thread_redundancy_score`: one thread's 0-100 redundancy score.
 *
 * Every bonus and its ordering follow `thread_optimization.py:32-119`. The
 * early returns are significant: a thread with no wakeup entries scores 15,
 * and a thread with no thread-state rows returns before the lifetime,
 * wakeup-depth and short-cycle bonuses.
 */
export function perThreadRedundancyScore(thread: ThreadWakeupResult): number {
  let score = 0;
  const wakeupThreads = thread.wakeupThreads;
  if (wakeupThreads.length === 0) {
    score += 15;
    return Math.min(100, score);
  }

  const first = wakeupThreads[0];
  const threadStates = first.threadStates;
  const wakeupDepth = first.wakeupDepth !== undefined ? first.wakeupDepth : -1;
  const totalDur = threadStates.reduce((total, state) => total + num(state.dur), 0);
  const waitDur = threadStates.reduce(
    (total, state) =>
      WAITING_STATES.includes(state.state) ? total + num(state.dur) : total,
    0,
  );
  const waitingRatio = totalDur > 0 ? waitDur / totalDur : 0;

  if (waitingRatio > 0.95) score += 30;
  else if (waitingRatio > 0.85) score += 20;
  else if (waitingRatio > 0.75) score += 10;

  const instructions = num(thread.totalInstructions);
  if (instructions === 0) score += 15;
  else if (instructions < 1000) score += 5;

  if (hasYieldCallchain(wakeupThreads)) score += 15;

  if (threadStates.length === 0) return Math.min(100, score);

  const states = [...threadStates].sort((a, b) => num(a.ts) - num(b.ts));
  let runningDuration = 0;
  let wakeupCount = 0;
  for (const state of states) {
    if (state.state === 'Running') runningDuration += num(state.dur);
    if (state.state === 'R') wakeupCount += 1;
  }

  const { startTs, endTs } = thread.threadInfo;
  const lifetime =
    startTs !== null && endTs !== null ? num(endTs) - num(startTs) : totalDur;
  if (lifetime > 0 && runningDuration === 0) score += 15;
  if (wakeupDepth === 0) score += 10;
  if (wakeupDepth === 0 && wakeupCount === 0) score += 15;

  let shortCycles = 0;
  for (let i = 0; i < states.length; i++) {
    if (states[i].state !== 'Running' || num(states[i].dur) >= 1_000_000) {
      continue;
    }
    const previous = i > 0 ? states[i - 1].state : '';
    const next = i < states.length - 1 ? states[i + 1].state : '';
    if (
      (previous === 'R' && WAITING_STATES.includes(next)) ||
      (previous === 'Running' && next === 'Running')
    ) {
      shortCycles += 1;
    }
  }
  if (
    wakeupCount >= 3 &&
    shortCycles / Math.max(wakeupCount, 1) > 0.5
  ) {
    score += 10;
  }

  if (lifetime > 0 && runningDuration >= 0) {
    const runRatio = runningDuration / lifetime;
    if (
      instructions > 10000 &&
      runRatio < 0.05 &&
      shortCycles >= 5
    ) {
      score += 22;
    } else if (
      instructions > 5000 &&
      runRatio < 0.1 &&
      shortCycles >= 3
    ) {
      score += 16;
    } else if (
      instructions > 2000 &&
      runRatio < 0.15 &&
      shortCycles >= 2
    ) {
      score += 12;
    }
  }

  return Math.min(100, score);
}

/** The feature record HapRay `thread_redundancy_features` returns. */
export interface ThreadRedundancyFeatures {
  waiting_ratio: number;
  total_instructions: number;
  has_callchain: boolean;
  has_yield: boolean;
  short_cycles: number;
  run_ratio: number;
  wakeup_depth: number;
  wakeup_count: number;
}

/**
 * HapRay `thread_redundancy_features`: the same per-thread measurements used
 * by the score, exposed separately for feature-summary consumers.
 */
export function threadRedundancyFeatures(
  thread: ThreadWakeupResult,
): ThreadRedundancyFeatures {
  const features: ThreadRedundancyFeatures = {
    waiting_ratio: 0,
    total_instructions: 0,
    has_callchain: false,
    has_yield: false,
    short_cycles: 0,
    run_ratio: 0,
    wakeup_depth: -1,
    wakeup_count: 0,
  };
  const wakeupThreads = thread.wakeupThreads;
  if (wakeupThreads.length === 0) return features;

  const first = wakeupThreads[0];
  const threadStates = first.threadStates;
  features.wakeup_depth =
    first.wakeupDepth !== undefined ? first.wakeupDepth : -1;
  const totalDur = threadStates.reduce((total, state) => total + num(state.dur), 0);
  const waitDur = threadStates.reduce(
    (total, state) =>
      WAITING_STATES.includes(state.state) ? total + num(state.dur) : total,
    0,
  );
  features.waiting_ratio = totalDur > 0 ? waitDur / totalDur : 0;
  features.total_instructions = num(thread.totalInstructions);
  features.has_callchain = wakeupThreads.some(
    (wakeupThread) => wakeupThread.callchains.length > 0,
  );
  features.has_yield = hasYieldCallchain(wakeupThreads);

  if (threadStates.length === 0) return features;

  const states = [...threadStates].sort((a, b) => num(a.ts) - num(b.ts));
  let runningDuration = 0;
  for (const state of states) {
    if (state.state === 'Running') runningDuration += num(state.dur);
    if (state.state === 'R') features.wakeup_count += 1;
  }

  const { startTs, endTs } = thread.threadInfo;
  const lifetime =
    startTs !== null && endTs !== null ? num(endTs) - num(startTs) : totalDur;
  features.run_ratio = lifetime > 0 ? runningDuration / lifetime : 0;

  let shortCycles = 0;
  for (let i = 0; i < states.length; i++) {
    if (states[i].state !== 'Running' || num(states[i].dur) >= 1_000_000) {
      continue;
    }
    const previous = i > 0 ? states[i - 1].state : '';
    const next = i < states.length - 1 ? states[i + 1].state : '';
    if (
      (previous === 'R' && WAITING_STATES.includes(next)) ||
      (previous === 'Running' && next === 'Running')
    ) {
      shortCycles += 1;
    }
  }
  features.short_cycles = shortCycles;
  return features;
}

/** The full per-pattern record `analyze_optimization_opportunities` builds. */
interface OptimizationPattern {
  thread_name: string;
  thread_name_variants: string[];
  total_thread_count: number;
  redundant_count: number;
  unique_itid_count: number;
  unique_tid_count: number;
  total_instructions: number;
  avg_instructions_per_thread: number;
  redundant_instructions: number;
  redundant_instructions_ratio: number;
  estimated_memory_bytes: number;
  estimated_memory_mb: number;
  avg_waiting_ratio: number;
  callchain_ratio: number;
  optimization_potential: OptimizationPotential;
  all_thread_ids: number[];
  redundant_thread_ids: number[];
  is_duplicate: boolean;
  callchain_sample: CallchainSample[];
  callchain_frame_total: number;
  sample_count: number;
  redundancy_score: number;
  score_breakdown: Record<string, number>;
  redundancy_level: RedundancyLevel;
  leak_score: number;
  leak_level: RedundancyLevel;
  avg_lifetime_ns: number;
  avg_lifetime_sec: number;
  running_time_ratio: number;
  never_running_ratio: number;
  zero_wakeup_depth_ratio: number;
  frequent_immediate_sleep_ratio: number;
  never_woken_ratio: number;
  avg_wakeup_count: number;
  avg_short_running_cycles: number;
  avg_short_running_periods: number;
  yield_call_ratio: number;
  high_instructions_low_work_ratio: number;
  busy_waiting_pattern_ratio: number;
  high_frequency_transitions_ratio: number;
  wakeup_pattern: RedundancyType;
}

interface CpuOpportunity {
  thread_name: string;
  current_instructions: number;
  potential_savings: number;
  reduction_percentage: number;
  method: string;
}

interface MemoryOpportunity {
  thread_name: string;
  current_threads: number;
  suggested_reduction: number;
  current_memory_mb: number;
  potential_savings_mb: number;
  reduction_percentage: number;
  is_duplicate: boolean;
}

interface Recommendation {
  priority: 'high' | 'medium';
  title: string;
  details: string[];
}

interface OptimizationAnalysis {
  framework: string;
  total_threads: number;
  redundant_patterns: OptimizationPattern[];
  below_threshold_patterns: BelowThresholdPattern[];
  cpu_optimization_opportunities: CpuOpportunity[];
  memory_optimization_opportunities: MemoryOpportunity[];
  recommendations: Recommendation[];
  summary: ThreadAnalysisSummary;
}

/** HapRay's `thread.thread_id or thread.thread_info.tid` (wakeup results have no tid). */
function threadIdOf(thread: ThreadWakeupResult): number | undefined {
  return thread.threadId !== 0 ? thread.threadId : undefined;
}

/** `f'{value:,}'` for the recommendation detail strings. */
function formatWithCommas(value: number): string {
  const [integerPart, fractionPart] = String(value).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
}

/**
 * Port of `thread_optimization.py:analyze_optimization_opportunities`.
 *
 * Patterns are grouped by {@link patternKey}; both score thresholds, the
 * primary-worker exclusion, every ratio, the score breakdown (including the
 * interpolated percentage keys), leak levels, wakeup classification,
 * opportunities and recommendations follow the upstream implementation.
 *
 * HapRay sorts `redundant_patterns` by `redundant_count` descending with a
 * stable sort; that order still feeds the opportunity lists and the
 * recommendation detail order, so it is reproduced before the public payload
 * applies its own name tie-break.
 */
function analyzeOptimizationOpportunities(
  results: ThreadWakeupResult[],
): OptimizationAnalysis {
  const analysis: OptimizationAnalysis = {
    framework: '',
    total_threads: results.length,
    redundant_patterns: [],
    below_threshold_patterns: [],
    cpu_optimization_opportunities: [],
    memory_optimization_opportunities: [],
    recommendations: [],
    summary: {
      total_memory_savings_mb: 0,
      total_cpu_savings_instructions: 0,
      high_priority_patterns_count: 0,
      total_cpu_instructions: 0,
      total_redundant_instructions: 0,
      redundant_instructions_ratio: 0,
    },
  };

  const threadsByName = new Map<string, ThreadWakeupResult[]>();
  for (const result of results) {
    const key = patternKey(result.threadInfo.threadName);
    const list = threadsByName.get(key);
    if (list === undefined) threadsByName.set(key, [result]);
    else list.push(result);
  }

  // The process total includes every result, including ignored OS_ patterns.
  const totalCpuInstructions = results.reduce(
    (total, result) => total + num(result.totalInstructions),
    0,
  );

  for (const [threadName, threadList] of threadsByName) {
    if (shouldIgnoreSystemPattern(threadName)) continue;

    const totalCount = threadList.length;
    const scored = threadList.map((thread) => ({
      score: perThreadRedundancyScore(thread),
      thread,
    }));
    let passedList = scored
      .filter((entry) => entry.score >= REDUNDANT_SCORE_THRESHOLD)
      .map((entry) => entry.thread);

    if (totalCount >= 2 && passedList.length > 0) {
      // Python `max` keeps the first maximum; both totals use `num()`.
      let primaryWorker = threadList[0];
      for (const thread of threadList) {
        if (num(thread.totalInstructions) > num(primaryWorker.totalInstructions)) {
          primaryWorker = thread;
        }
      }
      const primaryTid = threadIdOf(primaryWorker);
      if (primaryTid !== undefined) {
        passedList = passedList.filter(
          (thread) => threadIdOf(thread) !== primaryTid,
        );
      } else {
        passedList = passedList.filter((thread) => thread !== primaryWorker);
      }
    }

    const count = passedList.length;
    const listForStats = passedList.length > 0 ? passedList : threadList;
    const nStats = listForStats.length;

    const uniqueTids = new Set<number>();
    for (const thread of listForStats) {
      const tid = threadIdOf(thread);
      if (tid !== undefined) uniqueTids.add(tid);
    }
    // HapRay's wakeup results never carry `thread_info.itid`, so the unique
    // itid set is always empty and the field stays 0.
    const uniqueItidCount = 0;
    const uniqueTidCount = uniqueTids.size;

    const totalInstructions = listForStats.reduce(
      (total, thread) => total + num(thread.totalInstructions),
      0,
    );
    const avgInstructions =
      listForStats.length > 0
        ? Math.floor(totalInstructions / listForStats.length)
        : 0;

    const seenTidForInstructions = new Set<number>();
    let redundantInstructions = 0;
    for (const thread of passedList) {
      const tid = threadIdOf(thread);
      if (tid !== undefined && !seenTidForInstructions.has(tid)) {
        seenTidForInstructions.add(tid);
        redundantInstructions += num(thread.totalInstructions);
      } else if (tid === undefined) {
        redundantInstructions += num(thread.totalInstructions);
      }
    }

    const estimatedMemoryBytes = calculateThreadMemoryEstimate(
      uniqueTidCount || listForStats.length,
    );

    let totalWaitingRatio = 0;
    let threadsWithStates = 0;
    let threadsWithCallchains = 0;
    let threadsWithYieldCalls = 0;
    let totalLifetime = 0;
    let totalRunningTime = 0;
    let threadsWithLifetime = 0;
    let threadsNeverRunning = 0;
    let threadsWithZeroWakeupDepth = 0;
    let threadsFrequentImmediateSleep = 0;
    let threadsNeverWoken = 0;
    let totalWakeupCount = 0;
    let totalShortRunningCycles = 0;
    let totalShortRunningPeriods = 0;
    let threadsHighInstructionsLowWork = 0;
    let threadsBusyWaitingPattern = 0;
    let threadsHighFrequencyTransitions = 0;

    for (const thread of listForStats) {
      const wakeupThreads = thread.wakeupThreads;
      if (wakeupThreads.length > 0) {
        const threadStates = wakeupThreads[0].threadStates;
        if (threadStates.length > 0) {
          const totalDur = threadStates.reduce(
            (total, state) => total + num(state.dur),
            0,
          );
          const waitDur = threadStates.reduce(
            (total, state) =>
              WAITING_STATES.includes(state.state)
                ? total + num(state.dur)
                : total,
            0,
          );
          if (totalDur > 0) {
            totalWaitingRatio += waitDur / totalDur;
            threadsWithStates += 1;
          }
        }
      }

      let hasCallchain = false;
      let hasYield = false;
      for (const wakeupThread of wakeupThreads) {
        for (const callchain of wakeupThread.callchains) {
          if (callchain) hasCallchain = true;
          if (!callchain) continue;
          for (const func of callchain.functions) {
            const rawName = func.name || func.symbol || '';
            const rawPath = func.filePath || '';
            const haystack = `${rawName} ${rawPath}`.toLowerCase();
            if (YIELD_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
              hasYield = true;
              break;
            }
          }
          if (hasYield) break;
        }
        if (hasYield) break;
      }
      if (hasCallchain) threadsWithCallchains += 1;
      if (hasYield) threadsWithYieldCalls += 1;

      const { startTs, endTs } = thread.threadInfo;
      if (startTs !== null && endTs !== null) {
        totalLifetime += num(endTs) - num(startTs);
        threadsWithLifetime += 1;
      }

      if (wakeupThreads.length === 0) continue;
      const first = wakeupThreads[0];
      const threadStates = first.threadStates;
      const wakeupDepth = first.wakeupDepth !== undefined ? first.wakeupDepth : -1;
      if (wakeupDepth === 0) threadsWithZeroWakeupDepth += 1;
      if (threadStates.length === 0) continue;

      const states = [...threadStates].sort((a, b) => num(a.ts) - num(b.ts));
      let runningDuration = 0;
      let wakeupCount = 0;
      let shortRunningCycles = 0;
      let thisThreadShortPeriods = 0;
      for (let i = 0; i < states.length; i++) {
        const name = states[i].state;
        const dur = num(states[i].dur);
        if (name === 'Running') {
          runningDuration += dur;
          if (dur < 1_000_000) {
            totalShortRunningPeriods += 1;
            thisThreadShortPeriods += 1;
            const previous = i > 0 ? states[i - 1].state : '';
            const next = i < states.length - 1 ? states[i + 1].state : '';
            if (previous === 'R' && WAITING_STATES.includes(next)) {
              shortRunningCycles += 1;
            } else if (
              previous === 'Running' &&
              next === 'S' &&
              i + 3 < states.length
            ) {
              if (
                states[i + 2].state === 'R' &&
                states[i + 3].state === 'Running' &&
                num(states[i + 3].dur) < 1_000_000
              ) {
                shortRunningCycles += 1;
              }
            } else if (previous === 'Running' && next === 'Running') {
              shortRunningCycles += 1;
            }
          }
        } else if (name === 'R') {
          wakeupCount += 1;
        }
      }
      totalRunningTime += runningDuration;
      totalWakeupCount += wakeupCount;
      totalShortRunningCycles += shortRunningCycles;
      if (runningDuration === 0) threadsNeverRunning += 1;

      const threadInstructions = num(thread.totalInstructions);
      const threadLifetime =
        startTs !== null && endTs !== null
          ? num(endTs) - num(startTs)
          : states.reduce((total, state) => total + num(state.dur), 0);

      if (
        threadInstructions > 10000 &&
        runningDuration > 0 &&
        threadLifetime > 0 &&
        runningDuration / threadLifetime < HIGH_INST_LOW_WORK_RUNNING_RATIO &&
        shortRunningCycles >= HIGH_INST_LOW_WORK_SHORT_CYCLES
      ) {
        threadsHighInstructionsLowWork += 1;
      }

      const totalRunningPeriods = states.filter(
        (state) => state.state === 'Running',
      ).length;
      if (
        thisThreadShortPeriods >= BUSY_WAIT_MIN_PERIODS &&
        totalRunningPeriods > 0 &&
        thisThreadShortPeriods / totalRunningPeriods > BUSY_WAIT_SHORT_RATIO
      ) {
        threadsBusyWaitingPattern += 1;
      }

      if (states.length >= 20 && threadLifetime > 0) {
        const rate = states.length / (threadLifetime / 1_000_000_000);
        if (rate > HIGH_FREQ_TRANSITIONS_PER_SEC) {
          threadsHighFrequencyTransitions += 1;
        }
      }

      if (
        wakeupCount >= FREQUENT_SLEEP_WAKEUP_MIN &&
        shortRunningCycles >= FREQUENT_SLEEP_SHORT_CYCLES_MIN
      ) {
        if (
          shortRunningCycles / Math.max(wakeupCount, 1) > FREQUENT_SLEEP_RATIO
        ) {
          threadsFrequentImmediateSleep += 1;
        }
      } else if (
        thisThreadShortPeriods >= FREQUENT_SLEEP_ALT_PERIODS &&
        shortRunningCycles >= FREQUENT_SLEEP_ALT_CYCLES
      ) {
        threadsFrequentImmediateSleep += 1;
      }

      if (wakeupDepth === 0 && wakeupCount === 0) threadsNeverWoken += 1;
    }

    const avgWaitingRatio =
      threadsWithStates > 0 ? totalWaitingRatio / threadsWithStates : 0;
    const callchainRatio = nStats > 0 ? threadsWithCallchains / nStats : 0;
    const yieldCallRatio = nStats > 0 ? threadsWithYieldCalls / nStats : 0;
    const avgLifetime = threadsWithLifetime > 0 ? totalLifetime / threadsWithLifetime : 0;
    const avgRunningTime = nStats > 0 ? totalRunningTime / nStats : 0;
    const runningTimeRatio = avgLifetime > 0 ? avgRunningTime / avgLifetime : 0;
    const neverRunningRatio = nStats > 0 ? threadsNeverRunning / nStats : 0;
    const zeroWakeupDepthRatio =
      nStats > 0 ? threadsWithZeroWakeupDepth / nStats : 0;
    const frequentImmediateSleepRatio =
      nStats > 0 ? threadsFrequentImmediateSleep / nStats : 0;
    const neverWokenRatio = nStats > 0 ? threadsNeverWoken / nStats : 0;
    const highInstructionsLowWorkRatio =
      nStats > 0 ? threadsHighInstructionsLowWork / nStats : 0;
    const busyWaitingPatternRatio =
      nStats > 0 ? threadsBusyWaitingPattern / nStats : 0;
    const highFrequencyTransitionsRatio =
      nStats > 0 ? threadsHighFrequencyTransitions / nStats : 0;
    const avgWakeupCount = nStats > 0 ? totalWakeupCount / nStats : 0;
    const avgShortRunningCycles =
      nStats > 0 ? totalShortRunningCycles / nStats : 0;
    const avgShortRunningPeriods =
      nStats > 0 ? totalShortRunningPeriods / nStats : 0;

    let redundancyScore = 0;
    const scoreBreakdown: Record<string, number> = {};

    let bonus = 0;
    if (uniqueTidCount >= 30) bonus = 40;
    else if (uniqueTidCount >= 20) bonus = 30;
    else if (uniqueTidCount >= 15) bonus = 25;
    else if (uniqueTidCount >= 10) bonus = 20;
    else if (uniqueTidCount >= 6) bonus = 5;
    if (bonus !== 0) {
      scoreBreakdown[`thread_count(${uniqueTidCount})`] = bonus;
      redundancyScore += bonus;
    }

    bonus = 0;
    if (avgWaitingRatio > 0.95) bonus = 5;
    else if (avgWaitingRatio > 0.85) bonus = 3;
    else if (avgWaitingRatio > 0.75) bonus = 2;
    if (bonus !== 0) {
      scoreBreakdown[`waiting_ratio(${formatPercent0(avgWaitingRatio)}%)`] = bonus;
      redundancyScore += bonus;
    }

    if (avgInstructions === 0) {
      scoreBreakdown.zero_instructions = 10;
      redundancyScore += 10;
    }
    if (zeroWakeupDepthRatio > 0.5) {
      scoreBreakdown[
        `zero_wakeup_depth(${formatPercent0(zeroWakeupDepthRatio)}%)`
      ] = 10;
      redundancyScore += 10;
    }

    bonus = 0;
    if (frequentImmediateSleepRatio > 0.7) bonus = 15;
    else if (frequentImmediateSleepRatio > 0.5) bonus = 10;
    else if (frequentImmediateSleepRatio > 0.3) bonus = 5;
    if (bonus !== 0) {
      scoreBreakdown[
        `frequent_immediate_sleep(${formatPercent0(frequentImmediateSleepRatio)}%)`
      ] = bonus;
      redundancyScore += bonus;
    }

    bonus = 0;
    if (busyWaitingPatternRatio > 0.8) bonus = 10;
    else if (busyWaitingPatternRatio > 0.6) bonus = 7;
    else if (busyWaitingPatternRatio > 0.4) bonus = 5;
    if (bonus !== 0) {
      scoreBreakdown[`busy_waiting(${formatPercent0(busyWaitingPatternRatio)}%)`] =
        bonus;
      redundancyScore += bonus;
    }

    bonus = 0;
    if (highFrequencyTransitionsRatio > 0.8) bonus = 5;
    else if (highFrequencyTransitionsRatio > 0.6) bonus = 3;
    if (bonus !== 0) {
      scoreBreakdown[
        `high_freq_transitions(${formatPercent0(highFrequencyTransitionsRatio)}%)`
      ] = bonus;
      redundancyScore += bonus;
    }

    bonus = 0;
    if (yieldCallRatio > 0.5) bonus = 15;
    else if (yieldCallRatio > 0.3) bonus = 11;
    else if (yieldCallRatio > 0.1) bonus = 7;
    if (bonus !== 0) {
      scoreBreakdown[`yield_calls(${formatPercent0(yieldCallRatio)}%)`] = bonus;
      redundancyScore += bonus;
    }

    bonus = 0;
    if (highInstructionsLowWorkRatio > 0.5) bonus = 15;
    else if (highInstructionsLowWorkRatio > 0.3) bonus = 11;
    else if (highInstructionsLowWorkRatio > 0.1) bonus = 7;
    if (bonus !== 0) {
      scoreBreakdown[
        `high_inst_low_work(${formatPercent0(highInstructionsLowWorkRatio)}%)`
      ] = bonus;
      redundancyScore += bonus;
    }

    let leakScore = 0;
    if (avgLifetime > 15_000_000_000 && runningTimeRatio < 0.005) leakScore += 30;
    else if (avgLifetime > 10_000_000_000 && runningTimeRatio < 0.01) {
      leakScore += 20;
    } else if (avgLifetime > 5_000_000_000 && runningTimeRatio < 0.05) {
      leakScore += 10;
    }
    if (avgWaitingRatio > 0.95 && avgLifetime > 5_000_000_000) leakScore += 30;
    else if (avgWaitingRatio > 0.9 && avgLifetime > 1_000_000_000) leakScore += 20;
    else if (avgWaitingRatio > 0.8) leakScore += 10;
    if (avgInstructions === 0) leakScore += 30;
    else if (neverRunningRatio > 0.5) leakScore += 10;
    if (zeroWakeupDepthRatio > 0.5) leakScore += 10;
    if (neverWokenRatio > 0.7) leakScore += 20;
    else if (neverWokenRatio > 0.5) leakScore += 15;
    else if (neverWokenRatio > 0.3) leakScore += 10;

    const redundancyLevel: RedundancyLevel =
      redundancyScore >= 80 && (uniqueTidCount >= 10 || avgWaitingRatio > 0.9)
        ? 'high'
        : redundancyScore >= 60
          ? 'medium'
          : redundancyScore >= 40
            ? 'low'
            : 'none';
    const leakLevel: RedundancyLevel =
      leakScore >= 80 && (avgLifetime > 5_000_000_000 || avgWaitingRatio > 0.95)
        ? 'high'
        : leakScore >= 60
          ? 'medium'
          : leakScore >= 40
            ? 'low'
            : 'none';
    const optimizationPotential: OptimizationPotential =
      (redundancyLevel === 'high' && redundancyScore >= 90) ||
      (leakLevel === 'high' && leakScore >= 90)
        ? 'high'
        : redundancyLevel === 'high' ||
            redundancyLevel === 'medium' ||
            leakLevel === 'high' ||
            leakLevel === 'medium'
          ? 'medium'
          : 'low';

    const wakeupPattern: RedundancyType =
      frequentImmediateSleepRatio > 0.5
        ? 'frequent_immediate_sleep'
        : neverWokenRatio > 0.5
          ? 'never_woken'
          : busyWaitingPatternRatio > 0.5 || highFrequencyTransitionsRatio > 0.5
            ? 'busy_waiting'
            : highInstructionsLowWorkRatio > 0.5 || yieldCallRatio > 0.5
              ? 'busy_wait'
              : 'normal';

    if (wakeupPattern === 'busy_wait') {
      scoreBreakdown.busy_wait_bonus = 15;
      redundancyScore += 15;
    }

    const threadNameVariants = [
      ...new Set(threadList.map((thread) => thread.threadInfo.threadName)),
    ].sort(compareStrings);
    const callchainSample = collectCallchainSample(listForStats, 10);
    const [callchainFrameTotal, sampleCount] =
      countCallchainFrames(listForStats);
    const redundantInstructionsRatio =
      totalCpuInstructions > 0
        ? redundantInstructions / totalCpuInstructions
        : 0;

    const pattern: OptimizationPattern = {
      thread_name: threadName,
      thread_name_variants: threadNameVariants,
      total_thread_count: totalCount,
      redundant_count: count,
      unique_itid_count: uniqueItidCount,
      unique_tid_count: uniqueTidCount,
      total_instructions: totalInstructions,
      avg_instructions_per_thread: avgInstructions,
      redundant_instructions: redundantInstructions,
      redundant_instructions_ratio: redundantInstructionsRatio,
      estimated_memory_bytes: estimatedMemoryBytes,
      estimated_memory_mb: estimatedMemoryBytes / MIB,
      avg_waiting_ratio: avgWaitingRatio,
      callchain_ratio: callchainRatio,
      optimization_potential: optimizationPotential,
      all_thread_ids: threadList.map((thread) => threadIdOf(thread) ?? 0),
      redundant_thread_ids: passedList.map((thread) => threadIdOf(thread) ?? 0),
      is_duplicate: uniqueTidCount < Math.max(count, 1) * 0.5,
      callchain_sample: callchainSample,
      callchain_frame_total: callchainFrameTotal,
      sample_count: sampleCount,
      redundancy_score: redundancyScore,
      score_breakdown: scoreBreakdown,
      redundancy_level: redundancyLevel,
      leak_score: leakScore,
      leak_level: leakLevel,
      avg_lifetime_ns: avgLifetime,
      avg_lifetime_sec: avgLifetime > 0 ? avgLifetime / 1_000_000_000 : 0,
      running_time_ratio: runningTimeRatio,
      never_running_ratio: neverRunningRatio,
      zero_wakeup_depth_ratio: zeroWakeupDepthRatio,
      frequent_immediate_sleep_ratio: frequentImmediateSleepRatio,
      never_woken_ratio: neverWokenRatio,
      avg_wakeup_count: avgWakeupCount,
      avg_short_running_cycles: avgShortRunningCycles,
      avg_short_running_periods: avgShortRunningPeriods,
      yield_call_ratio: yieldCallRatio,
      high_instructions_low_work_ratio: highInstructionsLowWorkRatio,
      busy_waiting_pattern_ratio: busyWaitingPatternRatio,
      high_frequency_transitions_ratio: highFrequencyTransitionsRatio,
      wakeup_pattern: wakeupPattern,
    };

    // A multi-thread pattern needs 40 points; a lone thread needs 60 so an
    // ordinary idle singleton is not reported as redundant.
    const threshold =
      totalCount >= 2
        ? REDUNDANT_SCORE_THRESHOLD
        : REDUNDANT_SCORE_THRESHOLD_SINGLE_THREAD;
    if (redundancyScore >= threshold) {
      analysis.redundant_patterns.push(pattern);
    } else {
      const totalScore = scored.reduce((total, entry) => total + entry.score, 0);
      analysis.below_threshold_patterns.push({
        thread_name: threadName,
        thread_name_variants: threadNameVariants,
        total_thread_count: totalCount,
        all_thread_ids: pattern.all_thread_ids,
        redundant_count: count,
        max_score: redundancyScore,
        avg_score: totalCount > 0 ? round1(totalScore / totalCount) : 0,
      });
    }
  }

  // Stable sort: equal counts keep the pattern insertion order.
  analysis.redundant_patterns.sort(
    (a, b) => b.redundant_count - a.redundant_count,
  );

  for (const pattern of analysis.redundant_patterns) {
    if (pattern.total_instructions > 0 && pattern.redundant_count > 10) {
      analysis.cpu_optimization_opportunities.push({
        thread_name: pattern.thread_name,
        current_instructions: pattern.total_instructions,
        potential_savings: pattern.total_instructions * 0.5,
        reduction_percentage: 50,
        method: '减少线程数量',
      });
    }
  }
  for (const pattern of analysis.redundant_patterns) {
    const uniqueTids = pattern.unique_tid_count;
    if (uniqueTids >= 5) {
      const suggestion =
        uniqueTids >= 20
          ? uniqueTids * 0.6
          : uniqueTids >= 10
            ? uniqueTids * 0.4
            : uniqueTids * 0.2;
      analysis.memory_optimization_opportunities.push({
        thread_name: pattern.thread_name,
        current_threads: uniqueTids,
        suggested_reduction: Math.trunc(suggestion),
        current_memory_mb: pattern.estimated_memory_mb,
        potential_savings_mb:
          calculateThreadMemoryEstimate(Math.trunc(suggestion)) / MIB,
        reduction_percentage: (suggestion / uniqueTids) * 100,
        is_duplicate: pattern.is_duplicate,
      });
    }
  }

  let totalMemory = 0;
  for (const opportunity of analysis.memory_optimization_opportunities) {
    totalMemory += opportunity.potential_savings_mb || 0;
  }
  let totalCpu = 0;
  for (const opportunity of analysis.cpu_optimization_opportunities) {
    totalCpu += opportunity.potential_savings || 0;
  }
  const totalRedundantInstructions = analysis.redundant_patterns.reduce(
    (total, pattern) => total + pattern.redundant_instructions,
    0,
  );
  const redundantInstructionsRatio =
    totalCpuInstructions > 0
      ? totalRedundantInstructions / totalCpuInstructions
      : 0;
  const highPriority = analysis.redundant_patterns.filter(
    (pattern) => pattern.optimization_potential === 'high',
  );

  if (highPriority.length > 0) {
    analysis.recommendations.push({
      priority: 'high',
      title: '高优先级优化',
      details: highPriority.slice(0, 5).map(
        (pattern) =>
          `${pattern.thread_name}: ${pattern.redundant_count} 个冗余线程，建议减少到 ${Math.max(
            8,
            Math.trunc(pattern.redundant_count * 0.3),
          )} 个`,
      ),
    });
  }
  if (analysis.cpu_optimization_opportunities.length > 0) {
    const topCpu = [...analysis.cpu_optimization_opportunities]
      .sort((a, b) => b.potential_savings - a.potential_savings)
      .slice(0, 3);
    analysis.recommendations.push({
      priority: 'medium',
      title: 'CPU优化机会',
      details: topCpu.map(
        (opportunity) =>
          `${opportunity.thread_name}: 可节省 ${formatWithCommas(
            opportunity.potential_savings,
          )} 指令 (${opportunity.reduction_percentage}%)`,
      ),
    });
  }
  if (analysis.memory_optimization_opportunities.length > 0) {
    const topMemory = [...analysis.memory_optimization_opportunities]
      .sort((a, b) => b.potential_savings_mb - a.potential_savings_mb)
      .slice(0, 5);
    analysis.recommendations.push({
      priority: 'medium',
      title: '内存优化机会',
      details: topMemory.map(
        (opportunity) =>
          `${opportunity.thread_name}: ${opportunity.current_threads} → ${
            opportunity.current_threads - opportunity.suggested_reduction
          } 个，可节省 ${opportunity.potential_savings_mb.toFixed(2)} MB`,
      ),
    });
  }

  analysis.summary = {
    total_memory_savings_mb: totalMemory,
    total_cpu_savings_instructions: totalCpu,
    high_priority_patterns_count: highPriority.length,
    total_cpu_instructions: totalCpuInstructions,
    total_redundant_instructions: totalRedundantInstructions,
    redundant_instructions_ratio: redundantInstructionsRatio,
  };
  return analysis;
}

/** One redundant thread: score descending, then display name ascending. */
function byRedundantThreadOrder(
  a: RedundantThreadPattern,
  b: RedundantThreadPattern,
): number {
  if (a.redundancy_score !== b.redundancy_score) {
    return b.redundancy_score - a.redundancy_score;
  }
  return compareStrings(a.thread_name, b.thread_name);
}

/**
 * Port of HapRay `ThreadAnalyzer._analyze_impl`'s payload construction.
 *
 * Returns the three HapRay payloads with their snake_case keys intact. The two
 * deterministic deviations are documented by the task: `redundant_threads` is
 * sorted by score then name, and `below_threshold_patterns` by name, instead
 * of relying on trace insertion order. Summary floats keep Python's
 * `round(x, 6)` treatment.
 */
export function computeThreadAnalysis(
  results: ThreadWakeupResult[],
): ThreadAnalysis {
  const analysis = analyzeOptimizationOpportunities(results);
  const source = analysis.summary;
  const summary: RedundantThreadsSummary = {
    redundancy_types: { ...REDUNDANCY_TYPE_LABELS },
    total_redundant_thread_patterns: 0,
    total_redundant_threads: 0,
    total_cpu_instructions: source.total_cpu_instructions,
    total_redundant_instructions: source.total_redundant_instructions,
    redundant_instructions_ratio: round6(source.redundant_instructions_ratio),
    redundant_threads: [],
  };

  for (const pattern of analysis.redundant_patterns) {
    const redundantCount = pattern.unique_tid_count;
    summary.total_redundant_thread_patterns += 1;
    summary.total_redundant_threads += redundantCount;

    const variants = pattern.thread_name_variants;
    const displayName =
      variants.length === 1 ? variants[0] : `${pattern.thread_name}_*`;
    const wakeupPattern = pattern.wakeup_pattern;
    summary.redundant_threads.push({
      thread_name: displayName,
      thread_name_variants: variants,
      type: wakeupPattern,
      type_label:
        REDUNDANCY_TYPE_LABELS[wakeupPattern] ?? REDUNDANCY_TYPE_LABELS.normal,
      total_thread_count: pattern.total_thread_count,
      redundant_count: redundantCount,
      redundant_instructions: pattern.redundant_instructions,
      redundant_instructions_ratio: round6(pattern.redundant_instructions_ratio),
      estimated_memory_mb: round2(pattern.estimated_memory_mb),
      redundancy_score: pattern.redundancy_score,
      score_breakdown: pattern.score_breakdown,
      redundancy_level: pattern.redundancy_level,
      leak_score: pattern.leak_score,
      leak_level: pattern.leak_level,
      waiting_ratio: round1(pattern.avg_waiting_ratio * 100),
      wakeup_pattern: wakeupPattern,
      all_thread_ids: pattern.all_thread_ids,
      redundant_thread_ids: pattern.redundant_thread_ids,
      callchain_sample: pattern.callchain_sample,
    });
  }
  summary.redundant_threads.sort(byRedundantThreadOrder);

  const belowThresholdPatterns = [...analysis.below_threshold_patterns].sort(
    (a, b) => compareStrings(a.thread_name, b.thread_name),
  );

  return {
    redundantThreadsSummary: summary,
    summary: source,
    belowThresholdPatterns,
  };
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

function threadMetric(
  id: string,
  value: number,
  unit: MetricUnit,
  ctx: AnalyzeContext,
): Metric {
  return metric({
    id,
    value,
    unit,
    fidelity: 'exact',
    provenance: {
      collector: 'hitrace+streamer',
      device: ctx.deviceId,
    },
  });
}

/**
 * The five thread metrics, always emitted when the database handle exists.
 *
 * `thread.patterns.count` and `thread.redundant.count` are HapRay's
 * `total_redundant_thread_patterns` / `total_redundant_threads`; all five are
 * exact. The ratio is the 0-1 payload ratio scaled to a percentage.
 */
function threadMetrics(analysis: ThreadAnalysis, ctx: AnalyzeContext): Metric[] {
  const summary = analysis.redundantThreadsSummary;
  return [
    threadMetric(
      'thread.patterns.count',
      summary.total_redundant_thread_patterns,
      'count',
      ctx,
    ),
    threadMetric(
      'thread.redundant.count',
      summary.total_redundant_threads,
      'count',
      ctx,
    ),
    threadMetric(
      'thread.instructions.total',
      summary.total_cpu_instructions,
      'count',
      ctx,
    ),
    threadMetric(
      'thread.redundant.instructions',
      summary.total_redundant_instructions,
      'count',
      ctx,
    ),
    threadMetric(
      'thread.redundant.instructions.ratio',
      analysis.summary.redundant_instructions_ratio * 100,
      '%',
      ctx,
    ),
  ];
}

/** One evidence per redundant thread pattern; the display name keys the id. */
function redundancyEvidence(
  pattern: RedundantThreadPattern,
  ctx: AnalyzeContext,
): Evidence {
  return evidence({
    kind: 'thread_redundancy',
    severity: 'warn',
    subject: { process: appProcessName(ctx), thread: pattern.thread_name },
    window: ctx.window,
    signals: {
      score: pattern.redundancy_score,
      redundantCount: pattern.redundant_count,
      waitingRatio: pattern.waiting_ratio,
      instructions: pattern.redundant_instructions,
    },
    explain: pattern.type_label,
    drillDown: [
      {
        label: 'Thread pattern',
        tool: 'threads.pattern',
        args: { threadName: pattern.thread_name },
        returns: 'RedundantThreadPattern',
        estRows: pattern.redundant_count,
      },
    ],
    key: pattern.thread_name,
  });
}

/** Zero-metrics evidence for a context assembled without the raw handle. */
function missingDbEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'trace database handle (ctx.db) was not provided; thread analysis skipped',
    drillDown: [],
  });
}

/** Zero-pattern evidence when the wakeup results contain no redundancy. */
function noPatternsEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'no redundant thread pattern was found; thread optimization analysis skipped',
    drillDown: [],
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Sort order for evidence: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Redundant-thread analyzer over the wakeup chain and thread-state tables.
 *
 * The engine gates this analyzer on `trace.sched` and `trace.thread_state`.
 * `ctx.db` is still checked because the handle is optional on
 * `AnalyzeContext`; without it the analyzer emits one `no_data` evidence and no
 * metrics. The wakeup analysis is deliberately called without `timeRange`:
 * HapRay derives the range from the trace itself, and the CLI's open window
 * (`0..MAX_SAFE_INTEGER`) would change the thread-state predicate.
 *
 * With zero redundant patterns the five metrics are still real measurements of
 * zero, so they are emitted alongside a single `no_data` evidence explaining
 * that the analysis found no pattern to report.
 */
export class ThreadAnalyzer implements Analyzer {
  readonly id = 'threads';
  readonly requires: CapabilityId[] = ['trace.sched', 'trace.thread_state'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return { metrics: [], evidence: [missingDbEvidence(ctx)] };
    }

    const analysis = computeThreadAnalysis(
      analyzeThreadWakeup(ctx.db, { appPids: ctx.app.pids }),
    );
    const metrics = threadMetrics(analysis, ctx);
    const patterns = analysis.redundantThreadsSummary.redundant_threads;
    const evidenceItems =
      patterns.length > 0
        ? patterns.map((pattern) => redundancyEvidence(pattern, ctx))
        : [noPatternsEvidence(ctx)];

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
