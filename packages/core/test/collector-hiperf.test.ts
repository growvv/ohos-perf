import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HiperfCollector, hiperfEventsFor, hiperfRecordCommand, parseHiperfSummary,
} from '../src/collectors/hiperf';
import { createSceneLayout } from '../src/ingest/scene';
import { OhosPerfError } from '../src/errors';
import type { Hdc } from '../src/transport/hdc';

const DEVICE_PATH = '/data/local/tmp/ohosperf_perf.data';

/** A recording fake: every shell call is answered from `script`, else exits 0. */
function fakeHdc(script: Array<{ match: RegExp; stdout?: string; code?: number }>) {
  const calls: string[] = [];
  let perfBytes = 4096;
  const hdc = {
    async shell(_target: string, cmd: string) {
      calls.push(cmd);
      if (cmd.startsWith('rm -f')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.startsWith('ls -l')) {
        return {
          stdout: `-rw-r--r-- 1 shell shell ${perfBytes} ${DEVICE_PATH}`,
          stderr: '',
          code: 0,
        };
      }
      for (const step of script) {
        if (step.match.test(cmd)) {
          return { stdout: step.stdout ?? '', stderr: '', code: step.code ?? 0 };
        }
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    async recv(_t: string, _from: string, to: string) {
      writeFileSync(to, Buffer.alloc(perfBytes));
    },
  };
  return { hdc: hdc as unknown as Hdc, calls, setBytes: (n: number) => { perfBytes = n; } };
}

/** Measured on the Mate 60: a running debuggable app at 1000 Hz. */
const RECORDED = '[ Sample records: 150, Non sample records: 4115 ]\n' +
  '[ Sample lost: 0, Non sample lost: 0 ]\n' +
  '[ hiperf record: Captured 0.492 MB perf data. ]\n';

const tmp = () => mkdtempSync(join(tmpdir(), 'ohosperf-hiperf-'));

describe('parseHiperfSummary', () => {
  it('reads the sample, non-sample and lost counts', () => {
    expect(parseHiperfSummary(RECORDED)).toEqual({ samples: 150, nonSamples: 4115, lost: 0 });
  });

  it('accepts a zero-sample capture of an idle app', () => {
    const idle = '[ Sample records: 0, Non sample records: 4107 ]\n' +
      '[ Sample lost: 0, Non sample lost: 0 ]\n';
    expect(parseHiperfSummary(idle)).toEqual({ samples: 0, nonSamples: 4107, lost: 0 });
  });

  it('returns undefined without the sample marker', () => {
    expect(parseHiperfSummary('hiperf: permission denied')).toBeUndefined();
  });
});

describe('hiperfRecordCommand', () => {
  it('builds the measured invocation', () => {
    expect(hiperfRecordCommand({ durationMs: 3000, app: 'com.example.image' }, DEVICE_PATH))
      .toBe(`hiperf record --app com.example.image -d 3 -o ${DEVICE_PATH} -f 1000 -s fp`);
  });

  it('omits -s when call stacks are off and renders events', () => {
    expect(hiperfRecordCommand({
      durationMs: 1500, app: 'com.demo', frequency: 500,
      events: ['hw-cpu-cycles', 'sw-task-clock'], callStacks: false,
    }, DEVICE_PATH)).toBe(
      `hiperf record --app com.demo -d 1.5 -o ${DEVICE_PATH} -f 500 -e hw-cpu-cycles,sw-task-clock`,
    );
  });
});

describe('HiperfCollector', () => {
  it('declares the perf capabilities', () => {
    expect(new HiperfCollector().provides).toEqual(['perf.samples', 'perf.pmu']);
  });

  it('removes the stale path, records, recvs and reports the summary', async () => {
    const root = tmp();
    const { hdc, calls } = fakeHdc([{ match: /^hiperf record /, stdout: RECORDED }]);
    try {
      const capture = await new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.example.image' }, createSceneLayout(root),
      );
      expect(capture).toEqual({ samples: 150, nonSamples: 4115, lost: 0, bytes: 4096 });
      expect(calls[0]).toBe(`rm -f ${DEVICE_PATH}`);
      expect(existsSync(join(root, 'perf.data'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('succeeds with zero samples and reports them', async () => {
    const root = tmp();
    const { hdc } = fakeHdc([{ match: /^hiperf record /, stdout:
      '[ Sample records: 0, Non sample records: 4107 ]\n[ Sample lost: 0, Non sample lost: 0 ]\n' }]);
    try {
      const capture = await new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.example.image' }, createSceneLayout(root),
      );
      expect(capture.samples).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a release app with an actionable code', async () => {
    const root = tmp();
    const { hdc } = fakeHdc([{ match: /^hiperf record /,
      stdout: 'hiperf: --app option only support debug application\n', code: 1 }]);
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.system.app' }, createSceneLayout(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NOT_DEBUGGABLE' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognises the wording a real device prints, with exit 0', async () => {
    // Measured on HarmonyOS 7.0.0.111: `--app option only support debug or
    // profileable application`, exit 0. Matching the older wording exactly
    // meant a release app surfaced as HIPERF_RECORD_FAILED ("no sample
    // summary"), which tells the caller to check the cable instead of the
    // build. This fake is the device's output, verbatim.
    const root = tmp();
    const { hdc } = fakeHdc([{ match: /^hiperf record /,
      stdout: '--app option only support debug or profileable application\n', code: 0 }]);
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.huawei.hmos.settings' }, createSceneLayout(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NOT_DEBUGGABLE' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the file is empty', async () => {
    const root = tmp();
    const { hdc, setBytes } = fakeHdc([{ match: /^hiperf record /, stdout: RECORDED }]);
    setBytes(0);
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.demo' }, createSceneLayout(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NO_OUTPUT' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates before touching the device', async () => {
    const root = tmp();
    const { hdc, calls } = fakeHdc([]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ durationMs: 0 }, 'HIPERF_BAD_DURATION'],
      [{ durationMs: 3000, app: 'bad name' }, 'HIPERF_BAD_APP'],
      [{ durationMs: 3000, app: 'com.demo', frequency: 0 }, 'HIPERF_BAD_FREQUENCY'],
      [{ durationMs: 3000, app: 'com.demo', events: ['hw cycles'] }, 'HIPERF_BAD_EVENT'],
    ];
    try {
      for (const [patch, code] of cases) {
        await expect(new HiperfCollector().collect(
          hdc, 'dev', { durationMs: 3000, app: 'com.demo', ...patch } as never,
          createSceneLayout(root),
        )).rejects.toMatchObject({ code });
      }
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a release app as HIPERF_NOT_DEBUGGABLE when the transport throws', async () => {
    // The real Hdc.shell throws HDC_SHELL_FAILED on a nonzero device exit, so
    // the debuggability check cannot rely on a returned exit code: it must
    // inspect the transport error, or the actionable code is unreachable on a
    // real device and the caller is told "transport problem" instead of
    // "build a debug app".
    const root = tmp();
    const calls: string[] = [];
    const hdc = {
      async shell(_target: string, cmd: string) {
        calls.push(cmd);
        if (cmd.startsWith('hiperf record ')) {
          throw new OhosPerfError(
            'hdc shell failed: exit code 1' +
              ' (hiperf: --app option only support debug application)',
            { code: 'HDC_SHELL_FAILED' },
          );
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    } as unknown as Hdc;
    try {
      await expect(new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.system.app' }, createSceneLayout(root),
      )).rejects.toMatchObject({ code: 'HIPERF_NOT_DEBUGGABLE' });
      // Nothing was transferred: the failure happened at the record step.
      expect(existsSync(join(root, 'perf.data'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a generic transport failure as the transport error', async () => {
    const root = tmp();
    const hdc = {
      async shell(_target: string, cmd: string) {
        if (cmd.startsWith('hiperf record ')) {
          throw new OhosPerfError('hdc shell failed: exit code 2 (hiperf: out of memory)',
            { code: 'HDC_SHELL_FAILED' });
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    } as unknown as Hdc;
    try {
      // A failure that is not about debuggability must not be relabelled: the
      // caller's fix is different, and the message names what the device said.
      const err = await new HiperfCollector().collect(
        hdc, 'dev', { durationMs: 3000, app: 'com.demo' }, createSceneLayout(root),
      ).catch((e: unknown) => e);
      expect((err as OhosPerfError).code).toBe('HIPERF_RECORD_FAILED');
      expect((err as OhosPerfError).message).toContain('out of memory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hiperfEventsFor', () => {
  it('defaults to a software event when the device has no PMU', () => {
    expect(hiperfEventsFor(undefined, false, ['sw-task-clock', 'sw-cpu-clock']))
      .toEqual(['sw-task-clock']);
  });

  it('omits events on a device with a PMU, leaving hiperf its own default', () => {
    expect(hiperfEventsFor(undefined, true, ['sw-task-clock'])).toBeUndefined();
  });

  it('keeps an explicitly requested event that the device offers', () => {
    expect(hiperfEventsFor(['sw-cpu-clock'], false, ['sw-task-clock', 'sw-cpu-clock']))
      .toEqual(['sw-cpu-clock']);
  });

  it('rejects a hardware event on a PMU-less device, naming the software events', () => {
    const err = (() => {
      try {
        hiperfEventsFor(['hw-cpu-cycles'], false, ['sw-task-clock', 'sw-cpu-clock']);
      } catch (caught) {
        return caught as OhosPerfError;
      }
      throw new Error('expected hiperfEventsFor to reject');
    })();
    expect(err.code).toBe('HIPERF_BAD_EVENT');
    expect(err.message).toContain('hw-cpu-cycles');
    expect(err.message).toContain('sw-task-clock');
    expect(err.message).toContain('sw-cpu-clock');
  });

  it('rejects a hardware event the probe did not report even with a PMU', () => {
    // The probe's list is the authority: an event name hiperf cannot sample
    // would record nothing and report an idle app.
    expect(() => hiperfEventsFor(['hw-bogus'], true, ['sw-task-clock']))
      .toThrow(/hw-bogus/);
  });
});
