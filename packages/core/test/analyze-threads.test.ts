import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import {
  ThreadAnalyzer,
  computeThreadAnalysis,
  perThreadRedundancyScore,
  threadRedundancyFeatures,
} from '../src/analyze/threads-score';
import type { ThreadWakeupResult } from '../src/analyze/threads-wakeup';
import type { AnalyzeContext } from '../src/analyze/types';

const START = 1_000_000_000;
const MS = 1_000_000;
const LIFETIME = 1_000_000_000;

/**
 * HapRay `REDUNDANCY_TYPE_LABELS`, copied from `thread_analyzer.py:25-31`.
 *
 * The parity test anchors the same strings against `threads.*.json`, so this
 * literal only keeps the unit test independent of the private constant.
 */
const EXPECTED_LABELS = {
  normal: '未命中下述唤醒模式，多为高等待或混合行为。',
  frequent_immediate_sleep: '被频繁唤醒但立即进入等待，典型无效调度。',
  never_woken: '从未被唤醒，可能未被使用或孤立线程。',
  busy_waiting: '短运行周期占比高或状态切换极频繁（跑一下就睡、跑一下就睡）。',
  busy_wait: '高指令数但运行占比极低或含大量yield，属忙等浪费CPU。',
};

interface State {
  ts: number;
  dur: number;
  state: string;
}

/**
 * Twenty `R -> Running -> S` cycles.
 *
 * With `rDur = 10_000` the wait ratio is 20e6 / 22.2e6 = 0.9009 (the >0.85
 * branch), every Running state is a short (<1ms) period preceded by `R` and
 * followed by `S`, and 20 short cycles sit under 20 wakeups. With
 * `rDur = 1_000_000` the wait ratio drops to 40e6 / 42e6 = 0.9524 but every
 * state duration is >= 1ms, so the short-cycle counters stay at zero.
 */
function states(cycles: number, rDur: number): State[] {
  const result: State[] = [];
  for (let i = 0; i < cycles; i++) {
    const base = START + i * 2_100_000;
    result.push({ ts: base, dur: rDur, state: 'R' });
    result.push({ ts: base + rDur, dur: 100_000, state: 'Running' });
    result.push({ ts: base + rDur + 100_000, dur: 1_000_000, state: 'S' });
  }
  return result;
}

/** The state layout that drives the high-score duplicated patterns. */
function highStates(): State[] {
  return states(20, 10_000);
}

/** The layout whose per-thread score (35) stays below the multi threshold. */
function lowStates(): State[] {
  return states(20, 1_000_000);
}

const YIELD_CALLCHAIN = [
  {
    functions: [
      {
        symbol: 'sched_yield',
        name: 'sched_yield',
        filePath: '/proc/self/libace.so',
      },
    ],
  },
];

function makeResult(opts: {
  threadId: number;
  threadName: string;
  totalInstructions: number;
  threadStates: State[];
  startTs: number | null;
  endTs: number | null;
  yieldCallchain?: boolean;
}): ThreadWakeupResult {
  return {
    threadId: opts.threadId,
    threadInfo: {
      threadName: opts.threadName,
      startTs: opts.startTs,
      endTs: opts.endTs,
    },
    totalInstructions: opts.totalInstructions,
    wakeupThreads: [
      {
        itid: opts.threadId,
        tid: opts.threadId,
        threadName: opts.threadName,
        pid: 5000,
        processName: 'com.demo',
        instructionCount: opts.totalInstructions,
        isSystemThread: false,
        wakeupDepth: 0,
        threadStates: opts.threadStates,
        callchains: opts.yieldCallchain === true ? YIELD_CALLCHAIN : [],
      },
    ],
  };
}

/**
 * `zeta.work` is inserted first so the score tie with `ace.bg` proves the
 * public name-ascending tie-break rather than the insertion order.
 *
 * `mid.work` has zero instructions, so both of its threads score 35: neither
 * passes the redundant threshold, which makes the pattern fall back to
 * `thread_list` for statistics (unique_tid_count 2, redundant_count 0) while
 * its aggregate score (50) still clears the 40-point threshold.
 *
 * `solo_thread` is the only singleton and stays below the 60-point
 * single-thread threshold. The two `OS_system` threads score normally but are
 * filtered from both output arrays.
 */
function syntheticResults(): ThreadWakeupResult[] {
  const high = highStates();
  const low = lowStates();
  return [
    makeResult({
      threadId: 7001,
      threadName: 'zeta.work_1',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
    makeResult({
      threadId: 7002,
      threadName: 'zeta.work_2',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
    makeResult({
      threadId: 5001,
      threadName: 'ace.bg_1',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
    makeResult({
      threadId: 5002,
      threadName: 'ace.bg_2',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
    makeResult({
      threadId: 6001,
      threadName: 'mid.work_1',
      totalInstructions: 0,
      threadStates: low,
      startTs: START,
      endTs: START + 2 * MS,
    }),
    makeResult({
      threadId: 6002,
      threadName: 'mid.work_2',
      totalInstructions: 0,
      threadStates: low,
      startTs: START,
      endTs: START + 2 * MS,
    }),
    makeResult({
      threadId: 4001,
      threadName: 'solo_thread',
      totalInstructions: 500,
      threadStates: [
        { ts: START, dur: MS, state: 'S' },
        { ts: START + MS, dur: 500_000, state: 'Running' },
      ],
      startTs: null,
      endTs: null,
    }),
    makeResult({
      threadId: 9001,
      threadName: 'OS_system_1',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
    makeResult({
      threadId: 9002,
      threadName: 'OS_system_2',
      totalInstructions: 20000,
      threadStates: high,
      startTs: START,
      endTs: START + LIFETIME,
      yieldCallchain: true,
    }),
  ];
}

describe('computeThreadAnalysis', () => {
  it('normalizes pattern keys, aggregates duplicates, and sorts by score then name', () => {
    const analysis = computeThreadAnalysis(syntheticResults());
    const summary = analysis.redundantThreadsSummary;

    expect(summary.redundancy_types).toEqual(EXPECTED_LABELS);
    expect(summary.total_redundant_thread_patterns).toBe(3);
    // ace.bg and zeta.work lose their primary worker (1 each); mid.work has no
    // passing thread, so its two unique tids are counted.
    expect(summary.total_redundant_threads).toBe(4);
    expect(summary.total_cpu_instructions).toBe(120500);
    expect(summary.total_redundant_instructions).toBe(40000);
    // Python `round(40000 / 120500, 6)`.
    expect(summary.redundant_instructions_ratio).toBe(0.33195);

    expect(summary.redundant_threads.map((thread) => thread.thread_name)).toEqual([
      'ace.bg_*',
      'zeta.work_*',
      'mid.work_*',
    ]);
    expect(summary.redundant_threads.map((thread) => thread.redundancy_score)).toEqual([
      68, 68, 50,
    ]);

    const ace = summary.redundant_threads[0];
    expect(ace.thread_name_variants).toEqual(['ace.bg_1', 'ace.bg_2']);
    expect(ace.type).toBe('frequent_immediate_sleep');
    expect(ace.type_label).toBe(
      EXPECTED_LABELS.frequent_immediate_sleep,
    );
    expect(ace.total_thread_count).toBe(2);
    expect(ace.redundant_count).toBe(1);
    expect(ace.redundant_instructions).toBe(20000);
    expect(ace.redundant_instructions_ratio).toBe(0.165975);
    expect(ace.estimated_memory_mb).toBe(1.02);
    expect(ace.redundancy_score).toBe(68);
    expect(ace.redundancy_level).toBe('medium');
    expect(ace.leak_score).toBe(20);
    expect(ace.leak_level).toBe('none');
    expect(ace.waiting_ratio).toBe(90.1);
    expect(ace.wakeup_pattern).toBe('frequent_immediate_sleep');
    expect(ace.all_thread_ids).toEqual([5001, 5002]);
    expect(ace.redundant_thread_ids).toEqual([5002]);
    expect(ace.callchain_sample).toEqual([
      {
        symbol: 'sched_yield',
        file_path: '/proc/self/libace.so',
        count: 1,
      },
    ]);
    expect(ace.score_breakdown).toEqual({
      'waiting_ratio(90%)': 3,
      'zero_wakeup_depth(100%)': 10,
      'frequent_immediate_sleep(100%)': 15,
      'busy_waiting(100%)': 10,
      'yield_calls(100%)': 15,
      'high_inst_low_work(100%)': 15,
    });

    const zeta = summary.redundant_threads[1];
    expect(zeta.thread_name_variants).toEqual(['zeta.work_1', 'zeta.work_2']);
    expect(zeta.redundant_count).toBe(1);
    expect(zeta.redundant_thread_ids).toEqual([7002]);

    const mid = summary.redundant_threads[2];
    expect(mid.thread_name_variants).toEqual(['mid.work_1', 'mid.work_2']);
    expect(mid.total_thread_count).toBe(2);
    expect(mid.redundant_count).toBe(2);
    expect(mid.redundant_instructions).toBe(0);
    expect(mid.redundant_instructions_ratio).toBe(0);
    expect(mid.estimated_memory_mb).toBe(2.05);
    expect(mid.redundancy_score).toBe(50);
    expect(mid.redundancy_level).toBe('low');
    expect(mid.leak_score).toBe(40);
    expect(mid.leak_level).toBe('low');
    expect(mid.waiting_ratio).toBe(47.6);
    expect(mid.redundant_thread_ids).toEqual([]);
    expect(mid.callchain_sample).toEqual([]);
    expect(mid.score_breakdown).toEqual({
      zero_instructions: 10,
      'zero_wakeup_depth(100%)': 10,
      'frequent_immediate_sleep(100%)': 15,
      'busy_waiting(100%)': 10,
      'high_freq_transitions(100%)': 5,
    });

    expect(analysis.summary).toEqual({
      total_memory_savings_mb: 0,
      total_cpu_savings_instructions: 0,
      high_priority_patterns_count: 0,
      total_cpu_instructions: 120500,
      total_redundant_instructions: 40000,
      redundant_instructions_ratio: 0.33195020746887965,
    });

    expect(analysis.belowThresholdPatterns).toEqual([
      {
        thread_name: 'solo_thread',
        thread_name_variants: ['solo_thread'],
        total_thread_count: 1,
        all_thread_ids: [4001],
        redundant_count: 0,
        max_score: 10,
        avg_score: 30,
      },
    ]);

    // OS_ patterns are ignored by both output arrays even though their
    // instructions still count toward the process total.
    const serialized = JSON.stringify(analysis);
    expect(serialized).not.toContain('OS_system');
    expect(analysis.summary.total_cpu_instructions).toBe(120500);
  });

  it('scores and summarizes a single thread with HapRay\'s exact fields', () => {
    const [zeta] = syntheticResults();
    expect(perThreadRedundancyScore(zeta)).toBe(77);
    expect(threadRedundancyFeatures(zeta)).toEqual({
      waiting_ratio: 20_000_000 / 22_200_000,
      total_instructions: 20000,
      has_callchain: true,
      has_yield: true,
      short_cycles: 20,
      run_ratio: 2_000_000 / 1_000_000_000,
      wakeup_depth: 0,
      wakeup_count: 20,
    });

    const [mid] = syntheticResults().slice(4, 5);
    expect(perThreadRedundancyScore(mid)).toBe(35);
    const [solo] = syntheticResults().slice(6, 7);
    expect(perThreadRedundancyScore(solo)).toBe(30);
  });

  it('returns an all-zero analysis for empty input', () => {
    expect(computeThreadAnalysis([])).toEqual({
      redundantThreadsSummary: {
        redundancy_types: EXPECTED_LABELS,
        total_redundant_thread_patterns: 0,
        total_redundant_threads: 0,
        total_cpu_instructions: 0,
        total_redundant_instructions: 0,
        redundant_instructions_ratio: 0,
        redundant_threads: [],
      },
      summary: {
        total_memory_savings_mb: 0,
        total_cpu_savings_instructions: 0,
        high_priority_patterns_count: 0,
        total_cpu_instructions: 0,
        total_redundant_instructions: 0,
        redundant_instructions_ratio: 0,
      },
      belowThresholdPatterns: [],
    });
  });
});

/**
 * A trace with two app threads that score as redundant patterns.
 *
 * `ace.bg_*` threads have no callchains (pattern score 53); the `zeta.work_*`
 * threads carry a yield frame (pattern score 68). Each pattern's highest
 * instruction thread is the primary worker and is excluded from the redundant
 * counts, so both patterns report one redundant thread and 20000 redundant
 * instructions out of 80000 total.
 */
const DB_DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT);
  CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT);
  CREATE TABLE trace_range(start_ts INT, end_ts INT);
  CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
    ref_type TEXT, value REAL);
  CREATE TABLE thread_state(ts INT, dur INT, cpu INT, itid INT, tid INT,
    pid INT, state TEXT, arg_setid INT);
  CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
    thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT,
    cpu_id INT, thread_state TEXT);
  CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
    thread_name TEXT);
  CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT, file_id INT,
    symbol_id INT, name TEXT);
  CREATE TABLE perf_files(id INT, file_id INT, serial_id INT, symbol TEXT,
    path TEXT);
`;

const DB_THREADS: Array<[number, number, string]> = [
  [500, 5001, 'ace.bg_1'],
  [501, 5002, 'ace.bg_2'],
  [700, 7001, 'zeta.work_1'],
  [701, 7002, 'zeta.work_2'],
];

function seed(db: DatabaseSync): void {
  db.exec(DB_DDL);
  const threadRows = DB_THREADS.map(
    ([id, tid, name]) =>
      `(${id}, ${id}, ${tid}, '${name}', ${START}, ${START + LIFETIME}, 10, 0, 0)`,
  ).join(',\n');
  const perfThreadRows = DB_THREADS.map(
    ([id, tid, name]) => `(${id}, ${tid}, 5000, '${name}')`,
  ).join(',\n');
  db.exec(`
    INSERT INTO process VALUES (0, 10, 5000, 'com.demo', 0, 0, 4, 0, 0);
    INSERT INTO thread VALUES ${threadRows};
    INSERT INTO trace_range VALUES (${START}, ${START + 100 * MS});
    INSERT INTO perf_thread VALUES ${perfThreadRows};
    INSERT INTO perf_sample VALUES
      (0, NULL, ${START + MS}, 5001, 20000, 1, ${START + MS}, 0, ''),
      (1, NULL, ${START + MS}, 5002, 20000, 1, ${START + MS}, 0, ''),
      (2, 11, ${START + MS}, 7001, 20000, 1, ${START + MS}, 0, ''),
      (3, 12, ${START + MS}, 7002, 20000, 1, ${START + MS}, 0, '');
    INSERT INTO perf_callchain VALUES
      (0, 11, 0, 1, 1, 'sched_yield'),
      (1, 12, 0, 1, 1, 'sched_yield');
    INSERT INTO perf_files VALUES
      (0, 1, 1, 'sched_yield', '/proc/self/libace.so');
  `);

  const stateRows: string[] = [];
  for (const [id, tid] of DB_THREADS) {
    for (const state of highStates()) {
      stateRows.push(
        `(${state.ts}, ${state.dur}, 0, ${id}, ${tid}, 5000, '${state.state}', 0)`,
      );
    }
  }
  db.exec(`INSERT INTO thread_state VALUES ${stateRows.join(',\n')}`);
}

let dir: string;
let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-binder-score-'));
  const path = join(dir, 't.db');
  const raw = new DatabaseSync(path);
  seed(raw);
  raw.close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PROBE = { command: 'probe', stdout: '', stderr: '', code: 0 };

function makeCtx(
  opts: { withDb?: boolean; pids?: number[] } = {},
): AnalyzeContext {
  const { withDb = true, pids = [5000] } = opts;
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    ...(withDb ? { db } : {}),
    app: { packageName: 'com.demo', pids, processNames: ['com.demo'] },
    window: { startNs: START, endNs: START + 100 * MS },
    caps: new CapabilityMatrix([
      { id: 'trace.sched', available: true, fidelity: 'exact', probe: PROBE },
      {
        id: 'trace.thread_state',
        available: true,
        fidelity: 'exact',
        probe: PROBE,
      },
    ]),
    deviceId: 'emu-threads',
  };
}

describe('ThreadAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new ThreadAnalyzer();
    expect(analyzer.id).toBe('threads');
    expect(analyzer.requires).toEqual(['trace.sched', 'trace.thread_state']);
  });

  it('emits the five thread metrics with the ratio as a percentage', async () => {
    const result = await new ThreadAnalyzer().run(makeCtx());
    const byId = new Map(result.metrics.map((entry) => [entry.id, entry]));

    expect([...byId.keys()]).toEqual([
      'thread.instructions.total',
      'thread.patterns.count',
      'thread.redundant.count',
      'thread.redundant.instructions',
      'thread.redundant.instructions.ratio',
    ]);
    expect(byId.get('thread.patterns.count')).toMatchObject({
      value: 2,
      unit: 'count',
    });
    expect(byId.get('thread.redundant.count')).toMatchObject({
      value: 2,
      unit: 'count',
    });
    expect(byId.get('thread.instructions.total')).toMatchObject({
      value: 80000,
      unit: 'count',
    });
    expect(byId.get('thread.redundant.instructions')).toMatchObject({
      value: 40000,
      unit: 'count',
    });
    expect(byId.get('thread.redundant.instructions.ratio')).toMatchObject({
      value: 50,
      unit: '%',
    });

    for (const entry of result.metrics) {
      expect(entry.fidelity).toBe('exact');
      expect(entry.provenance).toEqual({
        collector: 'hitrace+streamer',
        device: 'emu-threads',
      });
    }
  });

  it('emits one warn-level thread_redundancy per redundant pattern', async () => {
    const result = await new ThreadAnalyzer().run(makeCtx());
    expect(result.evidence).toHaveLength(2);
    expect(new Set(result.evidence.map((item) => item.id)).size).toBe(2);

    for (const item of result.evidence) {
      expect(item.kind).toBe('thread_redundancy');
      expect(item.severity).toBe('warn');
      expect(item.subject.process).toBe('com.demo');
      expect(item.window).toEqual({ startNs: START, endNs: START + 100 * MS });
      expect(item.explain).toBe(EXPECTED_LABELS.frequent_immediate_sleep);
      expect(item.drillDown).toEqual([
        {
          label: 'Thread pattern',
          tool: 'threads.pattern',
          args: { threadName: item.subject.thread },
          returns: 'RedundantThreadPattern',
          estRows: item.signals.redundantCount,
        },
      ]);
      expect('key' in item).toBe(false);
    }

    const ace = result.evidence.find((item) => item.subject.thread === 'ace.bg_*');
    expect(ace).toBeDefined();
    expect(ace?.signals).toEqual({
      score: 53,
      redundantCount: 1,
      waitingRatio: 90.1,
      instructions: 20000,
    });

    const zeta = result.evidence.find(
      (item) => item.subject.thread === 'zeta.work_*',
    );
    expect(zeta).toBeDefined();
    expect(zeta?.signals).toEqual({
      score: 68,
      redundantCount: 1,
      waitingRatio: 90.1,
      instructions: 20000,
    });
  });

  it('emits zero metrics and one no_data evidence when no pattern is redundant', async () => {
    const result = await new ThreadAnalyzer().run(makeCtx({ pids: [] }));
    expect(result.metrics).toHaveLength(5);
    for (const entry of result.metrics) expect(entry.value).toBe(0);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('no_data');
    expect(result.evidence[0].severity).toBe('info');
    expect(result.evidence[0].subject.process).toBe('com.demo');
    expect(result.evidence[0].explain).toMatch(/redundant/i);
  });

  it('returns one no_data evidence and no metrics without ctx.db', async () => {
    const result = await new ThreadAnalyzer().run(makeCtx({ withDb: false }));
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    expect(item.kind).toBe('no_data');
    expect(item.severity).toBe('info');
    expect(item.subject.process).toBe('com.demo');
    expect(item.explain).toMatch(/ctx\.db/);
    expect(item.explain).toMatch(/thread/i);
    expect(item.drillDown).toEqual([]);
  });
});
