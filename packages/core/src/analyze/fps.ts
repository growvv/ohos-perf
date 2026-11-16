import type { Frame } from '../query/frames';

/** One tumbling FPS window. */
export interface FpsWindow {
  startNs: number;
  endNs: number;
  /** Rendered frames whose `ts` falls in `[startNs, endNs)`. */
  frames: number;
  fps: number;
}

/**
 * Tiles rendered frames into fixed-width FPS windows.
 *
 * HapRay's FPS path uses `FPS_WINDOW_SIZE_MS = 1000`; this reproduces the
 * definition without its vsync-group iteration order, which walks frames
 * group-by-group rather than chronologically. Frames are therefore sorted by
 * `(ts, id)` first, and a frame exactly on a boundary belongs to the next
 * window.
 *
 * Every window is exactly `windowMs` long, including the last one: a capture
 * that ends mid-second reports its final window over the full second, which
 * under-reports that window. This is the standard tumbling-window artifact
 * and matches upstream, so `frame.fps.window.*` stays comparable to HapRay.
 *
 * Idle gaps longer than one window produce explicit `frames: 0` windows; that
 * is the observable "the UI stopped drawing" signal, not noise to collapse.
 *
 * Only actual rendered frames count: `type = 1` rows are predictions and
 * `flag = 2` rows drew nothing. Duplicate frame ids are counted once.
 *
 * An empty input, or a non-positive `windowMs`, returns `[]`.
 */
export function computeFpsWindows(
  frames: readonly Frame[],
  windowMs = 1000,
): FpsWindow[] {
  if (!(windowMs > 0)) return [];

  const seen = new Set<number>();
  const rendered: Frame[] = [];
  for (const frame of frames) {
    if (frame.type !== 0 || frame.flag === 2) continue;
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    rendered.push(frame);
  }
  if (rendered.length === 0) return [];
  rendered.sort((a, b) => a.ts - b.ts || a.id - b.id);

  const width = windowMs * 1e6;
  const fpsPerWindow = (count: number): number => count / (windowMs / 1000);

  const windows: FpsWindow[] = [];
  let startNs = rendered[0].ts;
  let endNs = startNs + width;
  let count = 0;
  for (const frame of rendered) {
    while (frame.ts >= endNs) {
      windows.push({ startNs, endNs, frames: count, fps: fpsPerWindow(count) });
      startNs = endNs;
      endNs = startNs + width;
      count = 0;
    }
    count += 1;
  }
  windows.push({ startNs, endNs, frames: count, fps: fpsPerWindow(count) });
  return windows;
}
