import { describe, it, expect } from 'vitest';
import { aggregateUnreleased, buildNativeTimeline } from '../src/analyze/native-memory';
import type { NativeNames } from '../src/analyze/native-memory';
import type { NativeHookEvent } from '../src/query/native-hook';

function names(): NativeNames {
  return {
    processes: new Map([[4999, 'com.demo']]),
    threads: new Map([[100, 'main'], [101, 'worker']]),
    files: new Map([[1, '/system/lib64/libfoo.so'], [2, '/system/lib64/module/arkui/libcomponentutils.z.so']]),
    symbols: new Map([[1, 'foo()'], [2, 'bar()']]),
    frameLeaves: new Map([
      [10, { fileId: 1, symbolId: 1 }],
      [11, { fileId: 2, symbolId: 2 }],
    ]),
  };
}

function ev(
  id: number,
  kind: number,
  ts: number,
  addr: number,
  size: number,
  callchainId = 10,
  pid = 4999,
  tid = 100,
): NativeHookEvent {
  return {
    id,
    callchainId,
    ipid: 17,
    pid,
    itid: tid,
    eventType: kind,
    subTypeId: 0,
    startTs: ts,
    endTs: 0,
    dur: 0,
    addr,
    heapSize: size,
    allHeapSize: 0,
    currentSizeDur: 0,
    lastLibId: 1,
    lastSymbolId: 2,
  };
}

describe('aggregateUnreleased', () => {
  it('merges active allocations per (pid, tid) inside a callchain', () => {
    const rows = aggregateUnreleased(
      [
        { addr: 1, size: 30, pid: 4999, tid: 100, callchainId: 10, relativeNs: 5 },
        { addr: 2, size: 20, pid: 4999, tid: 100, callchainId: 10, relativeNs: 9 },
        { addr: 3, size: 50, pid: 4999, tid: 101, callchainId: 11, relativeNs: 7 },
      ],
      names(),
    );
    expect(rows.map((r) => [r.callchainId, r.tid, r.size, r.count, r.firstRelativeNs]))
      .toEqual([[10, 100, 50, 2, 5], [11, 101, 50, 1, 7]]);
  });

  it('resolves process, thread, leaf file and symbol, and classifies the row', () => {
    const rows = aggregateUnreleased(
      [{ addr: 1, size: 30, pid: 4999, tid: 100, callchainId: 10, relativeNs: 5 }],
      names(),
    );
    expect(rows[0]).toMatchObject({
      callchainId: 10,
      pid: 4999,
      process: 'com.demo',
      tid: 100,
      thread: 'main',
      file: '/system/lib64/libfoo.so',
      symbol: 'foo()',
      size: 30,
      count: 1,
      firstRelativeNs: 5,
      categoryName: 'SYS_SDK',
      subCategory: 'libfoo.so',
    });
  });

  it('falls back to unknown for a missing thread and empty for a missing name', () => {
    const rows = aggregateUnreleased(
      [{ addr: 1, size: 30, pid: 7777, tid: 900, callchainId: 99, relativeNs: 5 }],
      names(),
    );
    expect(rows[0]).toMatchObject({ process: '', thread: 'unknown', file: '', symbol: '' });
    expect(rows[0].categoryName).toBe('Thread');
  });

  it('orders equal sizes by callchain, then pid, then tid', () => {
    const rows = aggregateUnreleased(
      [
        { addr: 1, size: 10, pid: 2, tid: 2, callchainId: 20, relativeNs: 1 },
        { addr: 2, size: 10, pid: 1, tid: 9, callchainId: 20, relativeNs: 1 },
        { addr: 3, size: 10, pid: 2, tid: 2, callchainId: 10, relativeNs: 1 },
      ],
      names(),
    );
    expect(rows.map((r) => [r.callchainId, r.pid, r.tid])).toEqual([[10, 2, 2], [20, 1, 9], [20, 2, 2]]);
  });
});

describe('buildNativeTimeline', () => {
  it('buckets events and omits empty buckets', () => {
    const buckets = buildNativeTimeline(
      [
        ev(0, 0, 0, 4096, 100),
        ev(1, 1, 500_000_000, 4096, 40),
        ev(2, 0, 2_500_000_000, 8192, 60),
      ],
      1_000_000_000,
    );
    expect(buckets.map((b) => [b.startNs, b.allocBytes, b.freeBytes, b.totalBytes]))
      .toEqual([[0, 100, 40, 60], [2_000_000_000, 60, 0, 120]]);
    expect(buckets[0].endNs).toBe(1_000_000_000);
    expect(buckets[1].deltaBytes).toBe(60);
    expect(buckets.some((b) => b.isPeak)).toBe(true);
  });

  it('marks the bucket containing the peak', () => {
    const buckets = buildNativeTimeline(
      [ev(0, 0, 0, 4096, 10), ev(1, 0, 1_000_000_000, 8192, 90)],
      1_000_000_000,
    );
    expect(buckets.map((b) => b.isPeak)).toEqual([false, true]);
  });

  it('anchors at the first event and defaults to one second buckets', () => {
    const buckets = buildNativeTimeline([ev(0, 0, 5_000_000_000, 4096, 10)]);
    expect(buckets).toEqual([
      {
        startNs: 5_000_000_000,
        endNs: 6_000_000_000,
        allocBytes: 10,
        freeBytes: 0,
        deltaBytes: 10,
        totalBytes: 10,
        isPeak: true,
      },
    ]);
  });

  it('rejects a non-positive or non-finite bucket width', () => {
    expect(() => buildNativeTimeline([], 0)).toThrow(/bucketNs/);
    expect(() => buildNativeTimeline([], -1)).toThrow(/bucketNs/);
    expect(() => buildNativeTimeline([], Number.POSITIVE_INFINITY)).toThrow(/bucketNs/);
  });

  it('returns [] for no events', () => {
    expect(buildNativeTimeline([])).toEqual([]);
  });
});
