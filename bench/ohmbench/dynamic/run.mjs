#!/usr/bin/env node
/**
 * Run OhmBench's own workloads on a device and analyze what they capture.
 *
 * Usage:
 *   node bench/ohmbench/dynamic/run.mjs --bench <OhmBench> --out <dir> \
 *     --target <hdc-target> [--only case-id,...] [--scale 1]
 *
 * For each case this:
 *   1. reads the HapRay `PerfTestCase` to get the capture window HapRay uses;
 *   2. runs the case's `*.workload.json` through `ohos-perf workload`, which
 *      executes setup, captures the measured phase, then verifies;
 *   3. runs `ohos-perf analyze` and `ohos-perf root-cause --offline` on the
 *      scene it produced;
 *   4. records all three outcomes plus the artifacts' sizes.
 *
 * The apps must already be installed (see `sign.mjs` and `install.mjs`). A
 * case whose workload needs prepared data fails at its own `setup` wait, and
 * the record says which wait and how many nodes matched — that is the
 * benchmark's own documented gap (`docs/limitations.md`), measured rather
 * than assumed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../../../packages/cli/dist/index.js');

function option(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

const bench = option('--bench');
const outRoot = option('--out');
const target = option('--target');
const only = option('--only');
const cap = option('--cap') === undefined ? undefined : Number(option('--cap'));
if (bench === undefined || outRoot === undefined) {
  process.stderr.write(
    'usage: run.mjs --bench <OhmBench> --out <dir> [--target <id>] [--only id,...] [--cap seconds]\n',
  );
  process.exit(2);
}

/** HapRay's capture window for one case, from its `PerfTestCase`. */
function windowSeconds(caseDir) {
  const testcase = join(bench, 'cases', caseDir, 'testcase');
  if (!existsSync(testcase)) return undefined;
  for (const file of readdirSync(testcase)) {
    if (!file.endsWith('.py') || file === 'workload_driver.py') continue;
    const text = readFileSync(join(testcase, file), 'utf8');
    const match = /execute_performance_step,\s*'[^']*',\s*(\d+)/.exec(text);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

function planOf(caseDir) {
  const testcase = join(bench, 'cases', caseDir, 'testcase');
  if (!existsSync(testcase)) return undefined;
  const file = readdirSync(testcase).find((name) => name.endsWith('.workload.json'));
  return file === undefined ? undefined : join(testcase, file);
}

function run(args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [cli, ...args], {
        encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000,
      }),
    };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

function dirSize(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(child) : statSync(child).size;
  }
  return total;
}

const ids = readdirSync(join(bench, 'cases'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(bench, 'cases', name, 'case.json')))
  .filter((name) => only === undefined || only.split(',').includes(name))
  .sort();

mkdirSync(outRoot, { recursive: true });
const records = [];

for (const id of ids) {
  const plan = planOf(id);
  const seconds = windowSeconds(id);
  const outDir = join(outRoot, id);
  const record = { case: id, plan: plan ?? null, windowSeconds: seconds ?? null };
  if (plan === undefined) {
    record.status = 'no-plan';
    records.push(record);
    console.log(`${id}: no workload plan`);
    continue;
  }
  const duration = cap === undefined
    ? (seconds === undefined ? 15 : seconds)
    : Math.min(seconds ?? 15, cap);
  const started = Date.now();
  const workload = run(['workload', plan, '--duration', String(duration), '--out', outDir,
    ...(target === undefined ? [] : ['--target', target]), '--json']);
  record.durationS = duration;
  record.workloadExit = workload.code;
  try {
    record.workload = JSON.parse(workload.stdout);
  } catch {
    record.workload = { error: (workload.stderr || workload.stdout).slice(-2000) };
  }
  record.status = record.workload?.status ?? 'failed';
  record.wallS = Math.round((Date.now() - started) / 1000);

  if (record.status === 'ok') {
    const analyze = run(['analyze', outDir, '--json']);
    record.analyzeExit = analyze.code;
    try {
      const parsed = JSON.parse(analyze.stdout);
      record.metrics = parsed.metrics.length;
      record.degraded = parsed.metrics.filter((metric) => metric.degraded).length;
      record.evidence = parsed.evidence
        .filter((item) => item.kind !== 'degraded_capability' && item.kind !== 'no_data')
        .map((item) => item.kind);
      record.evidenceCounts = record.evidence.reduce((counts, kind) => {
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
      }, {});
    } catch {
      record.analyze = { error: (analyze.stderr || analyze.stdout).slice(-2000) };
    }
    const rootCause = run(['root-cause', outDir, '--out', join(outDir, 'root-cause'),
      '--offline', '--json']);
    record.rootCauseExit = rootCause.code;
    try {
      const parsed = JSON.parse(rootCause.stdout);
      record.rootCause = {
        verdict: parsed.summary.verdict,
        totals: parsed.summary.totals,
      };
    } catch {
      record.rootCause = { error: (rootCause.stderr || rootCause.stdout).slice(-2000) };
    }
  }
  record.bytes = dirSize(outDir);
  records.push(record);
  const measured = record.workload?.measured;
  const failedAction = measured?.actions?.find((action) => !action.ok);
  const where = record.status === 'ok'
    ? `${record.metrics ?? '?'} metrics, ${record.degraded ?? '?'} degraded,` +
      ` ${record.evidence?.length ?? 0} evidence, ${record.wallS}s`
    : `${record.workload?.setup?.ok === false ? 'setup' : 'measured'}:` +
      ` ${(record.workload?.error ?? failedAction?.error ?? record.workload?.error ?? '').slice(0, 120)}`;
  console.log(`${id}: ${record.status}  ${where}`);
}

writeFileSync(join(outRoot, 'dynamic.json'), `${JSON.stringify({ records }, null, 2)}\n`);
const ok = records.filter((record) => record.status === 'ok').length;
console.log(`\n${ok}/${records.length} captured and analyzed`);
