import type { CapabilityId } from '../device/capability';
import { matchRules, compileRules, DEFAULT_HILOG_RULES, type HilogMatch } from '../hilog/rules';
import type { HilogLine } from '../hilog/parse';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** How many matched messages one evidence item carries. */
const SAMPLE_LIMIT = 5;

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/** The proxy + explanation a caller gets when nothing can be measured. */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  return {
    metrics: [
      metric({
        id: 'hilog.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no hilog measurement' },
        provenance: { collector: 'hilog', device: ctx.deviceId },
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
        explain: reason,
        drillDown: [],
        key: 'hilog:no-data',
      }),
    ],
  };
}

/** One rule's matches, in line order. */
interface RuleHits {
  readonly ruleName: string;
  readonly matches: HilogMatch[];
}

/**
 * The capture's log, evaluated against the rule set.
 *
 * The analyzer reads no tables: the collector wrote a raw log, and the caller
 * parsed it (`ctx.hilog`). That keeps the capture artifact exactly what the
 * device printed and makes a parser or rule change a re-analysis rather than a
 * re-capture.
 *
 * Zero matches is a measurement, not an absence: a capture that printed
 * nothing the rules care about reports a zero per rule with `exact` fidelity.
 * Only a scene with no log at all degrades, and it says so.
 */
export class HilogAnalyzer implements Analyzer {
  readonly id = 'hilog';
  readonly requires: CapabilityId[] = ['hilog.stream'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const lines = ctx.hilog;
    if (lines === undefined) {
      return degradedResult(
        ctx,
        'the scene carries no hilog.log; capture with `--hilog` (or collect ' +
          '`hilog` yourself) to evaluate the log rules',
      );
    }

    const compiled = compileRules(ctx.hilogRules ?? DEFAULT_HILOG_RULES);
    const matches = matchRules(compiled, lines);

    // One bucket per rule, in the compiled (name) order, so the metrics and
    // the evidence are byte-stable for the same log.
    const hits = new Map<string, HilogMatch[]>();
    for (const rule of compiled) hits.set(rule.name, []);
    for (const match of matches) hits.get(match.ruleName)?.push(match);
    const byRule: RuleHits[] = [...hits].map(([ruleName, ruleMatches]) => ({
      ruleName,
      matches: ruleMatches,
    }));

    const parsed = lines.filter((line) => line.parsed).length;
    const prov = {
      collector: 'hilog',
      table: 'hilog.log',
      rows: lines.length,
      device: ctx.deviceId,
    };

    const metrics: Metric[] = [
      metric({
        id: 'hilog.lines.count',
        value: lines.length,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'hilog.parsed.count',
        value: parsed,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'hilog.unparsed.count',
        value: lines.length - parsed,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      ...byRule.map((rule) => metric({
        id: `hilog.rule.${rule.ruleName}.count`,
        value: rule.matches.length,
        unit: 'count',
        fidelity: 'exact' as const,
        provenance: prov,
        window: ctx.window,
      })),
      metric({
        id: 'hilog.rules.matched.count',
        value: byRule.filter((rule) => rule.matches.length > 0).length,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'hilog.rules.unmatched.count',
        value: byRule.filter((rule) => rule.matches.length === 0).length,
        unit: 'count',
        fidelity: 'exact',
        provenance: prov,
        window: ctx.window,
      }),
    ];
    metrics.sort((a, b) => byString(a.id, b.id));

    const process = appProcessName(ctx);
    const items: Evidence[] = byRule
      .filter((rule) => rule.matches.length > 0)
      .map((rule) => {
        const first = rule.matches[0];
        const last = rule.matches[rule.matches.length - 1];
        return evidence({
          kind: 'hilog_match',
          // A rule that fired is a signal worth looking at, never proof of a
          // fault; the rule set is a classifier, not a verdict.
          severity: 'info',
          subject: { process, rule: rule.ruleName },
          window: ctx.window,
          key: `hilog:${rule.ruleName}`,
          signals: {
            rule: rule.ruleName,
            count: rule.matches.length,
            firstLine: first.lineIndex,
            lastLine: last.lineIndex,
            samples: rule.matches
              .slice(0, SAMPLE_LIMIT)
              .map((match) => lines[match.lineIndex]?.message ?? ''),
          },
          explain:
            `rule ${rule.ruleName} matched ${rule.matches.length} ` +
            `line${rule.matches.length === 1 ? '' : 's'} between ` +
            `line ${first.lineIndex} and line ${last.lineIndex}; ` +
            'a match is a pattern hit, not a diagnosis',
          drillDown: [
            {
              label: `Every ${rule.ruleName} match`,
              tool: 'hilog.matches',
              args: { rule: rule.ruleName },
              returns: 'HilogMatch[]',
            },
            {
              label: 'The effective rule set with counts',
              tool: 'hilog.rules',
              args: {},
              returns: 'HilogRuleCount[]',
            },
          ],
        });
      });
    items.sort(byEvidenceOrder);

    return { metrics, evidence: items };
  }
}

/** Sort order shared with the engine: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Re-exported so a caller building a rule set does not import two modules. */
export type { HilogLine };
