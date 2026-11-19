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

  it('rejects a bad bufferKb in beginCommand', () => {
    // collect() validates independently; beginCommand() is public and
    // interpolates the value into the device command, so it needs its own gate.
    const c = new HitraceCollector();
    expect(() => c.beginCommand({ app: 'x', durationMs: 1, bufferKb: 0 }))
      .toThrow(/HITRACE_BAD_BUFFER|bufferKb/);
    expect(() => c.beginCommand({ app: 'x', durationMs: 1, bufferKb: 1.5 }))
      .toThrow(/HITRACE_BAD_BUFFER|bufferKb/);
    expect(c.beginCommand({ app: 'x', durationMs: 1, bufferKb: 8192 }))
      .toBe('hitrace --trace_begin -b 8192 ' + HITRACE_DEFAULT_CATEGORIES.join(' '));
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
type Reply = { stdout: string; stderr: string; code: number };

class FakeHdc {
  calls: Array<{ kind: string; args: unknown[] }> = [];
  constructor(
    private readonly responses: Record<string, Reply | Reply[]>,
    private readonly throwOn: string[] = [],
  ) {}
  async shell(_t: string, cmd: string) {
    this.calls.push({ kind: 'shell', args: [cmd] });
    for (const needle of this.throwOn) {
      if (cmd.includes(needle)) throw new Error(`hdc shell failed: ${cmd}`);
    }
    for (const [needle, r] of Object.entries(this.responses)) {
      if (!cmd.includes(needle)) continue;
      // An array answers the same command once per call, in order, holding
      // its last reply: a retry gets the next one instead of the same one.
      if (!Array.isArray(r)) return r;
      const next = r.length > 1 ? r.shift()! : r[0]!;
      return next;
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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

    expect(err.code).toBe('HITRACE_BEGIN_FAILED');
    // The actual device error line must survive into the message.
    expect(err.message).toContain('errorCode(1103)');
    expect(recvCalls(hdc)).toEqual([]);
    // A stale long recording is the one begin failure the collector can clear,
    // so it must try — see the retry suite below.
    expect(stopCalls(hdc)).toHaveLength(1);
  });

  it('stops a stale recording and retries the begin once', async () => {
    // Measured on the emulator: a `--trace_begin` left recording by an aborted
    // run makes every later begin answer `errorCode(1103)` until a
    // `--trace_finish_nodump` clears it — an earlier sweep recorded 0 of 21
    // cases to exactly this. One stop, one retry, and the retry succeeds.
    const stale = {
      stdout:
        '2026/11/15 03:09:00 hitrace enter, running_state is RECORDING_LONG_BEGIN\n' +
        'args: tags:sched bufferSize:204800 overwrite:1\n' +
        '2026/11/15 03:09:00 error: OpenRecording failed, errorCode(1103)',
      stderr: '',
      code: 0,
    };
    const hdc = new FakeHdc({
      '--trace_begin': [stale, BEGIN_OK],
      '--trace_finish': FINISH_OK,
      'ls -l': LS_OK,
    });
    const c = new HitraceCollector();
    await c.collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout());

    const begins = hdc.calls.filter(
      (x) => x.kind === 'shell' && String(x.args[0]).includes('--trace_begin'),
    );
    expect(begins).toHaveLength(2);
    expect(stopCalls(hdc)).toHaveLength(1);
    // The stop sits between the two begins, not after them.
    const order = hdc.calls.map((x) => String(x.args[0]));
    const firstBegin = order.findIndex((cmd) => cmd.includes('--trace_begin'));
    const stop = order.findIndex((cmd) => cmd.includes('--trace_finish_nodump'));
    const secondBegin = order.findIndex(
      (cmd, index) => index > stop && cmd.includes('--trace_begin'),
    );
    expect(firstBegin).toBeLessThan(stop);
    expect(secondBegin).toBeGreaterThan(stop);
    expect(recvCalls(hdc)).toHaveLength(1);
  });

  it('gives up after one retry and names both failures', async () => {
    // A begin that fails twice is not a stale session. Retrying again would
    // spend the capture window on a device that cannot record, so the second
    // failure is the error, and it carries the first one's text too.
    const stale = {
      stdout: 'error: OpenRecording failed, errorCode(1103)',
      stderr: '',
      code: 0,
    };
    const hdc = new FakeHdc({ '--trace_begin': [stale, stale, BEGIN_OK] });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

    expect(err.code).toBe('HITRACE_BEGIN_FAILED');
    expect(err.message).toContain('errorCode(1103)');
    const begins = hdc.calls.filter(
      (x) => x.kind === 'shell' && String(x.args[0]).includes('--trace_begin'),
    );
    expect(begins).toHaveLength(2);
    expect(stopCalls(hdc)).toHaveLength(1);
    expect(recvCalls(hdc)).toEqual([]);
  });

  it('does not retry a begin that failed for another reason', async () => {
    // `tag is empty` is a caller mistake, not a stale session: stopping a
    // recording that is not there and retrying the same command only doubles
    // the device round trips before the same error.
    const hdc = new FakeHdc({
      '--trace_begin': {
        stdout: 'error: tag is empty, please add.',
        stderr: '',
        code: 0,
      },
    });
    const c = new HitraceCollector();
    const err = await c
      .collect(hdc as never, 'dev', { app: 'x', durationMs: 1 }, fakeLayout())
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

    expect(err.code).toBe('HITRACE_BEGIN_FAILED');
    const begins = hdc.calls.filter(
      (x) => x.kind === 'shell' && String(x.args[0]).includes('--trace_begin'),
    );
    expect(begins).toHaveLength(1);
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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string }) => e,
      );
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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { message?: string }) => e,
      );

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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

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
    ['a blank entry', ['ace', '   ']],
    ['an empty string', ['ace', '']],
    ['a space', ['ace', 'a b']],
    ['a semicolon', ['ace', 'a;b']],
    ['a dollar sign', ['ace', 'a$b']],
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
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

    expect(err.code).toBe('HITRACE_BAD_CATEGORIES');
    expect(err.message).toMatch(/categor/i);
    expect(hdc.calls).toEqual([]);
  });
});

describe('HitraceCollector.collect buffer validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s bufferKb before touching the device', async (_label, bufferKb) => {
    const hdc = new FakeHdc({});
    const c = new HitraceCollector();
    const err = await c
      .collect(
        hdc as never,
        'dev',
        { app: 'x', durationMs: 1, bufferKb },
        fakeLayout(),
      )
      .then(
        () => { throw new Error('expected collect() to reject'); },
        (e: { code?: string; message?: string }) => e,
      );

    expect(err.code).toBe('HITRACE_BAD_BUFFER');
    expect(err.message).toMatch(/bufferKb/);
    expect(hdc.calls).toEqual([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
