/**
 * Device object and collection orchestration.
 *
 * {@link connect} is the only place that resolves a transport and a target;
 * every later stage receives a {@link Device} whose identity, capabilities and
 * shell are already established. {@link Device.collect} then owns the one
 * operation that touches both the device and the filesystem: capture a trace
 * and turn it into a queryable scene.
 */

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { HitraceCollector } from '../collectors/hitrace';
import { HiprofilerCollector } from '../collectors/hiprofiler';
import { MIN_BUFFER_PAGES, type HiprofilerPlugin } from '../collectors/hiprofiler/config';
import {
  ftracePlugin,
  gpuPlugin,
  memoryPlugin,
  nativehookPlugin,
  xpowerPlugin,
} from '../collectors/hiprofiler/templates';
import { HidumperCollector, type HidumperCapture } from '../collectors/hidumper';
import { HiperfCollector, hiperfEventsFor, type HiperfCapture } from '../collectors/hiperf';
import { ProcfsCollector, type ProcfsSample } from '../collectors/procfs';
import { UitestCollector } from '../collectors/uitest';
import type { UiNode } from '../query/ui';
import type { TraceCollectOptions } from '../collectors/types';
import { frameDelta } from '../analyze/render';
import { buildMatrix, type CapabilityMatrix } from './capability';
import { DeviceNotFoundError, OhosPerfError } from '../errors';
import { writeSceneMetadata } from '../ingest/metadata';
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

/** The hiprofiler plugins a caller can request by name. */
export const HIPROFILER_PLUGIN_NAMES = ['ftrace', 'gpu', 'xpower', 'nativehook', 'memory'] as const;
export type HiprofilerPluginName = (typeof HIPROFILER_PLUGIN_NAMES)[number];

export interface HiprofilerCollectRequest {
  /**
   * Plugins to run, by name; defaults to `['ftrace']`. `nativehook` resolves
   * the app's pids on the device after any cold start, so the caller does not
   * need a pid.
   */
  readonly plugins?: readonly HiprofilerPluginName[];
  /** Ring buffer pages; the daemon requires at least 16384. */
  readonly bufferPages?: number;
}

export interface CollectOptions extends TraceCollectOptions {
  /** Directory that holds this scene's artifacts. Reused across captures. */
  sceneRoot: string;
  /**
   * Also sample `/proc/<pid>/status` (and `smaps_rollup`) for `app`.
   * `true` uses the collector's default interval; an object overrides it.
   */
  procfs?: boolean | { intervalMs?: number };
  /** Launch this ability on `app` before recording (a cold-start capture). */
  coldStart?: { ability: string };
  /**
   * Capture the trace through hiprofiler instead of hitrace. The resulting
   * `.htrace` converts through the same Streamer into the same schema.
   */
  hiprofiler?: HiprofilerCollectRequest;
  /**
   * Also record a `perf.data` with `hiperf record --app`. Requires a
   * **debuggable** app; a release app is rejected with `HIPERF_NOT_DEBUGGABLE`.
   */
  hiperf?: { frequency?: number; events?: readonly string[]; callStacks?: boolean };
  /** Also sample the RenderService fps/hitch counters for `durationMs`. */
  hidumper?: boolean;
  /** Also dump the on-screen UI tree. */
  uitest?: boolean;
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
  hiprofiler?: HiprofilerCollector;
  procfs?: ProcfsCollector;
  hiperf?: HiperfCollector;
  hidumper?: HidumperCollector;
  uitest?: UitestCollector;
}

/** Bare device/application/ability names, safe to interpolate into a shell command. */
const BARE_NAME = /^[A-Za-z0-9_.]+$/;
const NS_PER_SECOND = 1_000_000_000;

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
    const require = (id: 'trace.frames' | 'perf.samples' | 'render.fps_live' | 'ui.tree'): void => {
      if (caps.has(id)) return;
      const reason = caps.get(id)?.reason;
      throw new OhosPerfError(
        `collect requires ${id} capability` + (reason ? ` (${reason})` : ''),
        { code: 'MISSING_CAPABILITY' },
      );
    };
    require('trace.frames');
    // hiperf is gated on `perf.samples` only, never on `perf.pmu`: the PMU is
    // absent on the emulator while the hiperf binary (and software events) is
    // present, and a hardware-event request there is rejected by the collector
    // with the software events the probe found.
    if (opts.hiperf !== undefined) require('perf.samples');
    if (opts.hidumper === true) require('render.fps_live');
    if (opts.uitest === true) require('ui.tree');

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
        const hdc = this.requireHdc();

        // Validation happens before any device call: a bad request must not
        // leave a half-started capture behind. The app name is interpolated
        // into `pidof`, `aa start` and the hitrace command, so it is checked
        // here rather than inside ProcfsCollector (which would run only after
        // hitrace had already begun).
        const wantsProcfs = opts.procfs !== undefined && opts.procfs !== false;
        const wantsHiprofiler = opts.hiprofiler !== undefined;
        const pluginNames: readonly HiprofilerPluginName[] =
          opts.hiprofiler?.plugins ?? ['ftrace'];
        for (const name of pluginNames) {
          if (!HIPROFILER_PLUGIN_NAMES.includes(name)) {
            throw new OhosPerfError(
              `unknown hiprofiler plugin ${JSON.stringify(name)};` +
                ` expected one of ${HIPROFILER_PLUGIN_NAMES.join(', ')}`,
              { code: 'COLLECT_BAD_PLUGIN' },
            );
          }
        }
        if (wantsHiprofiler && pluginNames.length === 0) {
          // An explicitly empty list is a request for a session that records
          // nothing; only an omitted list gets the ftrace default.
          throw new OhosPerfError(
            'hiprofiler requires at least one plugin (omit plugins to use ftrace)',
            { code: 'COLLECT_BAD_PLUGIN' },
          );
        }
        const bufferPages = opts.hiprofiler?.bufferPages;
        if (
          bufferPages !== undefined &&
          (!Number.isSafeInteger(bufferPages) || bufferPages < MIN_BUFFER_PAGES)
        ) {
          throw new OhosPerfError(
            `bufferPages must be a safe integer no smaller than ${MIN_BUFFER_PAGES}` +
              ` (got ${String(bufferPages)})`,
            { code: 'HIPROFILER_BAD_BUFFER' },
          );
        }
        // An app-less capture is valid for the device-wide collectors, so the
        // requirement lives with the modes that resolve a pid from it. Every
        // check below runs before the first device call.
        const app = opts.app;
        const requireApp = (mode: string, reason: string): string => {
          if (app === undefined || app === '') {
            throw new OhosPerfError(
              `${mode} capture requires an app (CollectOptions.app)${reason}`,
              { code: 'COLLECT_APP_REQUIRED' },
            );
          }
          return app;
        };
        const wantsNativehook = wantsHiprofiler && pluginNames.includes('nativehook');
        const needsPid = wantsProcfs || wantsNativehook || opts.coldStart !== undefined;
        const pidApp = needsPid
          ? requireApp(
              wantsNativehook ? 'nativehook' : wantsProcfs ? 'procfs' : 'cold start',
              wantsNativehook || wantsProcfs ? ' to resolve a pid' : ' to launch an ability',
            )
          : undefined;
        if (pidApp !== undefined && !BARE_NAME.test(pidApp)) {
          throw new OhosPerfError(
            `app must be a bare name matching ${String(BARE_NAME)}` +
              ` (got ${JSON.stringify(pidApp)})`,
            { code: 'COLLECT_BAD_APP' },
          );
        }
        if (opts.coldStart !== undefined) {
          const { ability } = opts.coldStart;
          if (!BARE_NAME.test(ability)) {
            throw new OhosPerfError(
              `cold start requires a bare ability name matching ${String(BARE_NAME)}` +
                ` (got ${JSON.stringify(ability)})`,
              { code: 'COLLECT_BAD_COLD_START' },
            );
          }
        }

        const wantsHiperf = opts.hiperf !== undefined;
        const wantsHidumper = opts.hidumper === true;
        const wantsUitest = opts.uitest === true;
        // Only hiperf needs a pid. hidumper and uitest read the whole screen,
        // so they work with no app at all.
        const hiperfApp = wantsHiperf ? requireApp('hiperf', ' to profile') : undefined;
        if (hiperfApp !== undefined && !BARE_NAME.test(hiperfApp)) {
          throw new OhosPerfError(
            `app must be a bare name matching ${String(BARE_NAME)}` +
              ` (got ${JSON.stringify(hiperfApp)})`,
            { code: 'COLLECT_BAD_APP' },
          );
        }

        // Resolve the sample event before any device call. Without a PMU,
        // hiperf's own default is a hardware event that samples nothing and
        // exits 0 — an empty recording that looks exactly like an idle app.
        // The probe's event lists decide: a PMU-less device gets a software
        // event, and an explicit hardware event there is rejected.
        const hiperfEvents = wantsHiperf
          ? hiperfEventsFor(
              opts.hiperf?.events,
              caps.has('perf.pmu'),
              [...this.snapshot.hiperfHwEvents, ...this.snapshot.hiperfSwEvents],
            )
          : undefined;

        mkdirSync(layout.root, { recursive: true });

        // Every optional collector overwrites its artifact during the capture.
        // If a collector or the conversion later fails, the old scene must stay
        // exactly as it was, so remember the previous bytes (if any) before
        // anything writes them. Only requested artifacts are remembered: a
        // stale file for a collector that did not run is removed on success,
        // not restored.
        const previous = new Map<string, Buffer | undefined>();
        const remember = (path: string): void => {
          previous.set(path, existsSync(path) ? readFileSync(path) : undefined);
        };
        if (wantsProcfs) remember(layout.procfsFile);
        if (wantsHiperf) {
          remember(layout.perfFile!);
          // A previous perf.db is converted output, not collector output, but
          // a failed perf conversion must leave the old one in place too.
          remember(layout.perfDb!);
        }
        if (wantsHidumper) remember(layout.hidumperFile);
        if (wantsUitest) remember(layout.uiFile);

        // Host wall-clock at capture start, recorded for humans only.
        const startedAtMs = Date.now();

        // The startup analyzer's fallback needs a device-uptime marker in the
        // same clock base as trace `ts`. A failed read is not a capture failure:
        // omit the field rather than losing the whole trace.
        const startedAtNs = await readUptimeNs(hdc, this.id);

        if (opts.coldStart !== undefined) {
          // `pidApp` is defined whenever `coldStart` is set: the gate above
          // includes it in `needsPid`.
          const result = await hdc.shell(
            this.id,
            `aa start -a ${opts.coldStart.ability} -b ${pidApp!}`,
          );
          if (result.code !== 0) {
            throw new OhosPerfError(
              `aa start failed for ${pidApp!}/${opts.coldStart.ability}` +
                ` (exit ${result.code})`,
              { code: 'COLLECT_COLD_START_FAILED' },
            );
          }
        }

        // The nativehook template needs pids, and only the device knows them.
        // Resolve them after a cold start (the old process is gone) and before
        // the session starts. A failure here happens before any trace capture,
        // so there is no partial scene to repair.
        let hiprofilerPlugins: HiprofilerPlugin[] | undefined;
        let nativehookPids: number[] | undefined;
        if (wantsHiprofiler) {
          hiprofilerPlugins = [];
          // Explicit per-name dispatch: a name added to the enum without a
          // branch here is a compile error rather than a silent nativehook
          // capture (the previous else-fallback would have done exactly that).
          for (const name of pluginNames) {
            switch (name) {
              case 'ftrace':
                hiprofilerPlugins.push(ftracePlugin());
                break;
              case 'gpu':
                hiprofilerPlugins.push(gpuPlugin());
                break;
              case 'xpower':
                hiprofilerPlugins.push(xpowerPlugin());
                break;
              case 'memory':
                hiprofilerPlugins.push(memoryPlugin());
                break;
              case 'nativehook':
                nativehookPids = await resolvePids(hdc, this.id, pidApp!);
                hiprofilerPlugins.push(nativehookPlugin({ pids: nativehookPids }));
                break;
            }
          }
        }

        const collector = this.deps.collector ?? new HitraceCollector();
        const traceOpts: TraceCollectOptions = {
          app,
          durationMs: opts.durationMs,
          bufferKb: opts.bufferKb,
          categories: opts.categories,
        };
        const runTrace = async (): Promise<void> => {
          if (hiprofilerPlugins === undefined) {
            await collector.collect(hdc, this.id, traceOpts, layout);
            return;
          }
          const hipro = this.deps.hiprofiler ?? new HiprofilerCollector();
          await hipro.collect(hdc, this.id, {
            durationMs: opts.durationMs,
            plugins: hiprofilerPlugins,
            ...(bufferPages === undefined ? {} : { bufferPages }),
          }, layout);
        };

        let procfsSamples: ProcfsSample[] | undefined;
        let hiperfCapture: HiperfCapture | undefined;
        let hidumperCapture: HidumperCapture | undefined;
        let uiNodes: UiNode[] | undefined;
        try {
          // Every requested collector starts in the same tick with the same
          // duration, and `Promise.all` rejects with the first failure: a
          // partial scene must never be presented as complete. The trace is
          // first in the array so a failure message names it first.
          const runs: Array<Promise<unknown>> = [runTrace()];
          if (wantsProcfs) {
            const procfs = this.deps.procfs ?? new ProcfsCollector();
            const intervalMs =
              typeof opts.procfs === 'object' ? opts.procfs.intervalMs : undefined;
            runs.push(procfs.collect(
              hdc,
              this.id,
              { app: pidApp!, durationMs: opts.durationMs, intervalMs },
              layout,
            ));
          }
          if (wantsHiperf) {
            const hiperf = this.deps.hiperf ?? new HiperfCollector();
            runs.push(hiperf.collect(hdc, this.id, {
              durationMs: opts.durationMs,
              app: hiperfApp!,
              ...(opts.hiperf?.frequency === undefined
                ? {}
                : { frequency: opts.hiperf.frequency }),
              ...(hiperfEvents === undefined ? {} : { events: hiperfEvents }),
              ...(opts.hiperf?.callStacks === undefined
                ? {}
                : { callStacks: opts.hiperf.callStacks }),
            }, layout));
          }
          if (wantsHidumper) {
            const hidumper = this.deps.hidumper ?? new HidumperCollector();
            runs.push(hidumper.collect(
              hdc,
              this.id,
              { durationMs: opts.durationMs },
              layout,
            ));
          }
          if (wantsUitest) {
            const uitest = this.deps.uitest ?? new UitestCollector();
            runs.push(uitest.collect(hdc, this.id, {}, layout));
          }

          // `allSettled`, not `all`: a rejection must not return while the
          // sibling collectors are still running, because they would write
          // this attempt's artifacts *after* the restore and leave the
          // previous scene holding a mixture of old and new files.
          //
          // The rethrown error is still the *chronologically* first failure,
          // as `Promise.all` reported it: each run records its rejection at
          // the moment it happens, so which message a caller sees does not
          // depend on array order.
          let firstFailure: { error: unknown } | undefined;
          const guarded = runs.map((run) => run.catch((error: unknown) => {
            firstFailure ??= { error };
            throw error;
          }));
          const settled = await Promise.allSettled(guarded);
          if (firstFailure !== undefined) throw firstFailure.error;

          // Index-aligned results: the trace is [0] and contributes nothing.
          const results = settled.map(
            (outcome) => (outcome as PromiseFulfilledResult<unknown>).value,
          );
          let index = 1;
          if (wantsProcfs) procfsSamples = results[index++] as ProcfsSample[];
          if (wantsHiperf) hiperfCapture = results[index++] as HiperfCapture;
          if (wantsHidumper) hidumperCapture = results[index++] as HidumperCapture;
          if (wantsUitest) uiNodes = results[index] as UiNode[];
        } catch (err) {
          // Every collector has settled, so nothing can overwrite the restored
          // bytes afterwards. The old scene must stay coherent, so put every
          // remembered file back (or remove the new one). Never mask the
          // capture error.
          restoreArtifacts(previous);
          throw err;
        }

        // Convert unconditionally instead of deleting a pre-existing trace.db.
        // `ingestScene` skips conversion when trace.db exists, so reusing a
        // sceneRoot would otherwise silently open the previous capture's
        // database. `Streamer.convert` writes to a sibling temp path and
        // renames over `layout.traceDb` only after a successful conversion, so
        // an existing good database survives a failed conversion. Deleting it
        // first would leave the caller with neither the old scene nor a new
        // one. On success the fresh database is already in place, and
        // `ingestScene` simply opens it.
        //
        // scene.json is scene metadata, not capture metadata: write it only
        // after conversion succeeds. On a failed conversion the untouched old
        // scene.json keeps describing the old trace.db, so the scene directory
        // stays coherent instead of pairing new metadata with an old database.
        const streamer = this.deps.streamer ?? new Streamer();
        // The trace conversion commits its database before the perf conversion
        // runs, so a perf failure would otherwise leave a new trace.db beside
        // the old scene.json — new trace data under the old app identity,
        // pids and collector list. Move the previous databases aside by
        // rename (never into memory: a trace database can be hundreds of
        // megabytes) and put them back if either conversion fails.
        const previousTraceDb = setAside(layout.traceDb, previousSuffix);
        const previousTraceSidecar = setAside(`${layout.traceDb}.ohos.ts`, previousSuffix);
        try {
          await streamer.convert(layout.traceFile, layout.traceDb);
          // The perf capture converts the same way and must succeed before the
          // metadata is written: a scene.json that claims a hiperf capture
          // whose database never appeared would be a lie the analyzers act on.
          if (wantsHiperf) await streamer.convert(layout.perfFile!, layout.perfDb!);
        } catch (err) {
          // The collectors have already written this attempt's artifacts.
          // Restore the previous files byte-for-byte, or remove them when the
          // previous scene had none, so the directory holds exactly the old
          // scene's artifacts. Never mask the conversion error.
          restoreArtifacts(previous);
          restoreAside(previousTraceDb);
          restoreAside(previousTraceSidecar);
          throw err;
        }
        // Both conversions succeeded: the new databases are the scene now.
        discardAside(previousTraceDb);
        discardAside(previousTraceSidecar);

        // A re-capture into the same sceneRoot that did not run a collector must
        // not leave the previous capture's artifact behind: analyze would
        // otherwise report `mem.*` as exact, `perf.samples` as available, or
        // `ui.get` rows, for a capture that never produced them. This is a
        // scene mutation, so it belongs on the success path with the metadata
        // write; a failed conversion leaves the whole old scene intact.
        // ENOENT is the normal case and is ignored.
        if (!wantsProcfs) removeIfPresent(layout.procfsFile);
        if (!wantsHiperf) {
          removeIfPresent(layout.perfFile!);
          removeIfPresent(layout.perfDb!);
        }
        if (!wantsHidumper) removeIfPresent(layout.hidumperFile);
        if (!wantsUitest) removeIfPresent(layout.uiFile);

        writeSceneMetadata(layout, {
          version: 1,
          // An app-less capture records the absence rather than an undefined
          // name: scene.json stays a valid descriptor a later analyze reads,
          // and the empty name resolves to no pid, never to a fabricated app.
          app: {
            packageName: app ?? '',
            processNames: app === undefined || app === '' ? [] : [app],
          },
          // The procfs collector resolves the pid for its samples; reuse it
          // instead of issuing another `pidof` device call. Without procfs the
          // nativehook resolution (if any) already holds the app's pids.
          pids: procfsSamples === undefined
            ? nativehookPids ?? []
            : [...new Set(procfsSamples.map((sample) => sample.pid))],
          deviceId: this.id,
          ...(startedAtNs === undefined ? {} : { startedAtNs }),
          capture: {
            startedAtMs,
            durationMs: opts.durationMs,
            // Fixed order, so two captures of the same request are identical.
            collectors: [
              wantsHiprofiler ? 'hiprofiler' : 'hitrace',
              ...(wantsProcfs ? ['procfs'] : []),
              ...(wantsHiperf ? ['hiperf'] : []),
              ...(wantsHidumper ? ['hidumper'] : []),
              ...(wantsUitest ? ['uitest'] : []),
            ],
            // A zero-count capture is recorded explicitly: "the collector ran
            // and saw nothing" is a different fact from "it did not run", and
            // the CLI prints the number so neither can read as the other.
            ...(hiperfCapture === undefined
              ? {}
              : { hiperf: { samples: hiperfCapture.samples } }),
            ...(hidumperCapture === undefined
              ? {}
              : { hidumper: { frames: frameDelta(hidumperCapture).frames } }),
            ...(uiNodes === undefined ? {} : { uitest: { nodes: uiNodes.length } }),
          },
        });

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
 * Remove another capture's artifact from a scene that did not produce it.
 * Only ENOENT is ignored; any other filesystem error is a real failure and
 * must not leave stale data silently in place.
 */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
}

/** Suffix for a previous database parked beside the one being replaced. */
const previousSuffix = '.previous-ohosperf';

/**
 * Move an existing database aside so a conversion that replaces it can be
 * undone by a rename, without reading a potentially huge file into memory.
 * Returns the parked path, or `undefined` when there was nothing to move.
 */
function setAside(path: string, suffix: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const parked = `${path}${suffix}`;
  // A leftover from a crashed earlier attempt must not block the rename.
  rmSync(parked, { force: true });
  renameSync(path, parked);
  return parked;
}

/** Put a parked database back in place, replacing whatever this attempt wrote. */
function restoreAside(parked: string | undefined): void {
  if (parked === undefined) return;
  try {
    const original = parked.slice(0, -previousSuffix.length);
    rmSync(original, { force: true });
    renameSync(parked, original);
  } catch {
    // Deliberately swallowed: never replace the real failure.
  }
}

/** Delete a parked database after the conversion that replaced it succeeded. */
function discardAside(parked: string | undefined): void {
  if (parked === undefined) return;
  rmSync(parked, { force: true });
}

/**
 * Undo a failed capture: put every remembered file back byte-for-byte, or
 * delete this attempt's file when the previous scene had none. Errors here are
 * best-effort — the capture or conversion error is the one the caller must see.
 */
function restoreArtifacts(previous: Map<string, Buffer | undefined>): void {
  for (const [path, bytes] of previous) {
    try {
      if (bytes === undefined) {
        removeIfPresent(path);
      } else {
        writeFileSync(path, bytes);
      }
    } catch {
      // Deliberately swallowed: never replace the real failure.
    }
  }
}

/**
 * Read device uptime in nanoseconds from `/proc/uptime`'s first token.
 *
 * Returns `undefined` on any failure (missing file, nonzero exit, a
 * non-numeric or negative token): a missing start marker only disables the
 * startup analyzer's fallback, so losing the whole capture would be worse.
 * The value is `seconds * 1e9`, matching the trace's nanosecond clock base.
 */
async function readUptimeNs(
  hdc: Hdc,
  target: string,
): Promise<number | undefined> {
  try {
    const result = await hdc.shell(target, 'cat /proc/uptime');
    if (result.code !== 0) return undefined;
    const first = result.stdout.trim().split(/\s+/)[0];
    // `Number('') === 0`, so an empty response must not become a valid zero
    // marker: it would address the trace origin instead of the capture start.
    if (first === undefined || first === '') return undefined;
    const seconds = Number(first);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    const ns = seconds * NS_PER_SECOND;
    return Number.isFinite(ns) && ns >= 0 ? ns : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the running process ids of `app` for the nativehook template.
 *
 * `pidof` prints every match, which is what a multi-process app needs. A
 * non-zero exit or empty output means no process is running: starting a
 * hiprofiler session without pids would record nothing and look like a quiet
 * app, so this is an error with an actionable message.
 */
async function resolvePids(hdc: Hdc, target: string, app: string): Promise<number[]> {
  const result = await hdc.shell(target, `pidof ${app}`);
  const pids = result.stdout
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token))
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.length === 0) {
    throw new OhosPerfError(
      `nativehook requires a running process for ${app};` +
        ` pidof exited ${result.code} with ${JSON.stringify(result.stdout.trim())}`,
      { code: 'COLLECT_NATIVEHOOK_NO_PID' },
    );
  }
  return [...new Set(pids)];
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
