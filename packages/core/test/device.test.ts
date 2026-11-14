import { describe, it, expect } from 'vitest';
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
});

describe('CollectSession.ingest', () => {
  it('re-ingests into the same sceneRoot instead of reusing a stale trace.db', async () => {
    // 修正 1：ingestScene 在 trace.db 已存在时跳过转换。同一 sceneRoot 复用
    // 会让第二次 ingest 打开第一次的库。ingest() 必须先删掉 traceDb。
    const convertCalls: string[] = [];
    const fakeStreamer = {
      convert: async (input: string, output: string) => {
        convertCalls.push(output);
        // 写一个空库占位，模拟转换产物
        const { DatabaseSync } = await import('node:sqlite');
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
});
