import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProcfsCollector,
  parseProcfsStatus,
  parseSmapsRollup,
  readProcfsSamples,
  writeProcfsSamples,
  type ProcfsSample,
} from '../src/collectors/procfs';
import { createSceneLayout } from '../src/ingest/scene';
import { DeviceNotFoundError, OhosPerfError } from '../src/errors';
import type { Hdc, HdcResult } from '../src/transport/hdc';

/**
 * Realistic `/proc/<pid>/status` excerpt. The values are deliberately distinct
 * so a parser that picks the wrong key is visible: VmRSS is 123456, VmHWM is
 * 234567, Threads is 42.
 */
const STATUS_TEXT = `Name:\tcom.demo
Umask:\t0077
State:\tS (sleeping)
Tgid:\t742
Pid:\t742
PPid:\t1
VmPeak:\t 2500000 kB
VmSize:\t 2400000 kB
VmRSS:\t 123456 kB
RssAnon:\t 50000 kB
VmHWM:\t 234567 kB
RssFile:\t 60000 kB
Threads:\t42
SigQ:\t0/16000
`;

/**
 * Realistic `/proc/<pid>/smaps_rollup` excerpt. `Pss_Anon` and `Pss_File` are
 * decoys: a parser using an unanchored `Pss` match would read 50000.
 */
const SMAPS_TEXT = `00400000-00500000 r--p 00000000 00:00 0  [empty]
Size:                400 kB
KernelPageSize:        4 kB
MMUPageSize:           4 kB
Rss:                 400 kB
Pss:              100000 kB
Pss_Anon:          50000 kB
Pss_File:          50000 kB
Pss_Shmem:             0 kB
Private_Dirty:     40000 kB
Shared_Dirty:          0 kB
SwapPss:            5000 kB
SwapPss_Anon:       9000 kB
Locked:                0 kB
`;

const STATUS: ProcfsSample['status'] = {
  vmRssBytes: 123456 * 1024,
  vmHwmBytes: 234567 * 1024,
  threads: 42,
};

// Every kB-valued field is converted, so each `*Bytes` name is accurate.
const SMAPS: NonNullable<ProcfsSample['smaps']> = {
  pssBytes: 100000 * 1024,
  privateDirtyBytes: 40000 * 1024,
  swapPssBytes: 5000 * 1024,
};

describe('parseProcfsStatus', () => {
  it('reads VmRSS, VmHWM and Threads and converts kB to bytes', () => {
    expect(parseProcfsStatus(STATUS_TEXT)).toEqual(STATUS);
  });

  it.each([
    ['VmRSS', 'VmRSS:\t 123456 kB\n'],
    ['VmHWM', 'VmHWM:\t 234567 kB\n'],
    ['Threads', 'Threads:\t42\n'],
  ])('returns undefined when %s is missing', (_field, line) => {
    expect(parseProcfsStatus(STATUS_TEXT.replace(line, ''))).toBeUndefined();
  });

  it('anchors the key: a lookalike line does not satisfy VmRSS', () => {
    const text = STATUS_TEXT.replace('VmRSS:\t 123456 kB', 'VmRSSHigh:\t 123456 kB');
    expect(parseProcfsStatus(text)).toBeUndefined();
  });

  it('ignores lines whose values are not plain integers', () => {
    const text = STATUS_TEXT.replace('VmHWM:\t 234567 kB', 'VmHWM:\t 1.5 kB');
    expect(parseProcfsStatus(text)).toBeUndefined();
  });
});

describe('parseSmapsRollup', () => {
  it('reads Pss, Private_Dirty and SwapPss', () => {
    expect(parseSmapsRollup(SMAPS_TEXT)).toEqual(SMAPS);
  });

  it('does not let Pss_Anon or Pss_File satisfy Pss', () => {
    const text = SMAPS_TEXT.replace('Pss:              100000 kB\n', '');
    expect(parseSmapsRollup(text)).toBeUndefined();
  });

  it('does not let SwapPss_Anon satisfy SwapPss', () => {
    const text = SMAPS_TEXT.replace('SwapPss:            5000 kB\n', '');
    expect(parseSmapsRollup(text)).toBeUndefined();
  });

  it.each([
    ['Pss', 'Pss:              100000 kB\n'],
    ['Private_Dirty', 'Private_Dirty:     40000 kB\n'],
    ['SwapPss', 'SwapPss:            5000 kB\n'],
  ])('returns undefined when %s is missing', (_field, line) => {
    expect(parseSmapsRollup(SMAPS_TEXT.replace(line, ''))).toBeUndefined();
  });
});

let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ohosperf-procfs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('procfs JSONL serialization', () => {
  it('round-trips samples in order, including one without smaps', () => {
    const dir = makeDir();
    // A nested path proves the directory is created.
    const path = join(dir, 'scene', 'nested', 'procfs.jsonl');
    const samples: ProcfsSample[] = [
      { ts: 0, pid: 742, status: STATUS, smaps: SMAPS },
      { ts: 500, pid: 742, status: STATUS },
    ];

    writeProcfsSamples(path, samples);

    expect(readProcfsSamples(path)).toEqual(samples);
    expect(readFileSync(path, 'utf8')).toBe(
      `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`,
    );
  });

  it('returns [] for a missing file', () => {
    const dir = makeDir();
    expect(readProcfsSamples(join(dir, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('skips blank lines and lines that are not a valid sample', () => {
    const dir = makeDir();
    const path = join(dir, 'procfs.jsonl');
    const valid: ProcfsSample = { ts: 5, pid: 6, status: STATUS };
    writeFileSync(
      path,
      [
        '',
        '   ',
        'not json',
        'null',
        '[]',
        '{"ts":1}',
        JSON.stringify({ ts: 2, pid: 3, status: { vmRssBytes: 1, vmHwmBytes: 2 } }),
        JSON.stringify({ ts: 3, pid: 4, status: STATUS, smaps: { pssBytes: 7 } }),
        JSON.stringify({ ts: '4', pid: 5, status: STATUS }),
        JSON.stringify(valid),
        '',
      ].join('\n'),
    );

    expect(readProcfsSamples(path)).toEqual([valid]);
  });

  it('writes an empty file for an empty sample list', () => {
    const dir = makeDir();
    const path = join(dir, 'empty.jsonl');
    writeProcfsSamples(path, []);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readProcfsSamples(path)).toEqual([]);
  });
});

function ok(stdout: string): HdcResult {
  return { stdout, stderr: '', code: 0 };
}

const fail = (stderr: string, code = 1): HdcResult => ({ stdout: '', stderr, code });

/** What the real `Hdc.shell` throws for a nonzero device exit. */
function shellFailure(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: 'HDC_SHELL_FAILED' });
}

/** Structural fake of `Hdc`; no device is ever contacted. */
function fakeHdc(
  handler: (cmd: string) => HdcResult | Promise<HdcResult>,
): { hdc: Hdc; calls: string[] } {
  const calls: string[] = [];
  const hdc = {
    async shell(_target: string, cmd: string): Promise<HdcResult> {
      calls.push(cmd);
      return handler(cmd);
    },
  } as unknown as Hdc;
  return { hdc, calls };
}

/** `now` values consumed in order; the last value repeats if called again. */
function clock(values: number[]): { now: () => number; reads: () => number } {
  let i = 0;
  return {
    now: () => values[Math.min(i++, values.length - 1)],
    reads: () => i,
  };
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return promise.then(
    () => {
      throw new Error('expected collect() to reject');
    },
    (e: { code?: string; message?: string }) => e,
  );
}

describe('ProcfsCollector identity', () => {
  it('provides mem.procfs', () => {
    const c = new ProcfsCollector();
    expect(c.id).toBe('procfs');
    expect(c.provides).toEqual(['mem.procfs']);
  });
});

describe('ProcfsCollector.collect', () => {
  it('samples at the requested interval, writes JSONL and returns the samples', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const sleeps: number[] = [];
    // Ordered log across both injected seams and the fake device, so clock
    // reads can be proven to precede the cat commands they time.
    const events: string[] = [];
    const { hdc } = fakeHdc((cmd) => {
      events.push(cmd);
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({
      now: () => {
        events.push('now');
        return fake.now();
      },
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
        sleeps.push(ms);
      },
    });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1000, intervalMs: 500 },
      layout,
    );

    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.ts)).toEqual([0, 500, 1000]);
    expect(samples.map((s) => s.pid)).toEqual([742, 742, 742]);
    expect(samples[0].status).toEqual(STATUS);
    expect(samples[0].smaps).toEqual(SMAPS);
    expect(sleeps).toEqual([500, 500]);
    // now() is read once per attempt, before that attempt's cat commands.
    expect(fake.reads()).toBe(3);
    expect(events).toEqual([
      'pidof com.demo',
      'now',
      'cat /proc/742/status', 'cat /proc/742/smaps_rollup',
      'sleep:500',
      'now',
      'cat /proc/742/status', 'cat /proc/742/smaps_rollup',
      'sleep:500',
      'now',
      'cat /proc/742/status', 'cat /proc/742/smaps_rollup',
    ]);
    expect(layout.procfsFile).toBe(join(dir, 'procfs.jsonl'));
    expect(readProcfsSamples(layout.procfsFile)).toEqual(samples);
  });

  it('defaults intervalMs to 1000', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 1000]);
    const sleeps: number[] = [];
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({
      now: fake.now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const samples = await c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout);

    expect(samples.map((s) => s.ts)).toEqual([0, 1000]);
    expect(sleeps).toEqual([1000]);
  });

  it('accepts the duration ceiling and the interval floor', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    // Jumping to the deadline ends the loop after the second attempt, so the
    // boundary values are exercised without a real 24-day wait.
    const fake = clock([0, 2_147_483_647]);
    const sleeps: number[] = [];
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({
      now: fake.now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 2_147_483_647, intervalMs: 100 },
      layout,
    );

    expect(samples.map((s) => s.ts)).toEqual([0, 2_147_483_647]);
    expect(sleeps).toEqual([100]);
  });

  it('rewrites a stale capture instead of appending to it', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const stale =
      '{"ts":999,"pid":1,"status":{"vmRssBytes":9,"vmHwmBytes":9,"threads":9}}\n';
    writeFileSync(layout.procfsFile, stale);
    const fake = clock([0]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1, intervalMs: 100 },
      layout,
    );

    expect(samples).toHaveLength(1);
    // Exactly the new JSONL: no stale line survives, and nothing was appended.
    expect(readFileSync(layout.procfsFile, 'utf8')).toBe(`${JSON.stringify(samples[0])}\n`);
    expect(readFileSync(layout.procfsFile, 'utf8')).not.toContain('"pid":1');
  });

  it('keeps sampling after a failed attempt and counts only successes', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    let statusCalls = 0;
    const { hdc, calls } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') {
        statusCalls += 1;
        return statusCalls === 1
          ? fail('cat: /proc/742/status: No such file or directory')
          : ok(STATUS_TEXT);
      }
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1000, intervalMs: 500 },
      layout,
    );

    expect(samples.map((s) => s.ts)).toEqual([500, 1000]);
    // The failed attempt does not read smaps_rollup at all.
    expect(calls.filter((cmd) => cmd.endsWith('/status'))).toHaveLength(3);
    expect(calls.filter((cmd) => cmd.endsWith('/smaps_rollup'))).toHaveLength(2);
  });

  it.each([
    ['the command exits nonzero', () => fail('cat: /proc/742/smaps_rollup: Permission denied')],
    ['the output is unparsable', () => ok('Size: 400 kB\n')],
  ])('still yields a sample when smaps_rollup fails because %s', async (_label, smaps) => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') return smaps();
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1000, intervalMs: 500 },
      layout,
    );

    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample.status).toEqual(STATUS);
      expect('smaps' in sample).toBe(false);
    }
    expect(readProcfsSamples(layout.procfsFile)).toEqual(samples);
  });

  it('throws PROCFS_NO_SAMPLES with the last device error and writes nothing', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      return fail('cat: /proc/742/status: No such file or directory');
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000, intervalMs: 500 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_SAMPLES');
    expect(err.message).toContain('No such file or directory');
    expect(err.message).toContain('exited 1');
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('removes a stale capture so a failing run leaves no file', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    writeFileSync(layout.procfsFile, 'stale capture from an earlier run');
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      return fail('cat: /proc/742/status: No such file or directory');
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000, intervalMs: 500 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_SAMPLES');
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('throws PROCFS_NO_SAMPLES when every status output is unparsable', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok('Name:\tcom.demo\n');
      return ok(SMAPS_TEXT);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000, intervalMs: 500 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_SAMPLES');
    expect(err.message).toMatch(/VmRSS/);
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('targets the first positive pid when pidof prints several', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0]);
    const { hdc, calls } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('\n743 742\n');
      if (cmd === 'cat /proc/743/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/743/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1, intervalMs: 100 },
      layout,
    );

    expect(samples.map((s) => s.pid)).toEqual([743]);
    expect(calls).toContain('cat /proc/743/status');
  });
});

describe('ProcfsCollector pid resolution failures', () => {
  it.each([
    ['empty output', ok('')],
    ['no positive integer', ok('0\n')],
    ['only text', ok('not running\n')],
    ['nonzero exit', fail('pidof: com.demo not found', 127)],
  ])('throws PROCFS_NO_PID on %s and includes the raw output', async (_label, pidof) => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const { hdc, calls } = fakeHdc(() => pidof);
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_PID');
    expect(err.message).toContain(`exit code ${pidof.code}`);
    expect(err.message).toContain(JSON.stringify(pidof.stdout));
    expect(err.message).toContain(JSON.stringify(pidof.stderr));
    // Only the pidof command ran.
    expect(calls).toEqual(['pidof com.demo']);
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('propagates a transport error from pidof', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const { hdc } = fakeHdc(() => {
      throw new Error('device disconnected');
    });
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    await expect(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout),
    ).rejects.toThrow('device disconnected');
  });

  it('removes an existing capture before pidof resolution fails', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    writeFileSync(layout.procfsFile, '{"stale":true}\n');
    const { hdc } = fakeHdc(() => ok(''));
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_PID');
    expect(existsSync(layout.procfsFile)).toBe(false);
  });
});

describe('ProcfsCollector with the Hdc.shell throw contract', () => {
  it('skips an attempt whose status call throws HDC_SHELL_FAILED', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    let statusCalls = 0;
    const { hdc, calls } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          throw shellFailure(
            'hdc shell failed: exit code 1 (cat: /proc/742/status: No such file or directory)',
          );
        }
        return ok(STATUS_TEXT);
      }
      if (cmd === 'cat /proc/742/smaps_rollup') return ok(SMAPS_TEXT);
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1000, intervalMs: 500 },
      layout,
    );

    expect(samples.map((s) => s.ts)).toEqual([500, 1000]);
    expect(calls.filter((cmd) => cmd.endsWith('/status'))).toHaveLength(3);
    expect(calls.filter((cmd) => cmd.endsWith('/smaps_rollup'))).toHaveLength(2);
  });

  it('yields the sample without smaps when smaps_rollup throws HDC_SHELL_FAILED', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      if (cmd === 'cat /proc/742/smaps_rollup') {
        throw shellFailure('hdc shell failed: exit code 1 (cat: Permission denied)');
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const samples = await c.collect(
      hdc,
      'dev',
      { app: 'com.demo', durationMs: 1000, intervalMs: 500 },
      layout,
    );

    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample.status).toEqual(STATUS);
      expect('smaps' in sample).toBe(false);
    }
    expect(readProcfsSamples(layout.procfsFile)).toEqual(samples);
  });

  it('converts a pidof HDC_SHELL_FAILED into PROCFS_NO_PID', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const { hdc, calls } = fakeHdc(() => {
      throw shellFailure('hdc shell failed: exit code 127 (pidof: com.demo: not found)');
    });
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_PID');
    expect(err.message).toContain('pidof com.demo');
    expect(err.message).toContain('exit code 127');
    expect(calls).toEqual(['pidof com.demo']);
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('propagates a non-HDC_SHELL_FAILED error from status unchanged', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const failure = new DeviceNotFoundError('emulator-5554');
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      throw failure;
    });
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    await expect(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000 }, layout),
    ).rejects.toBe(failure);
  });

  it('throws PROCFS_NO_SAMPLES when every status call throws HDC_SHELL_FAILED', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const fake = clock([0, 500, 1000]);
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      throw shellFailure('hdc shell failed: exit code 1 (cat: permission denied)');
    });
    const c = new ProcfsCollector({ now: fake.now, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000, intervalMs: 500 }, layout),
    );

    expect(err.code).toBe('PROCFS_NO_SAMPLES');
    expect(err.message).toContain('permission denied');
    expect(existsSync(layout.procfsFile)).toBe(false);
  });

  it('propagates a non-HDC_SHELL_FAILED error from smaps_rollup', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const failure = new OhosPerfError('spawn failed', { code: 'HDC_SPAWN_FAILED' });
    const { hdc } = fakeHdc((cmd) => {
      if (cmd === 'pidof com.demo') return ok('742\n');
      if (cmd === 'cat /proc/742/status') return ok(STATUS_TEXT);
      throw failure;
    });
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    await expect(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1 }, layout),
    ).rejects.toBe(failure);
    expect(existsSync(layout.procfsFile)).toBe(false);
  });
});

describe('ProcfsCollector validation', () => {
  it.each(['com.demo; rm -rf /', 'com demo', '', 'com/demo'])(
    'rejects app %j with PROCFS_BAD_APP before touching the device',
    async (app) => {
      const dir = makeDir();
      const layout = createSceneLayout(dir);
      const { hdc, calls } = fakeHdc(() => ok('742\n'));
      const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

      const err = await rejection(
        c.collect(hdc, 'dev', { app, durationMs: 1000 }, layout),
      );

      expect(err.code).toBe('PROCFS_BAD_APP');
      expect(calls).toEqual([]);
    },
  );

  it('does not touch an existing capture when validation fails', async () => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const original =
      '{"ts":0,"pid":1,"status":{"vmRssBytes":1,"vmHwmBytes":2,"threads":3}}\n';
    writeFileSync(layout.procfsFile, original);
    const { hdc, calls } = fakeHdc(() => ok('742\n'));
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo; rm -rf /', durationMs: 1000 }, layout),
    );

    expect(err.code).toBe('PROCFS_BAD_APP');
    expect(calls).toEqual([]);
    expect(readFileSync(layout.procfsFile, 'utf8')).toBe(original);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above the 32-bit setTimeout limit', 2_147_483_648],
  ])('rejects %s durationMs with PROCFS_BAD_DURATION', async (_label, durationMs) => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const { hdc, calls } = fakeHdc(() => ok('742\n'));
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs }, layout),
    );

    expect(err.code).toBe('PROCFS_BAD_DURATION');
    expect(err.message).toMatch(/durationMs/);
    expect(calls).toEqual([]);
  });

  it.each([
    ['below the floor', 99],
    ['zero', 0],
    ['negative', -100],
    ['fractional', 100.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s intervalMs with PROCFS_BAD_INTERVAL', async (_label, intervalMs) => {
    const dir = makeDir();
    const layout = createSceneLayout(dir);
    const { hdc, calls } = fakeHdc(() => ok('742\n'));
    const c = new ProcfsCollector({ now: () => 0, sleep: async () => {} });

    const err = await rejection(
      c.collect(hdc, 'dev', { app: 'com.demo', durationMs: 1000, intervalMs }, layout),
    );

    expect(err.code).toBe('PROCFS_BAD_INTERVAL');
    expect(err.message).toMatch(/intervalMs/);
    expect(calls).toEqual([]);
  });
});
