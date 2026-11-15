import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_CONFIG_PATH,
  DEVICE_OUTPUT_PATH,
  HiprofilerCollector,
  hiprofilerCommand,
  secondsFor,
} from '../src/collectors/hiprofiler';
import { gpuPlugin } from '../src/collectors/hiprofiler/templates';
import { OhosPerfError } from '../src/errors';

type Reply = { stdout: string; stderr: string; code: number };
const OK: Reply = { stdout: '', stderr: '', code: 0 };

class FakeHdc {
  calls: Array<{ kind: string; args: unknown[] }> = [];
  sent: Array<{ local: string; device: string; text: string }> = [];
  constructor(
    private readonly responses: Record<string, Reply> = {},
    private readonly throwOnShell: string[] = [],
  ) {}

  async shell(_t: string, cmd: string): Promise<Reply> {
    this.calls.push({ kind: 'shell', args: [cmd] });
    for (const needle of this.throwOnShell) {
      if (cmd.includes(needle)) throw new Error(`hdc shell failed: ${cmd}`);
    }
    for (const [needle, reply] of Object.entries(this.responses)) {
      if (cmd.includes(needle)) return reply;
    }
    return OK;
  }

  async send(_t: string, local: string, device: string): Promise<void> {
    this.calls.push({ kind: 'send', args: [local, device] });
    this.sent.push({ local, device, text: readFileSync(local, 'utf8') });
  }

  async recv(_t: string, device: string, local: string): Promise<void> {
    this.calls.push({ kind: 'recv', args: [device, local] });
    // A real transfer creates the destination file.
    writeFileSync(local, 'trace bytes');
  }
}

function fakeLayout() {
  const root = mkdtempSync(join(tmpdir(), 'ohos-perf-hipro-'));
  return {
    root,
    traceFile: join(root, 'trace.htrace'),
    traceDb: join(root, 'trace.db'),
    procfsFile: join(root, 'procfs.jsonl'),
    metadataFile: join(root, 'scene.json'),
  };
}

const SESSION_OK: Reply = { stdout: 'tracing 2000 ms....\nDONE\n', stderr: '', code: 0 };
const LS_OK: Reply = {
  stdout: `-rw-rw-r-- 1 hiprofiler shell 762851 2026-11-16 05:40 ${DEVICE_OUTPUT_PATH}`,
  stderr: '',
  code: 0,
};

const sessionShell = (hdc: FakeHdc) =>
  hdc.calls.filter((c) => c.kind === 'shell' && String(c.args[0]).startsWith('hiprofiler_cmd -c'));
const killShell = (hdc: FakeHdc) =>
  hdc.calls.filter((c) => c.kind === 'shell' && String(c.args[0]) === 'hiprofiler_cmd --kill');

const opts = { durationMs: 2000, plugins: [gpuPlugin()] };

describe('HiprofilerCollector', () => {
  it('declares the plane-A capabilities', () => {
    const c = new HiprofilerCollector();
    expect(c.provides).toEqual(
      expect.arrayContaining(['trace.frames', 'mem.native_hook', 'mem.gpu', 'power.xpower']),
    );
  });

  it('rounds a duration up to whole seconds', () => {
    expect(secondsFor(1500)).toBe(2);
    expect(secondsFor(2000)).toBe(2);
    expect(secondsFor(1)).toBe(1);
  });

  it('builds the session command with the fixed device paths', () => {
    expect(hiprofilerCommand(3)).toBe(
      `hiprofiler_cmd -c ${DEVICE_CONFIG_PATH} -o ${DEVICE_OUTPUT_PATH} -t 3 -s -k`,
    );
  });

  it('sends a config with a config_data block, then receives the trace', async () => {
    const hdc = new FakeHdc({ 'hiprofiler_cmd -c': SESSION_OK, 'ls -l': LS_OK });
    const layout = fakeLayout();
    await new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never);

    expect(hdc.sent).toHaveLength(1);
    expect(hdc.sent[0].device).toBe(DEVICE_CONFIG_PATH);
    expect(hdc.sent[0].text).toContain('plugin_name: "gpu-plugin"');
    expect(hdc.sent[0].text).toContain('config_data {');

    expect(sessionShell(hdc)).toHaveLength(1);
    expect(hdc.calls.filter((c) => c.kind === 'recv')).toEqual([
      { kind: 'recv', args: [DEVICE_OUTPUT_PATH, `${layout.traceFile}.partial`] },
    ]);
    expect(readFileSync(layout.traceFile, 'utf8')).toBe('trace bytes');
    expect(killShell(hdc)).toHaveLength(1);
    expect(existsSync(join(layout.root, 'hiprofiler.cfg'))).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('fails without receiving when the session does not print DONE', async () => {
    const hdc = new FakeHdc({
      'hiprofiler_cmd -c': {
        stdout: 'unknown plugin: gpu-plugin\nCreateSession FAIL\n',
        stderr: '',
        code: 0,
      },
    });
    const layout = fakeLayout();
    let error: unknown;
    try {
      await new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never);
    } catch (err) {
      error = err;
    }
    expect((error as OhosPerfError).code).toBe('HIPROFILER_SESSION_FAILED');
    expect((error as Error).message).toContain('unknown plugin');
    expect(hdc.calls.filter((c) => c.kind === 'recv')).toHaveLength(0);
    expect(killShell(hdc)).toHaveLength(1);
    expect(existsSync(layout.traceFile)).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('fails without receiving when the trace is empty', async () => {
    const hdc = new FakeHdc({
      'hiprofiler_cmd -c': SESSION_OK,
      'ls -l': { stdout: `-rw-rw-r-- 1 hiprofiler shell 0 2026-11-16 05:40 ${DEVICE_OUTPUT_PATH}`, stderr: '', code: 0 },
    });
    const layout = fakeLayout();
    let error: unknown;
    try {
      await new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never);
    } catch (err) {
      error = err;
    }
    expect((error as OhosPerfError).code).toBe('HIPROFILER_NO_OUTPUT');
    expect(hdc.calls.filter((c) => c.kind === 'recv')).toHaveLength(0);
    expect(existsSync(layout.traceFile)).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('still stops the session when the device command throws', async () => {
    const hdc = new FakeHdc({}, ['hiprofiler_cmd -c']);
    const layout = fakeLayout();
    await expect(
      new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never),
    ).rejects.toThrow(/hdc shell failed/);
    expect(killShell(hdc)).toHaveLength(1);
    expect(existsSync(layout.traceFile)).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('receives into a temp file so a failed transfer leaves no trace behind', async () => {
    const hdc = new FakeHdc({ 'hiprofiler_cmd -c': SESSION_OK, 'ls -l': LS_OK });
    // Simulate a target that drops after hdc created (and truncated) the
    // destination: the partial bytes must never become the scene's trace.
    hdc.recv = async (_t: string, _device: string, local: string) => {
      writeFileSync(local, 'partial bytes');
      throw new Error('connection reset');
    };
    const layout = fakeLayout();
    await expect(
      new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never),
    ).rejects.toThrow(/connection reset/);
    expect(existsSync(layout.traceFile)).toBe(false);
    expect(existsSync(`${layout.traceFile}.partial`)).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('keeps the previous trace file when the transfer fails', async () => {
    const hdc = new FakeHdc({ 'hiprofiler_cmd -c': SESSION_OK, 'ls -l': LS_OK });
    hdc.recv = async (_t: string, _device: string, local: string) => {
      writeFileSync(local, 'partial bytes');
      throw new Error('connection reset');
    };
    const layout = fakeLayout();
    writeFileSync(layout.traceFile, 'old scene trace');
    await expect(
      new HiprofilerCollector().collect(hdc as never, 'dev', opts, layout as never),
    ).rejects.toThrow(/connection reset/);
    expect(readFileSync(layout.traceFile, 'utf8')).toBe('old scene trace');
    expect(existsSync(`${layout.traceFile}.partial`)).toBe(false);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('rejects an empty plugin list before touching the device', async () => {
    const hdc = new FakeHdc();
    const layout = fakeLayout();
    let error: unknown;
    try {
      await new HiprofilerCollector().collect(
        hdc as never, 'dev', { ...opts, plugins: [] }, layout as never,
      );
    } catch (err) {
      error = err;
    }
    expect((error as OhosPerfError).code).toBe('HIPROFILER_BAD_PLUGIN');
    expect(hdc.calls).toHaveLength(0);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('rejects a bad buffer size before touching the device', async () => {
    const hdc = new FakeHdc();
    const layout = fakeLayout();
    let error: unknown;
    try {
      await new HiprofilerCollector().collect(
        hdc as never, 'dev', { ...opts, bufferPages: 4096 }, layout as never,
      );
    } catch (err) {
      error = err;
    }
    expect((error as OhosPerfError).code).toBe('HIPROFILER_BAD_BUFFER');
    expect(hdc.calls).toHaveLength(0);
    rmSync(layout.root, { recursive: true, force: true });
  });

  it('rejects a bad duration before touching the device', async () => {
    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const hdc = new FakeHdc();
      const layout = fakeLayout();
      let error: unknown;
      try {
        await new HiprofilerCollector().collect(
          hdc as never, 'dev', { ...opts, durationMs }, layout as never,
        );
      } catch (err) {
        error = err;
      }
      expect((error as OhosPerfError).code).toBe('HIPROFILER_BAD_DURATION');
      expect(hdc.calls).toHaveLength(0);
      rmSync(layout.root, { recursive: true, force: true });
    }
  });
});
