import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HidumperCollector,
  parseFpsCounts,
  parseHitches,
  readHidumperCapture,
  type HidumperCapture,
} from '../src/collectors/hidumper';
import { createSceneLayout, type SceneLayout } from '../src/ingest/scene';
import { OhosPerfError } from '../src/errors';
import type { Hdc, HdcResult } from '../src/transport/hdc';

/** Measured `hidumper -s RenderService -a 'fpsCount'` output (Mate 60). */
const FPS_TEXT = `
-------------------------------[ability]-------------------------------


----------------------------------RenderService----------------------------------

-- RefreshRateCounts:
Refresh Rate:30, Count:1202377;
Refresh Rate:60, Count:5534553;
Refresh Rate:90, Count:35829;
Refresh Rate:120, Count:396586;
`;

/** Measured `hidumper -s RenderService -a 'hitchs'` output (Mate 60). */
const HITCH_TEXT = `
----------------------------------RenderService----------------------------------

-- The recently window hitchs records info of screens:


 window [] Id[6343666696194]:
more than 66 ms       0
more than 33 ms       0
more than 16.67 ms    0

-----RSProcessDump-----

RSProcessDump pid:1477 screenId:12884901887
`;

describe('parseFpsCounts', () => {
  it('parses every refresh-rate bucket in device order', () => {
    expect(parseFpsCounts(FPS_TEXT)).toEqual([
      { refreshRate: 30, count: 1202377 },
      { refreshRate: 60, count: 5534553 },
      { refreshRate: 90, count: 35829 },
      { refreshRate: 120, count: 396586 },
    ]);
  });

  it('returns [] for output without the RefreshRateCounts header', () => {
    expect(parseFpsCounts('hidumper: service not found')).toEqual([]);
  });

  it('ignores a lookalike line outside the header block', () => {
    expect(parseFpsCounts(`Refresh Rate:60, Count:1;`)).toEqual([]);
  });
});

describe('parseHitches', () => {
  it('parses one window hitch record', () => {
    expect(parseHitches(HITCH_TEXT)).toEqual([
      { windowId: '6343666696194', over16_67: 0, over33: 0, over66: 0 },
    ]);
  });

  it('keeps buckets with non-zero counts', () => {
    const busy = HITCH_TEXT.replace('more than 16.67 ms    0', 'more than 16.67 ms    7');
    expect(parseHitches(busy)[0].over16_67).toBe(7);
  });

  it('parses several windows in device order', () => {
    const two = HITCH_TEXT +
      `\n window [] Id[42]:\nmore than 66 ms 1\nmore than 33 ms 2\nmore than 16.67 ms 3\n`;
    expect(parseHitches(two).map((w) => w.windowId)).toEqual(['6343666696194', '42']);
  });

  it('returns [] when no window record is present', () => {
    expect(parseHitches('hidumper: service not found')).toEqual([]);
  });
});

describe('HidumperCollector', () => {
  let dir: string;
  let layout: SceneLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohosperf-hidumper-'));
    layout = createSceneLayout(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * A structural Hdc fake: each shell command is answered by the first script
   * entry whose matcher it satisfies, so a test states only the commands it
   * cares about. Calls are recorded for order assertions.
   */
  function fakeHdc(
    script: Array<{ match: RegExp; result?: Partial<HdcResult>; error?: Error }>,
  ): { hdc: Hdc; calls: string[] } {
    const calls: string[] = [];
    const hdc = {
      async shell(_target: string, command: string): Promise<HdcResult> {
        calls.push(command);
        for (const entry of script) {
          if (!entry.match.test(command)) continue;
          if (entry.error !== undefined) throw entry.error;
          return { stdout: '', stderr: '', code: 0, ...entry.result };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    } as unknown as Hdc;
    return { hdc, calls };
  }

  it('takes two snapshots intervalMs apart and writes hidumper.json', async () => {
    const slept: number[] = [];
    const collector = new HidumperCollector({
      now: (() => { let t = 0; return () => (t += 1000); })(),
      sleep: async (ms) => { slept.push(ms); },
    });
    const { hdc, calls } = fakeHdc([
      { match: /fpsCount/, result: { stdout: FPS_TEXT } },
      { match: /hitchs/, result: { stdout: HITCH_TEXT } },
    ]);

    const capture = await collector.collect(hdc, 'dev', { durationMs: 5000 }, layout);

    expect(slept).toEqual([5000]);
    expect(calls).toEqual([
      "hidumper -s RenderService -a 'fpsCount'",
      "hidumper -s RenderService -a 'hitchs'",
      "hidumper -s RenderService -a 'fpsCount'",
      "hidumper -s RenderService -a 'hitchs'",
    ]);
    expect(capture.version).toBe(1);
    expect(capture.intervalMs).toBe(5000);
    expect(capture.samples).toHaveLength(2);
    expect(capture.samples[0].fpsCounts).toHaveLength(4);
    expect(capture.samples[0].hitches).toEqual([
      { windowId: '6343666696194', over16_67: 0, over33: 0, over66: 0 },
    ]);
    // The injected clock advances 1000 per read and each snapshot reads it
    // once, before its commands: the pair is 1000 apart, independent of sleep.
    expect(capture.samples[1].ts - capture.samples[0].ts).toBe(1000);

    expect(existsSync(layout.hidumperFile)).toBe(true);
    const written = JSON.parse(readFileSync(layout.hidumperFile, 'utf8')) as HidumperCapture;
    expect(written).toEqual(capture);
    expect(readFileSync(layout.hidumperFile, 'utf8').endsWith('\n')).toBe(true);
  });

  it('defaults the interval to durationMs', async () => {
    const collector = new HidumperCollector({ sleep: async () => {} });
    const { hdc } = fakeHdc([
      { match: /fpsCount/, result: { stdout: FPS_TEXT } },
      { match: /hitchs/, result: { stdout: HITCH_TEXT } },
    ]);
    const capture = await collector.collect(hdc, 'dev', { durationMs: 3000 }, layout);
    expect(capture.intervalMs).toBe(3000);
  });

  it('honours an explicit intervalMs', async () => {
    const slept: number[] = [];
    const collector = new HidumperCollector({ sleep: async (ms) => { slept.push(ms); } });
    const { hdc } = fakeHdc([
      { match: /fpsCount/, result: { stdout: FPS_TEXT } },
      { match: /hitchs/, result: { stdout: HITCH_TEXT } },
    ]);
    const capture = await collector.collect(hdc, 'dev', { durationMs: 10_000, intervalMs: 2000 }, layout);
    expect(capture.intervalMs).toBe(2000);
    expect(slept).toEqual([2000]);
  });

  it('rejects a bad duration before any device call', async () => {
    const { hdc, calls } = fakeHdc([]);
    for (const durationMs of [0, -1, Number.NaN, 2 ** 31]) {
      const err = await new HidumperCollector()
        .collect(hdc, 'dev', { durationMs }, layout)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OhosPerfError);
      expect((err as OhosPerfError).code).toBe('HIDUMPER_BAD_DURATION');
    }
    expect(calls).toEqual([]);
  });

  it('rejects a bad interval before any device call', async () => {
    const { hdc, calls } = fakeHdc([]);
    for (const intervalMs of [0, 99, 1.5]) {
      const err = await new HidumperCollector()
        .collect(hdc, 'dev', { durationMs: 5000, intervalMs }, layout)
        .catch((e: unknown) => e);
      expect((err as OhosPerfError).code).toBe('HIDUMPER_BAD_INTERVAL');
    }
    expect(calls).toEqual([]);
  });

  it('fails when a snapshot has no RefreshRateCounts block', async () => {
    const collector = new HidumperCollector({ sleep: async () => {} });
    const { hdc } = fakeHdc([
      { match: /fpsCount/, result: { stdout: 'hidumper: service not found' } },
      { match: /hitchs/, result: { stdout: HITCH_TEXT } },
    ]);
    const err = await collector
      .collect(hdc, 'dev', { durationMs: 1000 }, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('HIDUMPER_PARSE_FAILED');
    // A failed capture leaves no artifact behind.
    expect(existsSync(layout.hidumperFile)).toBe(false);
  });

  it('removes a previous capture before the first snapshot', async () => {
    writeFileSync(layout.hidumperFile, '{"stale":true}\n');
    const { hdc } = fakeHdc([
      { match: /fpsCount/, result: { stdout: 'nope' } },
      { match: /hitchs/, result: { stdout: HITCH_TEXT } },
    ]);
    await new HidumperCollector({ sleep: async () => {} })
      .collect(hdc, 'dev', { durationMs: 1000 }, layout)
      .catch(() => undefined);
    expect(existsSync(layout.hidumperFile)).toBe(false);
  });

  it('accepts an empty hitch list as a valid snapshot', async () => {
    const collector = new HidumperCollector({ sleep: async () => {} });
    const { hdc } = fakeHdc([
      { match: /fpsCount/, result: { stdout: FPS_TEXT } },
      { match: /hitchs/, result: { stdout: 'no windows' } },
    ]);
    const capture = await collector.collect(hdc, 'dev', { durationMs: 1000 }, layout);
    expect(capture.samples[0].hitches).toEqual([]);
  });

  it('declares the capabilities the analyzer gates on', () => {
    const collector = new HidumperCollector();
    expect(collector.id).toBe('hidumper');
    expect(collector.provides).toEqual(['render.fps_live', 'render.hitch']);
  });
});

describe('readHidumperCapture', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohosperf-hidumper-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const valid: HidumperCapture = {
    version: 1,
    intervalMs: 1000,
    samples: [
      { ts: 1, fpsCounts: [{ refreshRate: 60, count: 1 }], hitches: [] },
      { ts: 2, fpsCounts: [{ refreshRate: 60, count: 2 }], hitches: [] },
    ],
  };

  function write(value: unknown): string {
    const path = join(dir, 'hidumper.json');
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  }

  it('returns undefined for a missing file', () => {
    expect(readHidumperCapture(join(dir, 'absent.json'))).toBeUndefined();
  });

  it('reads a valid capture', () => {
    expect(readHidumperCapture(write(valid))).toEqual(valid);
  });

  it('rejects invalid JSON, a wrong version, and a wrong sample count', () => {
    expect(readHidumperCapture(write('{ not json'))).toBeUndefined();
    expect(readHidumperCapture(write({ ...valid, version: 2 }))).toBeUndefined();
    expect(readHidumperCapture(write({ ...valid, samples: [valid.samples[0]] })))
      .toBeUndefined();
    expect(readHidumperCapture(write({ ...valid, intervalMs: 'x' }))).toBeUndefined();
  });

  it('rejects a malformed bucket or window', () => {
    const badBucket = {
      ...valid,
      samples: [
        { ...valid.samples[0], fpsCounts: [{ refreshRate: 60 }] },
        valid.samples[1],
      ],
    };
    expect(readHidumperCapture(write(badBucket))).toBeUndefined();
    const badWindow = {
      ...valid,
      samples: [
        { ...valid.samples[0], hitches: [{ windowId: 1 }] },
        valid.samples[1],
      ],
    };
    expect(readHidumperCapture(write(badWindow))).toBeUndefined();
  });
});
