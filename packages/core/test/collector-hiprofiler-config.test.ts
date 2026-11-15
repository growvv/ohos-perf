import { describe, it, expect } from 'vitest';
import { buildHiprofilerConfig } from '../src/collectors/hiprofiler/config';
import { OhosPerfError } from '../src/errors';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OhosPerfError).code;
  }
  return undefined;
};

describe('buildHiprofilerConfig', () => {
  it('emits the session envelope the daemon requires', () => {
    const text = buildHiprofilerConfig({
      plugins: [{ pluginName: 'gpu-plugin', configData: '' }],
    });
    expect(text).toBe([
      'request_id: 1',
      'session_config {',
      '  buffers {',
      '    pages: 16384',
      '  }',
      '}',
      'plugin_configs {',
      '  plugin_name: "gpu-plugin"',
      '  sample_interval: 1000',
      '  config_data {',
      '  }',
      '}',
      '',
    ].join('\n'));
  });

  it('indents config data inside its block', () => {
    const text = buildHiprofilerConfig({
      plugins: [{
        pluginName: 'nativehook',
        sampleIntervalMs: 5000,
        configData: 'expand_pids: 6115\nexpand_pids: 6120',
      }],
    });
    expect(text).toContain([
      '  config_data {',
      '    expand_pids: 6115',
      '    expand_pids: 6120',
      '  }',
    ].join('\n'));
    expect(text).toContain('  sample_interval: 5000');
  });

  it('accepts no plugins', () => {
    const text = buildHiprofilerConfig({ plugins: [] });
    expect(text).not.toContain('plugin_configs');
    expect(text).toContain('pages: 16384');
  });

  it('rejects a buffer page count below the measured minimum', () => {
    expect(codeOf(() => buildHiprofilerConfig({ plugins: [], bufferPages: 4096 })))
      .toBe('HIPROFILER_BAD_BUFFER');
  });

  it('rejects a plugin name that is not a bare token', () => {
    expect(codeOf(() => buildHiprofilerConfig({
      plugins: [{ pluginName: 'gpu plugin"; rm -rf /', configData: '' }],
    }))).toBe('HIPROFILER_BAD_PLUGIN');
  });

  it('rejects config data that is not a field/value line', () => {
    expect(codeOf(() => buildHiprofilerConfig({
      plugins: [{ pluginName: 'gpu-plugin', configData: 'not a protobuf line' }],
    }))).toBe('HIPROFILER_BAD_CONFIG_DATA');
  });
});
