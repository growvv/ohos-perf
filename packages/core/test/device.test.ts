import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device, connect } from '../src/device/device';
import { CapabilityMatrix } from '../src/device/capability';
import { DeviceNotFoundError } from '../src/errors';

const probe = {
  identity: {
    abi: 'x86_64', productName: 'emulator', softwareVersion: 'emulator 6.1.0.126',
    osFullName: 'OpenHarmony-6.1.1.125', deviceType: 'phone', isEmulator: true,
  },
  abi: 'x86_64',
  isEmulator: true,
  binaries: { hitrace: true, hiperf: true, hidumper: true, uitest: true, hiprofiler_cmd: false },
  hiperfHwEvents: [], hiperfSwEvents: ['sw-cpu-clock'],
  probes: {},
};

describe('Device', () => {
  it('exposes identity from probe snapshot', () => {
    const d = new Device('t1', probe as any, {} as any);
    expect(d.id).toBe('t1');
    expect(d.kind).toBe('emulator');
    expect(d.abi).toBe('x86_64');
  });

  it('derives capability matrix from snapshot', async () => {
    const d = new Device('t1', probe as any, {} as any);
    const caps = await d.capabilities();
    expect(caps).toBeInstanceOf(CapabilityMatrix);
    expect(caps.get('perf.pmu')!.available).toBe(false);
    expect(caps.get('trace.frames')!.available).toBe(true);
  });

  it('caches capability matrix across calls', async () => {
    const d = new Device('t1', probe as any, {} as any);
    const a = await d.capabilities();
    const b = await d.capabilities();
    expect(a).toBe(b);
  });

  it('rejects collect when frames capability missing', async () => {
    const noTrace = { ...probe, binaries: { ...probe.binaries, hitrace: false } };
    const d = new Device('t1', noTrace as any, {} as any);
    await expect(d.collect({ app: 'x', durationMs: 1, sceneRoot: '/tmp/x' }))
      .rejects.toThrow(/trace\.frames/);
  });

  it('connect fails with DeviceNotFoundError when no targets are connected', async () => {
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: '127.0.0.1:5555', connected: false, raw: '127.0.0.1:5555\tOffline' },
      ],
      listTargetsRaw: async () => ({
        targets: [{ id: '127.0.0.1:5555', connected: false, raw: '127.0.0.1:5555\tOffline' }],
        raw: '127.0.0.1:5555\t\tTCP\tOffline\tlocalhost\thdc',
      }),
      tconn: async () => {},
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    const err = await connect({
      hdc: fakeHdc as any, probe: async () => probe as any,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    // The raw listing is passed through verbatim, never reassembled.
    expect((err as DeviceNotFoundError).targetsOutput).toBe(
      '127.0.0.1:5555\t\tTCP\tOffline\tlocalhost\thdc',
    );
  });

  it('connect selects the requested target even when others are online', async () => {
    const connected: string[] = [];
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: 'real-1', connected: true, raw: 'real-1\tConnected' },
        { id: '127.0.0.1:10178', connected: true, raw: '127.0.0.1:10178\tConnected' },
      ],
      listTargetsRaw: async () => ({ targets: [], raw: '' }),
      tconn: async (t: string) => { connected.push(t); },
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    const d = await connect({
      target: '127.0.0.1:10178', hdc: fakeHdc as any, probe: async () => probe as any,
    });
    expect(d.id).toBe('127.0.0.1:10178');
    expect(connected).toContain('127.0.0.1:10178');
  });

  it('connect rejects an explicitly requested target that is not connected', async () => {
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: 'real-1', connected: true, raw: 'real-1\tConnected' },
        { id: 'gone-1', connected: false, raw: 'gone-1\tOffline' },
      ],
      listTargetsRaw: async () => ({ targets: [], raw: '' }),
      tconn: async () => {},
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    await expect(connect({
      target: 'gone-1', hdc: fakeHdc as any, probe: async () => probe as any,
    })).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('says a requested target was seen but is not connected', async () => {
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: 'real-1', connected: true, raw: 'real-1\tConnected' },
        { id: 'gone-1', connected: false, raw: 'gone-1\tOffline' },
      ],
      listTargetsRaw: async () => ({ targets: [], raw: 'gone-1\t\tUSB\tOffline\tlocalhost\thdc' }),
      tconn: async () => {},
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    const err = await connect({
      target: 'gone-1', hdc: fakeHdc as any, probe: async () => probe as any,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeviceNotFoundError);
    // The caller can tell "your target is offline" from "nothing is attached".
    expect((err as DeviceNotFoundError).code).toBe('TARGET_NOT_CONNECTED');
    expect((err as DeviceNotFoundError).message).toContain('gone-1');
    expect((err as DeviceNotFoundError).targetsOutput).toBe(
      'gone-1\t\tUSB\tOffline\tlocalhost\thdc',
    );
  });

  it('codes the no-targets case distinctly from a rejected requested target', async () => {
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: '127.0.0.1:5555', connected: false, raw: '127.0.0.1:5555\tOffline' },
      ],
      listTargetsRaw: async () => ({ targets: [], raw: '127.0.0.1:5555\t\tTCP\tOffline\tlocalhost\thdc' }),
      tconn: async () => {},
      shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    };
    const err = await connect({
      hdc: fakeHdc as any, probe: async () => probe as any,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect((err as DeviceNotFoundError).code).toBe('NO_CONNECTED_TARGETS');
  });
});

describe('CollectSession.ingest', () => {
  it('re-ingests into the same sceneRoot instead of reusing a stale trace.db', async () => {
    // 修正 1：ingestScene 在 trace.db 已存在时跳过转换。同一 sceneRoot 复用
    // 会让第二次 ingest 打开第一次的库。ingest() 必须先删掉 traceDb。
    const convertCalls: string[] = [];
    const fakeStreamer = {
      convert: async (input: string, output: string) => {
        convertCalls.push(output);
        // 写一个空库占位，模拟转换产物。真实的 Streamer.convert 先写临时文件
        // 再原子 rename 覆盖 output，所以这里也先清掉旧文件，保持同样的替换语义。
        const { DatabaseSync } = await import('node:sqlite');
        const { rmSync } = await import('node:fs');
        rmSync(output, { force: true });
        const db = new DatabaseSync(output);
        db.exec('CREATE TABLE frame_slice(id INT)');
        db.close();
      },
    };
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-dev-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'trace.htrace'), 'fake');

    const collector = {
      collect: async (_hdc: unknown, _t: string, _o: unknown, layout: any) => {
        writeFileSync(layout.traceFile, 'fake-2');
      },
    };
    const d = new Device('t1', probe as any, {
      hdc: {} as any, streamer: fakeStreamer as any, collector: collector as any,
    });

    const s1 = await d.collect({ app: 'x', durationMs: 1, sceneRoot: root });
    const scene1 = await s1.ingest();
    scene1.close();
    expect(existsSync(join(root, 'trace.db'))).toBe(true);

    const s2 = await d.collect({ app: 'x', durationMs: 1, sceneRoot: root });
    const scene2 = await s2.ingest();
    scene2.close();
    expect(convertCalls).toHaveLength(2);   // 第二次必须重新转换
  });

  it('keeps the previous scene when conversion fails', async () => {
    // 转换失败（版本不符、磁盘满、坏 trace）比采集失败更常见。删除旧库必须
    // 只在转换成功后才发生，否则一次失败的转换会让用户既没有旧库也没有新库。
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-device-fail-'));
    try {
      const traceDb = join(root, 'trace.db');
      const db = new DatabaseSync(traceDb);
      db.exec('CREATE TABLE frame_slice(id INT, ts INT)');
      db.exec('INSERT INTO frame_slice VALUES (0, 42)');
      db.close();

      const collector = {
        collect: async (_hdc: unknown, _t: string, _o: unknown, layout: any) => {
          writeFileSync(layout.traceFile, 'fresh capture');
        },
      };
      const streamer = {
        convert: async () => {
          throw new Error('conversion exploded');
        },
      };
      const d = new Device('t1', probe as any, {
        hdc: {} as any, streamer: streamer as any, collector: collector as any,
      });

      const session = await d.collect({ app: 'x', durationMs: 1, sceneRoot: root });
      await expect(session.ingest()).rejects.toThrow(/conversion exploded/);

      // The old database is still there and still queryable.
      expect(existsSync(traceDb)).toBe(true);
      const check = new DatabaseSync(traceDb, { readOnly: true });
      expect(check.prepare('SELECT ts FROM frame_slice').all()).toEqual([{ ts: 42 }]);
      check.close();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('replaces the previous scene only after a successful conversion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-device-replace-'));
    try {
      const traceDb = join(root, 'trace.db');
      const old = new DatabaseSync(traceDb);
      old.exec('CREATE TABLE frame_slice(id INT, ts INT)');
      old.exec('INSERT INTO frame_slice VALUES (0, 7)');
      old.close();

      const collector = {
        collect: async (_hdc: unknown, _t: string, _o: unknown, layout: any) => {
          writeFileSync(layout.traceFile, 'fresh capture');
        },
      };
      const streamer = {
        convert: async (_input: string, output: string) => {
          // Real Streamer.convert replaces the output atomically; drop the old
          // file first so the fixture has the same semantics.
          rmSync(output, { force: true });
          const db = new DatabaseSync(output);
          db.exec('CREATE TABLE frame_slice(id INT, ts INT)');
          db.exec('INSERT INTO frame_slice VALUES (0, 99)');
          db.close();
        },
      };
      const d = new Device('t1', probe as any, {
        hdc: {} as any, streamer: streamer as any, collector: collector as any,
      });

      const scene = await d.collect({ app: 'x', durationMs: 1, sceneRoot: root }).then((s) => s.ingest());
      expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 99 }]);
      scene.close();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
