/**
 * Scene + step comparison (HapRay parity row 35, the pivot half).
 *
 * HapRay pivots a comparison by scene + step + version. `compareResults`
 * compares two flat metric sets, which is right for one scene and wrong for a
 * multi-step run: merging the steps would attribute every change to "the
 * run" instead of to the step that moved.
 *
 * `compareScenes` keeps the attribution. Each step is compared against the
 * same step id on the baseline, and a step that exists on one side only is
 * reported as `added` or `removed` rather than silently dropped — the same
 * honesty rule `compareResults` applies to metrics.
 *
 * Steps are sorted by id, so the output is byte-identical for the same input
 * whatever order the caller supplies them in.
 */

import type { AnalyzeResult } from '../analyze/types';
import { compareResults, type MetricDelta } from './compare';

/** One step's analysis, named by the step it belongs to. */
export interface SceneStep {
  readonly stepId: string;
  readonly result: AnalyzeResult;
}

/** What the comparison could say about one step. */
export type StepStatus = 'compared' | 'added' | 'removed';

export interface StepComparison {
  readonly stepId: string;
  readonly status: StepStatus;
  /**
   * Metric-by-metric rows. For `added` and `removed` every row is the one-sided
   * classification `compareResults` already produces, so a reader sees the
   * metrics a step brought or took away.
   */
  readonly rows: readonly MetricDelta[];
}

export interface ScenesComparison {
  /** Sorted by step id. */
  readonly steps: readonly StepComparison[];
  /** Steps only the baseline had. */
  readonly removed: readonly string[];
  /** Steps only the current run had. */
  readonly added: readonly string[];
}

function byStepId(a: SceneStep, b: SceneStep): number {
  return a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0;
}

/**
 * Compare two multi-step runs, step by step.
 *
 * A duplicate step id on one side is a caller error — the pivot would be
 * ambiguous — so it is refused rather than resolved by picking one.
 */
export function compareScenes(
  baseline: readonly SceneStep[],
  current: readonly SceneStep[],
): ScenesComparison {
  const before = new Map(baseline.map((step) => [step.stepId, step.result]));
  const after = new Map(current.map((step) => [step.stepId, step.result]));
  if (before.size !== baseline.length) {
    throw new Error('compareScenes: the baseline has a duplicate step id');
  }
  if (after.size !== current.length) {
    throw new Error('compareScenes: the current run has a duplicate step id');
  }

  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const steps: StepComparison[] = ids.map((stepId) => {
    const start = before.get(stepId);
    const end = after.get(stepId);
    if (start === undefined && end !== undefined) {
      return {
        stepId,
        status: 'added',
        rows: compareResults({ metrics: [], evidence: [] }, end).rows,
      };
    }
    if (start !== undefined && end === undefined) {
      return {
        stepId,
        status: 'removed',
        rows: compareResults(start, { metrics: [], evidence: [] }).rows,
      };
    }
    return { stepId, status: 'compared', rows: compareResults(start!, end!).rows };
  });

  return {
    steps,
    removed: ids.filter((id) => before.has(id) && !after.has(id)),
    added: ids.filter((id) => after.has(id) && !before.has(id)),
  };
}

/** Stable JSON for the comparison; `JSON.stringify` of the same shape. */
export function renderScenesComparison(comparison: ScenesComparison): string {
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

/** Re-exported so a caller importing this module needs one import, not two. */
export type { MetricDelta };

/** Sorts steps by id; exported for a caller assembling them from a run. */
export function sortSteps(steps: readonly SceneStep[]): SceneStep[] {
  return [...steps].sort(byStepId);
}
