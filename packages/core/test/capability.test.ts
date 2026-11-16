import { describe, it, expect } from 'vitest';
import { CapabilityMatrix, buildMatrix } from '../src/device/capability';
import type { CapabilityState, CapabilityId, ProbeResult } from '../src/device/capability';

const p = (cmd: string, out = ''): ProbeResult => ({ command: cmd, stdout: out, stderr: '', code: 0 });

const FULL_DEVICE = {
  abi: 'aarch64',
  isEmulator: false,
  binaries: {
    hitrace: true,
    hiperf: true,
    hidumper: true,
    hiprofiler_cmd: true,
    uitest: true,
    bjc_cov: false,
    hilog: true,
  },
  hiperfHwEvents: ['hw-cpu-cycles'],
  hiperfSwEvents: ['sw-cpu-clock'],
  probes: {},
};

const EMULATOR = {
  abi: 'x86_64',
  isEmulator: true,
  binaries: {
    hitrace: true,
    hiperf: true,
    hidumper: true,
    hiprofiler_cmd: false,
    uitest: true,
    bjc_cov: false,
    hilog: true,
  },
  hiperfHwEvents: [] as string[],
  hiperfSwEvents: ['sw-cpu-clock'],
  probes: {},
};

describe('buildMatrix', () => {
  it('marks frames available when hitrace exists', () => {
    const m = buildMatrix({
      abi: 'aarch64', isEmulator: false,
      binaries: { hitrace: true, hiperf: true, hidumper: true, hiprofiler_cmd: true },
      hiperfHwEvents: ['hw-cpu-cycles'], hiperfSwEvents: ['sw-cpu-clock'],
      probes: { hitrace: p('which hitrace', '/bin/hitrace') },
    });
    const s = m.get('trace.frames')!;
    expect(s.available).toBe(true);
    expect(s.collector).toBe('hitrace');
    expect(s.fidelity).toBe('exact');
  });

  it('marks pmu unavailable with reason on emulator without hw events', () => {
    const m = buildMatrix({
      abi: 'x86_64', isEmulator: true,
      binaries: { hitrace: true, hiperf: true, hidumper: true },
      hiperfHwEvents: [], hiperfSwEvents: ['sw-cpu-clock'],
      probes: { 'hiperf list hw': p('hiperf list hw', '') },
    });
    const s = m.get('perf.pmu')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('no hardware PMU events');
  });

  it('marks native_hook unavailable when hiprofiler_cmd absent', () => {
    const m = buildMatrix({
      abi: 'x86_64', isEmulator: true,
      binaries: { hitrace: true, hiperf: true, hidumper: true },
      hiperfHwEvents: [], hiperfSwEvents: [],
      probes: { 'which hiprofiler_cmd': p('which hiprofiler_cmd', 'MISSING') },
    });
    const s = m.get('mem.native_hook')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('hiprofiler');
  });

  it('satisfies reports missing capabilities sorted by id', () => {
    const m = new CapabilityMatrix([
      { id: 'perf.pmu', available: false, fidelity: 'exact', reason: 'x', probe: p('a') },
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('b') },
    ]);
    const r = m.satisfies(['trace.frames', 'perf.pmu', 'mem.gpu']);
    expect(r.ok).toBe(false);
    expect(r.missing.map((s) => s.id)).toEqual(['mem.gpu', 'perf.pmu']);
  });

  it('all() is deterministically sorted', () => {
    const m = new CapabilityMatrix([
      { id: 'ui.tree', available: true, fidelity: 'exact', probe: p('a') },
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('b') },
    ]);
    expect(m.all().map((s) => s.id)).toEqual(['trace.frames', 'ui.tree']);
  });
});

describe('buildMatrix availability rules', () => {
  it('emits exactly the 22 spec capability ids', () => {
    const ids = buildMatrix(FULL_DEVICE).all().map((s) => s.id);
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
  });

  it('serves hilog.stream from the hilog binary', () => {
    const m = buildMatrix(FULL_DEVICE);
    expect(m.get('hilog.stream')!.collector).toBe('hilog');
    expect(m.get('hilog.stream')!.available).toBe(true);
    expect(buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, hilog: false } })
      .get('hilog.stream')!.available).toBe(false);
  });

  it('serves trace.ark from hitrace', () => {
    const m = buildMatrix(FULL_DEVICE);
    expect(m.get('trace.ark')!.collector).toBe('hitrace');
    expect(m.get('trace.ark')!.available).toBe(true);
    expect(buildMatrix(EMULATOR).get('trace.ark')!.available).toBe(true);
  });

  it('maps each collector family to the right collector', () => {
    const m = buildMatrix(FULL_DEVICE);
    expect(m.get('trace.sched')!.collector).toBe('hitrace');
    expect(m.get('trace.binder')!.collector).toBe('hitrace');
    expect(m.get('trace.thread_state')!.collector).toBe('hitrace');
    expect(m.get('render.vsync')!.collector).toBe('hitrace');
    expect(m.get('perf.samples')!.collector).toBe('hiperf');
    expect(m.get('perf.pmu')!.collector).toBe('hiperf');
    expect(m.get('mem.procfs')!.collector).toBe('procfs');
    expect(m.get('mem.gpu')!.collector).toBe('hiprofiler');
    expect(m.get('power.xpower')!.collector).toBe('hiprofiler');
    expect(m.get('net.io')!.collector).toBe('hiprofiler');
    expect(m.get('disk.io')!.collector).toBe('hiprofiler');
    // js.heap has no serving collector: no analyzer consumes the heap tables,
    // so the state carries no `collector` (as with every unavailable state).
    expect(m.get('js.heap')!.available).toBe(false);
    // coverage has no serving collector in this package either; the row stays
    // in the matrix (pinned separately) so it reads as "unavailable", not
    // "never asked".
    expect(m.get('coverage')!.available).toBe(false);
    expect(m.get('startup.app_startup')!.collector).toBe('hiprofiler');
    expect(m.get('render.hitch')!.collector).toBe('hidumper');
    expect(m.get('ui.tree')!.collector).toBe('uitest');
    expect(m.get('ui.gesture')!.collector).toBe('uitest');
  });

  it('marks mem.procfs available even when every binary is absent', () => {
    const s = buildMatrix({
      ...EMULATOR,
      binaries: { hitrace: false, hiperf: false, hidumper: false, hiprofiler_cmd: false, uitest: false },
    }).get('mem.procfs')!;
    expect(s.available).toBe(true);
    expect(s.fidelity).toBe('exact');
    expect(s.reason).toBeUndefined();
  });

  it('degrades every hitrace capability when hitrace is absent', () => {
    const m = buildMatrix({ ...EMULATOR, binaries: { ...EMULATOR.binaries, hitrace: false } });
    for (const id of ['trace.frames', 'trace.sched', 'trace.binder', 'trace.thread_state', 'render.vsync'] as CapabilityId[]) {
      const s = m.get(id)!;
      expect(s.available).toBe(false);
      expect(s.reason).toBe('hitrace not present on device');
      expect(s.collector).toBeUndefined();
    }
  });

  it('uses the fixed hiprofiler reason for every hiprofiler-backed capability', () => {
    const m = buildMatrix(EMULATOR);
    for (const id of [
      'mem.native_hook', 'mem.gpu', 'power.xpower', 'net.io', 'disk.io',
      'js.heap', 'startup.app_startup',
    ] as CapabilityId[]) {
      const s = m.get(id)!;
      expect(s.available).toBe(false);
      expect(s.reason).toBe('hiprofiler not present on device (hiprofiler_cmd missing)');
    }
  });

  it('uses the fixed pmu reason when hiperf reports no hardware events', () => {
    expect(buildMatrix(EMULATOR).get('perf.pmu')!.reason).toBe(
      'no hardware PMU events reported by hiperf list hw',
    );
  });

  it('uses the binary-name reason for other missing binaries', () => {
    const m = buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, uitest: false } });
    expect(m.get('ui.tree')!.reason).toBe('uitest not present on device');
    expect(m.get('ui.gesture')!.reason).toBe('uitest not present on device');
  });

  it('marks fps_live as proxy on emulator and exact on a real device', () => {
    const emu = buildMatrix(EMULATOR).get('render.fps_live')!;
    const real = buildMatrix(FULL_DEVICE).get('render.fps_live')!;
    expect(emu.available).toBe(true);
    expect(emu.collector).toBe('hidumper');
    expect(emu.fidelity).toBe('proxy');
    expect(real.fidelity).toBe('exact');
    expect(buildMatrix(FULL_DEVICE).get('render.hitch')!.fidelity).toBe('exact');
  });

  it('populates probe from inputs.probes using the binary-name key', () => {
    const m = buildMatrix({
      ...FULL_DEVICE,
      probes: { hitrace: p('which hitrace', '/bin/hitrace') },
    });
    expect(m.get('trace.frames')!.probe).toEqual(p('which hitrace', '/bin/hitrace'));
    expect(m.get('trace.sched')!.probe.command).toBe('which hitrace');
  });

  it('populates probe from inputs.probes using the full-command key', () => {
    const probe = p('which hiprofiler_cmd', 'MISSING');
    const m = buildMatrix({ ...EMULATOR, probes: { 'which hiprofiler_cmd': probe } });
    expect(m.get('mem.native_hook')!.probe).toEqual(probe);
    expect(m.get('startup.app_startup')!.probe).toEqual(probe);
  });

  it('populates the pmu probe from hiperf list hw', () => {
    const probe = p('hiperf list hw', '');
    const m = buildMatrix({ ...EMULATOR, probes: { 'hiperf list hw': probe } });
    expect(m.get('perf.pmu')!.probe).toEqual(probe);
  });

  it('prefers the pmu verdict probe over the hiperf binary probe', () => {
    const hw = p('hiperf list hw', '');
    const which = p('which hiperf', '/bin/hiperf');
    const m = buildMatrix({
      ...EMULATOR,
      probes: { 'hiperf list hw': hw, hiperf: which, 'which hiperf': which },
    });
    expect(m.get('perf.pmu')!.probe).toEqual(hw);
    expect(m.get('perf.samples')!.probe).toEqual(which);
  });

  it('falls back to an empty probe when no probe entry matches', () => {
    const s = buildMatrix({ ...EMULATOR, probes: {} }).get('ui.tree')!;
    expect(s.probe).toEqual({ command: '', stdout: '', stderr: '', code: 0 });
  });
});

describe('CapabilityMatrix', () => {
  it('has() means available, get() returns the stored state', () => {
    const m = new CapabilityMatrix([
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('a') },
      { id: 'perf.pmu', available: false, fidelity: 'exact', reason: 'x', probe: p('b') },
    ]);
    expect(m.has('trace.frames')).toBe(true);
    expect(m.has('perf.pmu')).toBe(false);
    expect(m.has('mem.gpu')).toBe(false);
    expect(m.get('perf.pmu')!.reason).toBe('x');
    expect(m.get('mem.gpu')).toBeUndefined();
  });

  it('satisfies synthesizes unprobed capabilities without mutating the matrix', () => {
    const m = new CapabilityMatrix([
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('a') },
    ]);
    const r = m.satisfies(['trace.frames', 'mem.gpu']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      {
        id: 'mem.gpu',
        available: false,
        fidelity: 'exact',
        reason: 'capability not probed',
        probe: { command: '', stdout: '', stderr: '', code: 0 },
      },
    ]);
    expect(m.all()).toHaveLength(1);
    expect(m.get('mem.gpu')).toBeUndefined();
  });

  it('satisfies returns ok when every required capability is available', () => {
    const m = buildMatrix(FULL_DEVICE);
    const r = m.satisfies(['trace.frames', 'perf.pmu', 'mem.gpu']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('all() does not mutate the stored order across calls', () => {
    const m = new CapabilityMatrix([
      { id: 'ui.tree', available: true, fidelity: 'exact', probe: p('a') },
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('b') },
    ]);
    expect(m.all().map((s: CapabilityState) => s.id)).toEqual(['trace.frames', 'ui.tree']);
    expect(m.all().map((s: CapabilityState) => s.id)).toEqual(['trace.frames', 'ui.tree']);
  });
});

describe('plugin-aware hiprofiler verdicts', () => {
  const list = (names: string[]): ProbeResult =>
    p('hiprofiler_cmd --list', names.map((n) => `capabilities {\n  name: "${n}"\n}`).join('\n'));

  it('marks mem.gpu unavailable when gpu-plugin is not offered', () => {
    const probe = list(['cpu-plugin']);
    const m = buildMatrix({
      ...FULL_DEVICE,
      hiprofilerPlugins: ['cpu-plugin'],
      probes: { 'hiprofiler_cmd --list': probe },
    });
    const s = m.get('mem.gpu')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('gpu-plugin');
    expect(s.probe).toEqual(probe);
  });

  it('marks mem.native_hook unavailable when nativehook is not offered', () => {
    const m = buildMatrix({
      abi: 'aarch64',
      isEmulator: false,
      binaries: { ...FULL_DEVICE.binaries },
      hiperfHwEvents: [],
      hiperfSwEvents: [],
      hiprofilerPlugins: ['gpu-plugin'],
      probes: {},
    });
    const s = m.get('mem.native_hook')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('nativehook');
  });

  it('gates each hiprofiler capability on its plugin when the list is known', () => {
    const m = buildMatrix({
      ...FULL_DEVICE,
      hiprofilerPlugins: [
        'cpu-plugin', 'gpu-plugin', 'xpower-plugin', 'nativehook', 'ftrace-plugin',
        'memory-plugin', 'network-plugin', 'diskio-plugin',
      ],
    });
    for (const id of [
      'mem.native_hook', 'mem.gpu', 'power.xpower',
      'net.io', 'disk.io', 'startup.app_startup',
    ] as CapabilityId[]) {
      expect(m.has(id), id).toBe(true);
    }
    // js.heap is not gated on a plugin at all: the plugin's presence does not
    // imply a consumer, so the row stays unavailable (pinned separately).
    expect(m.has('js.heap')).toBe(false);
  });

  it('reports js.heap unavailable even when the daemon lists memory-plugin', () => {
    // The plugin exists on the device but nothing in this package consumes its
    // js_heap_* tables, so "available" would be a claim the package cannot
    // honour. The reason must name what is missing, not just say "no".
    const caps = buildMatrix({
      ...FULL_DEVICE,
      hiprofilerPlugins: ['memory-plugin'],
    });
    expect(caps.get('js.heap')).toMatchObject({
      available: false,
      reason: expect.stringContaining('no analyzer'),
    });
    // The measured hidumper route is permission-gated too; an agent reading
    // the reason should not go hunting for a debug-signed build thinking that
    // alone would make the capability available.
    expect(caps.get('js.heap')!.reason).toContain('debug-signed or profilerable');
  });

  it('serves coverage from bjc_cov, and never claims it available', () => {
    // Before P8 coverage was gated on hiprofiler_cmd, so every device with
    // hiprofiler reported a capability nothing in the package could produce.
    const present = buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, bjc_cov: true } });
    const absent = buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, bjc_cov: false } });
    expect(present.get('coverage')!.available).toBe(false);
    expect(present.get('coverage')!.collector).toBeUndefined();
    expect(absent.get('coverage')!.reason).toBe('bjc_cov not present on device');
    expect(present.get('coverage')!.reason)
      .toBe('no coverage collector in this package consumes bjc_cov output');
  });

  it('keeps the binary-based verdicts when the plugin list is unknown', () => {
    // "Service not started": the matrix cannot see plugins, so hiprofiler_cmd's
    // presence is the only evidence there is.
    const m = buildMatrix({ ...FULL_DEVICE, hiprofilerPlugins: undefined });
    expect(m.get('mem.gpu')!.available).toBe(true);
    expect(m.get('mem.native_hook')!.available).toBe(true);
  });
});
