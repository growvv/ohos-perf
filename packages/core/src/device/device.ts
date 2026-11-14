/**
 * Device object and collection orchestration.
 *
 * {@link connect} is the only place that resolves a transport and a target;
 * every later stage receives a {@link Device} whose identity, capabilities and
 * shell are already established. {@link Device.collect} then owns the one
 * operation that touches both the device and the filesystem: capture a trace
 * and turn it into a queryable scene.
 */

import { mkdirSync } from 'node:fs';
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
  /**
   * Injection points for tests and callers that already own a transport.
   * Production callers leave both unset.
   */
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

/**
 * A probed device.
 *
 * Construction is pure: no transport is resolved or spawned. `kind`, `abi`,
 * `capabilities()` and `collect()`'s capability gate work from the snapshot
 * alone, which is what makes a directly constructed Device useful for offline
 * analysis and tests. `deps.hdc` is **required** for anything that talks to the
 * device — {@link Device.shell} and {@link Device.collect} — and those throw
 * `DEVICE_NO_HDC` when it is absent. `connect()` always supplies one.
 */
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
      /**
       * Capture the trace, then convert and open it as a scene.
       *
       * The scene directory is created before the capture because hitrace's
       * `recv` needs its destination to exist, and `ingestScene` only creates
       * directories on its write path (after the capture). Consequence: a
       * capture that fails can leave the directory behind, empty. It is never
       * populated on the failure path.
       */
      ingest: async (): Promise<Scene> => {
        const layout = createSceneLayout(opts.sceneRoot);

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

        // Convert unconditionally instead of deleting a pre-existing trace.db.
        // `ingestScene` skips conversion when trace.db exists, so reusing a
        // sceneRoot would otherwise silently open the previous capture's
        // database. `Streamer.convert` writes to a sibling temp path and
        // renames over `layout.traceDb` only after a successful conversion, so
        // an existing good database survives a failed conversion. Deleting it
        // first would leave the caller with neither the old scene nor a new
        // one. On success the fresh database is already in place, and
        // `ingestScene` simply opens it.
        const streamer = this.deps.streamer ?? new Streamer();
        await streamer.convert(layout.traceFile, layout.traceDb);

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
  opts: ConnectOptions = {},
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
    // A caller who named a target and got an opaque "no device" error cannot
    // tell whether the id was wrong or the device is merely offline, and
    // retrying with the same id produces the same error. Distinguish the two
    // cases in both the code and the message. `targetsOutput` stays raw.
    const requestedSeen =
      opts.target !== undefined && targets.some((t) => t.id === opts.target);
    if (requestedSeen) {
      const err = new DeviceNotFoundError(raw, { code: 'TARGET_NOT_CONNECTED' });
      // DeviceNotFoundError's message is fixed by its signature, but the
      // caller-facing text must name the rejected id.
      err.message = `Requested target "${opts.target}" is present but not connected.` +
        ` \`hdc list targets\` output: ${raw}`;
      throw err;
    }
    throw new DeviceNotFoundError(raw, { code: 'NO_CONNECTED_TARGETS' });
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
