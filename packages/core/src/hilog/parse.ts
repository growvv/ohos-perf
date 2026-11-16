/**
 * hilog line parsing.
 *
 * A hilog line is:
 *
 * ```
 * MM-DD HH:MM:SS.mmm  PID  TID  LEVEL  DOMAIN/TAG  message
 * ```
 *
 * The timestamp carries **no year**. The year comes from the scene's capture
 * metadata, and a month/day that would place the line after the capture is
 * read as the previous year: the alternative (this year) invents a future log,
 * which no real capture can contain.
 *
 * A line that does not match is kept as a raw row (`parsed: false`) rather
 * than dropped. A rule count computed over silently discarded lines is a
 * number nobody can check.
 */

/** The five documented levels, plus whatever character the device printed. */
export type HilogLevel = 'D' | 'I' | 'W' | 'E' | 'F' | string;

/** One log line, parsed or raw. `index` is the file order, 0-based. */
export interface HilogLine {
  readonly index: number;
  /** Nanoseconds since the Unix epoch; `0` on a raw row. */
  readonly ts: number;
  readonly level: HilogLevel;
  readonly pid: number;
  readonly tid: number;
  readonly domain: string;
  readonly tag: string;
  readonly message: string;
  readonly parsed: boolean;
}

/**
 * `MM-DD HH:MM:SS.mmm  PID  TID  LEVEL  DOMAIN/TAG: message`
 *
 * Fields are separated by one or more spaces (the device pads pid/tid).
 * `tag` stops at the first `:` after the domain, so a tag containing `/`
 * keeps it; the message keeps every `:` after that.
 */
const LINE_PATTERN =
  /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+(\S)\s+([^/\s]+)\/(\S+?):\s?(.*)$/;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Nanoseconds in one millisecond; `ts` is ns, `Date.UTC` is ms. */
const NS_PER_MS = 1e6;

function rawLine(index: number, message: string): HilogLine {
  return {
    index,
    ts: 0,
    level: '',
    pid: 0,
    tid: 0,
    domain: '',
    tag: '',
    message,
    parsed: false,
  };
}

/**
 * Parse one line.
 *
 * `year` is the capture year and `captureNs` the capture instant in
 * nanoseconds — the same clock base as trace `ts` and every query window. A
 * line later than the capture by more than half a year is moved to `year - 1`,
 * the only reading that cannot produce a future log from a year-less format.
 */
export function parseHilogLine(line: string, year: number, captureNs: number): HilogLine {
  const match = LINE_PATTERN.exec(line);
  if (match === null) return rawLine(0, line);

  const [, month, day, hour, minute, second, milli, pid, tid, level, domain, tag, message] =
    match;
  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  const ms = Number(milli);

  // A date that does not exist in the capture year (e.g. 02-29 in a common
  // year) is still a raw row: fabricating a timestamp would misplace it.
  const inYearMs = Date.UTC(year, monthIndex, dayOfMonth, h, m, s, ms);
  const check = new Date(inYearMs);
  if (
    check.getUTCMonth() !== monthIndex ||
    check.getUTCDate() !== dayOfMonth ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== m ||
    check.getUTCSeconds() !== s
  ) {
    return rawLine(0, line);
  }

  // Compare in milliseconds: the capture instant arrives in nanoseconds, and
  // comparing it to a millisecond value directly makes the rule unreachable.
  const captureMs = captureNs / NS_PER_MS;
  const tsMs = inYearMs - captureMs > MS_PER_YEAR / 2
    ? Date.UTC(year - 1, monthIndex, dayOfMonth, h, m, s, ms)
    : inYearMs;

  return {
    index: 0,
    ts: tsMs * NS_PER_MS,
    level,
    pid: Number(pid),
    tid: Number(tid),
    domain,
    tag,
    message,
    parsed: true,
  };
}

/**
 * How to place a year-less timestamp on the timeline.
 *
 * `year` comes from `scene.json`'s capture time and is **absent** for a scene
 * with no descriptor. A raw scene still has a log worth counting, so an absent
 * year yields raw rows (`parsed: false`, `ts: 0`) rather than a guess: 1970 or
 * the host clock would be a confident wrong instant, and every `hilog.around`
 * window built from it would be wrong too.
 */
export interface HilogParseOptions {
  readonly year?: number;
  /** The capture instant, ns since epoch. `0` means unknown. */
  readonly captureNs: number;
}

/**
 * Parse a whole log.
 *
 * Splits on `\r?\n` and drops exactly one trailing empty element (the file's
 * final newline), so `lines.count` equals the number of lines a reader sees.
 * Interior blank lines stay as raw rows.
 */
export function parseHilogText(text: string, opts: HilogParseOptions): HilogLine[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const year = opts.year;
  return parts.map((line, index) => {
    const parsed = year === undefined
      ? rawLine(index, line)
      : parseHilogLine(line, year, opts.captureNs);
    return { ...parsed, index };
  });
}
