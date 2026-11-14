import { describe, it, expect } from 'vitest';
import { HitraceCollector, HITRACE_DEFAULT_CATEGORIES } from '../src/collectors/hitrace';

describe('HitraceCollector', () => {
  it('declares the trace capabilities', () => {
    const c = new HitraceCollector();
    expect(c.provides).toContain('trace.frames');
    expect(c.provides).toContain('trace.binder');
    expect(c.provides).not.toContain('mem.native_hook');
  });

  it('builds begin command with buffer and categories, without -t', () => {
    const c = new HitraceCollector();
    // 实测 E：-t 对 --trace_begin 不生效（-t 2 实测仍采集 8.24s），不传。
    expect(c.beginCommand({ app: 'com.demo', durationMs: 1000 }))
      .toBe(`hitrace --trace_begin -b 204800 ${HITRACE_DEFAULT_CATEGORIES.join(' ')}`);
  });

  it('honours custom buffer and categories', () => {
    const c = new HitraceCollector();
    expect(c.beginCommand({ app: 'x', durationMs: 1, bufferKb: 8192, categories: ['ace', 'app'] }))
      .toBe('hitrace --trace_begin -b 8192 ace app');
  });

  it('builds finish command writing to device path', () => {
    const c = new HitraceCollector();
    expect(c.finishCommand('/data/local/tmp/x.htrace'))
      .toBe('hitrace --trace_finish -o /data/local/tmp/x.htrace');
  });

  it('default categories include frame-relevant ones', () => {
    expect(HITRACE_DEFAULT_CATEGORIES).toEqual(
      expect.arrayContaining(['ability', 'ace', 'app', 'graphic', 'sched', 'window']),
    );
  });
});

// 用假 Hdc 驱动 collect()，断言失败路径不静默通过。
class FakeHdc {
  calls: Array<{ kind: string; args: unknown[] }> = [];
  constructor(private readonly responses: Record<string, { stdout: string; stderr: string; code: number }>) {}
  async shell(_t: string, cmd: string) {
    this.calls.push({ kind: 'shell', args: [cmd] });
    for (const [needle, r] of Object.entries(this.responses)) {
      if (cmd.includes(needle)) return r;
    }
    return { stdout: '', stderr: '', code: 0 };
  }
  async recv(_t: string, d: string, l: string) { this.calls.push({ kind: 'recv', args: [d, l] }); }
}

function fakeLayout() {
  return {
    dir: '/tmp/x',
    traceFile: '/tmp/x/trace.htrace',
    traceDb: '/tmp/x/trace.db',
    perfFile: '/tmp/x/perf.data',
    perfDb: '/tmp/x/perf.db',
  } as never;
}

it('throws when begin does not report OpenRecording done', async () => {
  // 实测 B：hdc shell 退出码 0，但 hitrace 内部失败。
  const hdc = new FakeHdc({
    '--trace_begin': { stdout: 'error: OpenRecording failed, errorCode(1103)', stderr: '', code: 0 },
  });
  const c = new HitraceCollector();
  await expect(
    c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout()),
  ).rejects.toThrow(/OpenRecording|HITRACE_BEGIN_FAILED/);
});

it('throws when finish produces no file', async () => {
  // 实测 C：finish 退出码 0、只有 Warning、文件不存在。
  const hdc = new FakeHdc({
    '--trace_begin': { stdout: 'OpenRecording done.', stderr: '', code: 0 },
    '--trace_finish': { stdout: 'Warning: tracing on is closed, no trace can be read.', stderr: '', code: 0 },
    'ls -l': { stdout: '', stderr: 'ls: No such file or directory', code: 0 },
  });
  const c = new HitraceCollector();
  await expect(
    c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout()),
  ).rejects.toThrow(/HITRACE_NO_OUTPUT|no trace/);
});

it('removes the stale device file before beginning', async () => {
  // 实测 D：固定路径会跨采集复用陈旧文件，必须先删。
  const hdc = new FakeHdc({
    '--trace_begin': { stdout: 'OpenRecording done.', stderr: '', code: 0 },
    '--trace_finish': { stdout: 'trace read done, output: /data/local/tmp/ohosperf_trace.htrace', stderr: '', code: 0 },
    'ls -l': { stdout: '-rw-r--r-- 1 shell shell 1024 /data/local/tmp/ohosperf_trace.htrace', stderr: '', code: 0 },
  });
  const c = new HitraceCollector();
  await c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout());
  const firstShell = hdc.calls.find((x) => x.kind === 'shell')!;
  expect(String(firstShell.args[0])).toMatch(/^rm -f /);
});
