import type { CapabilityId } from '../device/capability';
import { round2HalfEven } from './components';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { SymbolStat } from '../query/perf';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/*
 * What the capture could name, and what it could not.
 *
 * A hotspot list built only from resolved symbols reads as "the app spent its
 * time in these functions". On a measured capture 9.43% of leaf weight had no
 * symbol at all — the recorder saw the address but could not name it — so a
 * list that silently drops that weight understates how much of the profile is
 * unexplained. This analyzer reports both halves, states their ratio, and
 * names the flag that improves the next capture.
 *
 * ## What the numbers mean
 *
 * - `symbol.samples.count` — summed leaf weight whose symbol is a name.
 * - `symbol.unresolved.count` — summed leaf weight still `file+0xoffset`.
 * - `symbol.unresolved.share` — the latter over all leaf weight, × 100.
 * - `symbol.files.count` — distinct file paths among resolved leaves.
 * - `symbol.top.symbol` / `symbol.top.samples` — the heaviest resolved symbol.
 *
 * The first two sum to the window's sample weight, so a reader can check that
 * nothing went missing. Unresolved weight is *not* an error: the recorder is
 * honest about what it did not know, and a `libfoo.so+0x1cce24` reference is
 * still evidence about which library was running.
 */

/** How many evidence items each kind carries; enough to act on, not a dump. */
const TOP_ITEMS = 10;

export class SymbolsAnalyzer implements Analyzer {
  readonly id = 'symbols';
  readonly requires: CapabilityId[] = ['perf.samples'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.perf === undefined || !ctx.perf.hasSamples()) {
      return {
        metrics: [
          metric({
            id: 'symbols.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: {
              reason:
                'no perf samples: the scene was captured without --hiperf, or the app ' +
                'was not debuggable so perf recorded nothing',
              fallback: 'no symbol statistics',
            },
            provenance: { collector: 'hiperf', device: ctx.deviceId },
          }),
        ],
        evidence: [],
      };
    }

    const threads = ctx.perf.threads(ctx.app.pids);
    const threadIds = [...new Set(threads.map((thread) => thread.threadId))].sort((a, b) => a - b);
    const rows = ctx.perf.symbolStats(threadIds, ctx.window);

    const resolved = rows.filter((row) => !row.unresolved);
    const unresolved = rows.filter((row) => row.unresolved);
    const resolvedWeight = resolved.reduce((sum, row) => sum + row.samples, 0);
    const unresolvedWeight = unresolved.reduce((sum, row) => sum + row.samples, 0);
    const total = resolvedWeight + unresolvedWeight;
    const files = [...new Set(resolved.map((row) => row.filePath).filter((path) => path !== ''))]
      .sort(byString);
    const top = resolved[0];

    const prov = {
      collector: 'hiperf',
      table: 'perf_callchain',
      rows: threadIds.length,
      device: ctx.deviceId,
    };
    const metrics: Metric[] = [
      metric({
        id: 'symbol.samples.count',
        value: resolvedWeight,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'symbol.unresolved.count',
        value: unresolvedWeight,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'symbol.unresolved.share',
        value: total > 0 ? round2HalfEven((unresolvedWeight / total) * 100) : 0,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'symbol.files.count',
        value: files.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];
    if (top !== undefined) {
      metrics.push(
        metric({
          id: 'symbol.top.symbol',
          value: top.symbol,
          unit: 'none',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
        metric({
          id: 'symbol.top.samples',
          value: top.samples,
          unit: 'count',
          provenance: prov,
          fidelity: 'exact',
          window: ctx.window,
        }),
      );
    }
    metrics.sort(byMetricId);

    const process = ctx.app.packageName;
    const items: Evidence[] = [];
    for (const row of resolved.slice(0, TOP_ITEMS)) {
      items.push(evidence({
        kind: 'symbol_stats',
        severity: 'info',
        subject: { process },
        window: ctx.window,
        signals: {
          symbol: row.symbol,
          file: row.filePath,
          samples: row.samples,
          share: share(row.samples, total),
        },
        explain:
          `${row.symbol} accounts for ${row.samples} samples` +
          `${row.filePath === '' ? '' : ` in ${row.filePath}`}` +
          ` (${formatShare(share(row.samples, total))} of the window)`,
        drillDown: [{
          label: `all symbols in ${row.filePath === '' ? 'this window' : row.filePath}`,
          tool: 'symbol.stats',
          args: { startNs: ctx.window.startNs, endNs: ctx.window.endNs },
          returns: 'rows of { symbol, filePath, samples, share, unresolved }',
        }],
        // A symbol name is not unique across files, so the file is part of
        // the identity; two same-named symbols are two findings.
        key: `symbol:${row.symbol}\u0000${row.filePath}`,
      }));
    }

    for (const row of unresolved.slice(0, TOP_ITEMS)) {
      // A row with no symbol and no file is weight whose chain has no frames:
      // there is no address for `--so-dir` to symbolize, so the item says what
      // happened rather than naming a flag that cannot help.
      const frameLess = row.symbol === '' && row.filePath === '';
      items.push(evidence({
        kind: 'unresolved_symbol',
        severity: 'warn',
        subject: { process },
        window: ctx.window,
        signals: {
          symbol: row.symbol,
          file: row.filePath,
          samples: row.samples,
        },
        explain: frameLess
          ? `${row.samples} samples have no callchain frames, so no symbol can ` +
            'name them; the conversion truncated these chains or the recorder ' +
            'dropped them'
          : `the recorder had no symbol for ${row.samples} samples` +
            `${row.filePath === '' ? '' : ` in ${row.filePath}`}` +
            ` (${row.symbol}); pass --so-dir with the app's libraries on the next ` +
            'capture to symbolize these addresses',
        drillDown: [
          {
            label: 'the unresolved rows',
            tool: 'symbol.stats',
            args: { startNs: ctx.window.startNs, endNs: ctx.window.endNs },
            returns: 'rows of { symbol, filePath, samples, share, unresolved }',
          },
          {
            label: 'every symbol in this window',
            tool: 'frame.load.symbols',
            args: { startNs: ctx.window.startNs, endNs: ctx.window.endNs },
            returns: 'rows of { symbol, filePath, samples, share }',
          },
        ],
        key: `unresolved:${row.symbol}\u0000${row.filePath}`,
      }));
    }

    return { metrics, evidence: items };
  }
}

/** A percentage rounded to two decimals; `0` when there is no weight. */
function share(samples: number, total: number): number {
  return total > 0 ? round2HalfEven((samples / total) * 100) : 0;
}

/** A share as it reads in a sentence. */
function formatShare(value: number): string {
  return `${value}%`;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Re-exported so a caller building its own table has the row shape named. */
export type { SymbolStat };
