import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI must run the workspace's core, not a published copy of it.
 *
 * Found the hard way: npm had installed `@ohos-perf/core@0.33.2` under
 * `packages/cli/node_modules`, and a nested `node_modules` beats the hoisted
 * workspace link. `packages/cli/dist/index.js` therefore imported 0.33.2 — and
 * a whole device sweep was run against it, so its results measured the previous
 * build while every local test passed against the workspace source.
 *
 * The failure is silent in every direction: the CLI starts, its version string
 * is its own, and only the behaviour differs. So the check is on the tree and
 * on what the built CLI actually resolves, not on a version string.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..');
const REPO = join(CLI, '../..');

describe('the CLI resolves the workspace core', () => {
  it('has no nested copy of @ohos-perf/core under packages/cli/node_modules', () => {
    // A directory here is a published tarball, not a link. npm creates one when
    // the declared range does not match the workspace version — e.g. while a
    // new core version is still propagating — and then keeps it.
    const nested = join(CLI, 'node_modules/@ohos-perf/core');
    expect(
      existsSync(nested),
      `${nested} exists; a published copy shadows the workspace link, so the ` +
        `CLI runs that copy's code. Remove it and run \`npm install\`.`,
    ).toBe(false);
  });

  it('the lockfile links core to the workspace instead of pinning a tarball', () => {
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; resolved?: string; link?: boolean }>;
    };
    const workspace = lock.packages['node_modules/@ohos-perf/core'];
    expect(workspace?.link, 'node_modules/@ohos-perf/core is not a workspace link').toBe(true);
    const nested = Object.keys(lock.packages).filter(
      (key) => key.endsWith('@ohos-perf/core') && key !== 'node_modules/@ohos-perf/core',
    );
    expect(
      nested,
      `the lockfile pins a published core at ${nested.join(', ')}; that is what ` +
        `npm will install as a shadowing copy`,
    ).toEqual([]);
  });

  it('the CLI\'s own declared range is the workspace version', () => {
    // The pin is exact (no `^`), so it must equal core's version or npm will
    // resolve the published tarball for the mismatch.
    const cli = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const core = JSON.parse(readFileSync(join(CLI, '../core/package.json'), 'utf8')) as {
      version: string;
    };
    expect(cli.dependencies['@ohos-perf/core']).toBe(core.version);
  });

  it('the built CLI is not older than the core it imports', () => {
    // A stale CLI dist is the same defect from the other side: the sweep runs
    // `packages/cli/dist/index.js` directly, so a build older than core's
    // dist may still contain the previous core's inlined or resolved paths.
    const cliDist = join(CLI, 'dist/index.js');
    if (!existsSync(cliDist)) return; // a checkout without a build has nothing to check
    const coreDist = join(CLI, '../core/dist/index.js');
    expect(statSync(cliDist).mtimeMs).toBeGreaterThanOrEqual(statSync(coreDist).mtimeMs - 1000);
  });
});
