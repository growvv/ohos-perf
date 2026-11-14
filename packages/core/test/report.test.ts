import { describe, it, expect } from 'vitest';
import { metric } from '../src/report/metric';
import type { Metric } from '../src/report/metric';
import { evidence } from '../src/report/evidence';
import type { Evidence } from '../src/report/evidence';

const provenance = {
  collector: 'hitrace+streamer',
  table: 'frame_slice',
  rows: 220,
  device: 'emu',
};

describe('metric', () => {
  it('defaults unit to none and keeps provenance', () => {
    const m = metric({
      id: 'frame.jank.rate',
      value: 3.2,
      provenance,
      fidelity: 'exact',
    });
    expect(m.unit).toBe('none');
    expect(m.provenance.rows).toBe(220);
  });

  it('keeps an explicit unit', () => {
    const m = metric({
      id: 'frame.jank.rate',
      value: 3.2,
      unit: '%',
      provenance,
      fidelity: 'approximate',
    });
    expect(m.unit).toBe('%');
    expect(m.fidelity).toBe('approximate');
  });

  it('returns a new object and does not mutate the input', () => {
    const input = {
      id: 'frame.jank.rate',
      value: 3.2,
      provenance,
      fidelity: 'exact' as const,
    };
    const m = metric(input);
    expect(m).not.toBe(input);
    expect(m.provenance).toBe(provenance);
    expect('unit' in input).toBe(false);
    expect(m.unit).toBe('none');
  });

  it('preserves optional window and degraded fields verbatim', () => {
    const window = { startNs: 10, endNs: 20 };
    const degraded = { reason: 'no PMU', fallback: 'sw-cpu-clock' };
    const m: Metric = metric({
      id: 'perf.cycles',
      value: 42,
      unit: 'count',
      window,
      provenance,
      fidelity: 'proxy',
      degraded,
    });
    expect(m.window).toBe(window);
    expect(m.degraded).toBe(degraded);
  });
});

describe('evidence', () => {
  it('generates stable id for identical content', () => {
    const base = {
      kind: 'jank' as const,
      severity: 'warn' as const,
      subject: { process: 'render_service' },
      window: { startNs: 1, endNs: 2 },
      signals: { frames: 3 },
      explain: 'x',
      drillDown: [],
    };
    expect(evidence(base).id).toBe(evidence(base).id);
  });

  it('is independent of key construction order in subject', () => {
    const common = {
      kind: 'jank' as const,
      severity: 'warn' as const,
      window: { startNs: 1, endNs: 2 },
      signals: {},
      explain: 'x',
      drillDown: [],
    };
    const a = evidence({ ...common, subject: { process: 'a', thread: 't', pid: 7 } });
    const b = evidence({ ...common, subject: { pid: 7, thread: 't', process: 'a' } });
    expect(a.id).toBe(b.id);
  });

  it('generates different ids for different windows', () => {
    const base = {
      kind: 'jank' as const,
      severity: 'warn' as const,
      subject: { process: 'a' },
      signals: {},
      explain: 'x',
      drillDown: [],
    };
    const a = evidence({ ...base, window: { startNs: 1, endNs: 2 } });
    const b = evidence({ ...base, window: { startNs: 1, endNs: 3 } });
    expect(a.id).not.toBe(b.id);
  });

  it('generates different ids for different kinds and subject fields', () => {
    const base = {
      severity: 'warn' as const,
      subject: { process: 'a' },
      window: { startNs: 1, endNs: 2 },
      signals: {},
      explain: 'x',
      drillDown: [],
    };
    const jank = evidence({ ...base, kind: 'jank' });
    const noData = evidence({ ...base, kind: 'no_data' });
    const thread = evidence({ ...base, kind: 'jank', subject: { process: 'a', thread: 't' } });
    const frame = evidence({ ...base, kind: 'jank', subject: { process: 'a', frameNo: 9 } });
    const pid = evidence({ ...base, kind: 'jank', subject: { process: 'a', pid: 3 } });
    expect(new Set([jank.id, noData.id, thread.id, frame.id, pid.id]).size).toBe(5);
  });

  it('derives the id from the pinned field order', () => {
    // sha1('jank|render_service||||1|2').slice(0, 12)
    const e = evidence({
      kind: 'jank',
      severity: 'warn',
      subject: { process: 'render_service' },
      window: { startNs: 1, endNs: 2 },
      signals: {},
      explain: 'x',
      drillDown: [],
    });
    expect(e.id).toBe('8875da165f5f');
  });

  it('emits a 12-char lowercase hex id', () => {
    const e = evidence({
      kind: 'jank',
      severity: 'warn',
      subject: { process: 'a' },
      window: { startNs: 1, endNs: 2 },
      signals: {},
      explain: 'x',
      drillDown: [],
    });
    expect(e.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('preserves drillDown order and returns a new object', () => {
    const drillDown = [
      { label: 'first', tool: 'frames.get', args: { frameNo: 1 }, returns: 'Frame', estRows: 1 },
      { label: 'second', tool: 'sql', args: { sql: 'select 1' }, returns: 'rows' },
      { label: 'third', tool: 'binder.transactions', args: {}, returns: 'BinderTx[]' },
    ];
    const input = {
      kind: 'jank' as const,
      severity: 'warn' as const,
      subject: { process: 'a' },
      window: { startNs: 1, endNs: 2 },
      signals: { frames: 3 },
      explain: 'x',
      drillDown,
    };
    const e: Evidence = evidence(input);
    expect(e).not.toBe(input);
    expect(e.drillDown).toBe(drillDown);
    expect(e.drillDown.map((d) => d.label)).toEqual(['first', 'second', 'third']);
    expect('id' in input).toBe(false);
    expect(e.severity).toBe('warn');
    expect(e.explain).toBe('x');
  });
});
