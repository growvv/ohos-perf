import { describe, it, expect } from 'vitest';
import type { CliDeps, GestureRequest } from '../src/commands';
import { buildProgram } from '../src/program';
import type { Gesture, GestureResult } from '@ohos-perf/core';

function baseDeps(): CliDeps {
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('x'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => { throw new Error('x'); },
    gesture: async (req) => ({ gesture: req.gesture, output: 'No Error' }),
    query: async () => { throw new Error('x'); },
    tools: () => [],
    compare: async () => { throw new Error('x'); },
    uiCompare: async () => { throw new Error('ui-compare not stubbed'); },
    report: async () => { throw new Error('report not stubbed'); },
    hap: async () => { throw new Error('hap not stubbed'); },
    emulator: {
      list: async () => [],
      start: async () => { throw new Error('x'); },
      stop: async () => { throw new Error('x'); },
      create: async () => { throw new Error('x'); },
    },
    run: async () => { throw new Error('run not stubbed'); },
  };
}

async function parseWith(
  gesture: (req: GestureRequest) => Promise<GestureResult>,
  argv: string[],
) {
  const emitted: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
  const program = buildProgram({ ...baseDeps(), gesture }, {
    writeOut: () => {},
    writeErr: () => {},
    emit: (r) => emitted.push(r),
  }, { exitOverride: true });
  await program.parseAsync(['node', 'ohos-perf', ...argv]);
  return emitted;
}

const ok = (req: GestureRequest): Promise<GestureResult> =>
  Promise.resolve({ gesture: req.gesture, output: 'No Error' });

describe('ohos-perf gesture', () => {
  it.each([
    [['gesture', 'click', '500', '800'], { action: 'click', x: 500, y: 800 }],
    [['gesture', 'swipe', '500', '800', '500', '200', '--velocity', '600'],
      { action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200, velocity: 600 }],
    [['gesture', 'key', 'Home'], { action: 'key', key: 'Home' }],
    [['gesture', 'input', '500', '500', 'hello'],
      { action: 'inputText', x: 500, y: 500, text: 'hello' }],
    [['gesture', 'text', 'hello'], { action: 'text', text: 'hello' }],
  ])('maps %j to the core gesture', async (argv, expected) => {
    const seen: Gesture[] = [];
    const emitted = await parseWith((req) => { seen.push(req.gesture); return ok(req); }, argv);
    expect(seen).toEqual([expected]);
    expect(emitted[0].exitCode).toBe(0);
  });

  it('forwards --target to the gesture request', async () => {
    const seen: GestureRequest[] = [];
    const emitted = await parseWith((req) => { seen.push(req); return ok(req); },
      ['gesture', 'key', 'Back', '--target', '127.0.0.1:5555']);
    expect(seen).toEqual([{ gesture: { action: 'key', key: 'Back' }, target: '127.0.0.1:5555' }]);
    expect(emitted[0].stdout).toBe('key Back accepted\n');
  });

  it('rejects an invalid coordinate without calling the device', async () => {
    // `--` makes commander hand `-1` to the action as an operand; without it,
    // commander rejects the leading dash as an unknown option before the
    // action runs. Either way nothing reaches the device.
    let called = false;
    const emitted = await parseWith((req) => { called = true; return ok(req); },
      ['gesture', 'click', '--', '-1', '500']);
    expect(called).toBe(false);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/invalid <x>/);
  });

  it('rejects an out-of-range velocity before any device call', async () => {
    let called = false;
    const emitted = await parseWith((req) => { called = true; return ok(req); },
      ['gesture', 'swipe', '500', '800', '500', '200', '--velocity', '100']);
    expect(called).toBe(false);
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/invalid --velocity/);
  });

  it('rejects empty text before any device call', async () => {
    let called = false;
    const emitted = await parseWith((req) => { called = true; return ok(req); },
      ['gesture', 'text', '']);
    expect(called).toBe(false);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/invalid <text>/);
    expect(emitted[0].stderr).toMatch(/non-empty/);
  });

  it('rejects text with a control character before any device call', async () => {
    let called = false;
    const emitted = await parseWith((req) => { called = true; return ok(req); },
      ['gesture', 'input', '500', '500', 'line\nbreak']);
    expect(called).toBe(false);
    expect(emitted[0].stdout).toBe('');
    expect(emitted[0].exitCode).toBe(1);
    expect(emitted[0].stderr).toMatch(/invalid <text>/);
    expect(emitted[0].stderr).toMatch(/control character/);
  });

  it('emits the core result under --json', async () => {
    const emitted = await parseWith(ok, ['gesture', 'click', '500', '800', '--json']);
    expect(JSON.parse(emitted[0].stdout)).toEqual({
      gesture: { action: 'click', x: 500, y: 800 },
      output: 'No Error',
    });
  });
});
