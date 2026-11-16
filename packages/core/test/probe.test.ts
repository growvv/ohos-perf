import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseBinaries,
  parseHiperfEvents,
  parseHiprofilerPlugins,
  runProbe,
} from '../src/device/probe';
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
  'which bjc_cov',
  'hiprofiler_cmd --list',
  'hiperf list hw',
  'hiperf list',
];

/** Measured on the Mate 60 (HarmonyOS 7.0.0.111) with the daemon running. */
const HIPROFILER_LIST = [
  'support plugin list:',
  'capabilities {',
  '  path: "libcpudataplugin.z.so"',
  '  name: "cpu-plugin"',
  '}',
  'capabilities {',
  '  path: "libgpudataplugin.z.so"',
  '  name: "gpu-plugin"',
  '}',
  'capabilities {',
  '  path: "libxpowerplugin.z.so"',
  '  name: "xpower-plugin"',
  '}',
  'capabilities {',
  '  path: "nativehook"',
  '  name: "nativehook"',
  '}',
  '',
].join('\n');

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

describe('parseHiprofilerPlugins', () => {
  it('extracts plugin names from capabilities blocks', () => {
    expect(parseHiprofilerPlugins(HIPROFILER_LIST)).toEqual([
      'cpu-plugin', 'gpu-plugin', 'xpower-plugin', 'nativehook',
    ]);
  });

  it('returns undefined when the service is not running', () => {
    expect(parseHiprofilerPlugins('Service not started\n')).toBeUndefined();
  });

  it('returns undefined for unparseable output', () => {
    expect(parseHiprofilerPlugins('')).toBeUndefined();
    expect(parseHiprofilerPlugins('something unexpected\n')).toBeUndefined();
  });

  it('deduplicates repeated names but keeps their order', () => {
    const out = 'capabilities {\n  name: "a"\n}\ncapabilities {\n  name: "a"\n}\n'
      + 'capabilities {\n  name: "b"\n}\n';
    expect(parseHiprofilerPlugins(out)).toEqual(['a', 'b']);
  });
});

describe('runProbe', () => {
  // `which uitest` is not in the saved probe log; see test/fixtures/README.md.
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

  it('records the hiprofiler plugin list from the probe', async () => {
    const runner = tableRunner({
      'param get const.product.name': 'Phone',
      'hiprofiler_cmd --list': HIPROFILER_LIST,
    });
    const snap = await runProbe(runner);
    expect(snap.hiprofilerPlugins).toEqual([
      'cpu-plugin', 'gpu-plugin', 'xpower-plugin', 'nativehook',
    ]);
    expect(snap.probes['hiprofiler_cmd --list'].stdout).toBe(HIPROFILER_LIST);
  });

  it('leaves the plugin list unknown when the service is not started', async () => {
    const runner = tableRunner({ 'hiprofiler_cmd --list': 'Service not started\n' });
    const snap = await runProbe(runner);
    expect(snap.hiprofilerPlugins).toBeUndefined();
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
