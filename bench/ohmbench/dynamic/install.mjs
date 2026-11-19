#!/usr/bin/env node
/**
 * Install the signed HAPs on one device.
 *
 * Usage:
 *   node bench/ohmbench/dynamic/install.mjs --signed <signed-root> \
 *     --hdc <hdc.exe> --target <id> [case-id ...]
 *
 * The HAPs are untrusted data and are only ever copied to the device; the
 * `bm install` call names a device path, never a host path, because hdc on
 * Windows rewrites a host path it does not recognise and the install then
 * fails with "install file path invalid".
 *
 * An install that the device refuses is recorded, not retried: a refusal names
 * a permission the app asks for that a debug profile cannot grant
 * (`ohos.permission.SYSTEM_FLOAT_WINDOW` on cloudmusic), which is a fact about
 * the app, not a transient failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function option(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

const signedRoot = resolve(option('--signed') ?? '');
const hdc = option('--hdc');
const target = option('--target');
if (option('--signed') === undefined || hdc === undefined || target === undefined) {
  process.stderr.write(
    'usage: install.mjs --signed <root> --hdc <hdc.exe> --target <id> [case-id ...]\n',
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(signedRoot, 'sign.json'), 'utf8'));
// Positional case ids: every token that is neither a flag nor a flag's value.
const flagValues = new Set(
  process.argv.flatMap((token, index) =>
    token.startsWith('--') ? [process.argv[index + 1]] : []),
);
const requested = process.argv.slice(2)
  .filter((token) => !token.startsWith('--') && !flagValues.has(token));

function shell(command) {
  return execFileSync(hdc, ['-t', target, 'shell', command], { encoding: 'utf8' });
}

const results = {};
for (const [id, entry] of Object.entries(manifest)) {
  if (requested.length > 0 && !requested.includes(id)) continue;
  if (!entry.ok) {
    results[id] = { ok: false, error: 'not signed' };
    continue;
  }
  const local = entry.hap;
  if (!existsSync(local)) {
    results[id] = { ok: false, error: 'signed hap missing' };
    continue;
  }
  const remote = `/data/local/tmp/${id}.hap`;
  try {
    // A relative path from the HAP's own directory: hdc resolves a host path
    // against its working directory, and a Windows absolute path arrives at
    // the device side as `D:/...` and is rejected.
    execFileSync(hdc, ['-t', target, 'file', 'send', local.split(/[\\/]/).pop(), remote], {
      cwd: dirname(local), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    const output = shell(`bm install -p ${remote}`);
    const ok = output.includes('install bundle successfully');
    results[id] = {
      ok,
      bundle: entry.bundle,
      ...(ok ? {} : { error: output.trim().split('\n').slice(-2).join(' ') }),
    };
  } catch (err) {
    results[id] = {
      ok: false,
      error: String(err.stdout ?? err.message ?? err).trim().split('\n').slice(-2).join(' '),
    };
  }
  shell(`rm -f ${remote}`);
  console.log(`${id}: ${results[id].ok ? 'installed' : 'FAILED ' + results[id].error}`);
}

writeFileSync(join(signedRoot, 'install.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = Object.values(results).filter((entry) => !entry.ok).length;
console.log(`\n${Object.keys(results).length - failed}/${Object.keys(results).length} installed`);
