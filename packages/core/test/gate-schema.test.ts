import { describe, it, expect } from 'vitest';
import {
  BUDGET_SCHEMA_VERSION,
  deltaBudgetIds,
  parseBudgetDocument,
} from '../src/gate/schema';

/*
 * A budget document is committed beside the code and shared between people and
 * CI jobs, so it is data from outside the package: every field is checked, an
 * unknown key is an error, and every rejection names the JSON path. The tests
 * below pin both halves — what a valid document parses to, and that each
 * rejection says where it failed.
 */

function doc(budgets: unknown[]): unknown {
  return { schemaVersion: BUDGET_SCHEMA_VERSION, name: 'open-app', budgets };
}

describe('parseBudgetDocument', () => {
  it('parses a minimal document', () => {
    expect(parseBudgetDocument(doc([{ id: 'frame.jank.rate', max: 5 }]))).toEqual({
      schemaVersion: 1,
      name: 'open-app',
      budgets: [{ id: 'frame.jank.rate', bound: { kind: 'max', limit: 5 } }],
    });
  });

  it('parses each of the four bound kinds, keeping the limit exactly', () => {
    const parsed = parseBudgetDocument(
      doc([
        { id: 'a.max', max: 1.5 },
        { id: 'b.min', min: 55 },
        { id: 'c.delta', maxDelta: 0.25 },
        { id: 'd.pct', maxDeltaPct: -3 },
      ]),
    );
    expect(parsed.budgets.map((entry) => entry.bound)).toEqual([
      { kind: 'max', limit: 1.5 },
      { kind: 'min', limit: 55 },
      { kind: 'maxDelta', limit: 0.25 },
      { kind: 'maxDeltaPct', limit: -3 },
    ]);
  });

  it('sorts budgets by id regardless of document order', () => {
    const parsed = parseBudgetDocument(
      doc([
        { id: 'z.metric', max: 1 },
        { id: 'a.metric', max: 2 },
        { id: 'm.metric', max: 3 },
      ]),
    );
    expect(parsed.budgets.map((entry) => entry.id)).toEqual(['a.metric', 'm.metric', 'z.metric']);
  });

  it('names only the delta budgets as needing a baseline', () => {
    const parsed = parseBudgetDocument(
      doc([
        { id: 'b.pct', maxDeltaPct: 1 },
        { id: 'a.delta', maxDelta: 1 },
        { id: 'c.max', max: 1 },
        { id: 'd.min', min: 1 },
      ]),
    );
    expect(deltaBudgetIds(parsed)).toEqual(['a.delta', 'b.pct']);
    expect(deltaBudgetIds(parseBudgetDocument(doc([{ id: 'x', max: 1 }])))).toEqual([]);
  });

  it('rejects a document that is not an object', () => {
    for (const input of [null, [], 'doc', 3]) {
      expect(() => parseBudgetDocument(input)).toThrow(/^invalid budget document:/);
    }
    expect(() => parseBudgetDocument(null)).toThrow(/BUDGET_BAD_DOCUMENT|invalid budget document/);
  });

  it('names the schemaVersion it found and the one it accepts', () => {
    expect(() => parseBudgetDocument({ schemaVersion: 2, name: 'x', budgets: [] })).toThrow(
      /schemaVersion: expected 1, got 2/,
    );
  });

  it('rejects an unknown document key by name', () => {
    expect(() =>
      parseBudgetDocument({ schemaVersion: 1, name: 'x', budgets: [], extra: true }),
    ).toThrow(/unknown key "extra"/);
  });

  it('rejects an empty name and an empty budget list, naming each', () => {
    expect(() => parseBudgetDocument({ schemaVersion: 1, name: '', budgets: [] })).toThrow(/name/);
    expect(() => parseBudgetDocument({ schemaVersion: 1, name: 'x', budgets: [] })).toThrow(
      /budgets/,
    );
  });

  it('rejects an entry with no bound or two bounds, naming its index', () => {
    expect(() => parseBudgetDocument(doc([{ id: 'a' }]))).toThrow(/budgets\[0\]/);
    expect(() => parseBudgetDocument(doc([{ id: 'a', max: 1, min: 1 }]))).toThrow(/budgets\[0\]/);
  });

  it('rejects a duplicate metric id, naming the id and the second path', () => {
    expect(() =>
      parseBudgetDocument(doc([{ id: 'frame.fps', max: 1 }, { id: 'frame.fps', min: 2 }])),
    ).toThrow(/budgets\[1\].*frame\.fps|frame\.fps.*budgets\[1\]/);
  });

  it('rejects a limit that is not a finite number, naming the value', () => {
    expect(() => parseBudgetDocument(doc([{ id: 'a', max: '5' }]))).toThrow(/budgets\[0\].*"5"/);
    expect(() => parseBudgetDocument(doc([{ id: 'a', max: Infinity }]))).toThrow(/budgets\[0\]/);
  });

  it('rejects an id that is not a non-empty string', () => {
    expect(() => parseBudgetDocument(doc([{ id: '', max: 1 }]))).toThrow(/budgets\[0\]/);
    expect(() => parseBudgetDocument(doc([{ id: 4, max: 1 }]))).toThrow(/budgets\[0\]/);
  });

  it('rejects an unknown key inside an entry', () => {
    expect(() => parseBudgetDocument(doc([{ id: 'a', max: 1, above: 2 }]))).toThrow(
      /budgets\[0\].*"above"/,
    );
  });
});
