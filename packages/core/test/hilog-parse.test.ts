import { describe, it, expect } from 'vitest';
import { parseHilogLine, parseHilogText } from '../src/hilog/parse';

const LINE =
  '11-17 05:12:33.412  4999  5010 I A00000/com.demo/Image: ' +
  'CreatePixelMap success, memType : 3, cost 120 us';

/** 2026-11-17T05:13:00Z, the capture instant used by the fixtures. */
const CAPTURE = Date.UTC(2026, 10, 17, 5, 13);

describe('parseHilogLine', () => {
  it('parses the standard hilog line', () => {
    const row = parseHilogLine(LINE, 2026, CAPTURE);
    expect(row).toMatchObject({
      index: 0,
      level: 'I',
      pid: 4999,
      tid: 5010,
      domain: 'A00000',
      tag: 'com.demo/Image',
      parsed: true,
    });
    expect(row.message).toBe('CreatePixelMap success, memType : 3, cost 120 us');
    expect(new Date(row.ts).toISOString()).toBe('2026-11-17T05:12:33.412Z');
  });

  it('reads a December line as the previous year when the capture is in January', () => {
    const row = parseHilogLine(
      '12-31 23:59:59.999  1  1 I A/C: x',
      2027,
      Date.UTC(2027, 0, 1, 0, 1),
    );
    expect(new Date(row.ts).toISOString()).toBe('2026-12-31T23:59:59.999Z');
  });

  it('keeps a same-day line in the capture year', () => {
    const row = parseHilogLine(
      '01-01 00:00:01.000  1  1 I A/C: x',
      2027,
      Date.UTC(2027, 0, 1, 0, 5),
    );
    expect(new Date(row.ts).toISOString()).toBe('2027-01-01T00:00:01.000Z');
  });

  it('keeps an unparsable line as a raw row', () => {
    const row = parseHilogLine('garbage without a timestamp', 2026, CAPTURE);
    expect(row).toMatchObject({ parsed: false, ts: 0, message: 'garbage without a timestamp' });
  });

  it('keeps an unknown level character', () => {
    const row = parseHilogLine('11-17 05:12:33.412  1  1 X A/C: x', 2026, CAPTURE);
    expect(row.parsed).toBe(true);
    expect(row.level).toBe('X');
  });

  it('handles a message containing the separator characters', () => {
    const row = parseHilogLine(
      '11-17 05:12:33.412  1  1 I A/C: a: b / c',
      2026,
      CAPTURE,
    );
    expect(row.tag).toBe('C');
    expect(row.message).toBe('a: b / c');
  });
});

describe('parseHilogText', () => {
  it('counts every line once, with no trailing-newline loss', () => {
    const rows = parseHilogText(`${LINE}\n${LINE}`, { year: 2026, captureNs: CAPTURE });
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows.every((r) => r.parsed)).toBe(true);
  });

  it('drops one trailing empty line and keeps interior blanks as raw rows', () => {
    const rows = parseHilogText(`${LINE}\n\n${LINE}\n`, { year: 2026, captureNs: CAPTURE });
    expect(rows.map((r) => r.parsed)).toEqual([true, false, true]);
  });

  it('returns [] for an empty text', () => {
    expect(parseHilogText('', { year: 2026, captureNs: CAPTURE })).toEqual([]);
  });

  it('parses CRLF input', () => {
    const rows = parseHilogText(`${LINE}\r\n${LINE}\r\n`, { year: 2026, captureNs: CAPTURE });
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe('CreatePixelMap success, memType : 3, cost 120 us');
  });

  it('keeps every line raw when the capture year is unknown', () => {
    // A scene with no `scene.json` names no capture time, so a year-less
    // timestamp cannot be placed. Inventing one (1970, the host clock) would
    // be a confident wrong instant; raw rows keep the text and say so.
    const rows = parseHilogText(`${LINE}\n${LINE}`, { year: undefined, captureNs: 0 });
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows.every((r) => r.parsed === false && r.ts === 0)).toBe(true);
    expect(rows[0].message).toBe(LINE);
  });
});
