// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/** One `perf_thread` row; `threadId` joins `perf_sample.thread_id`. */
export interface PerfThread {
  id: number;
  threadId: number;
  processId: number;
  threadName: string;
}

/**
 * One `perf_sample` row with camelCase field names.
 *
 * `timestampTrace` is the trace-relative nanosecond timestamp and is the
 * column ranges are applied to (matching HapRay's preferred timestamp column).
 * `timeStamp` is kept as a separate field for callers that need the raw perf
 * timestamp.
 */
export interface PerfSampleRow {
  id: number;
  callchainId: number;
  timeStamp: number;
  threadId: number;
  eventCount: number;
  eventTypeId: number;
  timestampTrace: number;
  cpuId: number;
  threadState: string;
}

/** One resolved frame of a perf callchain. */
export interface PerfFunction {
  symbol: string;
  name: string;
  filePath: string;
}

/** A callchain for one perf thread, frames ordered by `depth`. */
export interface PerfCallchain {
  threadId: number;
  callchainId: number;
  functions: PerfFunction[];
}

/**
 * Sample weight attributed to one leaf symbol.
 *
 * `event_count` is attributed to the deepest frame of the sample's callchain
 * (the "self" cost), so rows answer "which function was executing when the
 * sample was taken". A chain whose deepest frame has an empty symbol is not
 * attributable and contributes no row.
 */
export interface PerfLeafAttribution {
  symbol: string;
  filePath: string;
  samples: number;
  /** True when `symbol` is a `file+0xoffset` reference, not a name. */
  unresolved: boolean;
}

/**
 * One row of summed sample weight per `(symbol, filePath, unresolved)`.
 *
 * This is the population {@link PerfQuery.leafAttribution} returns, plus the
 * frames no symbol resolves at all, so the rows sum to the window's weight.
 * `unresolved` separates "the recorder had no symbol" from "the lookup
 * missed": a `libfoo.so+0x1cce24` symbol is honest, and counting it as
 * resolved would make the numbers read better than the capture is.
 */
export interface SymbolStat {
  symbol: string;
  filePath: string;
  samples: number;
  unresolved: boolean;
}

/**
 * True when a resolved symbol is a `file+0xoffset` reference or empty.
 *
 * The converter writes `libfoo.so+0x1cce24` when it has no symbol for an
 * address, so the text is honest but unnamed. A space means the text is a
 * sentence or a demangled signature, never that form. The file path is never
 * part of the test: an unresolved frame still names the library it ran in,
 * which is what makes the evidence actionable.
 */
export function isUnresolvedSymbol(symbol: string): boolean {
  return symbol === '' || /^[^ ]+\+0x[0-9a-f]+$/.test(symbol);
}

/**
 * One folded stack, in the format `flamegraph.pl` and every flamegraph viewer
 * understands: `a;b;c` with `samples` samples ending at `c`.
 */
export interface FoldedStack {
  /** Semicolon-joined symbol path, root first. */
  stack: string;
  /** The last symbol on the stack — the frame the samples were taken in. */
  leaf: string;
  /** Summed `event_count` of every sample folded into this stack. */
  samples: number;
}

interface PerfThreadRow {
  id: number | null;
  thread_id: number | null;
  process_id: number | null;
  thread_name: string | null;
}

interface PerfSampleRowDb {
  id: number | null;
  callchain_id: number | null;
  timeStamp: number | null;
  thread_id: number | null;
  event_count: number | null;
  event_type_id: number | null;
  timestamp_trace: number | null;
  cpu_id: number | null;
  thread_state: string | null;
}

interface PerfChainIdRow {
  thread_id: number | null;
  callchain_id: number | null;
}

interface PerfFrameRow {
  callchain_id: number | null;
  depth: number | null;
  file_id: number | null;
  symbol_id: number | null;
  /**
   * A `data_dict` id in a real capture; text in a hand-built database. SQLite
   * does not enforce the declared type, so both shapes arrive here.
   */
  name: number | string | null;
}

interface PerfFileRow {
  id: number | null;
  file_id: number | null;
  serial_id: number | null;
  symbol: string | null;
  path: string | null;
}

/** HapRay's cap on distinct chain ids collected per thread. */
const MAX_CHAIN_IDS_PER_THREAD = 50;
/** HapRay's cap on callchains returned per thread. */
const DEFAULT_CHAINS_PER_THREAD = 20;

const SELECT_PERF_THREADS = `SELECT id, thread_id, process_id, thread_name
FROM perf_thread`;

const SELECT_PERF_SAMPLES = `SELECT id, callchain_id, timeStamp, thread_id,
       event_count, event_type_id, timestamp_trace, cpu_id, thread_state
FROM perf_sample`;

function toPerfThread(row: PerfThreadRow): PerfThread {
  return {
    id: num(row.id),
    threadId: num(row.thread_id),
    processId: num(row.process_id),
    threadName: str(row.thread_name),
  };
}

function toPerfSample(row: PerfSampleRowDb): PerfSampleRow {
  return {
    id: num(row.id),
    callchainId: num(row.callchain_id),
    timeStamp: num(row.timeStamp),
    threadId: num(row.thread_id),
    eventCount: num(row.event_count),
    eventTypeId: num(row.event_type_id),
    timestampTrace: num(row.timestamp_trace),
    cpuId: num(row.cpu_id),
    threadState: str(row.thread_state),
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * `perf_callchain.name` as text.
 *
 * The column holds a `data_dict` id in a real capture and text in a
 * hand-built database, and SQLite enforces neither, so this is `String(...)`
 * with the project's "absent is empty" rule.
 */
function frameName(value: number | string | null): string {
  return value == null ? '' : String(value).trim();
}

/**
 * Typed accessor over the optional `perf_*` tables.
 *
 * These tables exist only when a perf trace was ingested; every accessor
 * therefore checks `hasTable()` first and returns `[]`/`false` instead of
 * letting SQLite throw `no such table`. The query layer is read-only and never
 * creates the indexes HapRay's `ensure_perf_trace_indexes` would add.
 */
export class PerfQuery {
  constructor(private readonly db: QueryHandle) {}

  /** True when `perf_sample` exists and contains at least one row. */
  hasSamples(): boolean {
    if (!this.hasTable('perf_sample')) return false;
    return this.db.query<{ n: number }>('SELECT 1 AS n FROM perf_sample LIMIT 1').length > 0;
  }

  /**
   * True when `perf_files` exists, so a frame can carry a symbol at all.
   *
   * A capture without it has no symbol table to resolve against: every frame
   * is unnamed for that reason, not because its callchain was truncated. The
   * distinction matters to the wording a reader gets.
   */
  hasSymbolTable(): boolean {
    return this.hasTable('perf_files');
  }

  /**
   * `perf_thread` rows whose `process_id` is one of `pids`, ordered by `id`.
   *
   * `process_id` is the process pid, not an ipid. An empty `pids` or an absent
   * table returns `[]`.
   */
  threads(pids: number[]): PerfThread[] {
    if (pids.length === 0 || !this.hasTable('perf_thread')) return [];
    return this.db
      .query<PerfThreadRow>(
        `${SELECT_PERF_THREADS} WHERE process_id IN (${placeholders(pids.length)}) ORDER BY id`,
        pids,
      )
      .map(toPerfThread);
  }

  /**
   * The `thread_id`s of the threads named `threadName` in one of `pids`.
   *
   * Exists for the GC analyzer, which attributes samples to `OS_GC_Thread`.
   * Ordering is by `thread_id` so the result is byte-stable (D5); an empty
   * `pids` or an absent `perf_thread` table returns `[]`.
   */
  threadIdsNamed(pids: readonly number[], threadName: string): number[] {
    if (pids.length === 0 || !this.hasTable('perf_thread')) return [];
    return this.db
      .query<{ thread_id: number | null }>(
        `SELECT thread_id FROM perf_thread
WHERE process_id IN (${placeholders(pids.length)}) AND thread_name = ?
ORDER BY thread_id`,
        [...pids, threadName],
      )
      .map((row) => num(row.thread_id));
  }

  /**
   * The summed weight of the samples recorded by `threadIds`.
   *
   * `perf_sample.event_count` is the sample's weight — the number of events
   * the sample stands for — not 1. Summing rows instead of this column makes
   * every share computed from it wrong by the sampling period. `threadIds`
   * omitted sums the whole database; an empty array returns 0.
   *
   * `range` restricts the sum to samples whose `timestamp_trace` falls inside
   * it, which is what a windowed share needs: summing the whole table while the
   * stacks are windowed makes the share describe a different population.
   */
  eventCount(threadIds?: readonly number[], range?: TimeRange): number {
    if (threadIds !== undefined && threadIds.length === 0) return 0;
    if (!this.hasTable('perf_sample')) return 0;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (threadIds !== undefined) {
      conditions.push(`thread_id IN (${placeholders(threadIds.length)})`);
      params.push(...threadIds);
    }
    if (range !== undefined) {
      conditions.push('timestamp_trace >= ? AND timestamp_trace <= ?');
      params.push(range.startNs, range.endNs);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const [row] = this.db.query<{ n: number | null }>(
      `SELECT COALESCE(SUM(event_count), 0) AS n FROM perf_sample${where}`,
      params,
    );
    return row == null ? 0 : num(row.n);
  }

  /**
   * Samples of `threadIds` whose `timestamp_trace` is in `[startNs, endNs]`.
   *
   * Rows are ordered by `timestamp_trace, id`. An empty `threadIds` or an
   * absent `perf_sample` returns `[]`.
   */
  samples(threadIds: number[], range: TimeRange): PerfSampleRow[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
    return this.db
      .query<PerfSampleRowDb>(
        `${SELECT_PERF_SAMPLES}
WHERE thread_id IN (${placeholders(threadIds.length)})
  AND timestamp_trace >= ? AND timestamp_trace <= ?
ORDER BY timestamp_trace, id`,
        [...threadIds, range.startNs, range.endNs],
      )
      .map(toPerfSample);
  }

  /**
   * Callchains of `threadIds` inside `[startNs, endNs]`.
   *
   * Mirrors HapRay's `_query_callchains_batch`: per thread at most the first
   * 50 distinct `callchain_id`s (in chain-id order) are considered and at most
   * `maxChainsPerThread` (default 20) non-empty chains are returned. Frames
   * are ordered by `depth`; a symbol resolves through the exact
   * `(file_id, symbol_id → serial_id)` row of `perf_files`, then through the
   * `data_dict` text for `perf_callchain.name`, and never from a neighbouring
   * row of the same file. The file path still resolves from `file_id` alone,
   * so an unresolved frame names the library it ran in.
   *
   * If `perf_callchain` or `perf_files` is absent there is nothing to return,
   * so the result is `[]` (HapRay does the same).
   */
  callchains(
    threadIds: number[],
    range: TimeRange,
    maxChainsPerThread = DEFAULT_CHAINS_PER_THREAD,
  ): PerfCallchain[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];

    const uniqueThreadIds = [...new Set(threadIds)];
    const chainRows = this.db.query<PerfChainIdRow>(
      `SELECT thread_id, callchain_id
FROM perf_sample
WHERE thread_id IN (${placeholders(uniqueThreadIds.length)})
  AND timestamp_trace >= ? AND timestamp_trace <= ?
  AND callchain_id IS NOT NULL
ORDER BY thread_id, callchain_id`,
      [...uniqueThreadIds, range.startNs, range.endNs],
    );

    const chainIdsByThread = new Map<number, number[]>();
    for (const threadId of uniqueThreadIds) chainIdsByThread.set(threadId, []);
    for (const row of chainRows) {
      const list = chainIdsByThread.get(num(row.thread_id));
      const callchainId = num(row.callchain_id);
      if (!list || list.length >= MAX_CHAIN_IDS_PER_THREAD) continue;
      if (!list.includes(callchainId)) list.push(callchainId);
    }

    const allChainIds = [
      ...new Set(uniqueThreadIds.flatMap((id) => chainIdsByThread.get(id) ?? [])),
    ].sort((a, b) => a - b);
    if (allChainIds.length === 0) return [];

    const functionsByChain = this.chainFunctions(allChainIds);

    const chains: PerfCallchain[] = [];
    const limit = Math.max(0, maxChainsPerThread);
    for (const threadId of uniqueThreadIds) {
      const chainIds = (chainIdsByThread.get(threadId) ?? []).slice(0, limit);
      for (const callchainId of chainIds) {
        const functions = functionsByChain.get(callchainId);
        // A chain with no frames is skipped, as upstream does.
        if (functions === undefined || functions.length === 0) continue;
        chains.push({ threadId, callchainId, functions });
      }
    }
    return chains;
  }

  /**
   * Folds every sample of `threadIds` in `range` into semicolon-joined stacks.
   *
   * Deliberately **not** built on {@link callchains}: that method caps at 50
   * chain ids and 20 chains per thread (HapRay's UI budget), which would
   * silently drop samples from an aggregate. This reads every distinct
   * `callchain_id` the samples reference and weights each by `event_count` —
   * the sample's weight, not 1 row.
   *
   * Stacks are sorted by `samples` descending then `stack` ascending, so equal
   * weights never fall back to row order, and sliced to `top` — omit `top` to
   * get every distinct stack, which is what a count of stacks needs. A chain
   * with no frames contributes nothing. An empty `threadIds`, a missing
   * `perf_callchain`/`perf_files`, or no samples in range yields `[]`.
   */
  foldedStacks(
    threadIds: readonly number[],
    range: TimeRange,
    top?: number,
  ): FoldedStack[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
    const uniqueThreadIds = [...new Set(threadIds)];

    const weights = this.chainWeights(uniqueThreadIds, range);
    const chainIds = [...weights.keys()].sort((a, b) => a - b);
    if (chainIds.length === 0) return [];

    const functionsByChain = this.chainFunctions(chainIds);

    const folded = new Map<string, number>();
    for (const callchainId of chainIds) {
      const functions = functionsByChain.get(callchainId);
      if (functions === undefined || functions.length === 0) continue;
      const stack = functions.map((fn) => fn.symbol).join(';');
      folded.set(stack, (folded.get(stack) ?? 0) + (weights.get(callchainId) ?? 0));
    }

    return [...folded.entries()]
      .map(([stack, samples]) => ({
        stack,
        leaf: stack.slice(stack.lastIndexOf(';') + 1),
        samples,
      }))
      .sort((a, b) => (a.samples !== b.samples ? b.samples - a.samples : a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0))
      .slice(0, top === undefined ? undefined : Math.max(0, top));
  }

  /**
   * Attributes each sample's weight to the deepest frame of its callchain.
   *
   * This is the "self cost" table a hotspot list needs, as opposed to
   * {@link foldedStacks}, which preserves the whole stack. Rows are sorted by
   * `samples` descending, then symbol, then filePath, so equal weights never
   * fall back to row order (D5). A chain with no frames or with an empty leaf
   * symbol contributes nothing; an empty `threadIds` or a missing
   * `perf_sample`/`perf_callchain`/`perf_files` returns `[]`.
   */
  leafAttribution(
    threadIds: readonly number[],
    range: TimeRange,
  ): PerfLeafAttribution[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
    const uniqueThreadIds = [...new Set(threadIds)];

    const weights = this.chainWeights(uniqueThreadIds, range);
    const chainIds = [...weights.keys()].sort((a, b) => a - b);
    if (chainIds.length === 0) return [];

    const functionsByChain = this.chainFunctions(chainIds);
    const folded = new Map<string, PerfLeafAttribution>();
    for (const callchainId of chainIds) {
      const functions = functionsByChain.get(callchainId);
      const leaf = functions?.[functions.length - 1];
      if (leaf === undefined || leaf.symbol === '') continue;
      const unresolved = isUnresolvedSymbol(leaf.symbol);
      // The unresolved flag is part of the identity: two frames can share a
      // symbol text and a file and still differ in whether it is a name.
      const key = `${leaf.filePath}\u0000${leaf.symbol}\u0000${unresolved ? '1' : '0'}`;
      const existing = folded.get(key);
      const weight = weights.get(callchainId) ?? 0;
      if (existing === undefined) {
        folded.set(key, { symbol: leaf.symbol, filePath: leaf.filePath, samples: weight, unresolved });
      } else {
        existing.samples += weight;
      }
    }

    return [...folded.values()].sort(
      (a, b) =>
        b.samples - a.samples ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) ||
        (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0),
    );
  }

  /**
   * Summed weight per `(symbol, filePath, unresolved)` over the window.
   *
   * This is the typed form of HapRay's `symbol_statistics` table, and the same
   * population {@link leafAttribution} reports — plus the frames no symbol
   * resolves at all, which `leafAttribution` drops. Keeping them here is what
   * makes the rows sum to {@link eventCount} exactly, so a caller can check
   * that no weight went missing.
   *
   * A chain with no frames still holds weight: a truncated conversion or a
   * dropped kernel chain leaves `perf_sample` rows whose `callchain_id` names
   * nothing. That weight has no symbol and no file, so it lands in the
   * unresolved `('', '')` row rather than vanishing from the identity.
   */
  symbolStats(threadIds: readonly number[], range: TimeRange): SymbolStat[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
    const uniqueThreadIds = [...new Set(threadIds)];

    const weights = this.chainWeights(uniqueThreadIds, range);
    const chainIds = [...weights.keys()].sort((a, b) => a - b);
    if (chainIds.length === 0) return [];

    const functionsByChain = this.chainFunctions(chainIds);
    const folded = new Map<string, SymbolStat>();
    const add = (symbol: string, filePath: string, weight: number): void => {
      const unresolved = isUnresolvedSymbol(symbol);
      const key = `${filePath}\u0000${symbol}\u0000${unresolved ? '1' : '0'}`;
      const existing = folded.get(key);
      if (existing === undefined) {
        folded.set(key, { symbol, filePath, samples: weight, unresolved });
      } else {
        existing.samples += weight;
      }
    };

    for (const callchainId of chainIds) {
      const weight = weights.get(callchainId) ?? 0;
      const leaf = functionsByChain.get(callchainId)?.at(-1);
      // No frames: the chain names nothing, but its weight is still in the
      // window, so it is counted as unresolved rather than dropped.
      if (leaf === undefined) {
        add('', '', weight);
        continue;
      }
      add(leaf.symbol, leaf.filePath, weight);
    }

    return [...folded.values()].sort(
      (a, b) =>
        b.samples - a.samples ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) ||
        (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) ||
        (a.unresolved === b.unresolved ? 0 : a.unresolved ? 1 : -1),
    );
  }

  /**
   * The unresolved subset of {@link symbolStats}: frames the recorder could
   * not name.
   *
   * A subset, not an addition — the weights are already inside
   * `symbolStats`, so a caller must not add the two populations together.
   */
  unresolvedSymbols(threadIds: readonly number[], range: TimeRange): SymbolStat[] {
    return this.symbolStats(threadIds, range).filter((row) => row.unresolved);
  }

  /**
   * Summed `event_count` per `callchain_id` for the threads and range.
   *
   * Shared by {@link foldedStacks} and {@link leafAttribution} so both weight
   * samples identically. `callchain_id IS NULL` rows are omitted; the map is
   * ordered by the caller.
   */
  private chainWeights(
    threadIds: readonly number[],
    range: TimeRange,
  ): Map<number, number> {
    const weights = new Map<number, number>();
    if (threadIds.length === 0) return weights;
    const rows = this.db.query<{ callchain_id: number | null; weight: number | null }>(
      `SELECT callchain_id, SUM(event_count) AS weight
FROM perf_sample
WHERE thread_id IN (${placeholders(threadIds.length)})
  AND timestamp_trace >= ? AND timestamp_trace <= ?
  AND callchain_id IS NOT NULL
GROUP BY callchain_id
ORDER BY callchain_id`,
      [...threadIds, range.startNs, range.endNs],
    );
    for (const row of rows) weights.set(num(row.callchain_id), num(row.weight));
    return weights;
  }

  /**
   * Resolves each chain id to its frames, ordered by `depth`.
   *
   * A symbol comes from the exact `(file_id, symbol_id → serial_id)` row of
   * `perf_files`; when that row is missing or names nothing, from the
   * `data_dict` text for `perf_callchain.name`; and when the column holds text
   * rather than an id (a hand-built database), from that text. A frame whose
   * `name` is a dangling id gets `''` — the recorder had no symbol, and
   * repeating the number would claim a name. A missing `perf_callchain` or
   * `perf_files` yields an empty map (nothing can be resolved).
   */
  private chainFunctions(chainIds: readonly number[]): Map<number, PerfFunction[]> {
    const resolved = new Map<number, PerfFunction[]>();
    if (chainIds.length === 0) return resolved;
    if (!this.hasTable('perf_callchain') || !this.hasTable('perf_files')) return resolved;

    const frames = this.db.query<PerfFrameRow>(
      `SELECT callchain_id, depth, file_id, symbol_id, name
FROM perf_callchain
WHERE callchain_id IN (${placeholders(chainIds.length)})
ORDER BY callchain_id, depth, id`,
      [...chainIds],
    );
    const framesByChain = new Map<number, PerfFrameRow[]>();
    for (const frame of frames) {
      const list = framesByChain.get(num(frame.callchain_id));
      if (list) list.push(frame);
      else framesByChain.set(num(frame.callchain_id), [frame]);
    }

    const fileIds = [
      ...new Set(
        frames
          .filter((frame) => frame.file_id != null)
          .map((frame) => num(frame.file_id)),
      ),
    ].sort((a, b) => a - b);
    const files = fileIds.length
      ? this.db.query<PerfFileRow>(
          `SELECT id, file_id, serial_id, symbol, path
FROM perf_files
WHERE file_id IN (${placeholders(fileIds.length)})
ORDER BY id`,
          fileIds,
        )
      : [];

    const exactSymbols = new Map<string, PerfFunction>();
    const paths = new Map<number, string>();
    for (const file of files) {
      const symbol = str(file.symbol).trim();
      const path = str(file.path).trim();
      const fileId = num(file.file_id);
      // A path is a property of the file: a real capture has exactly one path
      // per `file_id` (measured: 0 of 215 file_ids carry more than one), so
      // resolving it from `file_id` alone invents nothing.
      if (!paths.has(fileId) && path !== '') paths.set(fileId, path);
      // Only an exact row that names something can decide a symbol. A row
      // whose symbol is empty falls through to `data_dict` like a miss.
      if (symbol === '') continue;
      const key = `${fileId}:${num(file.serial_id)}`;
      if (!exactSymbols.has(key)) {
        exactSymbols.set(key, { symbol, name: symbol, filePath: path });
      }
    }

    // `perf_callchain.name` is a `data_dict` id, not a symbol (measured: every
    // one of 484,630 frames in a real capture resolves through `data_dict`).
    // The dictionary is the honest answer for an address with no symbol —
    // `libfoo.so+0x1cce24` — where the previous file-only fallback attributed
    // the frame to whichever symbol sorted first in its file, fabricating
    // 7.14% of the capture's leaf weight.
    //
    // Three shapes have to keep working: a numeric `name` that the dictionary
    // knows (the normal case); a numeric `name` that it does not (a dangling
    // id — the frame has no symbol, and repeating the number as one would
    // claim a name); and text in that column (a hand-built fixture, or a
    // future converter, where the text is the symbol).
    const dictPresent = this.hasTable('data_dict');
    const dataDict = this.loadDataDict(frames);

    for (const [callchainId, chainFrames] of framesByChain) {
      const functions: PerfFunction[] = [];
      for (const frame of chainFrames) {
        const rawSymbol = frameName(frame.name);
        const exact = frame.file_id != null && frame.symbol_id != null
          ? exactSymbols.get(`${num(frame.file_id)}:${num(frame.symbol_id)}`)
          : undefined;
        const isId = /^\d+$/.test(rawSymbol);
        const fromDict = isId ? dataDict.get(Number(rawSymbol)) : undefined;
        const functionName = exact !== undefined
          ? exact.symbol
          : fromDict !== undefined
            ? fromDict
            : isId && dictPresent ? '' : rawSymbol;
        const filePath = frame.file_id == null ? '' : paths.get(num(frame.file_id)) ?? '';
        functions.push({ symbol: functionName, name: functionName, filePath });
      }
      resolved.set(callchainId, functions);
    }
    return resolved;
  }

  /**
   * The `data_dict` text for the `name` ids these frames carry.
   *
   * Optional table: a hand-built database may omit it, and then every frame
   * keeps its raw `name` column. Loaded once per call, ordered by id so the
   * query itself is deterministic.
   */
  private loadDataDict(frames: readonly PerfFrameRow[]): Map<number, string> {
    const dict = new Map<number, string>();
    if (!this.hasTable('data_dict')) return dict;
    const ids = [...new Set(
      frames
        .map((frame) => frameName(frame.name))
        .filter((text) => /^\d+$/.test(text))
        .map((text) => Number(text)),
    )]
      .filter((id) => id !== 0)
      .sort((a, b) => a - b);
    if (ids.length === 0) return dict;
    const rows = this.db.query<{ id: number | null; data: string | null }>(
      `SELECT id, data FROM data_dict
WHERE id IN (${placeholders(ids.length)})
ORDER BY id`,
      ids,
    );
    for (const row of rows) {
      const text = str(row.data).trim();
      if (text !== '') dict.set(num(row.id), text);
    }
    return dict;
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
