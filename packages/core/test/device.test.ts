import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device, connect } from '../src/device/device';
import { CapabilityMatrix } from '../src/device/capability';
import { DeviceNotFoundError } from '../src/errors';
import type { SceneLayout } from '../src/ingest/scene';

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
      // scene.json describes the previous capture; a failed conversion must
      // not overwrite it with the new capture's metadata (fix round 1, item 3).
      writeFileSync(join(root, 'scene.json'), JSON.stringify({
        version: 1, app: { packageName: 'old.app', processNames: ['old.app'] },
        pids: [7], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));

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
      // And scene.json still describes that old scene, not the failed capture.
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.app.packageName).toBe('old.app');
      expect(meta.capture.collectors).toEqual(['hitrace']);
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

/**
 * A harness that records every device shell command and the options each
 * collector receives. `bothStarted` is a barrier: both fakes await it, and it
 * resolves only once both have been entered. A sequential implementation would
 * await the first collector forever and hit the test timeout; `Promise.all`
 * starts both in the same tick, so the barrier releases.
 */
function collectHarness(opts: { failHitrace?: boolean; concurrent?: boolean } = {}) {
  const commands: string[] = [];
  const received: Array<{ durationMs: number }> = [];
  let release = (): void => {};
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });

  const hdc = {
    shell: async (_target: string, cmd: string) => {
      commands.push(cmd);
      if (cmd === 'cat /proc/uptime') return { stdout: '1234.56 9999.00\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };

  const enter = async (o: { durationMs: number }): Promise<void> => {
    received.push(o);
    if (opts.concurrent) {
      if (received.length === 2) release();
      await bothStarted;
    }
  };

  const hitrace = {
    collect: async (_h: unknown, _t: string, o: { durationMs: number }, layout: SceneLayout) => {
      await enter(o);
      if (opts.failHitrace) throw new Error('hitrace exploded');
      writeFileSync(layout.traceFile, 'fresh capture');
    },
  };
  const procfs = {
    collect: async (_h: unknown, _t: string, o: { durationMs: number }, layout: SceneLayout) => {
      await enter(o);
      writeFileSync(layout.procfsFile, '');
      return [{ ts: 1, pid: 42, status: { vmRssBytes: 1, vmHwmBytes: 1, threads: 1 } }];
    },
  };
  const streamer = {
    convert: async (_input: string, output: string) => {
      const db = new DatabaseSync(output);
      db.exec('CREATE TABLE frame_slice(id INT, ts INT)');
      db.close();
    },
  };
  return { commands, received, hdc, hitrace, procfs, streamer };
}

/** Build a Device whose dependencies are entirely fake. */
function fakeDevice(h: ReturnType<typeof collectHarness>): Device {
  return new Device('t1', probe as any, {
    hdc: h.hdc as any,
    streamer: h.streamer as any,
    collector: h.hitrace as any,
    procfs: h.procfs as any,
  });
}

describe('CollectSession.ingest with procfs and cold start', () => {
  it('rejects procfs without an app before any device call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-noapp-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const session = await d.collect({ app: '', durationMs: 1000, sceneRoot: root, procfs: true });
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_APP_REQUIRED' });
      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runs both collectors concurrently with the same duration and writes scene.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-'));
    try {
      // `concurrent` arms the barrier: both collectors must have entered
      // before either is allowed to finish (see collectHarness).
      const h = collectHarness({ concurrent: true });
      const d = fakeDevice(h);
      const scene = await d.collect({
        app: 'com.demo', durationMs: 10_000, sceneRoot: root, procfs: true,
      }).then((s) => s.ingest());
      scene.close();

      expect(h.received).toHaveLength(2);
      expect(h.received.every((o) => o.durationMs === 10_000)).toBe(true);
      expect(h.commands).toContain('cat /proc/uptime');
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta).toMatchObject({
        version: 1,
        app: { packageName: 'com.demo', processNames: ['com.demo'] },
        pids: [42],
        deviceId: 't1',
        startedAtNs: 1_234_560_000_000,
        capture: {
          durationMs: 10_000,
          collectors: ['hitrace', 'procfs'],
        },
      });
      expect(typeof meta.capture.startedAtMs).toBe('number');
      expect(Number.isFinite(meta.capture.startedAtMs)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('launches the ability on a cold start with validated bare names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-cold-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const scene = await d.collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root,
        coldStart: { ability: 'EntryAbility' },
      }).then((s) => s.ingest());
      scene.close();
      expect(h.commands).toContain('aa start -a EntryAbility -b com.demo');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects an unsafe cold-start ability before any device call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-bad-ability-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const session = await d.collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root,
        coldStart: { ability: 'Entry;rm -rf /' },
      });
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_BAD_COLD_START' });
      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('omits startedAtNs rather than failing when /proc/uptime is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-uptime-'));
    try {
      const h = collectHarness();
      h.hdc.shell = async (_t, cmd) => {
        h.commands.push(cmd);
        if (cmd === 'cat /proc/uptime') return { stdout: '', stderr: 'no such file', code: 1 };
        return { stdout: '', stderr: '', code: 0 };
      };
      const d = fakeDevice(h);
      const scene = await d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root })
        .then((s) => s.ingest());
      scene.close();
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.startedAtNs).toBeUndefined();
      expect(meta.capture.collectors).toEqual(['hitrace']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects when hitrace fails instead of presenting a partial scene', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-fail-'));
    try {
      const h = collectHarness({ failHitrace: true });
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/hitrace exploded/);
      expect(existsSync(join(root, 'scene.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('restores the previous procfs.jsonl when hitrace fails but procfs succeeded', async () => {
    // A hitrace failure rejects the pair after the procfs collector has already
    // written this attempt's samples. The old scene must stay coherent: new
    // memory data beside an old trace.db would be reported as exact.
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-hitrace-fail-procfs-'));
    try {
      const oldSamples = 'old samples\n';
      writeFileSync(join(root, 'procfs.jsonl'), oldSamples);

      const h = collectHarness({ failHitrace: true });
      h.procfs.collect = async (_h, _t, _o, layout) => {
        writeFileSync(layout.procfsFile, 'new samples\n');
        return [{ ts: 9, pid: 42, status: { vmRssBytes: 1, vmHwmBytes: 1, threads: 1 } }];
      };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/hitrace exploded/);

      expect(readFileSync(join(root, 'procfs.jsonl'), 'utf8')).toBe(oldSamples);
      expect(existsSync(join(root, 'scene.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('removes a new procfs.jsonl when hitrace fails and the old scene had none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-hitrace-fail-procfs2-'));
    try {
      const h = collectHarness({ failHitrace: true });
      h.procfs.collect = async (_h, _t, _o, layout) => {
        writeFileSync(layout.procfsFile, 'new samples\n');
        return [{ ts: 9, pid: 42, status: { vmRssBytes: 1, vmHwmBytes: 1, threads: 1 } }];
      };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/hitrace exploded/);
      expect(existsSync(join(root, 'procfs.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('forwards a custom procfs intervalMs and records no pids without procfs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-interval-'));
    try {
      const h = collectHarness();
      let gotInterval: number | undefined;
      h.procfs.collect = async (_h, _t, o: any, layout) => {
        gotInterval = o.intervalMs;
        h.received.push(o);
        writeFileSync(layout.procfsFile, '');
        return [];
      };
      const d = fakeDevice(h);
      const scene = await d.collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root,
        procfs: { intervalMs: 250 },
      }).then((s) => s.ingest());
      scene.close();
      expect(gotInterval).toBe(250);
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.pids).toEqual([]);
      expect(meta.capture.collectors).toEqual(['hitrace', 'procfs']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('omits startedAtNs for a non-finite or negative uptime token', async () => {
    for (const stdout of ['NaN 0\n', '-1 0\n', 'garbage\n', '']) {
      const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-uptime-bad-'));
      try {
        const h = collectHarness();
        h.hdc.shell = async (_t, cmd) => {
          h.commands.push(cmd);
          if (cmd === 'cat /proc/uptime') return { stdout, stderr: '', code: 0 };
          return { stdout: '', stderr: '', code: 0 };
        };
        const d = fakeDevice(h);
        const scene = await d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root })
          .then((s) => s.ingest());
        scene.close();
        const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
        expect(meta.startedAtNs, `stdout ${JSON.stringify(stdout)}`).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  });

  it('rejects a cold start whose app name is not a bare name (COLLECT_BAD_APP)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-bad-app-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const session = await d.collect({
        app: 'com.demo; rm -rf /', durationMs: 1000, sceneRoot: root,
        coldStart: { ability: 'EntryAbility' },
      });
      // The app is validated before the ability, so the app code wins.
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_BAD_APP' });
      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 1, item 2: the app name is interpolated into `pidof`, `aa start`
  // and hitrace, so it must be validated before the very first device call.
  it('rejects an unsafe app for --procfs with COLLECT_BAD_APP before any device call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-bad-procfs-app-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const session = await d.collect({
        app: 'bad;name', durationMs: 1000, sceneRoot: root, procfs: true,
      });
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_BAD_APP' });
      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('names the offending app in the COLLECT_BAD_APP message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-bad-procfs-app2-'));
    try {
      const h = collectHarness();
      const d = fakeDevice(h);
      const session = await d.collect({
        app: 'bad;name', durationMs: 1000, sceneRoot: root, procfs: true,
      });
      const err = (await session.ingest().catch((e: unknown) => e)) as Error;
      expect(err).toMatchObject({ code: 'COLLECT_BAD_APP' });
      expect(err.message).toContain('bad;name');
      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 1, item 1: a re-capture without --procfs must not leave the
  // previous capture's procfs.jsonl in the scene directory.
  it('unlinks a stale procfs.jsonl when this capture did not request procfs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-stale-'));
    try {
      writeFileSync(join(root, 'procfs.jsonl'), '{"ts":1,"pid":9,"status":{}}\n');
      const h = collectHarness();
      const d = fakeDevice(h);
      const scene = await d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root })
        .then((s) => s.ingest());
      scene.close();
      expect(existsSync(join(root, 'procfs.jsonl'))).toBe(false);
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.capture.collectors).toEqual(['hitrace']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 1, item 6: Promise.all must reject with the procfs failure even
  // when hitrace resolves; an allSettled regression would hide it.
  it('rejects when procfs fails while hitrace resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-procfs-fail-'));
    try {
      const h = collectHarness();
      h.procfs.collect = async () => { throw new Error('procfs exploded'); };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'com.demo', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/procfs exploded/);
      expect(existsSync(join(root, 'scene.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 1, item 3: metadata is written only after a successful
  // conversion, so a failure leaves scene.json describing the previous capture.
  it('keeps the previous scene.json when conversion fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-conv-fail-'));
    try {
      writeFileSync(join(root, 'scene.json'), JSON.stringify({
        version: 1, app: { packageName: 'old.app', processNames: ['old.app'] },
        pids: [7], deviceId: 't1', capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace', 'procfs'] },
      }));
      writeFileSync(join(root, 'procfs.jsonl'), 'old samples\n');
      const h = collectHarness();
      h.streamer.convert = async () => { throw new Error('conversion exploded'); };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'new.app', durationMs: 1000, sceneRoot: root })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/conversion exploded/);
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.app.packageName).toBe('old.app');
      expect(meta.capture.collectors).toEqual(['hitrace', 'procfs']);
      // Every scene artifact is untouched on the failure path, including a
      // stale procfs.jsonl from the previous capture.
      expect(readFileSync(join(root, 'procfs.jsonl'), 'utf8')).toBe('old samples\n');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  // Fix round 2, item 2: a failed conversion after a --procfs capture must not
  // leave this attempt's new procfs.jsonl beside the old scene. We preserve a
  // pre-existing file byte-for-byte (restoring it), and remove the file when
  // the previous scene had none.
  it('restores the previous procfs.jsonl when a --procfs conversion fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-procfs-conv-fail-'));
    try {
      const traceDb = join(root, 'trace.db');
      const db = new DatabaseSync(traceDb);
      db.exec('CREATE TABLE frame_slice(id INT, ts INT)');
      db.exec('INSERT INTO frame_slice VALUES (0, 42)');
      db.close();
      writeFileSync(join(root, 'scene.json'), JSON.stringify({
        version: 1, app: { packageName: 'old.app', processNames: ['old.app'] },
        pids: [7], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace', 'procfs'] },
      }));
      const oldSamples = 'old samples\n';
      writeFileSync(join(root, 'procfs.jsonl'), oldSamples);

      const h = collectHarness();
      // The procfs collector writes this attempt's samples.
      h.procfs.collect = async (_h, _t, _o, layout) => {
        writeFileSync(layout.procfsFile, 'new samples\n');
        return [{ ts: 9, pid: 42, status: { vmRssBytes: 1, vmHwmBytes: 1, threads: 1 } }];
      };
      h.streamer.convert = async () => { throw new Error('conversion exploded'); };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'new.app', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/conversion exploded/);

      // trace.db and scene.json still describe the previous capture...
      const check = new DatabaseSync(traceDb, { readOnly: true });
      expect(check.prepare('SELECT ts FROM frame_slice').all()).toEqual([{ ts: 42 }]);
      check.close();
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.app.packageName).toBe('old.app');
      // ...and the previous procfs.jsonl is byte-identical, not this attempt's.
      expect(readFileSync(join(root, 'procfs.jsonl'), 'utf8')).toBe(oldSamples);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('removes a new procfs.jsonl when a --procfs conversion fails and the old scene had none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-procfs-conv-fail2-'));
    try {
      writeFileSync(join(root, 'scene.json'), JSON.stringify({
        version: 1, app: { packageName: 'old.app', processNames: ['old.app'] },
        pids: [], deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));
      const h = collectHarness();
      h.procfs.collect = async (_h, _t, _o, layout) => {
        writeFileSync(layout.procfsFile, 'new samples\n');
        return [{ ts: 9, pid: 42, status: { vmRssBytes: 1, vmHwmBytes: 1, threads: 1 } }];
      };
      h.streamer.convert = async () => { throw new Error('conversion exploded'); };
      const d = fakeDevice(h);
      await expect(
        d.collect({ app: 'new.app', durationMs: 1000, sceneRoot: root, procfs: true })
          .then((s) => s.ingest()),
      ).rejects.toThrow(/conversion exploded/);
      expect(existsSync(join(root, 'procfs.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

/**
 * A harness for the hiprofiler path: the trace collector is a fake that only
 * records its options, and the hdc shell answers the two commands the device
 * issues before collection (`cat /proc/uptime`, `pidof <app>`).
 */
function hiprofilerHarness(opts: { pidof?: string; fail?: boolean } = {}) {
  const commands: string[] = [];
  const calls: Array<{
    opts: {
      durationMs: number;
      plugins: readonly { pluginName: string; configData: string }[];
      bufferPages?: number;
    };
  }> = [];
  const hdc = {
    shell: async (_target: string, cmd: string) => {
      commands.push(cmd);
      if (cmd === 'cat /proc/uptime') {
        return { stdout: '1234.56 9999.00\n', stderr: '', code: 0 };
      }
      if (cmd.startsWith('pidof ')) {
        return { stdout: (opts.pidof ?? '') + '\n', stderr: '', code: opts.pidof ? 0 : 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  };

  const hitraceCalls: string[] = [];
  const hitrace = {
    collect: async (_h: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
      hitraceCalls.push('hitrace');
      writeFileSync(layout.traceFile, 'hitrace capture');
    },
  };
  const hiprofiler = {
    collect: async (
      _h: unknown,
      _t: string,
      o: {
        durationMs: number;
        plugins: readonly { pluginName: string; configData: string }[];
        bufferPages?: number;
      },
      layout: SceneLayout,
    ) => {
      calls.push({ opts: o });
      if (opts.fail) throw new Error('hiprofiler exploded');
      writeFileSync(layout.traceFile, 'hiprofiler capture');
    },
  };
  const streamer = {
    convert: async (_input: string, output: string) => {
      const db = new DatabaseSync(output);
      db.exec('CREATE TABLE frame_slice(id INT, ts INT)');
      db.close();
    },
  };
  const device = (): Device => new Device('t1', probe as any, {
    hdc: hdc as any,
    streamer: streamer as any,
    collector: hitrace as any,
    hiprofiler: hiprofiler as any,
  });
  return { commands, calls, hitraceCalls, device };
}

describe('CollectSession.ingest through hiprofiler', () => {
  it('routes the trace capture to hiprofiler and records the collector', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-route-'));
    try {
      const h = hiprofilerHarness();
      const session = await h.device().collect({
        app: 'com.example',
        durationMs: 1500,
        sceneRoot: root,
        hiprofiler: { plugins: ['gpu', 'xpower'] },
      });
      const scene = await session.ingest();
      scene.close();

      expect(h.hitraceCalls).toHaveLength(0);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].opts.durationMs).toBe(1500);
      expect(h.calls[0].opts.plugins.map((p) => p.pluginName))
        .toEqual(['gpu-plugin', 'xpower-plugin']);

      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.capture.collectors).toEqual(['hiprofiler']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('defaults to the ftrace plugin when no plugin list is given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-default-'));
    try {
      const h = hiprofilerHarness();
      const session = await h.device().collect({
        app: 'com.example', durationMs: 1000, sceneRoot: root, hiprofiler: {},
      });
      (await session.ingest()).close();
      expect(h.calls[0].opts.plugins.map((p) => p.pluginName)).toEqual(['ftrace-plugin']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('resolves nativehook pids through pidof and records them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-pids-'));
    try {
      const h = hiprofilerHarness({ pidof: '4242 4243' });
      const session = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { plugins: ['nativehook'] },
      });
      (await session.ingest()).close();

      expect(h.commands).toContain('pidof com.example');
      expect(h.calls[0].opts.plugins[0].pluginName).toBe('nativehook');
      expect(h.calls[0].opts.plugins[0].configData).toContain('expand_pids: 4242');
      expect(h.calls[0].opts.plugins[0].configData).toContain('expand_pids: 4243');

      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.pids).toEqual([4242, 4243]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects nativehook when the app has no running process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-nopid-'));
    try {
      const h = hiprofilerHarness({ pidof: '' });
      const session = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { plugins: ['nativehook'] },
      });
      await expect(session.ingest()).rejects.toMatchObject({
        code: 'COLLECT_NATIVEHOOK_NO_PID',
      });
      expect(h.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects an unknown plugin and a bad buffer before any device call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-badopts-'));
    try {
      const h = hiprofilerHarness();
      const unknown = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { plugins: ['nope' as never] },
      });
      await expect(unknown.ingest()).rejects.toMatchObject({ code: 'COLLECT_BAD_PLUGIN' });

      const badBuffer = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { bufferPages: 4096 },
      });
      await expect(badBuffer.ingest()).rejects.toMatchObject({
        code: 'HIPROFILER_BAD_BUFFER',
      });

      const noPlugins = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { plugins: [] },
      });
      await expect(noPlugins.ingest()).rejects.toMatchObject({
        code: 'COLLECT_BAD_PLUGIN',
      });

      expect(h.commands).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('leaves the previous scene coherent when the hiprofiler capture fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hipro-fail-'));
    try {
      writeFileSync(join(root, 'trace.db'), 'old database');
      writeFileSync(join(root, 'scene.json'), JSON.stringify({
        version: 1,
        app: { packageName: 'old.app', processNames: ['old.app'] },
        pids: [],
        deviceId: 't1',
        capture: { startedAtMs: 1, durationMs: 2, collectors: ['hitrace'] },
      }));

      const h = hiprofilerHarness({ fail: true });
      const session = await h.device().collect({
        app: 'com.example',
        durationMs: 1000,
        sceneRoot: root,
        hiprofiler: { plugins: ['ftrace'] },
      });
      await expect(session.ingest()).rejects.toThrow(/hiprofiler exploded/);

      expect(readFileSync(join(root, 'trace.db'), 'utf8')).toBe('old database');
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.app.packageName).toBe('old.app');
      expect(meta.capture.collectors).toEqual(['hitrace']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

/**
 * A device whose trace collector writes a trace file, plus fake hiperf,
 * hidumper and uitest collectors. Each fake records that it ran and writes the
 * artifact its real counterpart would, so the restore path can be exercised
 * with real files.
 */
function extraCollectors(opts: {
  failHiperf?: boolean;
  failHidumper?: boolean;
  failUitest?: boolean;
} = {}) {
  const started: string[] = [];
  const hdc = {
    shell: async (_target: string, cmd: string) => {
      if (cmd === 'cat /proc/uptime') {
        return { stdout: '1234.56 9999.00\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  const hitrace = {
    collect: async (_h: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
      started.push('hitrace');
      writeFileSync(layout.traceFile, 'trace');
    },
  };
  const streamer = {
    convert: async (input: string, output: string) => {
      // Only the trace converts here; perf conversion is asserted separately.
      if (input.endsWith('trace.htrace')) {
        rmSync(output, { force: true });
        const db = new DatabaseSync(output);
        db.exec('CREATE TABLE frame_slice(id INT)');
        db.close();
        return;
      }
      rmSync(output, { force: true });
      const db = new DatabaseSync(output);
      db.exec('CREATE TABLE perf_sample(id INT, thread_id INT)');
      db.exec('INSERT INTO perf_sample VALUES (0, 1)');
      db.close();
    },
  };
  const hiperf = {
    collect: async (_h: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
      started.push('hiperf');
      if (opts.failHiperf === true) throw new Error('hiperf exploded');
      writeFileSync(layout.perfFile!, 'perf bytes');
      return { samples: 150, nonSamples: 1, lost: 0, bytes: 9 };
    },
  };
  const hidumper = {
    collect: async (_h: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
      started.push('hidumper');
      if (opts.failHidumper === true) throw new Error('hidumper exploded');
      const capture = {
        version: 1, intervalMs: 1000,
        samples: [
          { ts: 1, fpsCounts: [{ refreshRate: 60, count: 1 }], hitches: [] },
          { ts: 2, fpsCounts: [{ refreshRate: 60, count: 2 }], hitches: [] },
        ],
      };
      writeFileSync(layout.hidumperFile, JSON.stringify(capture));
      return capture;
    },
  };
  const uitest = {
    collect: async (_h: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
      started.push('uitest');
      if (opts.failUitest === true) throw new Error('uitest exploded');
      writeFileSync(layout.uiFile,
        JSON.stringify({ attributes: { type: 'Root' }, children: [] }));
      return [{ depth: 0, type: 'Root' }];
    },
  };
  return {
    started,
    // The pieces a test needs when it substitutes one collector and keeps the
    // rest, e.g. a zero-sample hiperf fake over the same trace capture.
    hdcLike: hdc,
    streamerLike: streamer,
    hitraceLike: hitrace,
    device: () => new Device('t1', probe as any, {
      hdc: hdc as any, streamer: streamer as any, collector: hitrace as any,
      hiperf: hiperf as any, hidumper: hidumper as any, uitest: uitest as any,
    }),
  };
}

describe('CollectSession.ingest with hiperf, hidumper and uitest', () => {
  it('runs every requested collector and records what each captured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-extra-'));
    try {
      const h = extraCollectors();
      const scene = await h.device().collect({
        app: 'com.demo', durationMs: 3000, sceneRoot: root,
        hiperf: {}, hidumper: true, uitest: true,
      }).then((s) => s.ingest());
      scene.close();

      expect(h.started.sort()).toEqual(['hidumper', 'hiperf', 'hitrace', 'uitest']);
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.capture.collectors).toEqual(['hitrace', 'hiperf', 'hidumper', 'uitest']);
      expect(meta.capture.hiperf).toEqual({ samples: 150 });
      expect(existsSync(join(root, 'perf.db'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('records a zero-sample hiperf capture instead of dropping it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-zero-'));
    try {
      const h = extraCollectors();
      // An idle app: the collector still succeeds and reports 0 samples.
      const device = new Device('t1', probe as any, {
        hdc: h.hdcLike as any,
        streamer: h.streamerLike as any,
        collector: h.hitraceLike as any,
        hiperf: { collect: async (_h2: unknown, _t: string, _o: unknown, layout: SceneLayout) => {
          writeFileSync(layout.perfFile!, 'perf');
          return { samples: 0, nonSamples: 4107, lost: 0, bytes: 5 };
        } } as any,
      });
      const scene = await device.collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root, hiperf: {},
      }).then((s) => s.ingest());
      scene.close();
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.capture.hiperf).toEqual({ samples: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects a hiperf request without an app before any device call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-noapp-'));
    try {
      const h = extraCollectors();
      const session = await h.device().collect({
        app: '', durationMs: 1000, sceneRoot: root, hiperf: {},
      });
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_APP_REQUIRED' });
      expect(h.started).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects uitest on a device whose probe found no uitest binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-noui-'));
    try {
      const noUitest = { ...probe, binaries: { ...probe.binaries, uitest: false } };
      const device = new Device('t1', noUitest as any, {
        hdc: { shell: async () => ({ stdout: '', stderr: '', code: 0 }) } as any,
        streamer: {} as any,
        collector: { collect: async () => {} } as any,
      });
      // The capability gate runs in collect(), before any session exists, so a
      // device that cannot dump a UI tree never starts a capture.
      await expect(device.collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root, uitest: true,
      })).rejects.toMatchObject({ code: 'MISSING_CAPABILITY' });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('restores every previous artifact when a collector fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-restore-'));
    try {
      // A complete previous scene: all five artifacts exist with known bytes.
      const before: Record<string, string> = {
        'perf.data': 'old perf',
        'perf.db': 'old perf db',
        'hidumper.json': 'old hidumper',
        'ui.json': 'old ui',
        'procfs.jsonl': 'old procfs',
      };
      for (const [name, content] of Object.entries(before)) {
        writeFileSync(join(root, name), content);
      }

      const h = extraCollectors({ failHiperf: true });
      const session = await h.device().collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root,
        procfs: true, hiperf: {}, hidumper: true, uitest: true,
      });
      await expect(session.ingest()).rejects.toThrow(/hiperf exploded/);

      for (const [name, content] of Object.entries(before)) {
        expect(readFileSync(join(root, name), 'utf8'), name).toBe(content);
      }
      // No new metadata: the directory still describes the old scene.
      expect(existsSync(join(root, 'scene.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('removes stale artifacts for collectors that did not run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-collect-stale-'));
    try {
      // A previous capture had all four; this one asks for none of them.
      for (const name of ['perf.data', 'perf.db', 'hidumper.json', 'ui.json']) {
        writeFileSync(join(root, name), 'stale');
      }
      const h = extraCollectors();
      const scene = await h.device().collect({
        app: 'com.demo', durationMs: 1000, sceneRoot: root,
      }).then((s) => s.ingest());
      scene.close();

      for (const name of ['perf.data', 'perf.db', 'hidumper.json', 'ui.json']) {
        expect(existsSync(join(root, name)), name).toBe(false);
      }
      const meta = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8'));
      expect(meta.capture.collectors).toEqual(['hitrace']);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
