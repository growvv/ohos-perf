import { describe, it, expect } from 'vitest';
import { ThermalAnalyzer } from '../src/analyze/thermal';
import { defaultAnalyzers } from '../src/analyze/engine';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { ThermalCapture } from '../src/collectors/thermal';
import type { Metric } from '../src/report/metric';
import type { ThermalReading } from '../src/thermal/parse';

/** A handle that answers nothing; the thermal analyzer reads no tables. */
const noDb = {
  path: '',
  query: () => [],
  close: () => {},
};

function reading(sensor: string, celsius: number): ThermalReading {
  return { sensor, raw: Math.round(celsius * 1000), unit: 'millidegree_celsius', celsius };
}

function ctxWithThermal(thermal: ThermalCapture | undefined): AnalyzeContext {
  return {
    ...(thermal === undefined ? {} : { thermal }),
    frames: new FrameQuery(noDb),
    processes: new ProcessQuery(noDb),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: new CapabilityMatrix([]),
    deviceId: 'offline',
  };
}

function metric(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

describe('ThermalAnalyzer', () => {
  it('computes start, end, peak, mean and rise per sensor from its own samples', async () => {
    const thermal: ThermalCapture = {
      invalidLines: 0,
      records: [
        { elapsedMs: 0, readings: [reading('Battery', 31), reading('ambient', 22)] },
        { elapsedMs: 5_000, readings: [reading('Battery', 31.5)] },
        { elapsedMs: 10_000, readings: [reading('Battery', 32), reading('ambient', 35)] },
      ],
    };
    const r = await new ThermalAnalyzer().run(ctxWithThermal(thermal));

    expect(metric(r, 'thermal.samples.count').value).toBe(3);
    expect(metric(r, 'thermal.sensors.count').value).toBe(2);
    expect(metric(r, 'thermal.duration.ms').value).toBe(10_000);
    expect(metric(r, 'thermal.interval.median.ms').value).toBe(5_000);

    expect(metric(r, 'thermal.battery.start.celsius').value).toBe(31);
    expect(metric(r, 'thermal.battery.end.celsius').value).toBe(32);
    expect(metric(r, 'thermal.battery.peak.celsius').value).toBe(32);
    expect(metric(r, 'thermal.battery.mean.celsius').value).toBe(31.5);
    expect(metric(r, 'thermal.battery.rise.celsius').value).toBe(1);

    // `ambient` is absent from the middle sample: its statistics use only the
    // two samples that carry it, never a zero or the previous value carried
    // forward.
    expect(metric(r, 'thermal.ambient.start.celsius').value).toBe(22);
    expect(metric(r, 'thermal.ambient.end.celsius').value).toBe(35);
    expect(metric(r, 'thermal.ambient.peak.celsius').value).toBe(35);
    expect(metric(r, 'thermal.ambient.mean.celsius').value).toBe(28.5);
    expect(metric(r, 'thermal.ambient.rise.celsius').value).toBe(13);

    const evidence = r.evidence.find((item) => item.signals.sensor === 'ambient');
    expect(evidence).toBeDefined();
    expect(evidence!.kind).toBe('thermal');
    expect(evidence!.severity).toBe('info');
    expect(evidence!.signals.samples).toBe(2);
    expect(evidence!.explain).toBe(
      'ambient rose 13 °C over 2 samples (22 → 35, peak 35)',
    );
  });

  it('keeps a plain-Celsius sensor distinct from a millidegree one', async () => {
    const thermal: ThermalCapture = {
      invalidLines: 0,
      records: [{
        elapsedMs: 0,
        readings: [
          { sensor: 'modem', raw: 27, unit: 'celsius', celsius: 27 },
          { sensor: 'Battery', raw: 31000, unit: 'millidegree_celsius', celsius: 31 },
        ],
      }],
    };
    const r = await new ThermalAnalyzer().run(ctxWithThermal(thermal));

    expect(metric(r, 'thermal.modem.start.celsius').value).toBe(27);
    expect(metric(r, 'thermal.modem.peak.celsius').value).toBe(27);
    expect(metric(r, 'thermal.battery.start.celsius').value).toBe(31);
    expect(metric(r, 'thermal.battery.peak.celsius').value).toBe(31);
  });

  it('gives two sensors with the same slug distinct metric ids', async () => {
    const thermal: ThermalCapture = {
      invalidLines: 0,
      records: [{
        elapsedMs: 0,
        readings: [reading('GPU 0', 40), reading('GPU-0', 45)],
      }],
    };
    const r = await new ThermalAnalyzer().run(ctxWithThermal(thermal));

    // 'GPU 0' sorts before 'GPU-0': space is less than hyphen.
    expect(metric(r, 'thermal.gpu_0.start.celsius').value).toBe(40);
    expect(metric(r, 'thermal.gpu_0_2.start.celsius').value).toBe(45);
    // Both sensors keep their own evidence item, and its id order is the
    // engine's `(kind, startNs, id)` order rather than sensor-name order.
    expect(r.evidence.map((item) => item.signals.sensor).sort())
      .toEqual(['GPU 0', 'GPU-0']);
    expect(r.evidence.map((item) => item.id)).toEqual(
      [...r.evidence.map((item) => item.id)].sort(),
    );
  });

  it('sorts metrics by id and produces identical output on two runs', async () => {
    const thermal: ThermalCapture = {
      invalidLines: 0,
      records: [
        { elapsedMs: 0, readings: [reading('Battery', 30), reading('system_h', 31)] },
        { elapsedMs: 2_000, readings: [reading('Battery', 33), reading('system_h', 32)] },
      ],
    };
    const first = await new ThermalAnalyzer().run(ctxWithThermal(thermal));
    const second = await new ThermalAnalyzer().run(ctxWithThermal(thermal));

    expect(first).toEqual(second);
    expect(first.metrics.map((m) => m.id)).toEqual(
      [...first.metrics.map((m) => m.id)].sort(),
    );
    expect(first.metrics.every((m) => m.unit === 'count' || m.unit === 'ms' ||
      m.unit === 'celsius')).toBe(true);
  });

  it('degrades with a --thermal hint when the scene has no capture', async () => {
    const r = await new ThermalAnalyzer().run(ctxWithThermal(undefined));

    expect(r.metrics.map((m) => m.id)).toEqual(['thermal.degraded']);
    expect(r.metrics[0]!.fidelity).toBe('proxy');
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.kind).toBe('no_data');
    expect(r.evidence[0]!.explain).toMatch(/--thermal/);
    expect(r.metrics.filter((m) => m.unit === 'celsius')).toEqual([]);
  });

  it('reports invalid artifact lines as a measurement', async () => {
    const thermal: ThermalCapture = {
      invalidLines: 2,
      records: [{ elapsedMs: 0, readings: [reading('Battery', 31)] }],
    };
    const r = await new ThermalAnalyzer().run(ctxWithThermal(thermal));
    expect(metric(r, 'thermal.records.invalid').value).toBe(2);
    expect(metric(r, 'thermal.records.invalid').fidelity).toBe('exact');
  });

  it('degrades when the artifact exists but holds no samples', async () => {
    const r = await new ThermalAnalyzer().run(ctxWithThermal({ records: [], invalidLines: 0 }));
    expect(r.metrics.map((m) => m.id)).toEqual(['thermal.degraded']);
    expect(r.metrics[0]!.degraded?.reason).toMatch(/thermal\.jsonl/);
    expect(r.evidence[0]!.explain).toMatch(/no samples/);
  });

  it('is registered in the default analyzer set', () => {
    expect(defaultAnalyzers().map((analyzer) => analyzer.id)).toContain('thermal');
  });
});
