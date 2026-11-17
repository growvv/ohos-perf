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

  it('finds the pid, dumps, and pulls the snapshot the dump produced', async () => {
    const { layout: l } = layout();
    const snapshot = '/data/app/el2/100/base/com.demo/files/leak/heap.heapsnapshot';
    let findCalls = 0;
    const hdc = {
      shell: async (_t: string, cmd: string) => {
        if (/^pidof /.test(cmd)) return { stdout: '4242\n', stderr: '', code: 0 };
        if (/^hidumper --mem-jsheap/.test(cmd)) return { stdout: 'ok', stderr: '', code: 0 };
        if (/^find /.test(cmd)) {
          findCalls += 1;
          // Nothing before the dump; the snapshot appears on the first poll.
          return {
            stdout: findCalls === 1 ? '' : `1700000000.5 ${snapshot}\n`,
            stderr: '',
            code: 0,
          };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
      recv: async (_t: string, _remote: string, local: string) => {
        writeFileSync(local, '{"snapshot":{}}');
      },
    };
    const capture = await new JsheapCollector().collect(
      hdc as never,
      't1',
      { app: 'com.demo' },
      l,
    );
    expect(capture.devicePath).toBe(snapshot);
    expect(capture.bytes).toBeGreaterThan(0);
    expect(readJsheapSnapshot(l)).toBeDefined();
    expect(readFileSync(l.jsheapFile, 'utf8')).toContain('snapshot');
  });

  it('ignores a snapshot older than this capture', async () => {
    // The dump is asynchronous, so the poll accepts the first `.heapsnapshot`
    // it sees. Without a freshness bound it would also accept one left by an
    // earlier run — a heap from a different session, recorded as this
    // capture's and reported `exact`. The file's mtime must be at or after the
    // moment the dump started.
    const { layout: l } = layout();
    // An mtime far in the past, as a previous run would have left it.
    const stale = '1600000000.0 /data/app/el2/100/base/com.demo/files/leak/old.heapsnapshot\n';
    const fresh = '9999999999.9 /data/app/el2/100/base/com.demo/files/leak/new.heapsnapshot\n';
    let findCalls = 0;
    const hdc = {
      shell: async (_t: string, cmd: string) => {
        if (/^pidof /.test(cmd)) return { stdout: '4242\n', stderr: '', code: 0 };
        if (/^hidumper --mem-jsheap/.test(cmd)) return { stdout: 'ok', stderr: '', code: 0 };
        if (/^find /.test(cmd)) {
          findCalls += 1;
          // First poll: only the previous run's file. Second: the new one.
          return { stdout: findCalls === 1 ? stale : fresh, stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
      recv: async (_t: string, _remote: string, local: string) => {
        writeFileSync(local, '{"snapshot":{}}');
      },
    };
    const capture = await new JsheapCollector().collect(
      hdc as never, 't1', { app: 'com.demo', timeoutMs: 2000 }, l,
    );
    expect(capture.devicePath).toBe(
      '/data/app/el2/100/base/com.demo/files/leak/new.heapsnapshot',
    );
    expect(findCalls).toBeGreaterThan(1);
  });

  it('refuses when only a snapshot from an earlier run exists', async () => {
    // Nothing fresh ever appears: the honest answer is that no snapshot was
    // produced, not the stale one from last time.
    const { layout: l } = layout();
    const hdc = fakeHdc([
      { match: /^pidof /, stdout: '4242\n' },
      { match: /^hidumper --mem-jsheap/, stdout: 'ok' },
      {
        match: /^find /,
        stdout: '1600000000.0 /data/app/el2/100/base/com.demo/files/leak/old.heapsnapshot\n',
      },
    ]);
    await expect(
      new JsheapCollector().collect(hdc as never, 't1', { app: 'com.demo', timeoutMs: 5 }, l),
    ).rejects.toMatchObject({ code: 'JSHEAP_NO_OUTPUT' });
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
