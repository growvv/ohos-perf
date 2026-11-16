import type { CapabilityId } from '../device/capability';
import { dhash } from '../image/diff';
import type { RgbaImage } from '../image/png';
import type { UiNode } from '../query/ui';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** The reason a scene with no screenshot reports on the image half. */
const NO_SCREENSHOT = 'no screenshot in this scene';

/** The reason a scene with no UI dump reports on the tree half. */
const NO_TREE = 'no UI tree in this scene';

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/** One node's contribution to the tree metrics. */
interface TreeStats {
  readonly nodes: number;
  readonly clickable: number;
  readonly text: number;
  readonly depth: number;
}

/**
 * Count what the tree metrics report.
 *
 * Depth is the deepest `depth` in the flattened list, which is the tree's
 * height in edges; a single root is depth 0, not 1. `text` counts nodes whose
 * `text` is non-empty — an empty string is a container, and counting it would
 * make "how much text is on screen" depend on how many containers there are.
 */
function treeStats(nodes: readonly UiNode[]): TreeStats {
  let clickable = 0;
  let text = 0;
  let depth = 0;
  for (const node of nodes) {
    if (node.clickable) clickable += 1;
    if (node.text !== '') text += 1;
    if (node.depth > depth) depth = node.depth;
  }
  return { nodes: nodes.length, clickable, text, depth };
}

/** The tree half, exact when a dump exists and degraded otherwise. */
function treeMetrics(ctx: AnalyzeContext, nodes: readonly UiNode[] | undefined): Metric[] {
  if (nodes === undefined) {
    return [
      degradedMetric(ctx, 'ui.nodes.count', NO_TREE),
      degradedMetric(ctx, 'ui.nodes.clickable', NO_TREE),
      degradedMetric(ctx, 'ui.nodes.text', NO_TREE),
      degradedMetric(ctx, 'ui.tree.depth.max', NO_TREE),
    ];
  }
  const stats = treeStats(nodes);
  const provenance = {
    collector: 'uitest',
    table: 'ui.json',
    rows: stats.nodes,
    device: ctx.deviceId,
  };
  return [
    metric({
      id: 'ui.nodes.count', value: stats.nodes, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
    metric({
      id: 'ui.nodes.clickable', value: stats.clickable, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
    metric({
      id: 'ui.nodes.text', value: stats.text, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
    metric({
      id: 'ui.tree.depth.max', value: stats.depth, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
  ];
}

/** The image half, exact when a screenshot exists and degraded otherwise. */
function imageMetrics(
  ctx: AnalyzeContext,
  image: RgbaImage | undefined,
  reason: string,
): Metric[] {
  if (image === undefined) {
    return [
      degradedMetric(ctx, 'ui.screenshot.width', reason),
      degradedMetric(ctx, 'ui.screenshot.height', reason),
      degradedMetric(ctx, 'ui.screenshot.dhash', reason),
    ];
  }
  const provenance = { collector: 'screenshot', table: 'screenshot.png', device: ctx.deviceId };
  return [
    metric({
      id: 'ui.screenshot.width', value: image.width, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
    metric({
      id: 'ui.screenshot.height', value: image.height, unit: 'count',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
    metric({
      id: 'ui.screenshot.dhash', value: dhash(image), unit: 'hash',
      fidelity: 'exact', provenance, window: ctx.window,
    }),
  ];
}

/**
 * A metric for a half that could not be measured.
 *
 * A zero labeled `exact` would read as a real measurement, so the value is a
 * placeholder carrying `fidelity: 'proxy'` and the reason. The dHash is a
 * string, so its placeholder is the empty string rather than a number.
 */
function degradedMetric(ctx: AnalyzeContext, id: string, reason: string): Metric {
  const isHash = id === 'ui.screenshot.dhash';
  return metric({
    id,
    value: isHash ? '' : 0,
    unit: isHash ? 'hash' : 'count',
    fidelity: 'proxy',
    degraded: { reason, fallback: isHash ? 'no dHash' : 'no measurement' },
    provenance: {
      collector: isHash ? 'screenshot' : 'uitest',
      device: ctx.deviceId,
    },
    window: ctx.window,
  });
}

/**
 * What is on screen: the dump's shape and the screenshot's fingerprint.
 *
 * The analyzer requires no capability and decides from the artifacts it is
 * given. `requires: ['ui.tree']` would skip it on a device without `uitest`,
 * but a scene can carry a `ui.json` captured elsewhere — and a scene with a
 * screenshot and no dump still has a width, a height and a hash worth
 * reporting. Each half degrades on its own, so a capture that produced only one
 * artifact reports the other's absence instead of discarding what it has.
 *
 * Neither artifact present is one `ui.degraded` proxy and one `no_data` item
 * naming both files, which is how the report says "this scene was not captured
 * with UI data" rather than reporting four zero node counts as measurements.
 */
export class UiAnalyzer implements Analyzer {
  readonly id = 'ui';
  readonly requires: CapabilityId[] = [];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const nodes = ctx.ui;
    const image = ctx.screenshot;

    if (nodes === undefined && image === undefined && ctx.screenshotError === undefined) {
      const reason = 'no UI capture in this scene';
      return {
        metrics: [
          metric({
            id: 'ui.degraded',
            value: 0,
            unit: 'count',
            fidelity: 'proxy',
            degraded: { reason, fallback: 'no UI measurement' },
            provenance: { collector: 'uitest', device: ctx.deviceId },
            window: ctx.window,
          }),
        ],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: { process: appProcessName(ctx) },
            window: ctx.window,
            signals: {},
            explain:
              `${reason}: neither ui.json nor screenshot.png exists here;` +
              ' capture with `--uitest --screenshot`',
            drillDown: [],
            key: 'ui:no-data',
          }),
        ],
      };
    }

    const metrics: Metric[] = [
      ...treeMetrics(ctx, nodes),
      ...imageMetrics(ctx, image, ctx.screenshotError ?? NO_SCREENSHOT),
    ];
    metrics.sort((a, b) => byString(a.id, b.id));

    const items = nodes === undefined
      ? []
      : (() => {
          const stats = treeStats(nodes);
          return [evidence({
            kind: 'ui_tree' as const,
            severity: 'info' as const,
            subject: { process: appProcessName(ctx) },
            window: ctx.window,
            key: 'ui:tree',
            signals: {
              nodes: stats.nodes,
              depth: stats.depth,
              clickable: stats.clickable,
              text: stats.text,
            },
            explain:
              `the captured screen has ${stats.nodes} node${stats.nodes === 1 ? '' : 's'}` +
              ` ${stats.depth} level${stats.depth === 1 ? '' : 's'} deep,` +
              ` ${stats.clickable} clickable and ${stats.text} carrying text;` +
              ' a node count is a shape, not a performance measurement',
            drillDown: [
              {
                label: 'The captured tree',
                tool: 'ui.tree',
                args: {},
                returns: 'UiNode[]',
                estRows: stats.nodes,
              },
            ],
          })];
        })();

    return { metrics, evidence: items };
  }
}
