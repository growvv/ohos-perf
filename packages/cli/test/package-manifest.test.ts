import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The CLI is published against a *published* core, so the two manifests must
 * agree on the version at release time.
 *
 * The defect this pins: 0.12.0 shipped with `"@ohos-perf/core": "0.11.0"`
 * because the dependency was written by hand and never bumped. The published
 * CLI installed the previous core and died on its first import —
 * `does not provide an export named 'discoverCases'` — while every workspace
 * test stayed green, because inside the workspace the dependency resolves to
 * the local package and the range is never consulted.
 *
 * An exact pin is deliberate: core and CLI share one release, so a range
 * would only let a user install a pair we never tested.
 */
const read = (path: string): { version: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));

const cli = read('../package.json');
const core = read('../../core/package.json');

describe('the published CLI depends on the core it ships with', () => {
  it('pins @ohos-perf/core to the core package version', () => {
    expect(cli.dependencies?.['@ohos-perf/core']).toBe(core.version);
  });

  it('pins it exactly, not as a range', () => {
    // `^0.12.0` would resolve to whatever is newest, which is how a CLI ends
    // up importing a symbol a later core renamed.
    expect(cli.dependencies?.['@ohos-perf/core']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
