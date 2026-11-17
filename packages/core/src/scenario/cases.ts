/**
 * Case discovery: a directory of scenarios run as one suite.
 *
 * HapRay's `--run_testcases` takes a prefix and silently runs whatever
 * happens to match. Two things here are deliberately stricter, because a
 * suite that runs zero cases and reports success is worse than one that
 * refuses: the filter is an anchored regex over the case id and is documented
 * as such, and a filter that matches nothing is a refusal that names what it
 * did find.
 *
 * Loading is separate from discovery so one malformed file cannot hide the
 * rest: the runner gets a scenario per good file and a named error per bad
 * one, and reports both.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OhosPerfError } from '../errors';
import { parseScenario, type Scenario } from './schema';

/** The suffix a case file must carry; nothing else in the directory is read. */
const CASE_SUFFIX = '.scenario.json';

export interface DiscoveredCase {
  /** The file stem, e.g. `scroll` from `scroll.scenario.json`. */
  readonly id: string;
  readonly path: string;
}

export interface CaseLoad {
  readonly id: string;
  readonly path: string;
  /** Present when the file parsed and validated. */
  readonly scenario?: Scenario;
  /** Present when it did not, naming the file. */
  readonly error?: string;
}

/**
 * Every case in `dir`, sorted by id.
 *
 * `filter` is an **anchored** regular expression, so `scroll` matches only a
 * case literally named `scroll`, and `^scroll` matches it and
 * `scroll-settings`. Anchoring is the point: an unanchored `scroll` would also
 * match `no-scroll` and run a case the author did not name.
 *
 * A filter that matches nothing, and a directory with no case files, are both
 * refusals — never an empty suite that "passed".
 */
export function discoverCases(dir: string, filter?: string): DiscoveredCase[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      throw new Error('not a directory');
    }
    entries = readdirSync(dir);
  } catch (err) {
    throw new OhosPerfError(
      `cannot read the cases directory ${dir}: ${message(err)}`,
      { code: 'SCENARIO_CASES_EMPTY', cause: err },
    );
  }

  const found = entries
    .filter((name) => name.endsWith(CASE_SUFFIX))
    .map((name) => ({
      id: basename(name, CASE_SUFFIX),
      path: join(dir, name),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (found.length === 0) {
    throw new OhosPerfError(
      `no *${CASE_SUFFIX} file in ${dir}; a cases directory holds one scenario per file`,
      { code: 'SCENARIO_CASES_EMPTY' },
    );
  }

  if (filter === undefined) return found;

  let pattern: RegExp;
  try {
    // Anchored here rather than left to the author: `--filter scroll` must
    // not also run `no-scroll`, which is the silent extra-case failure this
    // module exists to prevent. An author who writes `^` or `$` themselves is
    // saying the same thing, so the extra anchor is harmless.
    pattern = new RegExp(`^(?:${filter})$`);
  } catch (err) {
    throw new OhosPerfError(
      `invalid --filter ${JSON.stringify(filter)}: ${message(err)}`,
      { code: 'SCENARIO_BAD_INPUT', cause: err },
    );
  }
  const matched = found.filter((entry) => pattern.test(entry.id));
  if (matched.length === 0) {
    throw new OhosPerfError(
      `--filter ${JSON.stringify(filter)} matched no case;` +
        ` the directory has ${found.map((entry) => entry.id).join(', ')}`,
      { code: 'SCENARIO_CASES_EMPTY' },
    );
  }
  return matched;
}

/**
 * Parse every discovered case, keeping a per-file verdict.
 *
 * A malformed file does not abort the suite: it becomes a `CaseLoad` with an
 * error, which the CLI reports as a failed case. The alternative — refusing
 * the whole run — would let one typo hide the results of every other case.
 */
export function loadCases(cases: readonly DiscoveredCase[]): CaseLoad[] {
  return cases.map((entry) => {
    let text: string;
    try {
      text = readFileSync(entry.path, 'utf8');
    } catch (err) {
      // The file name, not the path: this error reaches `cases.json`, which is
      // a document, and a document carries no host path.
      return {
        id: entry.id,
        path: entry.path,
        error: `${basename(entry.path)}: cannot be read (${errorCode(err)})`,
      };
    }
    try {
      return { id: entry.id, path: entry.path, scenario: parseScenario(text) };
    } catch (err) {
      return { id: entry.id, path: entry.path, error: `${basename(entry.path)}: ${message(err)}` };
    }
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A filesystem error's code (`ENOENT`, `EACCES`), for a host-path-free message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unreadable';
}
