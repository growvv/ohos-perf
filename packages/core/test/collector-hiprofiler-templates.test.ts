import { describe, it, expect } from 'vitest';
import {
  PLANE_A_PLUGINS,
  ftracePlugin,
  gpuPlugin,
  memoryPlugin,
  nativehookPlugin,
  xpowerPlugin,
} from '../src/collectors/hiprofiler/templates';
import { OhosPerfError } from '../src/errors';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OhosPerfError).code;
  }
  return undefined;
};

describe('hiprofiler plugin templates', () => {
  it('keeps the HapRay ftrace event set and buffer verbatim', () => {
    const plugin = ftracePlugin();
    expect(plugin.pluginName).toBe('ftrace-plugin');
    expect(plugin.configData).toContain('ftrace_events: "sched/sched_switch"');
    expect(plugin.configData).toContain('ftrace_events: "power/cpu_idle"');
    expect(plugin.configData).toContain('hitrace_categories: "sched"');
    expect(plugin.configData).toContain('buffer_size_kb: 204800');
    expect(plugin.configData).toContain('clock: "boot"');
  });

  it('replaces the ftrace categories when asked', () => {
    const plugin = ftracePlugin({ categories: ['sched', 'graphic'] });
    expect(plugin.configData).toContain('hitrace_categories: "sched"');
    expect(plugin.configData).toContain('hitrace_categories: "graphic"');
    expect(plugin.configData).not.toContain('hitrace_categories: "ability"');
  });

  it('expands nativehook pids into one integer line each', () => {
    const plugin = nativehookPlugin({ pids: [6115, 6120] });
    expect(plugin.pluginName).toBe('nativehook');
    expect(plugin.configData).toContain('expand_pids: 6115');
    expect(plugin.configData).toContain('expand_pids: 6120');
    expect(plugin.configData).not.toContain('"6115,6120"');
  });

  it('rejects an empty pid list', () => {
    expect(codeOf(() => nativehookPlugin({ pids: [] }))).toBe('HIPROFILER_BAD_PIDS');
  });

  it('rejects a non-integer pid', () => {
    expect(codeOf(() => nativehookPlugin({ pids: [1.5] }))).toBe('HIPROFILER_BAD_PIDS');
  });

  it('configures memory-plugin so it emits per-process rows', () => {
    // Measured: an empty config_data yields only `stat`; these three fields are
    // what makes `process_measure` appear.
    const plugin = memoryPlugin({ statisticsIntervalMs: 500 });
    expect(plugin.pluginName).toBe('memory-plugin');
    expect(plugin.configData).toContain('statistics_interval: 500');
    expect(plugin.configData).toContain('report_process_tree: true');
    expect(plugin.configData).toContain('report_sysmem: true');
  });

  it('rejects a non-positive memory statistics interval before any device call', () => {
    expect(codeOf(() => memoryPlugin({ statisticsIntervalMs: 0 })))
      .toBe('HIPROFILER_BAD_SAMPLE_INTERVAL');
  });

  it('defines gpu and xpower as empty config blocks', () => {
    expect(gpuPlugin()).toEqual({ pluginName: 'gpu-plugin', configData: '' });
    expect(xpowerPlugin()).toEqual({ pluginName: 'xpower-plugin', configData: '' });
  });

  it('lists the three argument-free plane-A plugins in order', () => {
    expect(PLANE_A_PLUGINS.map((p) => p.pluginName))
      .toEqual(['ftrace-plugin', 'gpu-plugin', 'xpower-plugin']);
  });
});
