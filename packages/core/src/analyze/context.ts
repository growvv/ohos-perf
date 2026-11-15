import type { ProcessQuery } from '../query/process';
import type { AppIdentity } from '../types';

/**
 * Resolves the analyzed package to the identity every analyzer receives.
 *
 * The lookup is exact (`byName`), so a process named `com.demo:remote` is a
 * different process from `com.demo` and is not picked up here. `byName`
 * resolves duplicate names to the lowest `id`, keeping the result
 * deterministic (D5).
 *
 * An app that is not present in the trace yields `pids: []` rather than an
 * error: an offline analysis may legitimately target a package whose process
 * did not appear in the capture, and the analyzers decide what "no pid" means
 * for their metrics. `processNames` is always exactly `[packageName]`, even
 * when the process was not found.
 */
export function resolveAppIdentity(
  processes: ProcessQuery,
  packageName: string,
): AppIdentity {
  const process = processes.byName(packageName);
  return {
    packageName,
    pids: process === undefined ? [] : [process.pid],
    processNames: [packageName],
  };
}
