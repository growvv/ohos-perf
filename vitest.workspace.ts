import { defineWorkspace } from 'vitest/config';
import { nodeSqliteShim } from './vitest.shim';

/**
 * Two projects, because the suites have incompatible concurrency needs.
 *
 * `unit` (vitest.config.ts) holds every fake-injected test: fast and fully
 * parallel. `device` holds the tests that talk to an attached HarmonyOS
 * device, and they must run **serially**. They share one device, and hitrace,
 * uitest and hiprofiler each own a single fixed device path; running two at
 * once produced `OpenRecording failed, errorCode(1103)` and a zero-byte
 * `ui.json` — failures of the test harness, not of the collectors.
 *
 * Vitest 2.1's workspace entries ignore `fileParallelism` — it is a root-level
 * option, and setting it on a project has no effect (measured: six of seven
 * files still failed). `singleFork` *is* honoured per project, so the project
 * pins itself to one fork rather than relying on every caller remembering
 * `--fileParallelism=false`: `npx vitest run --project device` and
 * `npm run test:device` both produce 11 passing tests, and removing the option
 * fails six files with the same three signatures (`OpenRecording failed,
 * errorCode(1103)`, `CreateSession FAIL`, a truncated `StopSession start!`).
 * `maxConcurrency: 1` keeps tests inside one file serial as well.
 */
export default defineWorkspace([
  'vitest.config.ts',
  {
    plugins: [nodeSqliteShim],
    test: {
      name: 'device',
      include: ['packages/**/test/**/*.device.test.ts'],
      maxConcurrency: 1,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 180_000,
      hookTimeout: 60_000,
    },
  },
]);
