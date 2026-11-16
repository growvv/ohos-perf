import { describe, it, expect } from 'vitest';
import { HilogAnalyzer } from '../src/analyze/hilog';
import { parseHilogText } from '../src/hilog/parse';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';
import type { HilogLine } from '../src/hilog/parse';

/** A handle that answers nothing; the hilog analyzer reads no tables. */
const noDb = {
  path: '',
  query: () => [],
  close: () => {},
};

function caps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'hilog.stream', available: true, collector: 'hilog', fidelity: 'exact',
      probe: { command: 'which hilog', stdout: '/system/bin/hilog', stderr: '', code: 0 } },
  ]);
}

function ctxWithLines(lines: HilogLine[] | undefined): AnalyzeContext {
  return {
    ...(lines === undefined ? {} : { hilog: lines }),
    frames: new FrameQuery(noDb),
    processes: new ProcessQuery(noDb),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: caps(),
    deviceId: 'offline',
  };
}

/** Parse raw log text the way the CLI does, so the fixture is realistic. */
function log(...messages: string[]): HilogLine[] {
  const text = messages
    .map((message, index) =>
      `11-17 05:12:${String(10 + index).padStart(2, '0')}.000  4999  5010 I A00000/com.demo/Image: ${message}`)
    .join('\n');
  return parseHilogText(text, { year: 2026, captureNs: Date.UTC(2026, 10, 17, 5, 12) * 1e6 });
}

function metric(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

describe('HilogAnalyzer', () => {
  it('counts per-rule matches and emits one evidence item per matching rule', async () => {
    const r = await new HilogAnalyzer().run(ctxWithLines(log(
      'CreatePixelMap success, memType : 3, cost 1 us',
      'CreatePixelMap success, memType : 3, cost 2 us',
      'CreatePixelMap success, memType : 4, cost 3 us',
    )));
    expect(metric(r, 'hilog.lines.count').value).toBe(3);
    expect(metric(r, 'hilog.rule.no_dmp.count').value).toBe(2);
    const ev = r.evidence.filter((e) => e.kind === 'hilog_match');
    expect(ev.map((e) => e.subject.rule)).toEqual(['no_dmp']);
    expect(ev[0].signals.count).toBe(2);
    expect(ev[0].signals.samples).toHaveLength(2);
  });

  it('degrades with a reason when the scene has no log', async () => {
    const r = await new HilogAnalyzer().run(ctxWithLines(undefined));
    expect(r.metrics.map((m) => m.id)).toEqual(['hilog.degraded']);
    expect(r.metrics[0].fidelity).toBe('proxy');
    expect(r.evidence[0].kind).toBe('no_data');
  });

  it('reports a zero count as a measurement when the log has no matches', async () => {
    const r = await new HilogAnalyzer().run(ctxWithLines(log('unrelated line')));
    expect(metric(r, 'hilog.rule.no_dmp.count').value).toBe(0);
    expect(metric(r, 'hilog.rule.no_dmp.count').fidelity).toBe('exact');
    expect(r.evidence.filter((e) => e.kind === 'hilog_match')).toEqual([]);
  });

  it('counts parsed and unparsed rows separately', async () => {
    const lines = [...log('unrelated line'), {
      index: 1, ts: 0, level: 'I' as const, pid: 0, tid: 0, domain: '', tag: '',
      message: 'not a log record', parsed: false,
    }];
    const r = await new HilogAnalyzer().run(ctxWithLines(lines));
    expect(metric(r, 'hilog.lines.count').value).toBe(2);
    expect(metric(r, 'hilog.parsed.count').value).toBe(1);
    expect(metric(r, 'hilog.unparsed.count').value).toBe(1);
  });

  it('reports matched and unmatched rule totals', async () => {
    const r = await new HilogAnalyzer().run(ctxWithLines(log(
      'CreatePixelMap success, memType : 3, cost 1 us',
    )));
    expect(metric(r, 'hilog.rules.matched.count').value).toBe(1);
    expect(metric(r, 'hilog.rules.unmatched.count').value).toBe(3);
  });

  it('is deterministic across runs', async () => {
    const lines = log(
      'CreatePixelMap success, memType : 3, cost 1 us',
      'CreatePixelMap success, memType : 4, cost 3 us',
    );
    const a = await new HilogAnalyzer().run(ctxWithLines(lines));
    const b = await new HilogAnalyzer().run(ctxWithLines(lines));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
