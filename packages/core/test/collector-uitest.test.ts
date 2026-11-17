import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UitestCollector, DEVICE_UI_PATH } from '../src/collectors/uitest';
import { createSceneLayout, type SceneLayout } from '../src/ingest/scene';
import { OhosPerfError } from '../src/errors';
import type { Hdc } from '../src/transport/hdc';

/** The measured `uitest dumpLayout` success line (Mate 60). */
const SAVED = `DumpLayout saved to:${DEVICE_UI_PATH}\n`;

const TREE = {
  attributes: { type: '', bundleName: '', bounds: '[0,0][1216,2688]' },
  children: [
    {
      attributes: {
        type: 'WindowScene', bundleName: 'com.ohos.sceneboard', abilityName: '',
        bounds: '[0,107][1216,2688]', text: '', id: 'session176',
        clickable: '', enabled: 'true', scrollable: 'false',
      },
      children: [],
    },
  ],
};

describe('UitestCollector', () => {
  let dir: string;
  let layout: SceneLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohosperf-uitest-'));
    layout = createSceneLayout(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * A structural fake: `dump` controls the command's output, `bytes` the
   * `ls -l` size, and `payload` what `recv` writes locally.
   */
  function fakeHdc(opts: {
    dump?: string;
    code?: number;
    bytes?: number;
    payload?: unknown;
    /** Written verbatim instead of `payload`, for a non-JSON document. */
    rawPayload?: string;
    throwOnDump?: Error;
  } = {}): { hdc: Hdc; calls: string[]; recvTo: string[] } {
    const calls: string[] = [];
    const recvTo: string[] = [];
    const bytes = opts.bytes ?? 2048;
    const hdc = {
      async shell(_target: string, cmd: string) {
        calls.push(cmd);
        if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.startsWith('ls -l')) {
          return { stdout: `-rw-r--r-- 1 shell shell ${bytes} ${DEVICE_UI_PATH}`,
            stderr: '', code: 0 };
        }
        if (opts.throwOnDump !== undefined) throw opts.throwOnDump;
        return { stdout: opts.dump ?? SAVED, stderr: '', code: opts.code ?? 0 };
      },
      async recv(_target: string, _from: string, to: string) {
        recvTo.push(to);
        writeFileSync(to, opts.rawPayload ?? JSON.stringify(opts.payload ?? TREE));
      },
    };
    return { hdc: hdc as unknown as Hdc, calls, recvTo };
  }

  it('dumps, transfers, flattens and writes ui.json', async () => {
    const { hdc, calls, recvTo } = fakeHdc();
    const nodes = await new UitestCollector().collect(hdc, 'dev', {}, layout);

    expect(calls[0]).toBe(`rm -f ${DEVICE_UI_PATH}`);
    expect(calls[1]).toBe(`uitest dumpLayout -p ${DEVICE_UI_PATH}`);
    expect(calls[2]).toBe(`ls -l ${DEVICE_UI_PATH}`);
    expect(recvTo).toEqual([layout.uiFile]);
    expect(nodes.map((node) => node.type)).toEqual(['', 'WindowScene']);
    expect(nodes[1].bundleName).toBe('com.ohos.sceneboard');
    expect(existsSync(layout.uiFile)).toBe(true);
  });

  it('requires the DumpLayout marker', async () => {
    const { hdc, recvTo } = fakeHdc({ dump: 'error: unable to connect to ability manager\n' });
    const err = await new UitestCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UITEST_DUMP_FAILED');
    expect(recvTo).toEqual([]);
    expect(existsSync(layout.uiFile)).toBe(false);
  });

  it('fails when the device file is empty', async () => {
    const { hdc } = fakeHdc({ bytes: 0 });
    const err = await new UitestCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UITEST_NO_OUTPUT');
  });

  it('removes the local file when the transferred document is not JSON', async () => {
    const { hdc } = fakeHdc({ rawPayload: '{ not json' });
    const err = await new UitestCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UITEST_PARSE_FAILED');
    expect(existsSync(layout.uiFile)).toBe(false);
  });

  it('treats a valid non-tree document as an empty screen', async () => {
    const { hdc } = fakeHdc({ rawPayload: '{"not":"a tree"}' });
    const nodes = await new UitestCollector().collect(hdc, 'dev', {}, layout);
    expect(nodes).toEqual([]);
    expect(existsSync(layout.uiFile)).toBe(true);
  });

  it('rejects a bad timeout before any device call', async () => {
    const { hdc, calls } = fakeHdc();
    for (const timeoutMs of [0, -5, 1.5]) {
      const err = await new UitestCollector()
        .collect(hdc, 'dev', { timeoutMs }, layout)
        .catch((e: unknown) => e);
      expect((err as OhosPerfError).code).toBe('UITEST_BAD_TIMEOUT');
    }
    expect(calls).toEqual([]);
  });

  it('turns a transport failure on the dump into UITEST_DUMP_FAILED', async () => {
    const { hdc } = fakeHdc({
      throwOnDump: new OhosPerfError('device offline', { code: 'HDC_SHELL_FAILED' }),
    });
    const err = await new UitestCollector()
      .collect(hdc, 'dev', {}, layout)
      .catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UITEST_DUMP_FAILED');
  });

  it('declares the ui.tree capability', () => {
    const collector = new UitestCollector();
    expect(collector.id).toBe('uitest');
    expect(collector.provides).toEqual(['ui.tree']);
    expect(DEVICE_UI_PATH).toBe('/data/local/tmp/ohosperf_ui.json');
  });
});

/*
 * P17: the tree a selector reads must carry geometry.
 *
 * `flattenUiTree` only adds `boundsRect` with `full: true`, and the capture
 * path deliberately omits it (a query row carries the documented subset). A
 * selector, though, taps the centre of a node's bounds — so the read that
 * feeds selectors has to ask for the full row. Without this, every selector
 * action on a real device refuses with "no parseable bounds" for a bounds
 * string that parsed perfectly well.
 */
describe('UitestCollector — full rows for selectors', () => {
  it('adds boundsRect when asked for full rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-uitest-full-'));
    const layout = createSceneLayout(dir);
    const hdc = {
      async shell(_t: string, cmd: string) {
        if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.startsWith('ls -l')) {
          return { stdout: `-rw-r--r-- 1 shell shell 2048 ${DEVICE_UI_PATH}`, stderr: '', code: 0 };
        }
        return { stdout: SAVED, stderr: '', code: 0 };
      },
      async recv(_t: string, _f: string, to: string) {
        writeFileSync(to, JSON.stringify(TREE));
      },
    } as unknown as Hdc;
    try {
      const nodes = await new UitestCollector().collect(hdc, 'dev', { full: true }, layout);
      const scene = nodes.find((node) => node.type === 'WindowScene')!;
      expect(scene.bounds).toBe('[0,107][1216,2688]');
      expect(scene.boundsRect).toEqual({ left: 0, top: 107, right: 1216, bottom: 2688 });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('still omits boundsRect for a capture, so ui.json stays the documented subset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohosperf-uitest-plain-'));
    const layout = createSceneLayout(dir);
    const hdc = {
      async shell(_t: string, cmd: string) {
        if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
        if (cmd.startsWith('ls -l')) {
          return { stdout: `-rw-r--r-- 1 shell shell 2048 ${DEVICE_UI_PATH}`, stderr: '', code: 0 };
        }
        return { stdout: SAVED, stderr: '', code: 0 };
      },
      async recv(_t: string, _f: string, to: string) {
        writeFileSync(to, JSON.stringify(TREE));
      },
    } as unknown as Hdc;
    try {
      const nodes = await new UitestCollector().collect(hdc, 'dev', {}, layout);
      expect(nodes.find((node) => node.type === 'WindowScene')!.boundsRect).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
