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
 * `year` is the capture year and `captureNs` the capture instant; a line later
 * than the capture by more than a few days is moved to `year - 1`, which is
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
  const inYear = Date.UTC(year, monthIndex, dayOfMonth, h, m, s, ms);
  const check = new Date(inYear);
  if (
    check.getUTCMonth() !== monthIndex ||
    check.getUTCDate() !== dayOfMonth ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== m ||
    check.getUTCSeconds() !== s
  ) {
    return rawLine(0, line);
  }

  // More than half a year ahead of the capture can only be the previous year.
  const ts = inYear - captureNs > MS_PER_YEAR / 2 ? Date.UTC(year - 1, monthIndex, dayOfMonth, h, m, s, ms) : inYear;

  return {
    index: 0,
    ts,
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
 * Parse a whole log.
 *
 * Splits on `\r?\n` and drops exactly one trailing empty element (the file's
 * final newline), so `lines.count` equals the number of lines a reader sees.
 * Interior blank lines stay as raw rows.
 */
export function parseHilogText(
  text: string,
  opts: { year: number; captureNs: number },
): HilogLine[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((line, index) => {
    const parsed = parseHilogLine(line, opts.year, opts.captureNs);
    return { ...parsed, index };
  });
}
