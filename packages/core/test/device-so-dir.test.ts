import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Device } from '../src/device/device';
import { readSceneMetadata } from '../src/ingest/metadata';
import { createSceneLayout } from '../src/ingest/scene';

/*
 * `--so-dir`: the host directory a hiperf capture's symbols are resolved from.
 *
 * The flag only means something with `hiperf`, and the directory must exist
 * before the device is touched — a capture that runs for ten seconds and then
 * fails to symbolize is worse than one that refuses immediately.
 */

const probe = {
  identity: {
    abi: 'arm64-v8a', productName: 'phone', softwareVersion: '6.0.0.1',
    osFullName: 'OpenHarmony-6.0.0.1', deviceType: 'phone', isEmulator: false,
  },
  abi: 'arm64-v8a',
  isEmulator: false,
  binaries: {
    hitrace: true, hiperf: true, hidumper: true, uitest: true,
    hiprofiler_cmd: false, hilog: true,
  },
  hiperfHwEvents: [], hiperfSwEvents: ['sw-cpu-clock'],
  probes: {},
};

interface Harness {
  device: Device;
  /** Every `convert(input, output, soDir)` call, in order. */
  converts: Array<[string, string, string | undefined]>;
  /** Whether any collector or hdc call happened. */
  touched: () => boolean;
}

/**
 * A Device whose collectors and streamer are fakes.
 *
 * The streamer writes a minimal `trace.db`/`perf.db` so `ingestScene` can open
 * the result; the collectors write an empty input file and nothing else.
 */
function harness(root: string): Harness {
  const converts: Array<[string, string, string | undefined]> = [];
  let touched = false;

  const writeDb = (path: string, ddl: string): void => {
    const db = new DatabaseSync(path);
    db.exec(ddl);
    db.close();
  };

  const streamer = {
    convert: async (input: string, output: string, soDir?: string) => {
      converts.push([input, output, soDir]);
      if (output.endsWith('trace.db')) writeDb(output, 'CREATE TABLE frame_slice(id INT)');
      else {
        writeDb(output, `CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
          thread_name TEXT)`);
      }
    },
  };
  const collector = {
    collect: async (_hdc: unknown, _t: string, _o: unknown, layout: { traceFile: string }) => {
      touched = true;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(layout.traceFile, 'fake');
    },
  };
  const hiperf = {
    collect: async (_hdc: unknown, _t: string, _o: unknown, layout: { perfFile: string }) => {
      touched = true;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(layout.perfFile, 'fake');
      return { samples: 3 };
    },
  };

  const device = new Device('t1', probe as unknown as never, {
    hdc: {} as never,
    streamer: streamer as never,
    collector: collector as never,
    hiperf: hiperf as never,
  });
  return { device, converts, touched: () => touched };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ohosperf-so-dir-'));
}

describe('Device.collect — soDir', () => {
  it('passes the symbol directory to the perf conversion only', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, hiperf: {}, soDir: dir,
      });
      (await session.ingest()).close();

      // Two conversions: the trace without a symbol directory, the perf one with.
      expect(h.converts.map(([, , so]) => so)).toEqual([undefined, dir]);
      expect(h.converts[1][0]).toContain('perf');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('passes undefined when no symbol directory was requested', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, hiperf: {},
      });
      (await session.ingest()).close();

      expect(h.converts.map(([, , so]) => so)).toEqual([undefined, undefined]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('records symbolized: true in scene.json when a symbol directory was used', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, hiperf: {}, soDir: dir,
      });
      (await session.ingest()).close();

      const meta = readSceneMetadata(createSceneLayout(dir));
      expect(meta?.capture?.hiperf).toEqual({ samples: 3, symbolized: true });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('omits symbolized when no symbol directory was requested', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, hiperf: {},
      });
      (await session.ingest()).close();

      const meta = readSceneMetadata(createSceneLayout(dir));
      expect(meta?.capture?.hiperf).toEqual({ samples: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('refuses a symbol directory without hiperf before any collector runs', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      // Every collect check lives in `ingest()`, alongside the app, plugin and
      // buffer checks: `collect()` only builds the session.
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, soDir: dir,
      });
      await expect(session.ingest())
        .rejects.toMatchObject({ code: 'COLLECT_SO_DIR_WITHOUT_HIPERF' });
      expect(h.touched()).toBe(false);
      expect(h.converts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('refuses a symbol directory that does not exist before any device call', async () => {
    const dir = root();
    try {
      const h = harness(dir);
      const session = await h.device.collect({
        app: 'com.demo', durationMs: 1, sceneRoot: dir, hiperf: {},
        soDir: join(dir, 'does-not-exist'),
      });
      await expect(session.ingest()).rejects.toMatchObject({ code: 'COLLECT_BAD_SO_DIR' });
      expect(h.touched()).toBe(false);
      expect(h.converts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
