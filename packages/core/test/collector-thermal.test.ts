import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_THERMAL_INTERVAL_MS,
  MIN_THERMAL_INTERVAL_MS,
  THERMAL_COMMAND,
  ThermalCollector,
  readThermalRecords,
} from '../src/collectors/thermal';
import { createSceneLayout } from '../src/ingest/scene';
import type { Hdc } from '../src/transport/hdc';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-thermal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OUTPUT = 'Type: Battery\nTemperature: 31000\nType: ambient\nTemperature: 22000\n';

/** A structural Hdc fake, returning one canned dump per call. */
function fakeHdc(outputs: string | string[] = OUTPUT): {
  hdc: Hdc;
  calls: Array<{ command: string; timeoutMs: number }>;
} {
  const sequence = Array.isArray(outputs) ? outputs : [outputs];
  const calls: Array<{ command: string; timeoutMs: number }> = [];
  let index = 0;
  const hdc = {
    async shellFor(_target: string, command: string, timeoutMs: number) {
      calls.push({ command, timeoutMs });
      const stdout = sequence[Math.min(index, sequence.length - 1)]!;
      index += 1;
      return { stdout, stderr: '', code: 0 };
    },
  } as unknown as Hdc;
  return { hdc, calls };
}

/** A clock whose sleep advances time, so a 10 s capture runs in microseconds. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe('ThermalCollector', () => {
  it('samples at 0, 5 s and 10 s and writes one record per sample', async () => {
    const { hdc, calls } = fakeHdc();
    const layout = createSceneLayout(dir);
    const out = await new ThermalCollector(fakeClock()).collect(
      hdc,
      'dev',
      { durationMs: 10_000, intervalMs: 5_000 },
      layout,
    );

    expect(out.samples).toBe(3);
    expect(calls.map((call) => call.command)).toEqual([
      THERMAL_COMMAND,
      THERMAL_COMMAND,
      THERMAL_COMMAND,
    ]);
    const records = readFileSync(layout.thermalFile, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { elapsedMs: number; readings: unknown[] });
    expect(records.map((record) => record.elapsedMs)).toEqual([0, 5_000, 10_000]);
    expect(records[0]!.readings).toEqual([
      { sensor: 'Battery', raw: 31000, unit: 'millidegree_celsius', celsius: 31 },
      { sensor: 'ambient', raw: 22000, unit: 'millidegree_celsius', celsius: 22 },
    ]);
  });

  it('takes one sample when the capture is shorter than the interval', async () => {
    // A scenario step is often shorter than the default 5 s; waiting for a
    // partial interval would extend the capture past its own window.
    const { hdc, calls } = fakeHdc();
    const out = await new ThermalCollector(fakeClock()).collect(
      hdc,
      'dev',
      { durationMs: 3_000 },
      createSceneLayout(dir),
    );
    expect(out.samples).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('does not take a partial-interval sample at the end of a longer capture', async () => {
    // 12 s with a 5 s interval: samples at 0, 5 and 10 s, then 2 s remain and
    // the walk stops rather than sampling off the interval.
    const { hdc } = fakeHdc();
    const out = await new ThermalCollector(fakeClock()).collect(
      hdc,
      'dev',
      { durationMs: 12_000, intervalMs: 5_000 },
      createSceneLayout(dir),
    );
    expect(out.samples).toBe(3);
  });

  it('fails THERMAL_NO_OUTPUT when the service printed no sensors', async () => {
    const { hdc } = fakeHdc('--- ThermalService ---\n');
    const layout = createSceneLayout(dir);
    await expect(
      new ThermalCollector(fakeClock()).collect(hdc, 'dev', { durationMs: 10 }, layout),
    ).rejects.toMatchObject({ code: 'THERMAL_NO_OUTPUT' });
    expect(existsSync(layout.thermalFile)).toBe(false);
  });

  it('names the device stderr when the dump failed', async () => {
    const hdc = {
      async shellFor() {
        return { stdout: '', stderr: 'ThermalService not found', code: 1 };
      },
    } as unknown as Hdc;
    await expect(
      new ThermalCollector(fakeClock()).collect(hdc, 'dev', { durationMs: 10 }, createSceneLayout(dir)),
    ).rejects.toThrow(/ThermalService not found/);
  });

  it('rejects a bad duration or interval before touching the device', async () => {
    const { hdc, calls } = fakeHdc();
    await expect(
      new ThermalCollector(fakeClock()).collect(hdc, 'dev', { durationMs: 0 }, createSceneLayout(dir)),
    ).rejects.toMatchObject({ code: 'THERMAL_BAD_DURATION' });
    await expect(
      new ThermalCollector(fakeClock()).collect(
        hdc,
        'dev',
        { durationMs: 1_000, intervalMs: MIN_THERMAL_INTERVAL_MS - 1 },
        createSceneLayout(dir),
      ),
    ).rejects.toMatchObject({ code: 'THERMAL_BAD_INTERVAL' });
    expect(calls).toEqual([]);
  });

  it('removes a stale artifact before capturing', async () => {
    const layout = createSceneLayout(dir);
    writeFileSync(layout.thermalFile, 'stale from an earlier run\n');
    const { hdc } = fakeHdc();
    await new ThermalCollector(fakeClock()).collect(
      hdc,
      'dev',
      { durationMs: 10 },
      layout,
    );
    expect(readFileSync(layout.thermalFile, 'utf8')).not.toContain('stale');
  });

  it('defaults to HapRay\'s 5 s interval', () => {
    expect(DEFAULT_THERMAL_INTERVAL_MS).toBe(5_000);
  });
});

describe('readThermalRecords', () => {
  it('returns undefined when the scene captured no thermal data', () => {
    expect(readThermalRecords(createSceneLayout(dir))).toBeUndefined();
  });

  it('returns the records and counts invalid lines', () => {
    const layout = createSceneLayout(dir);
    const valid = {
      elapsedMs: 0,
      readings: [{ sensor: 'Battery', raw: 31000, unit: 'millidegree_celsius', celsius: 31 }],
    };
    writeFileSync(
      layout.thermalFile,
      `${JSON.stringify(valid)}\nnot json\n{"elapsedMs": 1}\n\n`,
    );
    expect(readThermalRecords(layout)).toEqual({
      records: [valid],
      invalidLines: 2,
    });
  });

  it('rejects a reading whose fields have the wrong types', () => {
    const layout = createSceneLayout(dir);
    writeFileSync(
      layout.thermalFile,
      `${JSON.stringify({
        elapsedMs: 0,
        readings: [{ sensor: 'x', raw: '31000', unit: 'celsius', celsius: 31 }],
      })}\n`,
    );
    expect(readThermalRecords(layout)).toEqual({ records: [], invalidLines: 1 });
  });
});
