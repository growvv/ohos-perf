/**
 * hiprofiler plugin templates.
 *
 * Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 *
 * HapRay's `FTracePluginTemplate` is copied here field for field; its comment
 * lines are dropped because the config builder only accepts `field: value`
 * lines. The nativehook template keeps HapRay's field set, with one measured
 * correction: `expand_pids` is a repeated integer, not a comma-joined string
 * (the daemon rejects `expand_pids: "1"` with "Expected integer").
 */

import { OhosPerfError } from '../../errors';
import type { HiprofilerPlugin } from './config';

/** HapRay's hitrace category list, in its original order. */
export const FTRACE_CATEGORIES: readonly string[] = [
  'ability', 'ace', 'app', 'ark', 'binder', 'disk', 'freq', 'graphic', 'idle',
  'irq', 'memreclaim', 'mmc', 'multimodalinput', 'notification', 'ohos',
  'pagecache', 'rpc', 'sched', 'sync', 'window', 'workq', 'zaudio', 'zcamera',
  'zimage', 'zmedia',
];

/** HapRay's ftrace event list, in its original order. */
const FTRACE_EVENTS: readonly string[] = [
  'sched/sched_switch',
  'power/suspend_resume',
  'sched/sched_wakeup',
  'sched/sched_wakeup_new',
  'sched/sched_waking',
  'sched/sched_process_exit',
  'sched/sched_process_free',
  'task/task_newtask',
  'task/task_rename',
  'power/cpu_frequency',
  'power/cpu_idle',
];

export interface FtraceOptions {
  /** Override the hitrace category list (default: {@link FTRACE_CATEGORIES}). */
  readonly categories?: readonly string[];
  /** Buffer size in KB; HapRay's value is 204800. */
  readonly bufferKb?: number;
}

/** The full-trace plugin: frames, sched, binder and thread state tables. */
export function ftracePlugin(opts: FtraceOptions = {}): HiprofilerPlugin {
  const categories = opts.categories ?? FTRACE_CATEGORIES;
  const bufferKb = opts.bufferKb ?? 204800;
  const lines: string[] = [];
  for (const event of FTRACE_EVENTS) lines.push(`ftrace_events: "${event}"`);
  for (const category of categories) lines.push(`hitrace_categories: "${category}"`);
  lines.push(
    `buffer_size_kb: ${bufferKb}`,
    'flush_interval_ms: 1000',
    'flush_threshold_kb: 4096',
    'parse_ksyms: true',
    'clock: "boot"',
    'trace_period_ms: 200',
    'debug_on: false',
  );
  return { pluginName: 'ftrace-plugin', configData: lines.join('\n') };
}

export interface NativehookOptions {
  /** App pids to instrument. Must be non-empty; `expand_pids` is repeated. */
  readonly pids: readonly number[];
  readonly maxStackDepth?: number;
}

/** Native allocation profiling (`mem.native_hook`). */
export function nativehookPlugin(opts: NativehookOptions): HiprofilerPlugin {
  if (opts.pids.length === 0) {
    throw new OhosPerfError('nativehook requires at least one pid', {
      code: 'HIPROFILER_BAD_PIDS',
    });
  }
  for (const pid of opts.pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new OhosPerfError(`invalid nativehook pid ${String(pid)}`, {
        code: 'HIPROFILER_BAD_PIDS',
      });
    }
  }
  const lines: string[] = [];
  for (const pid of opts.pids) lines.push(`expand_pids: ${pid}`);
  lines.push(
    'save_file: false',
    'smb_pages: 16384',
    `max_stack_depth: ${opts.maxStackDepth ?? 20}`,
    'string_compressed: true',
    'fp_unwind: true',
    'blocked: true',
    'callframe_compress: true',
    'record_accurately: true',
    'offline_symbolization: true',
    'startup_mode: false',
    'malloc_free_matching_interval: 10',
  );
  return { pluginName: 'nativehook', sampleIntervalMs: 5000, configData: lines.join('\n') };
}

/** GPU counters (`mem.gpu`). Measured to complete with an empty config block. */
export function gpuPlugin(): HiprofilerPlugin {
  return { pluginName: 'gpu-plugin', configData: '' };
}

/** Power/energy counters (`power.xpower`). */
export function xpowerPlugin(): HiprofilerPlugin {
  return { pluginName: 'xpower-plugin', configData: '' };
}

/** The plugins that need no per-capture arguments. */
export const PLANE_A_PLUGINS: readonly HiprofilerPlugin[] = [
  ftracePlugin(),
  gpuPlugin(),
  xpowerPlugin(),
];
