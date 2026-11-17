import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsheapCollector, readJsheapSnapshot } from '../src/collectors/jsheap';
import { createSceneLayout } from '../src/ingest/scene';

/*
 * HapRay's row 20 is capture only: ask the device for a `.heapsnapshot`, pull
 * it, done. There is no analyzer on either side, because the format is one
 * only DevEco Studio reads.
 *
 * What matters for a capture is that every way it can fail is a typed refusal
 * naming the cause — a non-debuggable app, an app that is not running, a
 * command that succeeds but writes nothing — and never an empty file a later
 * step mistakes for a snapshot.
 */

/** A fake hdc whose replies are scripted by the command prefix. */
function fakeHdc(replies: Array<{ match: RegExp; stdout?: string; stderr?: string; code?: number }>) {
  const calls: string[] = [];
  return {
    calls,
    shell: async (_target: string, cmd: string) => {
      calls.push(cmd);
      const reply = replies.find((r) => r.match.test(cmd));
      return {
        stdout: reply?.stdout ?? '',
        stderr: reply?.stderr ?? '',
        code: reply?.code ?? 0,
      };
    },
    recv: async (_target: string, _remote: string, local: string) => {
      writeFileSync(local, '{"snapshot":{}}');
    },
  };
}

function layout(): { root: string; layout: ReturnType<typeof createSceneLayout> } {
  const root = mkdtempSync(join(tmpdir(), 'jsheap-'));
  return { root, layout: createSceneLayout(root) };
}

describe('JsheapCollector', () => {
  it('declares the js.heap capability', () => {
    expect(new JsheapCollector().provides).toEqual(['js.heap']);
  });

  it('finds the pid, dumps, and pulls the newest snapshot', async () => {
    const { layout: l } = layout();
    const hdc = fakeHdc([
      { match: /^pidof /, stdout: '4242\n' },
      { match: /^hidumper --mem-jsheap/, stdout: 'ok' },
      {
        match: /^find /,
        stdout: '1700000000.5 /data/app/el2/100/base/com.demo/files/leak/heap.heapsnapshot\n',
      },
    ]);
    const capture = await new JsheapCollector().collect(
      hdc as never,
      't1',
      { app: 'com.demo' },
      l,
    );
    expect(capture.devicePath).toBe(
      '/data/app/el2/100/base/com.demo/files/leak/heap.heapsnapshot',
    );
    expect(capture.bytes).toBeGreaterThan(0);
    expect(readJsheapSnapshot(l)).toBeDefined();
    expect(readFileSync(l.jsheapFile, 'utf8')).toContain('snapshot');
  });

  it('refuses when the app is not running', async () => {
    const { layout: l } = layout();
    const hdc = fakeHdc([{ match: /^pidof /, stdout: '', code: 1 }]);
    await expect(
      new JsheapCollector().collect(hdc as never, 't1', { app: 'com.demo' }, l),
    ).rejects.toMatchObject({ code: 'JSHEAP_NO_PID' });
  });

  it('refuses with the device message when the app is not debuggable', async () => {
    const { layout: l } = layout();
    const hdc = fakeHdc([
      { match: /^pidof /, stdout: '4242\n' },
      {
        match: /^hidumper --mem-jsheap/,
        stderr: 'Error: process is not debuggable',
        code: 1,
      },
    ]);
    await expect(
      new JsheapCollector().collect(hdc as never, 't1', { app: 'com.demo' }, l),
    ).rejects.toMatchObject({ code: 'JSHEAP_UNSUPPORTED' });
  });

  it('refuses when no snapshot appears before the timeout', async () => {
    const { layout: l } = layout();
    const hdc = fakeHdc([
      { match: /^pidof /, stdout: '4242\n' },
      { match: /^hidumper --mem-jsheap/, stdout: 'ok' },
      { match: /^find /, stdout: '' },
    ]);
    await expect(
      new JsheapCollector().collect(hdc as never, 't1', { app: 'com.demo', timeoutMs: 5 }, l),
    ).rejects.toMatchObject({ code: 'JSHEAP_NO_OUTPUT' });
  });

  it('refuses an empty app name before any device call', async () => {
    const { layout: l } = layout();
    const hdc = fakeHdc([]);
    await expect(
      new JsheapCollector().collect(hdc as never, 't1', { app: '' }, l),
    ).rejects.toMatchObject({ code: 'JSHEAP_NO_APP' });
    expect(hdc.calls).toHaveLength(0);
  });
});
