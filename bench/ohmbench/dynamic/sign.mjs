#!/usr/bin/env node
/**
 * Sign OhmBench's unsigned HAPs with the OpenHarmony test identity.
 *
 * The benchmark ships `app-unsigned.hap` per case and leaves signing to the
 * user (`docs/build.md`). This script produces the two things a device needs:
 * a debug provisioning profile naming the app's bundle, and a HAP signed with
 * the profile and the OpenHarmony Application Release key that the emulator
 * trusts.
 *
 * The signing material is the SDK's own: `OpenHarmony.p12` and
 * `OpenHarmonyProfileDebug.pem` under the command-line-tools `toolchains/lib`
 * directory, plus the application release certificate chain. Passwords are the
 * published OpenHarmony test password, not a secret.
 *
 * Usage:
 *   node sign.mjs --bench <OhmBench> --cases <reconstructed-trees> \
 *     --out <signed-root> --toolchain <command-line-tools> [case-id ...]
 *
 * Every path is an argument because the case trees are untrusted data: this
 * script never runs from inside one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EMULATOR_UDID = '454D55057494E058383601813E81FA5EC4CD2B347B5074C756DBD00000000000';
const PASSWORD = '123456';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

const bench = resolve(arg('bench'));
const casesRoot = resolve(arg('cases'));
const outRoot = resolve(arg('out'));
const toolchain = resolve(arg('toolchain'));
const buildManifestPath = arg('build-manifest');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Case ids follow the flag values; drop the values themselves.
const flagValues = new Set(
  process.argv.flatMap((token, index) =>
    token.startsWith('--') ? [process.argv[index + 1]] : []),
);
const requested = only.filter((token) => !flagValues.has(token));

const lib = join(toolchain, 'sdk', 'default', 'openharmony', 'toolchains', 'lib');
const signTool = join(lib, 'hap-sign-tool.jar');
const keystore = join(lib, 'OpenHarmony.p12');
const profileCert = join(lib, 'OpenHarmonyProfileDebug.pem');
const appCert = resolve(arg('app-cert', join(lib, 'OpenHarmonyApplication.pem')));
const java = arg('java', join(toolchain, 'jbr', 'bin', 'java.exe'));

if (!existsSync(signTool)) throw new Error(`hap-sign-tool.jar not found under ${lib}`);
if (!existsSync(appCert)) {
  throw new Error(
    `application certificate chain not found at ${appCert}; pass --app-cert <pem>\n` +
    '(three-level-two-root chain for "OpenHarmony Application Release")',
  );
}

/** Run one hap-sign-tool command and return its combined output. */
function sign(args) {
  return execFileSync(java, ['-jar', signTool, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The HAP's own minAPIVersion, read without extracting anything.
 *
 * `unzip -p` prints one member to stdout; the file is untrusted input to the
 * zip reader, not to an interpreter, so this stays a plain data read.
 */
function minApi(hap) {
  const module = JSON.parse(execFileSync('unzip', ['-p', hap, 'module.json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  const value = module.app?.minAPIVersion ?? 12;
  return String(value);
}

function profileFor(bundle) {
  return {
    'version-name': '2.0.0',
    'version-code': 2,
    uuid: '11111111-2222-3333-4444-555555555555',
    validity: { 'not-before': 1750000000, 'not-after': 1900000000 },
    type: 'debug',
    'bundle-info': {
      'developer-id': 'OpenHarmony',
      // The first certificate of the chain is the application-signing leaf;
      // the profile names it verbatim, with no `\r` for the pad parser to
      // trip over.
      'development-certificate':
        readFileSync(appCert, 'utf8').split('-----END CERTIFICATE-----')[0]
          .replace(/\r/g, '') + '-----END CERTIFICATE-----\n',
      'bundle-name': bundle,
      apl: 'normal',
      'app-feature': 'hos_normal_app',
    },
    acls: { 'allowed-acls': [''] },
    permissions: { 'restricted-permissions': [''] },
    'debug-info': { 'device-ids': [EMULATOR_UDID], 'device-id-type': 'udid' },
    issuer: 'pki_internal',
  };
}

const results = {};
const ids = requested.length === 0
  ? readdirSorted(casesRoot)
  : requested;
const built = buildManifestPath === undefined
  ? undefined
  : JSON.parse(readFileSync(resolve(buildManifestPath), 'utf8'));

function readdirSorted(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

for (const id of ids) {
  const caseDir = join(bench, 'cases', id);
  const tree = join(casesRoot, id);
  if (!existsSync(caseDir) || !existsSync(tree)) {
    results[id] = { ok: false, error: 'case or tree missing' };
    continue;
  }
  const prompt = JSON.parse(readFileSync(join(caseDir, 'prompt.json'), 'utf8'));
  const bundle = prompt.bundle_name;
  const hap = built === undefined
    ? execFileSync('bash', ['-c',
      `find ${JSON.stringify(tree)} -path '*/outputs/*' -name '*-unsigned.hap' | head -1`,
    ], { encoding: 'utf8' }).trim()
    : (built[id] ?? '');
  if (hap === '' || !hap.endsWith('.hap')) {
    results[id] = { ok: false, error: 'no unsigned hap' };
    continue;
  }
  const outDir = join(outRoot, id);
  mkdirSync(outDir, { recursive: true });
  const profileJson = join(outDir, 'profile.json');
  const profileP7b = join(outDir, 'profile.p7b');
  const signed = join(outDir, `${id}-signed.hap`);
  try {
    writeFileSync(profileJson, JSON.stringify(profileFor(bundle), null, 1));
    sign([
      'sign-profile', '-mode', 'localSign',
      '-keyAlias', 'openharmony application profile debug',
      '-keyPwd', PASSWORD,
      '-profileCertFile', profileCert,
      '-inFile', profileJson,
      '-signAlg', 'SHA256withECDSA',
      '-keystoreFile', keystore,
      '-keystorePwd', PASSWORD,
      '-outFile', profileP7b,
    ]);
    sign([
      'sign-app', '-mode', 'localSign',
      '-keyAlias', 'openharmony application release',
      '-keyPwd', PASSWORD,
      '-appCertFile', appCert,
      '-profileFile', profileP7b,
      '-inFile', hap,
      '-signAlg', 'SHA256withECDSA',
      '-keystoreFile', keystore,
      '-keystorePwd', PASSWORD,
      '-outFile', signed,
      '-compatibleVersion', minApi(hap),
      '-signCode', '1',
    ]);
    results[id] = { ok: true, bundle, hap: signed, from: hap };
  } catch (err) {
    results[id] = { ok: false, error: String(err.message ?? err).slice(-400) };
  }
  const record = results[id];
  console.log(`${id}: ${record.ok ? 'signed' : 'FAILED ' + record.error}`);
}

writeFileSync(join(outRoot, 'sign.json'), JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([, r]) => !r.ok);
console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} signed`);
if (failed.length > 0) process.exitCode = 1;
