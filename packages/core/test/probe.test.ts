import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBinaries, parseHiperfEvents, runProbe } from '../src/device/probe';
import { buildMatrix } from '../src/device/capability';

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

/** Runner over an explicit command→stdout table, for cases no fixture captures. */
function tableRunner(table: Record<string, string>) {
  return {
    calls: [] as string[],
    async shell(cmd: string) {
      this.calls.push(cmd);
      return { stdout: table[cmd] ?? '', stderr: '', code: 0 };
    },
  };
}

const UNSUPPORTED_BLOCK = [
  'event not support hw-cpu-cycles',
  'event not support hw-instructions',
  'event not support hw-cache-references',
  'event not support hw-cache-misses',
  'event not support hw-branch-instructions',
  'event not support hw-branch-misses',
  'event not support hw-bus-cycles',
  'event not support hw-stalled-cycles-frontend',
  'event not support hw-stalled-cycles-backend',
  'event not support hw-ref-cpu-cycles',
].join('\n');

const COMMAND_SEQUENCE = [
  'param get const.product.cpu.abilist',
  'param get const.product.name',
  'param get const.product.software.version',
  'param get const.ohos.fullname',
  'param get const.product.devicetype',
  'which hiprofiler_cmd',
  'which hiperf',
  'which hitrace',
  'which hidumper',
  'which uitest',
  'hiperf list hw',
  'hiperf list',
];

describe('parseBinaries', () => {
  it('treats MISSING and empty output as absent', () => {
    expect(parseBinaries({ hiperf: '/bin/hiperf', hitrace: 'MISSING', uitest: '' }))
      .toEqual({ hiperf: true, hitrace: false, uitest: false });
  });

  it('treats No such file output as absent', () => {
    expect(parseBinaries({
      hiprofiler_cmd: 'which: /bin/hiprofiler_cmd: No such file or directory',
      hiperf: '/bin/hiperf',
    })).toEqual({ hiprofiler_cmd: false, hiperf: true });
  });

  it('treats whitespace-only output as absent', () => {
    expect(parseBinaries({ uitest: '  \t \n ' })).toEqual({ uitest: false });
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

  it('excludes unsupported lines that precede the header', () => {
    const out = `${UNSUPPORTED_BLOCK}\n\nSupported events for hardware:\n`;
    expect(parseHiperfEvents(out)).toEqual({ hw: [], sw: [] });
  });

  it('skips unsupported lines inside a section and keeps real events', () => {
    const out = 'Supported events for hardware:\n'
      + 'event not support hw-ref-cpu-cycles\n'
      + '\thw-cpu-cycles\n'
      + 'event not support hw-bus-cycles\n'
      + '\thw-instructions\n';
    expect(parseHiperfEvents(out).hw).toEqual(['hw-cpu-cycles', 'hw-instructions']);
  });

  it('ends the section at a colon-bearing line, truncating later events', () => {
    // Current, deliberate behavior: any colon-bearing line is not an event and
    // closes the section, so events after it are not collected.
    const out = 'Supported events for hardware:\n'
      + '\thw-cpu-cycles\n'
      + 'Some Note: x\n'
      + '\thw-instructions\n';
    expect(parseHiperfEvents(out).hw).toEqual(['hw-cpu-cycles']);
  });

  it('returns empty lists for empty output', () => {
    expect(parseHiperfEvents('')).toEqual({ hw: [], sw: [] });
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

  it('reports no PMU events on the emulator and disables perf.pmu', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-emulator.txt'));
    expect(snap.hiperfHwEvents).toEqual([]);
    expect(snap.hiperfSwEvents).toEqual([]);

    const matrix = buildMatrix(snap);
    const pmu = matrix.get('perf.pmu');
    expect(pmu).toBeDefined();
    expect(pmu!.available).toBe(false);
    expect(pmu!.reason).toBe('no hardware PMU events reported by hiperf list hw');
  });

  it('detects real device identity from fixture', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-real.txt'));
    expect(snap.identity.isEmulator).toBe(false);
    expect(snap.binaries.hiprofiler_cmd).toBe(true);
  });

  it('collects the nine measured hw events on the real device', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-real.txt'));
    expect(snap.hiperfHwEvents).toEqual([
      'hw-cpu-cycles', 'hw-instructions', 'hw-cache-references', 'hw-cache-misses',
      'hw-branch-instructions', 'hw-branch-misses', 'hw-bus-cycles',
      'hw-stalled-cycles-frontend', 'hw-stalled-cycles-backend',
    ]);
    // The real capture has no software section; none is invented.
    expect(snap.hiperfSwEvents).toEqual([]);
    expect(buildMatrix(snap).get('perf.pmu')!.available).toBe(true);
  });

  it('runs the fixed command sequence and keys probes by exact command', async () => {
    const runner = fixtureRunner('test/fixtures/probe-real.txt');
    const snap = await runProbe(runner);
    expect(runner.calls).toEqual(COMMAND_SEQUENCE);
    expect(Object.keys(snap.probes)).toEqual(COMMAND_SEQUENCE);
    for (const cmd of COMMAND_SEQUENCE) {
      expect(snap.probes[cmd].command).toBe(cmd);
    }
  });

  it('detects the emulator from the softwareVersion prefix', async () => {
    const runner = tableRunner({
      'param get const.product.name': 'Phone',
      'param get const.product.software.version': 'emulator 6.1.0.126(SP1DEVC00E120R4P11)',
    });
    const snap = await runProbe(runner);
    expect(snap.identity.productName).toBe('Phone');
    expect(snap.identity.softwareVersion).toBe('emulator 6.1.0.126(SP1DEVC00E120R4P11)');
    expect(snap.identity.isEmulator).toBe(true);
  });
});
