/**
 * JS heap snapshot analysis (HapRay parity row 20, extended).
 *
 * HapRay captures the snapshot and stops: `hidumper --mem-jsheap` writes a
 * `.heapsnapshot` into the app's leak directory, the collector pulls it, and
 * nothing reads it. On both sides of the parity inventory a captured heap is a
 * file a person opens in DevEco Studio, and no report mentions that it exists.
 *
 * This analyzer reads the file. It is the one place in this package where the
 * input is a V8 document rather than a trace table, and the numbers it produces
 * are `exact`: nothing sits between the snapshot and the metric but this
 * package's own parser, so calling them approximate would understate them.
 *
 * ## Why it requires no capability
 *
 * `js.heap` is unavailable in the device matrix for a measured reason
 * (`hidumper --mem-jsheap` needs a debug-signed or profilerable app, and on the
 * Mate 60 even a debug-signed one produced no file). Declaring it as a
 * requirement would therefore skip this analyzer on every scene that *does*
 * carry a snapshot — a snapshot can be produced elsewhere and dropped into a
 * scene directory. The artifact is a scene file, exactly like
 * `coverageReport.json`, and the presence of the file is what decides whether
 * there is anything to analyze.
 */

import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { parseHeapSnapshot } from '../jsheap/snapshot';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

export class JsheapAnalyzer implements Analyzer {
  readonly id = 'jsheap';
  readonly requires = [];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const text = ctx.jsheap;
    if (text === undefined) {
      return {
        metrics: [],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: { process: ctx.app.packageName },
            window: ctx.window,
            signals: {},
            explain:
              'the scene carries no jsheap.heapsnapshot; the JS heap was not captured.' +
              ' `collect --jsheap` captures one, and it needs a debug-signed or' +
              ' profilerable app — a release build on this hardware produces no file',
            drillDown: [],
            key: 'jsheap:no-snapshot',
          }),
        ],
      };
    }

    const snapshot = parseHeapSnapshot(text);
    const provenance = {
      collector: 'scene:jsheap.heapsnapshot',
      table: 'js_heap_nodes',
      rows: snapshot.nodeCount,
      device: ctx.deviceId,
    };
    const make = (id: string, value: number, unit: Metric['unit']): Metric =>
      metric({ id, value, unit, fidelity: 'exact', provenance });

    const metrics: Metric[] = [
      make('jsheap.total.bytes', snapshot.totalSelfSize, 'bytes'),
      make('jsheap.nodes.count', snapshot.nodeCount, 'count'),
      make('jsheap.detached.count', snapshot.detachedCount, 'count'),
      make('jsheap.objects.count', snapshot.nodeCountByType.get('object') ?? 0, 'count'),
    ];

    // The largest constructor is the actionable one. Listing all twenty would
    // turn the evidence list into a second copy of the snapshot; naming the
    // top answers the question a reader asks first. A detached node is the
    // shape of a leak, so its presence raises the severity — it is the one
    // finding no other capture in this package can produce.
    const items = [];
    const largest = snapshot.retainedByConstructor[0];
    if (largest !== undefined) {
      items.push(
        evidence({
          kind: 'js_heap',
          severity: snapshot.detachedCount > 0 ? 'warn' : 'info',
          subject: { process: ctx.app.packageName },
          window: ctx.window,
          signals: {
            constructor: largest.name,
            selfSize: largest.selfSize,
            count: largest.count,
            detachedCount: snapshot.detachedCount,
            totalSelfSize: snapshot.totalSelfSize,
          },
          explain:
            `${largest.name} holds the largest self size at ${largest.selfSize} bytes` +
            ` across ${largest.count} nodes` +
            (snapshot.detachedCount > 0
              ? `; ${snapshot.detachedCount} node(s) are detached`
              : ''),
          drillDown: [],
          key: largest.name,
        }),
      );
    }

    return { metrics, evidence: items };
  }
}
