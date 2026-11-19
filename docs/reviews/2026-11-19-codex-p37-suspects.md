# Codex review — P37 `suspects`

Model: `lab/gpt-6.2-sol` (Codex CLI 0.170.0, reasoning effort `medium`).
Prompt: five files inlined (`scan.ts`, `rules.ts`, `suspects.ts`, `symptoms.ts`,
`report.ts`), no tool access, findings-only output.
Raw transcript: `.review/codex-output4.md` (not committed — the CLI dumps its
own reasoning summaries before the findings, and the findings are reproduced
below verbatim).

Two earlier dispatches at `xhigh` produced 8,856 and 1,172 lines of file dumps
with no findings, and a third lost its connection mid-review. The run that
worked inlined the source into the prompt and asked for the review as the only
output. Worth repeating: the model will not reliably stop exploring and start
writing on its own.

## What the review said

1. `scan.ts:199` — `stripNoise` treats a regex's closing `/` as the previous
   token, so a later division is read as another regex and can swallow the rest
   of the file; input `const value = /x/ / 2; class A { run() {} }`; Important.
2. `scan.ts:113` — template interpolation is blanked with the literal, so braces
   in `${...}` are ignored; input `` `${make({ nested: true })}` ``; Minor.
3. `rules.ts:91` — `sqlText` does not assemble a concatenation unless every
   continuation line starts with a quote; input `'SELECT * FROM ' +\n TABLE +
   ' WHERE id = ?'`; Important.
4. `rules.ts:115` — the loop rules read raw symbol text, so a loop shape inside
   a string satisfies them; input `const text = "for (…) { db.insert(row); }"`;
   Important.
5. `rules.ts:335` — `unbounded-accumulation` is suppressed by a cap word
   anywhere in the file, even in an unrelated class; Important.
6. `rules.ts:383` — `http-session-not-destroyed` is suppressed by any
   `.destroy()` in the file, even an unrelated one; Important.
7. `suspects.ts:78` — two rules at equal confidence: the first declared wins,
   though the comment promises the sharper one does; Important.
8. `suspects.ts:132` — `moduleLineOf` recovers a line by text search, so two
   identical module statements both report the first line; Minor.
9. `symptoms.ts:486` — the name filter runs before the confidence tier, so a
   low-confidence finding on the named screen can drop a high-confidence one
   elsewhere; Critical.
10. `symptoms.ts:506` — the final sort puts `RULE_RANK` ahead of component kind
    and shared words, contradicting the stated "文章列表 prefers the list"
    rule; Important.
11. `report.ts:1` — clean.

## What held up when measured

Each claim was reproduced or refuted against the real code before any edit.
Scripts: `.review/verify*.mjs`.

| # | verdict | evidence |
| --- | --- | --- |
| 1 | **refuted** | `const value = /x/ / 2;` followed by `export class A {` on its own line still finds `run`. The slash after a completed regex is read as division because `previous` is `/`, which is not in the value set — the reviewer's premise about `previous` is wrong. |
| 2 | **refuted** | `` `${make({ nested: true })}` ``, `` `${ "}" }` `` and `` `${ { a: 1 }.a }` `` all keep the following method. Blanking an interpolation is harmless because its braces are balanced; an unbalanced brace can only come from a nested string, which the string branch already handles. |
| 3 | **confirmed** | The benchmark case's own statement reformatted so the table identifier sits on its own line returns no suspect, while the shipped formatting returns `sql-order-by-random`. The helper's doc comment promises exactly the case it fails. |
| 4 | **confirmed** | `const text = "for (const row of rows) { db.insert(row); }"` produces a `sql-statement-in-loop` finding. A string is not a loop. |
| 5 | **confirmed** | A `HistoryStore` that calls `putSync` with no cap returns nothing when an unrelated `ImageCache` declares `maxItems`. |
| 6 | **confirmed** | `ApiClient.request()` creating an `http.createHttp()` session returns nothing when an unrelated class calls `image.destroy()`. |
| 7 | **confirmed, minor in effect** | `this.db.insert(row)` inside a loop reports `sql-statement-in-loop` rather than `db-write-in-loop`. Both are `high` on the same line, so the location is right and only the description is the weaker of the two. |
| 8 | **confirmed** | Two identical `PersistentStorage.persistProp('items', [])` statements both report line 1. |
| 9 | **refuted in effect** | The code does what the reviewer describes: an eager `ArticleListView` (low) plus an `order by random()` constant (high) returns only the list when the symptom names the list. Applying the tier first, as recommended, was measured: precision 0.857 → 0.738, recall 0.929 → 0.833, three cases broken. The name filter answers *which question*; confidence answers *which answer within it*, and a high-confidence defect on a screen nobody named is a good answer to a different question. Reverted, and the contract is now pinned by a test. |
| 10 | **refuted** | The final sort can never see two suspects of different kinds: `top` is already filtered to equal `strength`, and `strength = 2·words + kind`, so equal strength implies equal kind and equal words. The kind and word comparisons in that sort are dead code, not a wrong order. |
| 11 | **agreed** | `report.ts` needed no change. |

Six findings were real: 3, 4, 5, 6, 8 and 9's *observation* (though not its remedy).
Five were false positives that each described a plausible failure the code does
not have. The false positives are recorded rather than deleted, because a
reviewer that is wrong in a convincing register is the normal case and the next
review will be read the same way.

## What changed

- **#3** — `sqlText` follows a concatenation to the end of the statement,
  keeping identifier and operator lines, instead of requiring every
  continuation line to open a quote.
- **#4** — the loop rules count loop depth on the noise-stripped lines, so a
  `for (…)` inside a string or a comment is not a loop. The database-call test
  still reads the raw line, because a SQL statement is very often a template
  literal.
- **#5, #6** — the "is there a cap / a destroy" search is narrowed to the class
  that holds the finding, not the whole file. No OhmBench case has an unrelated
  class doing the suppressing, so the macro average does not move; the fix is
  kept because the file-wide search is wrong in principle.
- **#8** — `scanSourceFile` carries each module line's original line number, so
  duplicate statements report their own lines.
- **#9** — not applied. The observation is accurate and the remedy measurably
  worse; the existing order is now documented as deliberate and pinned by a
  test named for the tradeoff.
- **#7** — not fixed. Both rules are `high` and name the same line; the
  description differs, the finding does not. Recorded here rather than traded
  for a tie-break that would have to encode "which of two true statements about
  one line is truer".

## What the fixes turned up that the review did not

Fixing the loop counter's handling of template literals made a previously
hidden finding visible: `RdbUtils.deleteAll` in `browser_eager_history_load`
runs `executeSql(\`DROP TABLE IF EXISTS ${date}\`)` once per table. The `${date}`
closes a brace, and the old depth counter read that brace as the end of the
`forEach` block, so the executor on the next line looked like it was outside the
loop. That is a real finding on a real tree.

It also exposed a false positive in the same rule: `executeSql('select …')`
inside a loop was called a write. `executeSql` runs whatever string it is
given, so the rule now requires the statement to name a write rather than
treating the executor as one.

Those two pull in opposite directions on the benchmark. Reporting the DDL loop
costs precision in that case — the ground truth names the eager history load,
not the cleanup method, so `browser_eager_history_load` goes from P 1.00 to
P 0.50 and the macro average from 0.857 to 0.833. Requiring the write to be
named on the line removes the false positive and also removes the DDL loop,
because in the benchmark's code the statement reaches `executeSql` through a
variable (`const sql = …; RdbUtils.executeSql(sql)`) and the rule cannot see
what the string says.

The shipped rule takes the second option: no false positive, no indirect
finding. It is a deliberate false negative, not an oversight — a rule that
fired on every `executeSql(anything)` inside a loop reported reads as writes,
and a rule that tried to follow a local variable into the executor would be
doing dataflow analysis this scanner does not do. The limitation is recorded
here rather than papered over, and the benchmark is byte-identical to the
previous run (0.857 / 0.929 / 0.871).

Each fix is covered by a test that failed first. The benchmark was re-measured
after every one.
