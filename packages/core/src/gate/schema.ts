/**
 * Performance budgets: a versioned document that says how much a metric may
 * move before a run is a regression.
 *
 * A budget document is data from outside the package — committed beside the
 * code, shared between people and CI jobs — so this module is a trust
 * boundary: every field is checked, an unknown key is an error rather than a
 * silently ignored typo, and every rejection names the JSON path that caused
 * it. The validator is hand-written for the same reason `scenario/schema.ts`
 * is: a schema library would be the first runtime dependency, and path-naming
 * errors are what a generic validator reports least clearly.
 *
 * `name` is a label, not a path. A document is committed next to the code it
 * gates and run from wherever CI happens to check out, so nothing in it may
 * depend on the working directory.
 */

import { OhosPerfError } from '../errors';

/** The document schema. A change to any shape below bumps this. */
export const BUDGET_SCHEMA_VERSION = 1;

/**
 * The bound a budget entry applies. Exactly one per entry.
 *
 * `max`/`min` are absolute limits on the measured value; `maxDelta` and
 * `maxDeltaPct` are limits on the movement from a baseline run, in the
 * metric's own unit and in percent respectively. A negative delta limit is
 * legal: it says the metric must *fall* by at least that much.
 */
export type BudgetBound =
  | { readonly kind: 'max'; readonly limit: number }
  | { readonly kind: 'min'; readonly limit: number }
  | { readonly kind: 'maxDelta'; readonly limit: number }
  | { readonly kind: 'maxDeltaPct'; readonly limit: number };

export interface BudgetEntry {
  /** The metric id the bound applies to, e.g. `frame.jank.rate`. */
  readonly id: string;
  readonly bound: BudgetBound;
}

export interface BudgetDocument {
  readonly schemaVersion: typeof BUDGET_SCHEMA_VERSION;
  /** A human label for the gate; copied into its output. Never a path. */
  readonly name: string;
  /** Sorted by metric id, so two documents with the same budgets compare equal. */
  readonly budgets: readonly BudgetEntry[];
}

const DOCUMENT_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'name', 'budgets']);
const ENTRY_KEYS: ReadonlySet<string> = new Set(['id', 'max', 'min', 'maxDelta', 'maxDeltaPct']);
const BOUND_KEYS = ['max', 'min', 'maxDelta', 'maxDeltaPct'] as const;

function bad(path: string, message: string, code: string): OhosPerfError {
  return new OhosPerfError(`invalid budget document: ${path}: ${message}`, { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `"x"` / `5` — how a rejection quotes the value it found. */
function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? String(value);
}

function readBound(entry: Record<string, unknown>, path: string): BudgetBound {
  const present = BOUND_KEYS.filter((key) => key in entry);
  if (present.length === 0) {
    throw bad(
      path,
      `no bound; give exactly one of ${BOUND_KEYS.join(', ')}`,
      'BUDGET_BAD_ENTRY',
    );
  }
  if (present.length > 1) {
    throw bad(
      path,
      `two bounds (${present.join(', ')}); give exactly one of ${BOUND_KEYS.join(', ')}`,
      'BUDGET_BAD_ENTRY',
    );
  }
  const kind = present[0]!;
  const limit = entry[kind];
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw bad(`${path}.${kind}`, `expected a finite number, got ${show(limit)}`, 'BUDGET_BAD_ENTRY');
  }
  return { kind, limit } as BudgetBound;
}

function readEntry(value: unknown, path: string): BudgetEntry {
  if (!isRecord(value)) {
    throw bad(path, `expected an object, got ${show(value)}`, 'BUDGET_BAD_ENTRY');
  }
  for (const key of Object.keys(value)) {
    if (!ENTRY_KEYS.has(key)) {
      throw bad(path, `unknown key ${JSON.stringify(key)}`, 'BUDGET_BAD_ENTRY');
    }
  }
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw bad(`${path}.id`, `expected a non-empty string, got ${show(id)}`, 'BUDGET_BAD_ENTRY');
  }
  return { id, bound: readBound(value, path) };
}

/**
 * Parse and validate a budget document.
 *
 * Throws `OhosPerfError` with `BUDGET_BAD_DOCUMENT` for a problem with the
 * document as a whole and `BUDGET_BAD_ENTRY` for one inside `budgets[i]`; both
 * name the JSON path. Returns a new object whose `budgets` are sorted by id,
 * so the document's own order never leaks into output.
 */
export function parseBudgetDocument(input: unknown): BudgetDocument {
  if (!isRecord(input)) {
    throw bad('document', `expected an object, got ${show(input)}`, 'BUDGET_BAD_DOCUMENT');
  }
  for (const key of Object.keys(input)) {
    if (!DOCUMENT_KEYS.has(key)) {
      throw bad('document', `unknown key ${JSON.stringify(key)}`, 'BUDGET_BAD_DOCUMENT');
    }
  }

  const version = input.schemaVersion;
  if (version !== BUDGET_SCHEMA_VERSION) {
    throw bad(
      'schemaVersion',
      `expected ${BUDGET_SCHEMA_VERSION}, got ${show(version)}`,
      'BUDGET_BAD_DOCUMENT',
    );
  }

  const name = input.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw bad('name', `expected a non-empty string, got ${show(name)}`, 'BUDGET_BAD_DOCUMENT');
  }

  const raw = input.budgets;
  if (!Array.isArray(raw)) {
    throw bad('budgets', `expected an array, got ${show(raw)}`, 'BUDGET_BAD_DOCUMENT');
  }
  if (raw.length === 0) {
    throw bad('budgets', 'expected at least one budget', 'BUDGET_BAD_DOCUMENT');
  }

  const budgets = raw.map((entry, index) => readEntry(entry, `budgets[${index}]`));

  // Duplicates are found after every entry is read, so the message can name
  // both positions rather than only the one that happened to be second.
  const firstAt = new Map<string, number>();
  budgets.forEach((entry, index) => {
    const seen = firstAt.get(entry.id);
    if (seen !== undefined) {
      throw bad(
        `budgets[${index}]`,
        `duplicate metric id ${JSON.stringify(entry.id)} (first at budgets[${seen}])`,
        'BUDGET_BAD_ENTRY',
      );
    }
    firstAt.set(entry.id, index);
  });

  budgets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: BUDGET_SCHEMA_VERSION, name, budgets };
}

/** The budgets that need a baseline run to be evaluated, sorted by id. */
export function deltaBudgetIds(doc: BudgetDocument): string[] {
  return doc.budgets
    .filter((entry) => entry.bound.kind === 'maxDelta' || entry.bound.kind === 'maxDeltaPct')
    .map((entry) => entry.id);
}
