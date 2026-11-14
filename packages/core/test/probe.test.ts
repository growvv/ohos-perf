import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBinaries, parseHiperfEvents, runProbe } from '../src/device/probe';

function fixtureRunner(path: string) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const table = new Map<string, string>();
  for (const line of lines) {
    const [cmd, ...rest] = line.split('\t');
    table.set(cmd, rest.join('\t').replace(/\\n/g, '\n'));
  }
  return {
    calls: [] as string[],
    async shell(cmd: string) {
      this.calls.push(cmd);
      return { stdout: table.get(cmd) ?? '', stderr: '', code: 0 };
    },
  };
}

describe('parseBinaries', () => {
  it('treats MISSING and empty output as absent', () => {
    expect(parseBinaries({ hiperf: '/bin/hiperf', hitrace: 'MISSING', uitest: '' }))
      .toEqual({ hiperf: true, hitrace: false, uitest: false });
  });
});

describe('parseHiperfEvents', () => {
  it('splits hw and sw event lists', () => {
    const out = 'Supported events for hardware:\nhw-cpu-cycles\nhw-instructions\n'
      + 'Supported events for software:\nsw-cpu-clock\nsw-task-clock\n';
    expect(parseHiperfEvents(out)).toEqual({
      hw: ['hw-cpu-cycles', 'hw-instructions'],
      sw: ['sw-cpu-clock', 'sw-task-clock'],
    });
  });

  it('returns empty hw list when header present but no events', () => {
    expect(parseHiperfEvents('Supported events for hardware:\n').hw).toEqual([]);
  });
});

describe('runProbe', () => {
  it('detects emulator identity from fixture', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-emulator.txt'));
    expect(snap.identity.abi).toBe('x86_64');
    expect(snap.identity.isEmulator).toBe(true);
    expect(snap.identity.productName).toBe('emulator');
    expect(snap.binaries.hiprofiler_cmd).toBe(false);
    expect(snap.binaries.hitrace).toBe(true);
  });

  it('detects real device identity from fixture', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-real.txt'));
    expect(snap.identity.isEmulator).toBe(false);
    expect(snap.binaries.hiprofiler_cmd).toBe(true);
  });
});
