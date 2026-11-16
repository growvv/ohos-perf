// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import { metric, type Metric } from '../report/metric';
import type { FoldedStack } from '../query/perf';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * Folded flamegraph stacks from a perf capture.
 *
 * HapRay renders flamegraph HTML by shelling out to `perf -i` and a
 * flamegraph.pl script; neither works from a trace database alone, so this
 * analyzer produces the data a renderer needs instead of the HTML: folded
 * stacks (`a;b;c N`), weighted by `perf_sample.event_count`.
 *
 * ## What the numbers mean
 *
 * - `flamegraph.samples.count` — the app threads' summed sample weight, not a
 *   row count. `event_count` is how many events each sample stands for.
 * - `flamegraph.app.share` — that weight over every sample in the database
 *   × 100. On a capture filtered to the app this is 100; on a device-wide one
 *   it is the app's slice of the profile.
 * - `flamegraph.stacks.count` — the number of distinct folded stacks in the
 *   window. The `top.*` payload is cut to the heaviest 20; this count is not.
 * - `flamegraph.top.symbol` / `flamegraph.top.samples` — the leaf of the
 *   heaviest folded stack and that stack's weight.
 *
 * These are **not** HapRay metrics: upstream reports flamegraph files, not
 * numbers. The definitions live here and in the test, not in a parity claim.
 *
 * Without `perf.db` there is nothing to fold, so the analyzer emits one
 * `flamegraph.degraded` proxy naming the capture requirements rather than five
 * zeros that read as "the app did nothing".
 */
export class FlamegraphAnalyzer implements Analyzer {
  readonly id = 'flamegraph';
  readonly requires: CapabilityId[] = ['perf.samples'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.perf === undefined || !ctx.perf.hasSamples()) {
      return {
        metrics: [
          metric({
            id: 'flamegraph.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: {
              reason:
                'no perf samples: the scene was captured without --hiperf, or the app ' +
                'was not debuggable so perf recorded nothing',
              fallback: 'no flamegraph',
            },
            provenance: { collector: 'hiperf', device: ctx.deviceId },
          }),
        ],
        evidence: [],
      };
    }

    const threads = ctx.perf.threads(ctx.app.pids);
    const threadIds = [...new Set(threads.map((thread) => thread.threadId))].sort((a, b) => a - b);
    // Both totals are windowed to match the stacks: a share over the whole
    // database while the stacks cover the window describes two populations.
    const samples = ctx.perf.eventCount(threadIds, ctx.window);
    const total = ctx.perf.eventCount(undefined, ctx.window);
    // The full list, so `stacks.count` counts stacks; the top cut is applied
    // to the payload below, not to the count.
    const allStacks: FoldedStack[] = ctx.perf.foldedStacks(threadIds, ctx.window);
    const stacks = allStacks.slice(0, TOP_STACKS);

    const prov = {
      collector: 'hiperf',
      table: 'perf_sample',
      rows: threadIds.length,
      device: ctx.deviceId,
    };
    const metrics: Metric[] = [
      metric({
        id: 'flamegraph.app.share',
        value: total > 0 ? (samples / total) * 100 : 0,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'flamegraph.samples.count',
        value: samples,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'flamegraph.stacks.count',
        value: allStacks.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    const top = stacks[0];
    if (top !== undefined) {
      metrics.push(
        metric({
          id: 'flamegraph.top.samples',
          value: top.samples,
          unit: 'count',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
        metric({
          id: 'flamegraph.top.symbol',
          value: top.leaf,
          unit: 'none',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
      );
    }

    metrics.sort(byMetricId);
    return { metrics, evidence: [] };
  }
}

/** How many folded stacks are kept; enough to seed a viewer without flooding. */
const TOP_STACKS = 20;

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
