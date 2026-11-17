# P18 — Closing the remaining HapRay capability gaps

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.13.0`
**Builds on:** P17 selector-driven scenarios (`0.12.1`); HapRay `9386e4e`
**Gap-analysis rows:** 15 (fault tree `ipc_binder`), 20 (JS heap snapshot),
21 (cold-start redundant-file I/O), 29 (HapFlow dependency graph),
33/35 (report bundle and comparison completion), plus the four partial rows
8, 10, 12, 31

## Why this phase

P17 closed the last workstream (W5), and the site said "all eight parity
workstreams are shipped". That sentence is true about the workstreams and
misleading about the capabilities: the 35-row inventory still has rows with no
implementation at all. The user's standing goal is "hapray 有的功能我们都需要有"
— every HapRay capability — so a workstream being shipped is not the finish
line; every row being ported is.

A recount of all 35 rows, applying every move each release claims, gives
**21 ported / 6 partial / 8 missing**. The README's "18 ported / 9 partial /
8 missing" was last written before 0.10.0 and never recounted. That arithmetic
is the defect this phase starts by fixing, because a parity claim that cannot
be reproduced from the inventory is a claim, not a measurement.

Of the eight missing rows, three are structurally out and stay out with their
measured reasons (they need a network LLM, a ~2 GB TensorFlow stack, or a
radare2 disassembly pipeline): row 5 (LLM GUI agent), row 27 (opt-detector),
row 28 (symbol recovery). Row 4 (HapTest autonomous exploration) is replaced
by the agent skill driving selectors deterministically — the inventory itself
says it is "nondeterministic and unsuitable as a parity target".

That leaves four rows this phase ports, plus the partials that are closeable:

- **Row 15 — fault tree `ipc_binder` section.** `binder.ts` already computes
  every underlying number; `fault-tree.ts` emits no `fault.ipc_binder.*`
  metrics and no combined payload. HapRay's own registry order makes the fault
  tree read a stale binder file at this revision, so the section is derived
  from the typed binder analyzer instead of a shared JSON file.
- **Row 20 — JS heap snapshot capture.** `hidumper --mem-jsheap` plus a pull of
  the newest `.heapsnapshot`. Capture only; there is no analyzer upstream and
  none here. The capability already exists and reports why it is unavailable;
  this adds the collector that makes it available on a debuggable app.
- **Row 21 — cold-start redundant-file I/O.** HapRay counts redundant file
  reads from `htrace/stepN/redundant_file.txt`. That file's producer is
  unverified upstream, so this ports the analyzer's contract and reads the
  file when a scene carries one, degrading with a reason when it does not.
- **Row 29 — HapFlow static/dynamic integration.** File→HAR ownership by path
  segments and basename, cross-HAR edge counts, `timing_cycles`. Offline and
  deterministic; no Homecheck checkout required if the dependency graph is
  supplied as input.

The partial rows this phase finishes are the report bundle and comparison
(33, 35) and the three analyzer partials whose remaining subfeatures are
metrics rather than subsystems (8, 10, 12).

## What "parity" will mean when this phase lands

Every row is one of:

- **ported** — the capability exists here and its output is comparable;
- **out, with a measured reason** — rows 5, 27, 28, and 4's replacement. The
  reason names the prerequisite this package refuses to ship (an LLM API key,
  a TensorFlow venv, a disassembler) and what a user gets instead.

No row is left "partial" without a named missing subfeature, and no row is
left "missing" without either a port or a reason. The README and the site
carry that table, and a test reads it so the arithmetic cannot drift again.

## Verification

- Every ported capability has a unit test over a hand-built fixture, and the
  row-level status test fails if a row's declared status disagrees with the
  analyzers that exist.
- The full suite stays green; the device suite's environmental failures stay
  named.
- The published pair is installed into an empty directory and started, because
  0.12.0 shipped a CLI that could not.
