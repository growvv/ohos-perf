import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HitraceCollector,
  HITRACE_DEFAULT_CATEGORIES,
  parseSize,
} from '../src/collectors/hitrace';

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

  it('default categories cannot be mutated by callers', () => {
    expect(Object.isFrozen(HITRACE_DEFAULT_CATEGORIES)).toBe(true);
    expect(() =>
      (HITRACE_DEFAULT_CATEGORIES as unknown as string[]).push('INJECTED'),
    ).toThrow();
  });

  it('rejects an empty category list in beginCommand', () => {
    const c = new HitraceCollector();
    expect(() => c.beginCommand({ app: 'x', durationMs: 1, categories: [] }))
      .toThrow(/HITRACE_BAD_CATEGORIES|categories/);
  });
});

describe('parseSize', () => {
  const PATH = '/data/local/tmp/ohosperf_trace.htrace';

  it('reads the size field of a standard ls -l line', () => {
    expect(parseSize(`-rw-r--r-- 1 shell shell 1663638 2026-11-15 02:46 ${PATH}`, PATH))
      .toBe(1663638);
  });

  it('does not match a path that merely starts with the target', () => {
    // A directory that accumulates files will contain these decoys.
    expect(
      parseSize(
        `-rw-r--r-- 1 shell shell 9 2026-11-15 02:46 ${PATH}.bak\n` +
          `-rw-r--r-- 1 shell shell 1663638 2026-11-15 02:46 ${PATH}`,
        PATH,
      ),
    ).toBe(1663638);
    expect(parseSize(`-rw-r--r-- 1 shell shell 7 2026-11-15 02:46 ${PATH}2`, PATH))
      .toBeUndefined();
  });

  it('returns undefined when the path is absent', () => {
    expect(parseSize('ls: No such file or directory', PATH)).toBeUndefined();
  });
});

// 用假 Hdc 驱动 collect()，断言失败路径不静默通过。
class FakeHdc {
  calls: Array<{ kind: string; args: unknown[] }> = [];
  constructor(
    private readonly responses: Record<string, { stdout: string; stderr: string; code: number }>,
    private readonly throwOn: string[] = [],
  ) {}
  async shell(_t: string, cmd: string) {
    this.calls.push({ kind: 'shell', args: [cmd] });
    for (const needle of this.throwOn) {
      if (cmd.includes(needle)) throw new Error(`hdc shell failed: ${cmd}`);
    }
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

function recvCalls(hdc: FakeHdc) {
  return hdc.calls.filter((x) => x.kind === 'recv');
}

function stopCalls(hdc: FakeHdc) {
  return hdc.calls.filter(
    (x) => x.kind === 'shell' && String(x.args[0]).includes('--trace_finish_nodump'),
  );
}

const DEVICE_PATH = '/data/local/tmp/ohosperf_trace.htrace';

const BEGIN_OK = { stdout: 'OpenRecording done.', stderr: '', code: 0 };
const FINISH_OK = {
  stdout: `trace read done, output: ${DEVICE_PATH}`,
  stderr: '',
  code: 0,
};
const LS_OK = {
  stdout: `-rw-r--r-- 1 shell shell 1024 2026-11-15 02:46 ${DEVICE_PATH}`,
  stderr: '',
  code: 0,
};

describe('HitraceCollector.collect failure paths', () => {
  it('throws when begin does not report OpenRecording done', async () => {
    // 实测 B：hdc shell 退出码 0，但 hitrace 内部失败。Real output is
    // multi-line and the error is on the last line, not the first.
    const hdc = new FakeHdc({
      '--trace_begin': {
        stdout:
          '2026/11/15 03:09:00 hitrace enter, running_state is RECORDING_LONG_BEGIN\n' +
          'args: tags:sched bufferSize:204800 overwrite:1\n' +
          '2026/11/15 03:09:00 error: OpenRecording failed, errorCode(1103)',
        stderr: '',
        code: 0,
      },
    });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .catch((e: { code?: string; message?: string }) => e);

    expect(err.code).toBe('HITRACE_BEGIN_FAILED');
    // The actual device error line must survive into the message.
    expect(err.message).toContain('errorCode(1103)');
    expect(recvCalls(hdc)).toEqual([]);
    expect(stopCalls(hdc)).toEqual([]);
  });

  it('throws when finish reports no marker', async () => {
    const hdc = new FakeHdc({
      '--trace_begin': BEGIN_OK,
      '--trace_finish': {
        stdout:
          '2026/11/15 03:10:00 hitrace enter, running_state is RECORDING_LONG_FINISH\n' +
          '2026/11/15 03:10:00 error: opening /bad/path, errno: 2',
        stderr: '',
        code: 0,
      },
    });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .catch((e: { code?: string; message?: string }) => e);

    expect(err.code).toBe('HITRACE_FINISH_FAILED');
    expect(err.message).toContain('errno: 2');
    expect(recvCalls(hdc)).toEqual([]);
  });

  it('throws HITRACE_NO_OUTPUT when finish succeeds but no file appears', async () => {
    // 实测 C：finish 退出码 0、只有 Warning、文件不存在。The finish output
    // here DOES contain the success marker, so the failure must come from the
    // existence check — not from the marker check.
    const hdc = new FakeHdc({
      '--trace_begin': BEGIN_OK,
      '--trace_finish': {
        stdout:
          `2026/11/15 03:00:00 trace read done, output: ${DEVICE_PATH}\n` +
          '2026/11/15 03:00:01 Trace Closed.',
        stderr: '',
        code: 0,
      },
      'ls -l': { stdout: '', stderr: 'ls: No such file or directory', code: 0 },
    });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .catch((e: { code?: string; message?: string }) => e);

    expect(err.code).toBe('HITRACE_NO_OUTPUT');
    expect(err.message).toMatch(/file not found/);
    // The existence check really ran.
    expect(
      hdc.calls.some((x) => x.kind === 'shell' && String(x.args[0]).startsWith('ls -l ')),
    ).toBe(true);
    expect(recvCalls(hdc)).toEqual([]);
  });

  it('throws when the file exists but is empty', async () => {
    const hdc = new FakeHdc({
      '--trace_begin': BEGIN_OK,
      '--trace_finish': FINISH_OK,
      'ls -l': {
        stdout: `-rw-r--r-- 1 shell shell 0 2026-11-15 02:46 ${DEVICE_PATH}`,
        stderr: '',
        code: 0,
      },
    });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .catch((e: { code?: string }) => e);
    expect(err.code).toBe('HITRACE_NO_OUTPUT');
    expect(recvCalls(hdc)).toEqual([]);
  });

  it('removes the stale device file before beginning', async () => {
    // 实测 D：固定路径会跨采集复用陈旧文件，必须先删。
    const hdc = new FakeHdc({
      '--trace_begin': BEGIN_OK,
      '--trace_finish': FINISH_OK,
      'ls -l': LS_OK,
    });
    const c = new HitraceCollector();
    await c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout());
    const firstShell = hdc.calls.find((x) => x.kind === 'shell')!;
    expect(String(firstShell.args[0])).toBe(`rm -f ${DEVICE_PATH}`);
  });
});

describe('HitraceCollector.collect success path', () => {
  it('transfers only after the size check passes', async () => {
    const hdc = new FakeHdc({
      '--trace_begin': BEGIN_OK,
      '--trace_finish': FINISH_OK,
      'ls -l': LS_OK,
    });
    const layout = fakeLayout();
    const c = new HitraceCollector();
    await c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, layout);

    const recv = recvCalls(hdc);
    expect(recv).toHaveLength(1);
    expect(recv[0].args).toEqual([DEVICE_PATH, '/tmp/x/trace.htrace']);

    // recv is the final call, and the size check directly precedes it.
    const kinds = hdc.calls.map((x) => x.kind);
    expect(kinds[kinds.length - 1]).toBe('recv');
    const lastShell = [...hdc.calls].reverse().find((x) => x.kind === 'shell')!;
    expect(String(lastShell.args[0])).toMatch(/^ls -l /);
    // A completed capture does not attempt a stop.
    expect(stopCalls(hdc)).toEqual([]);
  });
});

describe('HitraceCollector.collect stop-on-failure', () => {
  it('stops recording when the finish call throws', async () => {
    // If hdc.shell itself throws, hitrace keeps recording on the device and
    // every later begin fails with errorCode(1103). A best-effort stop is
    // required.
    const hdc = new FakeHdc(
      { '--trace_begin': BEGIN_OK },
      ['--trace_finish -o'],
    );
    const c = new HitraceCollector();
    await expect(
      c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout()),
    ).rejects.toThrow(/hdc shell failed/);

    const stops = stopCalls(hdc);
    expect(stops).toHaveLength(1);
    expect(recvCalls(hdc)).toEqual([]);
  });

  it('swallows the stop command own failure and rethrows the original', async () => {
    const hdc = new FakeHdc(
      { '--trace_begin': BEGIN_OK },
      ['--trace_finish'],
    );
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .catch((e: { message?: string }) => e);

    // The original finish failure surfaces, not the stop failure.
    expect(err.message).toContain('--trace_finish -o');
    expect(stopCalls(hdc)).toHaveLength(1);
  });
});

describe('HitraceCollector.collect duration validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['above the 32-bit setTimeout limit', 2_147_483_648],
    ['30 days', 2_592_000_000],
  ])('rejects %s durationMs before touching the device', async (_label, durationMs) => {
    const hdc = new FakeHdc({});
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs }, fakeLayout())
      .catch((e: { code?: string; message?: string }) => e);

    expect(err.code).toBe('HITRACE_BAD_DURATION');
    expect(err.message).toMatch(/durationMs/);
    expect(hdc.calls).toEqual([]);
  });

  it('accepts the largest value setTimeout can represent', async () => {
    vi.useFakeTimers();
    try {
      const hdc = new FakeHdc({
        '--trace_begin': BEGIN_OK,
        '--trace_finish': FINISH_OK,
        'ls -l': LS_OK,
      });
      const c = new HitraceCollector();
      const done = c.collect(
        hdc as never,
        'dev',
        { app: 'x', durationMs: 2_147_483_647 },
        fakeLayout(),
      );
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      await done;
      expect(recvCalls(hdc)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HitraceCollector.collect category validation', () => {
  it.each([
    ['an empty array', [] as string[]],
    ['a blank entry', ['ace', '']],
  ])('rejects %s before touching the device', async (_label, categories) => {
    const hdc = new FakeHdc({});
    const c = new HitraceCollector();
    const err = await c
      .collect(
        hdc as never,
        'dev',
        { app: 'x', durationMs: 1, categories },
        fakeLayout(),
      )
      .catch((e: { code?: string; message?: string }) => e);

    expect(err.code).toBe('HITRACE_BAD_CATEGORIES');
    expect(err.message).toMatch(/categor/i);
    expect(hdc.calls).toEqual([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
