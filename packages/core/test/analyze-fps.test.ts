import { describe, it, expect } from 'vitest';
import { computeFpsWindows } from '../src/analyze/fps';
import type { Frame } from '../src/query/frames';

function f(ts: number, dur = 0, flag: 0 | 1 | 2 = 0, type: 0 | 1 = 0, id = ts): Frame {
  return { id, ts, dur, vsync: 0, ipid: 17, itid: 44, callstackId: 0,
    flag, type, typeDesc: '', src: '', dst: 0, depth: 0, frameNo: 0 };
}

describe('computeFpsWindows', () => {
  it('tiles fixed 1s windows and counts rendered frames only', () => {
    const frames = Array.from({ length: 10 }, (_, i) => f(i * 100_000_000, 10_000_000));
    const windows = computeFpsWindows([...frames, f(950_000_000, 0, 2), f(960_000_000, 0, 0, 1)]);
    expect(windows).toEqual([{ startNs: 0, endNs: 1_000_000_000, frames: 10, fps: 10 }]);
  });

  it('puts a frame on a window boundary into the next window', () => {
    expect(computeFpsWindows([f(0), f(1_000_000_000)])).toEqual([
      { startNs: 0, endNs: 1_000_000_000, frames: 1, fps: 1 },
      { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('emits explicit zero windows across an idle gap', () => {
    expect(computeFpsWindows([f(0), f(3_500_000_000)])).toEqual([
      { startNs: 0, endNs: 1_000_000_000, frames: 1, fps: 1 },
      { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 0, fps: 0 },
      { startNs: 2_000_000_000, endNs: 3_000_000_000, frames: 0, fps: 0 },
      { startNs: 3_000_000_000, endNs: 4_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('counts a duplicate frame id once', () => {
    expect(computeFpsWindows([f(0, 0, 0, 0, 7), f(0, 0, 0, 0, 7)])).toEqual([
      { startNs: 0, endNs: 1_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('returns [] for no rendered frames and is deterministic', () => {
    expect(computeFpsWindows([])).toEqual([]);
    expect(computeFpsWindows([f(5, 0, 2)])).toEqual([]);
    expect(computeFpsWindows([f(300), f(100), f(200)])).toEqual([
      { startNs: 100, endNs: 1_000_000_100, frames: 3, fps: 3 },
    ]);
    const frames = [f(300), f(100), f(200)];
    expect(JSON.stringify(computeFpsWindows(frames)))
      .toBe(JSON.stringify(computeFpsWindows([...frames].reverse())));
  });

  it('returns [] for a non-positive window width', () => {
    expect(computeFpsWindows([f(0)], 0)).toEqual([]);
    expect(computeFpsWindows([f(0)], -1000)).toEqual([]);
  });
});
