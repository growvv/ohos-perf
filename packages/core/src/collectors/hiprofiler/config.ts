/**
 * hiprofiler session config builder.
 *
 * `hiprofiler_cmd -c <file>` parses the file as protobuf text for the
 * `CreateSessionRequest` message. Two fields are load-bearing and were measured
 * on a real device (Mate 60, API 26):
 *
 *   - `session_config.buffers.pages` must be at least 16384; 4096 is rejected
 *     before a session is created.
 *   - every `plugin_configs` entry needs a `config_data { }` block, even an
 *     empty one. Without it the daemon answers `unknown plugin: <name>` and
 *     `CreateSession FAIL`, which reads like a name problem but is not.
 *
 * Only field/value lines are accepted in `configData`: the text is embedded in
 * a device command path, and rejecting anything else keeps a malformed or
 * injected line from reaching the daemon.
 */

import { OhosPerfError } from '../../errors';

/** One plugin block in a hiprofiler session config. */
export interface HiprofilerPlugin {
  /** Plugin name as listed by `hiprofiler_cmd --list`, e.g. `gpu-plugin`. */
  readonly pluginName: string;
  /** Sampling interval; the daemon's own default is 1000. */
  readonly sampleIntervalMs?: number;
  /**
   * Body of the plugin's `config_data` block, one `field: value` per line.
   * Empty string is valid and yields an empty block.
   */
  readonly configData: string;
}

export interface HiprofilerConfigOptions {
  readonly plugins: readonly HiprofilerPlugin[];
  /** Ring-buffer pages. Defaults to 16384, the measured minimum. */
  readonly bufferPages?: number;
}

/** Measured: `pages: 4096` fails to create a session. */
export const MIN_BUFFER_PAGES = 16384;
export const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

const PLUGIN_NAME = /^[a-z][a-z0-9_-]*$/;
const CONFIG_DATA_LINE = /^[A-Za-z0-9_]+: .+$/;

/**
 * Render a complete `CreateSessionRequest` in protobuf text format.
 *
 * Output is deterministic: plugin blocks appear in the caller's order, fields
 * in a fixed order, and the text ends with one newline.
 */
export function buildHiprofilerConfig(opts: HiprofilerConfigOptions): string {
  const pages = opts.bufferPages ?? MIN_BUFFER_PAGES;
  if (!Number.isSafeInteger(pages) || pages < MIN_BUFFER_PAGES) {
    throw new OhosPerfError(
      `hiprofiler buffer pages must be an integer >= ${MIN_BUFFER_PAGES}` +
        ` (got ${String(pages)})`,
      { code: 'HIPROFILER_BAD_BUFFER' },
    );
  }

  const lines: string[] = [
    'request_id: 1',
    'session_config {',
    '  buffers {',
    `    pages: ${pages}`,
    '  }',
    '}',
  ];

  for (const plugin of opts.plugins) {
    if (!PLUGIN_NAME.test(plugin.pluginName)) {
      throw new OhosPerfError(
        `invalid hiprofiler plugin name ${JSON.stringify(plugin.pluginName)}`,
        { code: 'HIPROFILER_BAD_PLUGIN' },
      );
    }
    const interval = plugin.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval <= 0) {
      throw new OhosPerfError(
        `invalid hiprofiler sample interval ${String(interval)}`,
        { code: 'HIPROFILER_BAD_SAMPLE_INTERVAL' },
      );
    }

    lines.push('plugin_configs {');
    lines.push(`  plugin_name: "${plugin.pluginName}"`);
    lines.push(`  sample_interval: ${interval}`);
    lines.push('  config_data {');
    for (const raw of plugin.configData.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      if (!CONFIG_DATA_LINE.test(line)) {
        throw new OhosPerfError(
          `invalid hiprofiler config_data line ${JSON.stringify(raw)}`,
          { code: 'HIPROFILER_BAD_CONFIG_DATA' },
        );
      }
      lines.push(`    ${line}`);
    }
    lines.push('  }');
    lines.push('}');
  }

  return `${lines.join('\n')}\n`;
}
