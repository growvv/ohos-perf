import type { CapabilityId } from '../device/capability';
import type { Frame } from '../query/frames';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** `frame_slice` provenance shared by every metric this analyzer emits. */
function provenance(ctx: AnalyzeContext, rows: number) {
  return {
    collector: 'hitrace+streamer',
    table: 'frame_slice',
    rows,
    device: ctx.deviceId,
  };
}

/**
 * HapRay's 60 Hz budget in nanoseconds.
 *
 * The comparison is done in integer nanoseconds rather than milliseconds so a
 * frame whose excess is exactly 2 or 6 budget units lands on the documented
 * side of the boundary. Converting through `16.67` makes 100.02ms compute as
 * `5.999999999999999` units in IEEE doubles and silently drops it to level 2.
 */
const FRAME_BUDGET_NS = 16_670_000;
/** Excess in budget units below this is level 1 (HapRay's `STUTTER_LEVEL_1_FRAMES`). */
const STUTTER_LEVEL_1_FRAMES = 2;
/** Excess in budget units below this is level 2 (HapRay's `STUTTER_LEVEL_2_FRAMES`). */
const STUTTER_LEVEL_2_FRAMES = 6;

/** How a stuttered frame compares with its vsync group's expected frame. */
interface StutterGrade {
  excessNs: number;
  excessFrames: number;
  level: 1 | 2 | 3;
  expectedDurNs: number;
}

/**
 * Grades `frame` against `expected`, ported from HapRay's stutter path.
 *
 * Negative excess is level 1. There is deliberately no `flag = 3` special
 * case: upstream's clause is unreachable because its stutter loop returns
 * before grading anything whose flag is not 1.
 */
function gradeStutter(frame: Frame, expected: Frame): StutterGrade {
  const excessNs = frame.dur - expected.dur;
  const excessFrames = excessNs / FRAME_BUDGET_NS;
  const level: 1 | 2 | 3 =
    excessFrames < STUTTER_LEVEL_1_FRAMES
      ? 1
      : excessFrames < STUTTER_LEVEL_2_FRAMES
        ? 2
        : 3;
  return { excessNs, excessFrames, level, expectedDurNs: expected.dur };
}

/** HapRay's process buckets, with its ui fallback for unknown processes. */
type ProcessClass = 'ui' | 'render' | 'sceneboard';

function processClassOf(name: string): ProcessClass {
  if (name === 'render_service') return 'render';
  if (name === 'ohos.sceneboard') return 'sceneboard';
  return 'ui';
}

/**
 * Mean `dur` of `frames`, in milliseconds; `0` for an empty set.
 *
 * Summation follows `frames` order (ts ascending), which is fixed, so the
 * result is bit-stable across runs (D5).
 */
function meanDurationMs(frames: Frame[]): number {
  if (frames.length === 0) return 0;
  let totalNs = 0;
  for (const frame of frames) totalNs += frame.dur;
  const ms = totalNs / frames.length / 1e6;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * One `jank` evidence per stuttered frame.
 *
 * The `window` is the frame's **own** `[ts, ts + dur]`, never the analysis
 * window. `evidenceId` hashes `kind|process|thread|frameNo|pid|startNs|endNs`
 * and `frame_no` is `0` on all 177 rows of the measured 249MB trace (like
 * `depth`, it is a reserved field the platform never fills). Using the
 * analysis window for every frame therefore reduces 60 jank evidences to 2
 * distinct ids on that trace — one per process name (`pbench.baseline`,
 * `render_service`) — and any downstream dedupe by id silently drops 58 of 60.
 * The per-frame window yields 60 distinct ids.
 *
 * `subject.frameNo` still carries `frame.frameNo` because that is the honest
 * value of the column, but it is **not** a unique key: it is `0` on every real
 * row. Uniqueness comes from the window.
 *
 * The process name is resolved from `frame.ipid` through `process.ipid`. When
 * the ipid is absent from `process` (or its name is NULL, which maps to `''`),
 * the subject reads `ipid:<n>` rather than borrowing the analyzed app's name:
 * attributing a render_service frame to the app would be a wrong answer, while
 * an ipid is at least a true identifier. Duplicate ipids resolve to the lowest
 * `process.id` row, matching `ProcessQuery.byName`'s deterministic tie-break.
 *
 * `originNs` is the `ts` of the first frame in the analyzed set. The `explain`
 * text prints the frame's offset from it, not the raw `ts`: `ts` is device
 * uptime (the measured trace's first jank is at 6382537.7ms, ~106 minutes of
 * uptime), so two captures from the same device produce unrelated numbers and
 * an absolute timestamp is useless for triage. The measured first jank is
 * 1955.4ms into the capture. The `window` and drill-down args stay absolute —
 * they must remain in the database's own time base for ids and queries.
 */
function jankEvidence(
  frame: Frame,
  processName: string,
  originNs: number,
  grade?: StutterGrade,
): Evidence {
  const durMs = frame.dur / 1e6;
  const offsetMs = (frame.ts - originNs) / 1e6;
  const startNs = frame.ts;
  const endNs = frame.ts + frame.dur;

  return evidence({
    kind: 'jank',
    severity: 'warn',
    subject: { process: processName, frameNo: frame.frameNo },
    // The frame's own interval, not ctx.window — see the doc comment above.
    window: { startNs, endNs },
    // `ipid` rather than `frameNo`: frameNo is 0 on every real row and carries
    // no information, while ipid says which process owns the frame. `offsetMs`
    // is the human-facing time; `durMs` is the frame's own cost.
    signals: {
      durMs,
      offsetMs,
      vsync: frame.vsync,
      ipid: frame.ipid,
      ...(grade === undefined
        ? {}
        : {
            excessMs: grade.excessNs / 1e6,
            excessFrames: grade.excessFrames,
            stutterLevel: grade.level,
          }),
    },
    // Names the platform's own verdict rather than comparing against a
    // 60Hz budget: 11 of the 60 measured flag-1 frames have `dur` under 16.7ms
    // (lowest 0.35ms), so a "(budget 16.7ms)" clause would present them as
    // self-contradictory and an agent would dismiss them as false positives.
    // `flag = 1` means the platform judged the frame late — not that it missed
    // a fixed budget this library chose. When an expected frame exists, the
    // HapRay-compatible level and excess are appended as a second clause.
    explain:
      `${processName} frame at ${offsetMs.toFixed(1)}ms flagged late by platform ` +
      `(dur ${durMs.toFixed(1)}ms, vsync ${frame.vsync})` +
      (grade === undefined
        ? ''
        : `; level ${grade.level} (excess ${(grade.excessNs / 1e6).toFixed(1)}ms ` +
          `over expected ${(grade.expectedDurNs / 1e6).toFixed(1)}ms)`),
    drillDown: [
      { label: 'Frame detail', tool: 'frames.get', args: { id: frame.id }, returns: 'Frame' },
      {
        label: 'Callstack for frame',
        tool: 'callstack.range',
        args: { startNs, endNs },
        returns: 'CallstackEvent[]',
      },
    ],
  });
}

/**
 * The `no_data` evidence for a window that contains no actual frames.
 *
 * This is not an error, but it has two distinct causes that must not be
 * conflated, because six zero metrics look identical either way:
 *
 * - `frames.length === 0` — nothing was captured at all. An idle UI legitimately
 *   produces zero frames (Phase B measured 0 frames across 3 idle seconds), so
 *   the explain says the UI may have been static.
 * - `frames.length > 0` but every row is an expect frame (`type = 1`) — the
 *   query worked and the trace has data, but no actual frame was rendered in
 *   this window. Saying "no frames captured" would be false; the explain names
 *   the expect-frame count instead.
 * - `frames.length > 0` with no actual and no expect rows (a `type` outside
 *   `{0, 1}`). This does not occur on the measured traces, where `type` is
 *   always 0 or 1, but the branch is reachable in principle. It falls back to
 *   the "no frames captured" text; `estRows` still reports `totalRows`, so the
 *   drill-down never claims 0 rows when `frames.all()` would return some.
 *
 * Returning an empty `metrics` array with no evidence (or six zeros with no
 * evidence) would be indistinguishable from a broken query, so the evidence
 * carries the explanation and a drill-down that lets an agent confirm it.
 */
function noDataEvidence(
  ctx: AnalyzeContext,
  expectFrames: number,
  totalRows: number,
): Evidence {
  // First non-empty name: an empty `subject.process` would make the evidence id
  // and the explain text unattributable. Falls back to the package name.
  const process =
    ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
  const expectOnly = expectFrames > 0;
  const rowWord = expectFrames === 1 ? 'row' : 'rows';
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process },
    window: ctx.window,
    signals: expectOnly ? { expectFrames } : {},
    explain: expectOnly
      ? `only expected frames in window (${expectFrames} ${rowWord}, type=1); ` +
        'no actual frames were rendered'
      : 'no frames captured in window; the UI may have been static (no redraw)',
    drillDown: [
      {
        label: 'All frames in window',
        tool: 'frames.all',
        args: { window: ctx.window },
        returns: 'Frame[]',
        // The rows `frames.all(window)` would actually return, not just the
        // expect count: an unknown-type window has rows but no expect frames.
        estRows: totalRows,
      },
    ],
    key: 'frames:no-data',
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Sort order for evidence: `(kind, window.startNs, id)`.
 *
 * Not `frameNo`: it is `0` on every real row, so ordering by it is a no-op and
 * the array order would depend on insertion instead (a D5 violation).
 * `window.startNs` is the per-frame start for jank evidence, so this sorts
 * jank frames chronologically; `id` breaks the remaining ties deterministically.
 */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Analyzer for `frame_slice`: counts, jank/empty rates, mean duration, fps,
 * and one evidence per stuttered frame.
 *
 * ## Metric semantics (measured on the 249MB emulator trace)
 *
 * - `frame.count` — **actual** frames only (`type = 0`): 169. Includes empty
 *   frames and flag-3 (RS-App abnormal) frames. Expect frames (`type = 1`) are
 *   excluded; on the measured trace 161 of 169 expect rows also have a NULL
 *   flag and are invisible to `FrameQuery` anyway.
 * - `frame.rendered.count` — actual frames that are not empty
 *   (`flag !== 2`): 161. **This is the jank denominator.** It is emitted
 *   separately because `stuttered / frame.count` (60/169 = 35.50%) differs
 *   from `frame.jank.rate` (60/161 = 37.27%) and a consumer recomputing the
 *   rate from `frame.count` would otherwise have no way to see why. Like the
 *   jank denominator, this count **includes flag-3 (RS-App abnormal) frames**:
 *   on the measured trace the 161 contains the 10 flag-3 rows. Only empty
 *   frames are excluded.
 * - `frame.jank.rate` — `stuttered / rendered * 100` (37.27%). HapRay's
 *   `frame_analyzer_stuttered.py` skips expect frames and `flag = 2` frames
 *   before counting, so empty frames cannot dilute the rate: a frame with
 *   nothing to draw cannot stutter. Note `rendered` still includes flag 3, so
 *   the 161 denominator contains the 10 flag-3 rows, matching HapRay.
 * - `frame.empty.rate` — `empty / actual * 100` (8/169 = 4.73%). The
 *   denominator stays `actual` because the question is "what fraction of
 *   actual frames had nothing to draw". The 8 flag-2 **expect** frames are not
 *   counted: this metric is about actual frames only.
 * - `frame.avg.duration` — mean `dur` of rendered frames (35.836ms), not of
 *   actual frames (34.172ms): an empty frame's `dur` is not render cost. The
 *   mean is over the same rendered set as the jank denominator, so it
 *   **includes flag-3 (RS-App abnormal) frames** (10 on the measured trace).
 * - `frame.fps` — actual frames per second over the **frame span**, not
 *   `ctx.window` (5.917 fps over 28.562s). A caller-supplied window wider than
 *   the captured frames would systematically under-report fps. This is a
 *   whole-span average, **not** HapRay's 1-second sliding-window average
 *   (`FPS_WINDOW_SIZE_MS = 1000`), which is why its fidelity is
 *   `'approximate'` rather than `'exact'`.
 *
 * Every division is guarded so no metric is ever `NaN` or `Infinity`:
 * `JSON.stringify(NaN)` is `null`, which would silently turn a bad value into
 * a missing one.
 *
 * ## Zero-actual windows
 *
 * `metrics: []` (no frames at all) or six zero metrics (expect frames only)
 * are both paired with a `no_data` evidence whose `explain` distinguishes the
 * two cases. Zeros without an explanation are indistinguishable from a broken
 * query, and "only expect frames" is a real, measured shape of the data (161
 * of 169 expect rows on the measured trace have a NULL flag and are invisible
 * here, but a window can still land on flagged expect rows).
 *
 * ## Determinism
 *
 * `metrics` is sorted by `id`; `evidence` by `(kind, startNs, id)`. The
 * analyzer reads the same database through `FrameQuery` (ordered by `ts`) and
 * performs no time- or randomness-dependent work, so identical input yields
 * byte-identical output (D5).
 */
export class FrameAnalyzer implements Analyzer {
  readonly id = 'frames';
  readonly requires: CapabilityId[] = ['trace.frames'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const frames = ctx.frames.all(ctx.window);

    if (frames.length === 0) {
      return { metrics: [], evidence: [noDataEvidence(ctx, 0, 0)] };
    }

    const actual = frames.filter((frame) => frame.type === 0);
    const expect = frames.filter((frame) => frame.type === 1);
    const rendered = actual.filter((frame) => frame.flag !== 2);
    const empty = actual.filter((frame) => frame.flag === 2);
    const stuttered = rendered.filter((frame) => frame.flag === 1);

    // No actual frames but at least one expect frame: the six metrics below
    // are honest zeros, but without evidence they are indistinguishable from a
    // broken analyzer. The no_data item names the expect-frame count so the
    // zeros are attributable.
    const noData =
      actual.length === 0 ? noDataEvidence(ctx, expect.length, frames.length) : undefined;

    // Span of the captured actual frames, not of ctx.window: a caller window
    // wider than the capture would under-report fps. `actual` preserves
    // `frames`' ts order, so its ends bound the actual-frame span. Measured
    // trace: 28.562s. An empty `actual` yields 0 rather than a division by 0.
    const first = actual[0];
    const last = actual[actual.length - 1];
    const spanNs = first && last ? last.ts + last.dur - first.ts : 0;

    const prov = provenance(ctx, frames.length);
    const metrics: Metric[] = [
      metric({
        id: 'frame.count',
        value: actual.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.rendered.count',
        value: rendered.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.jank.rate',
        value: rendered.length > 0 ? (stuttered.length / rendered.length) * 100 : 0,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.empty.rate',
        value: actual.length > 0 ? (empty.length / actual.length) * 100 : 0,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.avg.duration',
        value: meanDurationMs(rendered),
        unit: 'ms',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.fps',
        value: spanNs > 0 ? actual.length / (spanNs / 1e9) : 0,
        unit: 'fps',
        provenance: prov,
        // Whole-span average, not HapRay's 1s sliding-window average.
        fidelity: 'approximate',
      }),
    ];

    // Lowest `process.id` wins for a duplicate ipid, matching byName()'s
    // deterministic tie-break. `all()` is already ordered by id.
    const processNames = new Map<number, string>();
    for (const process of ctx.processes.all()) {
      if (!processNames.has(process.ipid)) {
        processNames.set(process.ipid, process.name);
      }
    }
    const nameOf = (frame: Frame): string => processNames.get(frame.ipid) ?? '';

    // Expected frame per vsync: the first `type = 1` row ordered by (ts, id).
    // HapRay takes the first row of its unordered group; the explicit
    // tie-break makes the choice reproducible (D5) and is the only divergence.
    const expectedByVsync = new Map<number, Frame>();
    for (const frame of [...frames].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
      if (frame.type === 1 && !expectedByVsync.has(frame.vsync)) {
        expectedByVsync.set(frame.vsync, frame);
      }
    }

    const graded = stuttered.map((frame) => {
      const expected = expectedByVsync.get(frame.vsync);
      return { frame, grade: expected === undefined ? undefined : gradeStutter(frame, expected) };
    });
    const levelCounts: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    let unpaired = 0;
    for (const item of graded) {
      if (item.grade === undefined) unpaired += 1;
      else levelCounts[item.grade.level] += 1;
    }

    const renderedByClass: Record<ProcessClass, number> = { ui: 0, render: 0, sceneboard: 0 };
    for (const frame of rendered) renderedByClass[processClassOf(nameOf(frame))] += 1;
    const stutteredByClass: Record<ProcessClass, number> = { ui: 0, render: 0, sceneboard: 0 };
    for (const frame of stuttered) stutteredByClass[processClassOf(nameOf(frame))] += 1;

    metrics.push(
      metric({
        id: 'frame.stutter.count',
        value: stuttered.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
      }),
      metric({
        id: 'frame.stutter.unpaired.count',
        value: unpaired,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
      }),
      ...[1, 2, 3].map((level) =>
        metric({
          id: `frame.stutter.level${level}.count`,
          value: levelCounts[level as 1 | 2 | 3],
          unit: 'count',
          provenance: prov,
          fidelity: 'exact',
        }),
      ),
      ...(['ui', 'render', 'sceneboard'] as const).flatMap((processClass) => [
        metric({
          id: `frame.stutter.${processClass}.count`,
          value: stutteredByClass[processClass],
          unit: 'count',
          provenance: prov,
          fidelity: 'exact',
        }),
        metric({
          id: `frame.stutter.${processClass}.rate`,
          value:
            renderedByClass[processClass] > 0
              ? (stutteredByClass[processClass] / renderedByClass[processClass]) * 100
              : 0,
          unit: '%',
          provenance: prov,
          fidelity: 'exact',
        }),
      ]),
    );

    // Trace-relative origin for the human-readable explain text. `frames` is
    // ordered by ts, so its first entry is the earliest captured frame.
    const originNs = frames[0].ts;
    const evidenceItems: Evidence[] = graded.map(({ frame, grade }) => {
      const name = nameOf(frame);
      return jankEvidence(
        frame,
        name === '' ? `ipid:${frame.ipid}` : name,
        originNs,
        grade,
      );
    });
    if (noData !== undefined) evidenceItems.push(noData);

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
