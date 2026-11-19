import { describe, it, expect } from 'vitest';
import { aaStartFailed } from '../src/device/launch';

/**
 * `aa start` answers exit 0 whether or not it started anything.
 *
 * Measured on the emulator for a bundle that is not installed:
 *
 * ```
 * error: failed to start ability.
 * Error Code:10104001  Error Message:The specified ability does not exist
 * Error cause: The specified Ability is not installed
 * ```
 *
 * with `echo $?` printing `0`. Three call sites — the workload runner's
 * `launch`, the scenario runner's `launch`, and `collect --cold-start` — each
 * read only the exit code, so all three recorded a start for an app that was
 * never there. The cloudmusic cases were reported as a setup wait that matched
 * nothing, which points a reader at the plan rather than at the missing app.
 */
describe('aaStartFailed', () => {
  it('accepts the device\'s own success line', () => {
    expect(aaStartFailed({ stdout: 'start ability successfully.\n', stderr: '', code: 0 })).toBe(false);
  });

  it('rejects a launch that printed the not-installed error and exited 0', () => {
    const result = {
      stdout:
        'error: failed to start ability.\n' +
        'Error Code:10104001  Error Message:The specified ability does not exist\n' +
        'Error cause: The specified Ability is not installed\n',
      stderr: '',
      code: 0,
    };
    expect(aaStartFailed(result)).toBe(true);
  });

  it('rejects a nonzero exit even when the output looks fine', () => {
    // A transport failure can leave stdout empty and the code set.
    expect(aaStartFailed({ stdout: '', stderr: '', code: 1 })).toBe(true);
  });

  it('looks at stderr as well as stdout', () => {
    // hdc does not promise which stream the device's diagnostics land on.
    expect(
      aaStartFailed({ stdout: '', stderr: 'error: failed to start ability.\n', code: 0 }),
    ).toBe(true);
  });
});
