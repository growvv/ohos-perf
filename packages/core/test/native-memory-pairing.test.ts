import { describe, it, expect } from 'vitest';
import { pairNativeMemory, nativeEventKind } from '../src/analyze/native-memory';
import type { NativeHookEvent } from '../src/query/native-hook';

/** One event with every field the pairing layer reads. */
function ev(
  id: number,
  kind: number | string,
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

describe('nativeEventKind', () => {
  it('recognises both numeric and string event types', () => {
    expect(nativeEventKind(0)).toBe('alloc');
    expect(nativeEventKind('AllocEvent')).toBe('alloc');
    expect(nativeEventKind('MmapEvent')).toBe('alloc');
    expect(nativeEventKind(1)).toBe('free');
    expect(nativeEventKind('FreeEvent')).toBe('free');
    expect(nativeEventKind('MunmapEvent')).toBe('free');
    expect(nativeEventKind(7)).toBe('other');
  });
});

describe('pairNativeMemory', () => {
  it('pairs allocs and frees per address and tracks the running total', () => {
    const r = pairNativeMemory([ev(0, 0, 100, 4096, 100), ev(1, 1, 200, 4096, 100)]);
    expect(r.allocBytes).toBe(100);
    expect(r.freeBytes).toBe(100);
    expect(r.endTotal).toBe(0);
    expect(r.unreleasedAt(200)).toEqual([]);
  });

  it('consumes older blocks when a free exceeds the newest block (LIFO)', () => {
    const r = pairNativeMemory([
      ev(0, 0, 100, 4096, 60), // older block
      ev(1, 0, 150, 4096, 40), // reused address, newer block
      ev(2, 1, 200, 4096, 70), // frees the 40 then 30 of the 60
    ]);
    expect(r.unreleasedAt(200).map((a) => a.size)).toEqual([30]);
    expect(r.endTotal).toBe(30);
  });

  it('leaves a remainder on a partial free', () => {
    const r = pairNativeMemory([ev(0, 0, 100, 4096, 100), ev(1, 1, 200, 4096, 25)]);
    expect(r.unreleasedAt(200).map((a) => a.size)).toEqual([75]);
  });

  it('reports the peak with the earliest event on a tie, and a negative trough', () => {
    const r = pairNativeMemory([
      ev(0, 0, 100, 4096, 50),
      ev(1, 0, 200, 8192, 50), // peak 100 at ts 200
      ev(2, 1, 300, 4096, 50), // 50
      ev(3, 1, 400, 8192, 50), // 0
      ev(4, 1, 500, 9000, 30), // unpaired free: -30
    ]);
    expect(r.peak).toBe(100);
    expect(r.peakTs).toBe(200);
    expect(r.trough).toBe(-30);
    expect(r.endTotal).toBe(-30);
    expect(r.unpairedFrees).toBe(1);
  });

  it('keeps the earliest timestamp when a later event merely ties the peak', () => {
    const r = pairNativeMemory([
      ev(0, 0, 100, 4096, 50),
      ev(1, 0, 200, 8192, 50), // peak 100 at 200
      ev(2, 1, 300, 8192, 50), // 50
      ev(3, 0, 400, 16384, 50), // ties 100 again at 400
    ]);
    expect(r.peak).toBe(100);
    expect(r.peakTs).toBe(200);
  });

  it('excludes unaddressed allocs from the unreleased set and counts them', () => {
    const r = pairNativeMemory([ev(0, 0, 100, 0, 64)]);
    expect(r.unreleasedAt(100)).toEqual([]);
    expect(r.unaddressedAllocs).toBe(1);
    expect(r.endTotal).toBe(64);
  });

  it('counts active bytes with no callchain once', () => {
    const r = pairNativeMemory([ev(0, 0, 100, 4096, 32, 0), ev(1, 0, 110, 8192, 16, 0)]);
    expect(r.unattributedBytes).toBe(48);
    expect(r.unreleasedAt(200)).toEqual([]);
  });

  it('orders by (start_ts, id) regardless of input order and ignores other types', () => {
    const r = pairNativeMemory([
      ev(1, 0, 200, 8192, 40),
      ev(0, 0, 100, 4096, 100),
      ev(2, 7, 150, 4096, 999), // other: counted, no effect
    ]);
    expect(r.peak).toBe(140);
    expect(r.peakTs).toBe(200);
    expect(r.endTotal).toBe(140);
    expect(r.events).toBe(3);
    expect(r.allocCount).toBe(2);
  });

  it('treats a negative stored heap_size as a magnitude', () => {
    const r = pairNativeMemory([ev(0, 0, 100, 4096, -64), ev(1, 1, 200, 4096, -64)]);
    expect(r.allocBytes).toBe(64);
    expect(r.freeBytes).toBe(64);
    expect(r.endTotal).toBe(0);
  });

  it('is deterministic for identical input', () => {
    const events = [ev(0, 0, 100, 4096, 10), ev(1, 0, 100, 8192, 20)];
    expect(JSON.stringify(pairNativeMemory(events))).toBe(JSON.stringify(pairNativeMemory(events)));
  });

  it('replays the peak to its own position, not past every event at its timestamp', () => {
    // An alloc and a free share a timestamp. The peak is the alloc's 100 bytes;
    // replaying the whole timestamp would also apply the free and report an
    // empty unreleased set for a peak that was 100 bytes high.
    const r = pairNativeMemory([ev(0, 0, 1000, 4096, 100), ev(1, 1, 1000, 4096, 100)]);
    expect(r.peak).toBe(100);
    expect(r.peakTs).toBe(1000);
    expect(r.peakId).toBe(0);
    expect(r.unreleasedAt(r.peakTs, r.peakId!).map((a) => a.size)).toEqual([100]);
    // Without the id the timestamp means "after every event at it".
    expect(r.unreleasedAt(r.peakTs)).toEqual([]);
  });

  it('does not count a zero-size free as unpaired', () => {
    // A `heap_size` of 0 (or a NULL read as 0) frees nothing, so there is no
    // unmatched allocation to report; counting it inflates
    // `mem.native.free.unpaired.count` with a free that consumed nothing.
    const r = pairNativeMemory([ev(0, 0, 100, 4096, 100), ev(1, 1, 200, 4096, 0)]);
    expect(r.unpairedFrees).toBe(0);
    expect(r.endTotal).toBe(100);
  });

  it('treats a NULL event type as neither alloc nor free', () => {
    const r = pairNativeMemory([
      ev(0, 0, 100, 4096, 100),
      ev(1, null as unknown as number, 150, 8192, 999),
    ]);
    expect(r.events).toBe(2);
    expect(r.allocBytes).toBe(100);
    expect(r.freeBytes).toBe(0);
    expect(r.endTotal).toBe(100);
  });
});
