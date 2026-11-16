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

/**
 * The `ipid` of every app pid, in `pids` order, without duplicates.
 *
 * `AppIdentity.pids` are **pids** while `thread.ipid`, `frame_slice.ipid`,
 * `process_measure_filter.ipid` and `app_startup.ipid` are **ipids**: the two
 * number spaces overlap, so comparing them directly silently reads another
 * process's rows (measured on the Mate 60: sceneboard has `pid=6500` and
 * `ipid=117`). `ProcessQuery.byPid` is the only safe translation, and it
 * resolves duplicate pids to the lowest row id (D5).
 *
 * `ipid` 0 is a NULL column, not a process — the query layer maps NULL to 0 —
 * so it is skipped, as are non-integers. An empty result means "no process
 * identified", which every caller must treat as "no data", never as
 * "device-wide".
 */
export function resolveAppIpids(
  processes: ProcessQuery,
  pids: readonly number[],
): number[] {
  const ipids: number[] = [];
  const seen = new Set<number>();
  for (const pid of pids) {
    const ipid = processes.byPid(pid)?.ipid;
    if (ipid === undefined || !Number.isInteger(ipid) || ipid <= 0) continue;
    if (seen.has(ipid)) continue;
    seen.add(ipid);
    ipids.push(ipid);
  }
  return ipids;
}
