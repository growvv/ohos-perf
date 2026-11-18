#!/usr/bin/env node
/**
 * Run the CLI over every OhmBench case and write one result file per case.
 *
 * Usage:
 *   node bench/ohmbench/run.mjs --bench <OhmBench> --cases <trees> --out <dir>
 *
 * `<trees>` holds one reconstructed source tree per case: the upstream project
 * with that case's `source.patch` applied. `<OhmBench>` must be cloned with
 * `core.autocrlf=false`; with it on, the patch files arrive as CRLF and none
 * of them apply.
 *
 * The output is the shape `score.mjs` reads: `{case, tool, suspects: [...]}`,
 * with the suspects cut to the top five and the field names the benchmark
 * documents (`class`, `line_start`, `line_end`).
 *
 * The scan is driven through the built CLI, not through the library, so the
 * number this produces is the number a user of the tool would get.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../../packages/cli/dist/index.js');

function option(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

const bench = option('--bench');
const casesDir = option('--cases');
const outDir = option('--out');
if (bench === undefined || casesDir === undefined || outDir === undefined) {
  process.stderr.write('usage: run.mjs --bench <OhmBench> --cases <trees> --out <dir>\n');
  process.exit(2);
}
if (!existsSync(cli)) {
  process.stderr.write(`the CLI is not built: ${cli}\nrun: npm run build -w packages/cli\n`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (const name of readdirSync(join(bench, 'cases')).sort()) {
  const tree = join(casesDir, name);
  // A case whose tree was not reconstructed is skipped, not scored as empty:
  // an empty answer would read as a detector failure rather than a missing
  // input.
  if (!existsSync(join(tree, 'build-profile.json5'))) continue;
  const prompt = join(bench, 'cases', name, 'prompt.json');
  const argv = [cli, 'suspects', tree, '--json'];
  if (existsSync(prompt)) argv.push('--prompt', prompt);
  const document = JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 1 << 28 }));
  writeFileSync(
    join(outDir, `${name}.json`),
    `${JSON.stringify(
      {
        case: name,
        tool: 'ohos-perf',
        suspects: document.suspects.slice(0, 5).map((suspect) => ({
          rank: suspect.rank,
          file: suspect.file,
          class: suspect.className ?? null,
          symbol: suspect.symbol ?? null,
          line_start: suspect.lineStart,
          line_end: suspect.lineEnd,
          description: suspect.description,
        })),
      },
      null,
      2,
    )}\n`,
  );
  written += 1;
}
process.stdout.write(`wrote ${written} record(s) to ${outDir}\n`);
