/**
 * Did `aa start` actually start anything?
 *
 * The exit code says no such thing. Measured on the emulator (OpenHarmony
 * 6.1.1.125), starting a bundle that is not installed prints
 *
 * ```
 * error: failed to start ability.
 * Error Code:10104001  Error Message:The specified ability does not exist
 * Error cause: The specified Ability is not installed
 * ```
 *
 * and `echo $?` prints `0`. A successful start prints
 * `start ability successfully.` and also exits 0. Three call sites read the
 * code alone — the workload runner's `launch`, the scenario runner's
 * `launch`, and `collect --cold-start` — so each could record a start for an
 * app that was never there. That is how the OhmBench cloudmusic cases came to
 * be reported as a setup `wait` that matched nothing: the app was not
 * installed, and nothing said so.
 *
 * hdc does not promise which stream a device's diagnostics land on, so both
 * are searched.
 */
export function aaStartFailed(result: { stdout: string; stderr: string; code: number }): boolean {
  if (result.code !== 0) return true;
  return `${result.stdout}\n${result.stderr}`.includes(LAUNCH_FAILURE_MARKER);
}

/** The line `aa start` prints when it started nothing, with exit code 0. */
const LAUNCH_FAILURE_MARKER = 'failed to start ability';
