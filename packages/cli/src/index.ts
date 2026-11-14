#!/usr/bin/env node
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  CapabilityMatrix,
  FrameAnalyzer,
  FrameQuery,
  Hdc,
  ProcessQuery,
  Streamer,
  connect,
  createSceneLayout,
  ingestScene,
  type CapabilityState,
} from '@ohos-perf/core';
import { doctorReport, type DeviceLike, type DoctorDeps } from './doctor';

/**
 * Kept in sync with `package.json` by hand: tsup does not inject the package
 * version, and `--version` is the one place the two must agree.
 */
const VERSION = '0.1.0';

/** Production wiring for {@link doctorReport}; the report itself does no IO. */
function realDeps(): DoctorDeps {
  return {
    resolveHdc: () => new Hdc().resolvePath(),
    async resolveStreamer() {
      const streamer = new Streamer();
      return { path: await streamer.resolvePath(), version: await streamer.version() };
    },
    connectDevice: () => connect() as Promise<DeviceLike>,
  };
}

/** Mark/collector/fidelity line shared by `doctor` and `caps` human output. */
function formatCapability(state: CapabilityState, idWidth: number, collectorWidth: number): string {
  const mark = state.available ? '✓' : '✗';
  const collector = state.collector ?? '—';
  const line = `${mark} ${state.id.padEnd(idWidth)}  ${collector.padEnd(collectorWidth)}  ${state.fidelity}`;
  return state.reason === undefined ? line : `${line}  ${state.reason}`;
}

function printCapabilities(states: CapabilityState[]): void {
  if (states.length === 0) {
    process.stdout.write('no capabilities (no device probed)\n');
    return;
  }
  const idWidth = Math.max(...states.map((s) => s.id.length));
  const collectorWidth = Math.max(...states.map((s) => (s.collector ?? '—').length));
  for (const state of states) {
    process.stdout.write(formatCapability(state, idWidth, collectorWidth) + '\n');
  }
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** `caps` needs the same hdc gate as `doctor` for its exit code, nothing else. */
async function capsReport(): Promise<{ hdcOk: boolean; hdcError?: string; capabilities: CapabilityState[] }> {
  try {
    await new Hdc().resolvePath();
  } catch (err) {
    return { hdcOk: false, hdcError: err instanceof Error ? err.message : String(err), capabilities: [] };
  }
  try {
    const device = await connect();
    const matrix = await device.capabilities();
    return { hdcOk: true, capabilities: matrix.all() };
  } catch {
    // Toolchain present, no usable device: environmental, not a failure.
    return { hdcOk: true, capabilities: [] };
  }
}

const program = new Command();

program
  .name('ohos-perf')
  .description('Performance analysis for OpenHarmony devices and captured traces')
  .version(VERSION);

program
  .command('doctor')
  .description('check the hdc/trace_streamer toolchain and the attached device')
  .option('--json', 'print the report as JSON')
  .action(async (opts: { json?: boolean }) => {
    const report = await doctorReport(realDeps());
    if (opts.json) {
      printJson(report);
    } else {
      process.stdout.write(`hdc      ${report.hdc.ok ? `ok  ${report.hdc.path}` : `FAIL  ${report.hdc.error}`}\n`);
      process.stdout.write(
        `streamer ${report.streamer.ok ? `ok  ${report.streamer.path} (${report.streamer.version})` : `FAIL  ${report.streamer.error}`}\n`,
      );
      if (report.device === undefined) {
        process.stdout.write('device   none attached\n');
      } else {
        process.stdout.write(`device   ${report.device.id} (${report.device.kind}, ${report.device.abi})\n`);
      }
      printCapabilities(report.capabilities);
    }
    // Only a missing toolchain is a failure; capability absence is a degraded
    // device, not a broken install.
    if (!report.hdc.ok) process.exitCode = 1;
  });

program
  .command('caps')
  .description('print the capability matrix of the attached device')
  .option('--json', 'print the capabilities as JSON')
  .action(async (opts: { json?: boolean }) => {
    const report = await capsReport();
    if (!report.hdcOk) {
      process.stderr.write(`hdc unavailable: ${report.hdcError}\n`);
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      printJson(report.capabilities);
    } else {
      printCapabilities(report.capabilities);
    }
  });

program
  .command('analyze')
  .description('analyze a captured scene directory (trace.db or trace.htrace)')
  .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
  .option('--app <packageName>', 'app package name, for evidence wording')
  .option('--json', 'print the analysis result as JSON')
  .action(async (sceneDir: string, opts: { app?: string; json?: boolean }) => {
    try {
      // `createSceneLayout` joins onto the argument, so a relative path or a
      // shell-style `/c/...` must be normalized against the current drive
      // before it is handed over.
      const layout = createSceneLayout(resolve(sceneDir));
      const scene = await ingestScene(new Streamer(), layout);
      try {
        const result = await new FrameAnalyzer().run({
          frames: new FrameQuery(scene.traceDb),
          processes: new ProcessQuery(scene.traceDb),
          app: { packageName: opts.app ?? 'unknown', pids: [], processNames: [] },
          // The whole database: a CLI run has no capture window to honour.
          window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
          // Offline analysis probes no device; the analyzer does not consult
          // caps (the caller gates on `requires`), so this only fills the shape.
          caps: new CapabilityMatrix([
            {
              id: 'trace.frames',
              available: true,
              collector: 'hitrace',
              fidelity: 'exact',
              probe: { command: '', stdout: '', stderr: '', code: 0 },
            },
          ]),
          deviceId: 'offline',
        });

        if (opts.json) {
          printJson(result);
        } else {
          for (const metric of result.metrics) {
            process.stdout.write(`${metric.id}  ${metric.value} ${metric.unit} (${metric.fidelity})\n`);
          }
          const jank = result.evidence.filter((item) => item.kind === 'jank').length;
          process.stdout.write(`evidence  ${result.evidence.length} items (jank: ${jank})\n`);
        }
      } finally {
        // Windows keeps the file handle open otherwise, so a second analysis
        // of the same scene would fail.
        scene.close();
      }
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
