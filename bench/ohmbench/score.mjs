#!/usr/bin/env node
/**
 * OhmBench's matcher and scorer, transcribed from docs/evaluation.md.
 *
 * This lives outside `packages/` on purpose: it reads `groundtruth.json`, which
 * the benchmark calls evaluator-only. Nothing the package ships may depend on
 * it, and no detector code reads it.
 *
 * Usage:
 *   node bench/ohmbench/score.mjs --bench <OhmBench> --results <dir> [--top 5]
 *
 * `<dir>` holds one `<case-id>.json` per case, each in the shape the benchmark
 * documents: `{ case, tool, suspects: [{rank, file, class, symbol,
 * line_start, line_end, description}] }`.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Strip an extension the benchmark says to ignore. */
export function stripExtension(path) {
  return path.replace(/\.(ets|ts|js)$/i, '');
}

/**
 * An ABC record name (`&entry/src/main/ets/pages/Index&`) reduced to its path.
 * The benchmark's `data.md` describes this form for bytecode-derived records.
 */
export function normalizePath(path) {
  let value = path.trim();
  if (value.startsWith('&') && value.endsWith('&')) value = value.slice(1, -1);
  return stripExtension(value).replace(/^\.\//, '');
}

/**
 * Rule 1: the trailing path segments agree, at least two of them, or the whole
 * of a one-segment path.
 */
export function fileMatches(suspectFile, locationFile) {
  const a = normalizePath(suspectFile).split('/').filter(Boolean);
  const b = normalizePath(locationFile).split('/').filter(Boolean);
  const shared = Math.min(a.length, b.length);
  if (shared === 0) return false;
  if (shared === 1) return a.length === 1 && b.length === 1 && a[0] === b[0];
  return a[a.length - 1] === b[b.length - 1] && a[a.length - 2] === b[b.length - 2];
}

/**
 * Rule 2: the symbol names the location's symbol (the last component of
 * `Class.method` counts), or the line range overlaps the location's scope.
 */
export function functionMatches(suspect, location) {
  const suspectSymbol = (suspect.symbol ?? '').trim();
  const locationSymbol = (location.symbol ?? '').trim();
  if (suspectSymbol !== '' && locationSymbol !== '') {
    const last = locationSymbol.split('.').pop();
    if (suspectSymbol === locationSymbol || suspectSymbol === last) return true;
  }
  const start = suspect.line_start ?? 0;
  const end = suspect.line_end ?? start;
  for (const key of ['changed_lines', 'scope_lines']) {
    const range = location[key];
    if (Array.isArray(range) && range.length === 2) {
      if (start <= range[1] && end >= range[0]) return true;
    }
  }
  return false;
}

/**
 * A suspect is correct if it matches the location, or any alias of it.
 *
 * The alias is checked first and on its own: an alias names a different file
 * (the caller of a slow SQL constant), so testing the suspect against the
 * location's file before reaching the alias would reject it.
 */
export function matches(suspect, location) {
  const locations = [location, ...(location.aliases ?? [])];
  return locations.some((entry) => fileMatches(suspect.file, entry.file) && functionMatches(suspect, entry));
}

/**
 * Precision and recall over the top five, exactly as the standard defines them.
 *
 * `precision` is correct suspects / suspects, over the top five by rank — so a
 * case that returns three suspects and gets all three is 1.0, not 0.6.
 * `recall` is primary root causes matched by at least one top-five suspect,
 * over all primary root causes.
 */
export function scoreCase(record, groundtruth, top = 5) {
  const ranked = [...(record.suspects ?? [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, top);
  const primaries = (groundtruth.root_causes ?? []).filter((rc) => rc.role === 'primary');
  const all = groundtruth.root_causes ?? [];

  const correct = ranked.filter((suspect) => all.some((loc) => matches(suspect, loc))).length;
  const found = primaries.filter((rc) => ranked.some((suspect) => matches(suspect, rc))).length;

  const precision = ranked.length === 0 ? 0 : correct / ranked.length;
  const recall = primaries.length === 0 ? 0 : found / primaries.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    case: groundtruth.case ?? record.case,
    suspects: ranked.length,
    correct,
    primaries: primaries.length,
    found,
    precision,
    recall,
    f1,
    hits: ranked.map((suspect) => ({
      rank: suspect.rank,
      file: suspect.file,
      symbol: suspect.symbol ?? null,
      correct: all.some((loc) => matches(suspect, loc)),
      primary: primaries.some((rc) => matches(suspect, rc)),
    })),
  };
}

/** The macro average over cases, and the per-case rows behind it. */
export function scoreAll(records, groundtruths, top = 5) {
  const rows = records.map((record) => {
    const groundtruth = groundtruths.get(record.case);
    if (groundtruth === undefined) throw new Error(`no groundtruth for ${record.case}`);
    return scoreCase(record, groundtruth, top);
  });
  const mean = (pick) => (rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / rows.length);
  return {
    cases: rows.length,
    precision: mean((row) => row.precision),
    recall: mean((row) => row.recall),
    f1: mean((row) => row.f1),
    rows,
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
  };
  const bench = option('--bench');
  const results = option('--results');
  const top = Number(option('--top', '5'));
  if (bench === undefined || results === undefined) {
    process.stderr.write('usage: score.mjs --bench <OhmBench> --results <dir> [--top 5]\n');
    process.exit(2);
  }

  const groundtruths = new Map();
  for (const name of readdirSync(join(bench, 'cases'))) {
    const file = join(bench, 'cases', name, 'groundtruth.json');
    if (!existsSync(file)) continue;
    const groundtruth = JSON.parse(readFileSync(file, 'utf8'));
    groundtruths.set(groundtruth.case ?? name, groundtruth);
  }

  const records = [];
  for (const name of readdirSync(results)) {
    if (!name.endsWith('.json')) continue;
    records.push(JSON.parse(readFileSync(join(results, name), 'utf8')));
  }

  const summary = scoreAll(records, groundtruths, top);
  process.stdout.write(
    `cases ${summary.cases}  precision ${summary.precision.toFixed(3)}` +
      `  recall ${summary.recall.toFixed(3)}  f1 ${summary.f1.toFixed(3)}\n`,
  );
  for (const row of summary.rows) {
    process.stdout.write(
      `${row.case.padEnd(46)} P ${row.precision.toFixed(2)}  R ${row.recall.toFixed(2)}` +
        `  (${row.found}/${row.primaries} primary, ${row.correct}/${row.suspects} correct)\n`,
    );
  }

  const out = option('--out');
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.precision >= 0.8 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
