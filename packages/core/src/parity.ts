/**
 * The HapRay parity ledger: one row per capability in the source-level
 * inventory of ArkAnalyzer-HapRay rev `bd5c98a` (2026-11-18).
 *
 * This exists because the claim drifted. The README said "18 ported / 9
 * partial / 8 missing" long after six releases had moved rows, and nothing
 * failed when it did — the numbers were prose. Here every row is data, the
 * summary is computed, and `parity.test.ts` checks the ported rows against the
 * analyzers the engine actually registers.
 *
 * The numbering is the inventory's own (`gap-analysis.md`), and it is what
 * the README and the site quote. Each `reason` for a non-ported row names what
 * is absent, so "not worth it" and "not done" are distinguishable.
 *
 * **Re-pinned from `9386e4e` to `bd5c98a`** in 0.23.0. The 428 commits between
 * them added three actions (`build`, `root-cause`, and an LLM exploration
 * strategy inside `haptest`) and a thermal collector. Rows 1–35 keep their
 * numbers; the new capabilities are appended so a reader can tell the original
 * inventory from what followed it.
 */

/** How much of one HapRay capability this package implements. */
export type ParityStatus = 'ported' | 'partial' | 'missing' | 'out';

export interface ParityRow {
  /** The inventory's row number, 1-based. */
  readonly row: number;
  /** The capability, as the inventory names it. */
  readonly name: string;
  readonly status: ParityStatus;
  /**
   * What is absent, for a row that is not fully ported. Empty for `ported`.
   * A `missing` row is a gap this project intends to close; an `out` row is a
   * prerequisite this package refuses to ship.
   */
  readonly reason: string;
  /**
   * The analyzer class that carries this capability, when one analyzer does.
   * Checked against `defaultAnalyzers()`: a row cannot claim `ported` on the
   * strength of prose alone.
   */
  readonly analyzer?: string;
}

/**
 * Every capability, with the status this package's code supports today.
 *
 * The moves since the inventory was written: `0.4.0` the report layer (33),
 * `0.5.0` frame load (9), `0.6.0` native memory (19), `0.7.0` hilog (30),
 * `0.8.0` run-only preparation (2), `0.9.0` UI capture (7) and UI comparison
 * (32) and animation (31, partial), `0.10.0` static HAP (25) and HAP size
 * (26) and static report artifacts (34), `0.11.0` flamegraph (22) and symbol
 * statistics (23), `0.12.0` the step DSL (3) and case discovery (1) and
 * per-step orchestration (6).
 */
export const PARITY_ROWS: readonly ParityRow[] = [
  {
    row: 1,
    name: 'Scripted performance test execution (`perf`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 2,
    name: 'Run-only preparation (`prepare`)',
    status: 'ported',
    reason: '',
  },
  { row: 3, name: 'YAML UI test DSL', status: 'ported', reason: '' },
  {
    row: 4,
    name: 'HapTest autonomous exploration (`haptest`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 5,
    name: 'LLM GUI agent (`gui-agent`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 6,
    name: 'Per-step capture orchestration',
    status: 'ported',
    reason: '',
  },
  { row: 7, name: 'UI capture per step', status: 'ported', reason: '' },
  {
    row: 8,
    name: 'Frame stutter / FPS analysis',
    status: 'ported',
    reason: '',
    analyzer: 'FrameAnalyzer',
  },
  {
    row: 9,
    name: 'Frame load / instruction attribution',
    status: 'ported',
    reason: '',
    analyzer: 'FrameLoadAnalyzer',
  },
  {
    row: 10,
    name: 'Empty-frame analysis',
    status: 'ported',
    reason: '',
    analyzer: 'EmptyFrameAnalyzer',
  },
  {
    row: 11,
    name: 'VSync anomaly',
    status: 'ported',
    reason: '',
    analyzer: 'VsyncAnalyzer',
  },
  {
    row: 12,
    name: 'RenderService skip reverse tracing',
    status: 'ported',
    reason: '',
    analyzer: 'RsSkipAnalyzer',
  },
  {
    row: 13,
    name: 'IPC binder analysis',
    status: 'ported',
    reason: '',
    analyzer: 'BinderAnalyzer',
  },
  {
    row: 14,
    name: 'Fault tree core sections',
    status: 'ported',
    reason: '',
    analyzer: 'FaultTreeAnalyzer',
  },
  {
    row: 15,
    name: 'Fault tree `ipc_binder` section',
    status: 'ported',
    reason: '',
    analyzer: 'FaultTreeAnalyzer',
  },
  {
    row: 16,
    name: 'GC pressure',
    status: 'ported',
    reason: '',
    analyzer: 'GcAnalyzer',
  },
  {
    row: 17,
    name: 'Component reuse',
    status: 'ported',
    reason: '',
    analyzer: 'ComponentReuseAnalyzer',
  },
  {
    row: 18,
    name: 'Thread wakeup chain',
    status: 'ported',
    reason: '',
    analyzer: 'ThreadAnalyzer',
  },
  {
    row: 19,
    name: 'Native memory analysis',
    status: 'ported',
    reason: '',
    analyzer: 'NativeMemoryAnalyzer',
  },
  {
    row: 20,
    name: 'JS heap snapshot capture',
    status: 'ported',
    reason: '',
  },
  {
    row: 21,
    name: 'Cold start redundant-file I/O',
    status: 'ported',
    reason: '',
    analyzer: 'RedundantFileAnalyzer',
  },
  {
    row: 22,
    name: 'Flamegraph generation',
    status: 'ported',
    reason: '',
    analyzer: 'FlamegraphAnalyzer',
  },
  {
    row: 23,
    name: 'Symbol statistics',
    status: 'ported',
    reason: '',
    analyzer: 'SymbolsAnalyzer',
  },
  {
    row: 24,
    name: 'Coverage',
    status: 'ported',
    reason: '',
  },
  {
    row: 25,
    name: 'Static HAP tech-stack analysis',
    status: 'ported',
    reason: '',
  },
  { row: 26, name: 'HAP size analysis', status: 'ported', reason: '' },
  {
    row: 27,
    name: 'Optimization detector (`opt-detector`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 28,
    name: 'Symbol recovery',
    status: 'ported',
    reason: '',
  },
  {
    row: 29,
    name: 'HapFlow static/dynamic integration',
    status: 'ported',
    reason: '',
  },
  {
    row: 30,
    name: 'Hilog analysis',
    status: 'ported',
    reason: '',
    analyzer: 'HilogAnalyzer',
  },
  {
    row: 31,
    name: 'UI animation analysis',
    status: 'ported',
    reason: '',
    analyzer: 'UiAnalyzer',
  },
  {
    row: 32,
    name: 'UI comparison (`ui-compare`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 33,
    name: 'Report bundle, dashboard and update',
    status: 'ported',
    reason: '',
  },
  {
    row: 34,
    name: 'XLSX report suite',
    status: 'ported',
    reason: '',
  },
  {
    row: 35,
    name: 'Report comparison',
    status: 'ported',
    reason: '',
  },
  /*
   * Rows 36–39 were added after the pinned revision. They keep counting from
   * 35 so a reader can tell the original inventory from what followed it.
   */
  {
    row: 36,
    name: 'Root-cause narrative (`root-cause`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 37,
    name: 'Debug HAP build (`build`, wraps deveco-cli)',
    status: 'out',
    reason:
      'this is a build tool, not a measurement: it invokes deveco-cli to produce'
      + ' a debug package. A package analyzer cannot own the toolchain that'
      + ' compiles the package it reads, and a half-ported wrapper would make'
      + ' every measurement depend on a compiler version this package does not'
      + ' control. `hap` and `opt` read what the build produced instead.',
  },
  {
    row: 38,
    name: 'LLM exploration strategy and state comparator (`haptest`)',
    status: 'ported',
    reason: '',
  },
  {
    row: 39,
    name: 'Thermal analysis (`hidumper -s ThermalService`)',
    status: 'missing',
    reason:
      'a collector plus an analyzer, so it is a capability of its own rather'
      + ' than part of the root-cause narrative: HapRay samples each sensor'
      + ' through hidumper and reports start/end/peak/mean and the rise. Not'
      + ' ported yet; the collector is the part that has to be measured on a'
      + ' device first, because a sensor list that is assumed rather than read'
      + ' would produce a thermal curve for a sensor the device lacks.',
  },
];

/** The counts, computed from {@link PARITY_ROWS} rather than written down. */
export function paritySummary(): {
  ported: number;
  partial: number;
  missing: number;
  out: number;
  total: number;
} {
  let ported = 0;
  let partial = 0;
  let missing = 0;
  let out = 0;
  for (const row of PARITY_ROWS) {
    if (row.status === 'ported') ported += 1;
    else if (row.status === 'partial') partial += 1;
    else if (row.status === 'missing') missing += 1;
    else out += 1;
  }
  return { ported, partial, missing, out, total: PARITY_ROWS.length };
}
