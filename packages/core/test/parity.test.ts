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
  it('has one row per HapRay capability, numbered 1..39', () => {
    // 1..35 is the inventory at rev `9386e4e`; 36..39 are what the 428 commits
    // up to `bd5c98a` added. The numbers are contiguous because the ledger is
    // the index a reader follows, not a set of independent labels.
    expect(PARITY_ROWS).toHaveLength(39);
    expect(PARITY_ROWS.map((row) => row.row)).toEqual(
      Array.from({ length: 39 }, (_, index) => index + 1),
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
    expect(summary.total).toBe(39);
    expect(
      summary.ported + summary.partial + summary.missing + summary.out,
    ).toBe(39);
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

  it('has no refused row left, and each row that left says what replaced it', () => {
    // Every row is ported as of 0.22.0. The history below is the record of
    // what each refused row needed, kept because a future reader will ask why
    // a row that once carried a reason no longer does.
    //
    // Row 4 (HapTest exploration) left this list when `explore` replaced it:
    // HapRay's version is nondeterministic and verifies nothing, which is a
    // defect in its implementation rather than a prerequisite we cannot meet.
    // Row 24 (coverage) left it when the package started reading the report
    // `bjc` writes: the instrumented build is still external, but the analysis
    // of its output no longer is, and the absence is a named `no_data` rather
    // than HapRay's silent skip.
    //
    // Row 27 (opt-detector) left it in `0.20.0`. HapRay's blocker was never
    // the question — it was the ~2 GB model it answered the question with.
    // An ELF records LTO markers and compiler flags directly, and its
    // instruction mix is a measurement rather than an inference from a byte
    // histogram, so `opt` reports both and labels the inferred part `proxy`.
    //
    // Row 5 (LLM GUI agent) left it in `0.21.0`. The blocker was the external
    // `phone_agent` dependency and the API key, and both were defects in how
    // HapRay used the model rather than in what it asked: the loop is written
    // here against an injected client, the endpoint is read from the same
    // variables HapRay reads, and completion is verified against the screen
    // instead of trusted.
    //
    // Row 28 (symbol recovery) left it in `0.22.0`. HapRay's tool shells out
    // to radare2 for function boundaries and asks an LLM to name what it
    // finds, and never measures whether the name is right — its own docs
    // record the heuristic (a function over 100 KB is "unreasonable, skip",
    // and a missed lookup gets 2000 bytes). An ELF records every function's
    // start and size in `st_value`/`st_size`, so the boundary is a lookup;
    // `symbols recover --measure` holds out names the file does record and
    // states the model's accuracy over them.
    // Row 37 (`build`) was refused in 0.23.0, when the ledger was re-pinned to
    // `bd5c98a`. It wraps `deveco-cli` to compile a debug HAP: a build tool,
    // not a measurement. Refusing it is the one place this ledger says "we do
    // not want this", as opposed to "we have not done it yet" — which is why
    // the assertion names the row instead of requiring the list to be empty.
    // A new `out` row has to be added here deliberately, with its argument.
    const out = PARITY_ROWS.filter((row) => row.status === 'out');
    expect(out.map((row) => row.row)).toEqual([37]);
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

  it('has no partial row left', () => {
    // Row 33's last clause was re-rendering a bundle from its saved inputs,
    // which `render` now does. Every row is ported or refused with a named
    // prerequisite; a `partial` would mean a capability with an unnamed gap.
    expect(paritySummary().partial).toBe(0);
    const bundle = PARITY_ROWS.find((row) => row.row === 33);
    expect(bundle?.status).toBe('ported');
  });

  it('ports the model-guided exploration row without a model state comparator', () => {
    // Row 38 asks a model two things in HapRay: which node to tap, and whether
    // the screen changed. The first is a genuine choice and is ported with its
    // answer checked against the offer; the second has a deterministic answer
    // (`hashPageShape`), so no second model call exists to leave untested.
    expect(PARITY_ROWS.find((row) => row.row === 38)?.status).toBe('ported');
    expect(paritySummary().missing).toBe(1);
    expect(PARITY_ROWS.filter((row) => row.status === 'missing').map((row) => row.row))
      .toEqual([39]);
  });
});
