import { describe, it, expect } from 'vitest';
import { PARITY_ROWS, paritySummary } from '../src/parity';
import { defaultAnalyzers } from '../src/analyze/engine';

/*
 * The parity ledger is the only place the "how much of HapRay do we have"
 * claim lives. It exists because the README's arithmetic drifted: it said
 * 18 ported / 9 partial / 8 missing long after releases had moved six rows,
 * and nothing failed when it did.
 *
 * A claim that cannot be reproduced from the inventory is a claim, not a
 * measurement. So every row carries its status and, when it is not ported,
 * the reason; and the test below checks the ported rows against the analyzers
 * the engine actually registers.
 */

describe('the parity ledger', () => {
  it('has one row per HapRay capability, numbered 1..35', () => {
    expect(PARITY_ROWS).toHaveLength(35);
    expect(PARITY_ROWS.map((row) => row.row)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1),
    );
  });

  it('gives every row a status, and a reason when it is not ported', () => {
    for (const row of PARITY_ROWS) {
      expect(['ported', 'partial', 'missing', 'out']).toContain(row.status);
      expect(row.name.length).toBeGreaterThan(0);
      if (row.status !== 'ported') {
        // A bare "missing" is the claim this ledger exists to prevent.
        expect(row.reason.length).toBeGreaterThan(20);
      }
    }
  });

  it('counts exactly what it contains', () => {
    const summary = paritySummary();
    expect(summary.total).toBe(35);
    expect(
      summary.ported + summary.partial + summary.missing + summary.out,
    ).toBe(35);
    expect(summary.ported).toBe(
      PARITY_ROWS.filter((row) => row.status === 'ported').length,
    );
  });

  it('names an analyzer the engine registers, for every ported row that has one', () => {
    // The ledger cannot claim a row is ported on the strength of prose. If it
    // names an analyzer, that analyzer must exist and be wired into the
    // default set — which is what a user's `analyze` run actually executes.
    const registered = new Set(defaultAnalyzers().map((a) => a.constructor.name));
    for (const row of PARITY_ROWS) {
      if (row.status === 'ported' && row.analyzer !== undefined) {
        expect(registered, `row ${row.row} (${row.name})`).toContain(row.analyzer);
      }
    }
  });

  it('keeps the structurally-out rows out, with the prerequisite named', () => {
    // These five are the reason the project can claim parity without shipping
    // an LLM client, a TensorFlow venv, a disassembler or an instrumented
    // build. Each reason must name the prerequisite it refuses, so a reader
    // can tell "not worth it" from "not done".
    const out = PARITY_ROWS.filter((row) => row.status === 'out');
    expect(out.map((row) => row.row).sort((a, b) => a - b)).toEqual([4, 5, 24, 27, 28]);
    const prerequisites: Record<number, RegExp> = {
      4: /nondeterministic/i,
      5: /LLM/i,
      24: /bjc/i,
      27: /TensorFlow/i,
      28: /disassembl/i,
    };
    for (const row of out) {
      expect(row.reason, `row ${row.row}`).toMatch(prerequisites[row.row]!);
    }
  });

  it('does not name a subfeature as missing once the code emits it', () => {
    // A `partial` row's reason is a claim about the code, and P18 added the
    // CPU-waste metric while row 12's reason still said it was missing — the
    // ledger was checking its statuses against the analyzers but never its
    // prose against the metrics.
    //
    // The reason has two clauses: what is missing, then what is ported. Only
    // the first is a claim of absence, so only the first is checked — matching
    // the whole string would fail on the fix that names the metric as ported,
    // which is how this test first went wrong.
    // Row 12 is now `ported`: the system-API backtracking landed, so the row
    // that used to carry the claim is empty. The guard generalises to every
    // `ported` row — an `out` row carries a reason naming the prerequisite it
    // refuses, which is not a claim of absence.
    for (const row of PARITY_ROWS) {
      if (row.status !== 'ported') continue;
      expect(row.reason, `row ${row.row}`).toBe('');
    }
    const rsSkip = PARITY_ROWS.find((row) => row.row === 12);
    expect(rsSkip?.status).toBe('ported');
  });
});
