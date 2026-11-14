/**
 * Device object and collection orchestration.
 *
 * {@link connect} is the only place that resolves a transport and a target;
 * every later stage receives a {@link Device} whose identity, capabilities and
 * shell are already established. {@link Device.collect} then owns the one
 * operation that touches both the device and the filesystem: capture a trace
 * and turn it into a queryable scene.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { HitraceCollector } from '../collectors/hitrace';
import type { TraceCollectOptions } from '../collectors/types';
import { buildMatrix, type CapabilityMatrix } from './capability';
import { DeviceNotFoundError, OhosPerfError } from '../errors';
import {
  createSceneLayout,
  ingestScene,
  type Scene,
} from '../ingest/scene';
import { Streamer } from '../ingest/streamer';
import { Hdc } from '../transport/hdc';
import { runProbe, type ProbeRunner, type ProbeSnapshot } from './probe';

export interface ConnectOptions {
  /** Explicit target id. When omitted the first connected target is used. */
  target?: string;
  /** Explicit hdc executable; otherwise the normal SDK/PATH search runs. */
  hdcPath?: string;
  /** Explicit trace_streamer executable; otherwise the normal search runs. */
  streamerPath?: string;
}

/**
 * Injection points used by tests (and by callers that already own a transport).
 * Production callers leave both unset.
 */
export interface ConnectOverrides {
  hdc?: Hdc;
  probe?: (runner: ProbeRunner) => Promise<ProbeSnapshot>;
}

export interface CollectOptions extends TraceCollectOptions {
  /** Directory that holds this scene's artifacts. Reused across captures. */
  sceneRoot: string;
}

export interface CollectSession {
  /** Capture, then convert and open the scene. */
  ingest(): Promise<Scene>;
}

/** Dependencies a Device uses. All default to their production implementations. */
export interface DeviceDeps {
  hdc?: Hdc;
  streamer?: Streamer;
  collector?: HitraceCollector;
}

export class Device {
  readonly id: string;
  readonly kind: 'real' | 'emulator';
  readonly abi: string;

  private readonly snapshot: ProbeSnapshot;
  private readonly deps: DeviceDeps;
  private capabilitiesPromise?: Promise<CapabilityMatrix>;

  constructor(id: string, snapshot: ProbeSnapshot, deps: DeviceDeps = {}) {
    this.id = id;
    this.snapshot = snapshot;
    this.deps = deps;
    this.kind = snapshot.identity.isEmulator ? 'emulator' : 'real';
    this.abi = snapshot.identity.abi;
  }

  /**
   * Capability verdicts for this device. Built once from the probe snapshot and
   * cached: the matrix is pure data and the probe is not re-run.
   */
  capabilities(): Promise<CapabilityMatrix> {
    this.capabilitiesPromise ??= Promise.resolve(buildMatrix(this.snapshot));
    return this.capabilitiesPromise;
  }

  /** Run a command on this device through the transport, targeting `this.id`. */
  shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.requireHdc().shell(this.id, cmd);
  }

  /**
   * Prepare a capture session. The capability gate runs here so a device that
   * cannot produce frames fails before any device state is touched.
   */
  async collect(opts: CollectOptions): Promise<CollectSession> {
    const caps = await this.capabilities();
    if (!caps.has('trace.frames')) {
      const reason = caps.get('trace.frames')?.reason;
      throw new OhosPerfError(
        'collect requires trace.frames capability' + (reason ? ` (${reason})` : ''),
        { code: 'MISSING_CAPABILITY' },
      );
    }

    return {
      ingest: async (): Promise<Scene> => {
        const layout = createSceneLayout(opts.sceneRoot);

        // hitrace's recv needs the destination directory to exist. ingestScene
        // would create it, but only after the capture has already run.
        mkdirSync(layout.root, { recursive: true });

        const collector = this.deps.collector ?? new HitraceCollector();
        await collector.collect(
          this.requireHdc(),
          this.id,
          {
            app: opts.app,
            durationMs: opts.durationMs,
            bufferKb: opts.bufferKb,
            categories: opts.categories,
          },
          layout,
        );

        // ingestScene() deliberately skips conversion when trace.db exists, so
        // a database left by an earlier capture in this same sceneRoot would
        // silently hide the trace that was just recorded. The database is an
        // artifact of one capture, and this capture has not been converted
        // yet; delete it so conversion is not skipped. This runs only after a
        // successful capture, so a failed capture leaves the previous scene
        // intact. Only the database is removed, never the directory.
        if (existsSync(layout.traceDb)) rmSync(layout.traceDb, { force: true });

        const streamer = this.deps.streamer ?? new Streamer();
        return ingestScene(streamer, layout);
      },
    };
  }

  private requireHdc(): Hdc {
    if (this.deps.hdc === undefined) {
      throw new OhosPerfError(
        `Device ${this.id} has no hdc transport configured`,
        { code: 'DEVICE_NO_HDC' },
      );
    }
    return this.deps.hdc;
  }
}

/**
 * Find a usable device and probe it.
 *
 * Success is decided solely by the `connected` flag from `hdc list targets -v`.
 * `hdc tconn` is issued for its side effect only: measured USB devices answer
 * `[Fail]CreateConnect failed` while working, and hdc exits 0 even when it has
 * not connected anything, so neither output nor exit code is evidence.
 *
 * When no usable target exists, the error carries the raw listing verbatim
 * (`listTargetsRaw().raw`) rather than a reassembled string, so the user sees
 * exactly what hdc said.
 */
export async function connect(
  opts: ConnectOptions & ConnectOverrides = {},
): Promise<Device> {
  const hdc = opts.hdc ?? new Hdc({ hdcPath: opts.hdcPath });

  // `listTargets()` is the documented selection surface: only rows whose
  // status is `Connected` are usable. The raw text is fetched separately, and
  // only on the failure path, so the happy path spawns hdc once.
  const targets = await hdc.listTargets();
  const selected =
    opts.target === undefined
      ? targets.find((t) => t.connected)
      : targets.find((t) => t.id === opts.target && t.connected);

  if (selected === undefined) {
    const { raw } = await hdc.listTargetsRaw();
    throw new DeviceNotFoundError(raw);
  }

  // Best effort, never a gate: see above.
  await hdc.tconn(selected.id);

  const probe = opts.probe ?? runProbe;
  const snapshot = await probe({
    shell: (cmd) => hdc.shell(selected.id, cmd),
  });

  return new Device(selected.id, snapshot, {
    hdc,
    streamer: new Streamer({ streamerPath: opts.streamerPath }),
  });
}
