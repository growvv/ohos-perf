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
 * The `ipid` of every app process, resolved by pid first and by name second.
 *
 * `AppIdentity.pids` are **pids** while `thread.ipid`, `frame_slice.ipid`,
 * `process_measure_filter.ipid` and `app_startup.ipid` are **ipids**: the two
 * number spaces overlap, so comparing them directly silently reads another
 * process's rows (measured on the Mate 60: sceneboard has `pid=6500` and
 * `ipid=117`). `ProcessQuery.byPid` is the only safe translation, and it
 * resolves duplicate pids to the lowest row id (D5).
 *
 * The name route exists because a trace records the kernel's `comm`, capped at
 * 15 characters: `com.hefengbao.jingmo.hw` is stored as `ngbao.jingmo.hw`, and
 * a plain hitrace capture records no pid at all. Without the fallback every
 * app-attributed analyzer reported `no_data` on a trace that was full of the
 * app (measured: a 6 s emulator capture, 2026-11-19). A name matches when it
 * is the bundle itself, the comm truncation of it (the bundle ends with the
 * name), or one of its `:`-separated sub-processes. Short names are not
 * eligible: a 3-character comm can be a suffix of half the system.
 *
 * `ipid` 0 is a NULL column, not a process — the query layer maps NULL to 0 —
 * so it is skipped, as are non-integers. An empty result means "no process
 * identified", which every caller must treat as "no data", never as
 * "device-wide".
 */
export function resolveAppIpids(
  processes: ProcessQuery,
  app: AppIdentity,
): number[] {
  const ipids: number[] = [];
  const seen = new Set<number>();
  const remember = (ipid: number | undefined): void => {
    if (ipid === undefined || !Number.isInteger(ipid) || ipid <= 0) return;
    if (seen.has(ipid)) return;
    seen.add(ipid);
    ipids.push(ipid);
  };
  for (const pid of app.pids) remember(processes.byPid(pid)?.ipid);
  // The pid route resolved something: the caller's list is authoritative and
  // a name search could only add another app's rows.
  if (ipids.length > 0) return ipids;

  const names = app.processNames.filter((name) => name !== '');
  if (names.length === 0) return ipids;
  for (const process of processes.all()) {
    if (names.some((name) => commMatches(process.name, name))) remember(process.ipid);
  }
  return ipids;
}

/**
 * Whether a trace's `process.name` names `bundle` or one of its processes.
 *
 * The 15-character floor is the kernel's comm limit's useful half: a name
 * shorter than that either is the whole bundle (matched by equality) or is
 * too generic to claim. `com.example.app:remote` is a child process of
 * `com.example.app` and counts; a bare `app` does not.
 */
function commMatches(comm: string, bundle: string): boolean {
  if (comm === '') return false;
  if (comm === bundle) return true;
  if (comm.startsWith(`${bundle}:`)) return true;
  return comm.length >= 15 && bundle.endsWith(comm);
}
