# P12 — hilog: capture, deterministic pattern rules, per-window evidence (HapRay parity W4)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.7.0`
**Builds on:** P11 native memory (`0.6.0`); HapRay `9386e4e`
**Gap-analysis rows:** 9 (hilog analysis), part of 12 (per-window log attribution)

## Why this phase

HapRay reads the device's `hilog` stream and counts occurrences of
configured patterns — how many `CreatePixelMap` calls allocated a large image,
how many of those were already at their target size, and so on. The counts go
into the report per capture step, so a reviewer can say "this flow created 40
oversized bitmaps" without opening a log file.

This package has no hilog surface at all: the capability matrix does not list
it, `collect` cannot capture it, and nothing reads it. P12 adds the capture,
the rule engine and the report section, so a scene can answer the same
questions HapRay answers — and, because this package's rules are typed and its
output is deterministic, do it reproducibly.

## Scope

**In scope**

- `hilog` capability (`hilog.stream`), probed by the presence of the `hilog`
  binary on the device, with the device's own reason when absent.
- `HilogCollector`: streams `hilog` over the existing `Hdc` transport for the
  capture window and writes `<scene>/hilog.log`. The capture is bounded by the
  host clock, and the collector verifies a non-empty file before declaring
  success — hdc exits 0 even when the device tool fails, so a size check is
  the only honest success signal.
- `hilog.jsonl` — one typed row per log line: `ts` (device time, ns), `level`,
  `pid`, `tid`, `domain`, `tag`, `message`. Unparsable lines are kept as
  `raw` rows with `parsed: false`, never dropped, so a count is never
  silently short.
- `HilogRules`: a typed rule set — `{ name, regex, groups, conditions }` —
  evaluated with a deterministic, dependency-free matcher:
  - `groups` selects capture groups (`0` = whole match), 1-based like HapRay;
  - `conditions` is either an array of per-group comparisons (`'!=4'`,
    `'>512'`, …) or an expression over `$1`, `$2`, … with `+ - * / %`,
    comparisons, parentheses and `,`/`&&` conjunction.
  - **No `eval`.** HapRay builds a Python expression string and calls `eval`
    with a restricted namespace. This package parses the expression into an
    AST and evaluates it, so a rule file cannot execute code, and a malformed
    expression is a typed error naming the rule rather than a logged warning
    that silently drops the pattern.
- `HilogAnalyzer` (`id: 'hilog'`, requires `['hilog.stream']`):
  - per-rule match counts over the whole capture, and per capture window when
    the scene carries `steps.json` (W5 owns the runner; until it lands the
    window is the whole scene);
  - metrics `hilog.lines.count`, `hilog.parsed.count`,
    `hilog.unparsed.count`, `hilog.rule.<name>.count` per rule, and
    `hilog.rules.matched.count` / `hilog.rules.unmatched.count`;
  - `hilog_match` evidence per rule with at least one match, carrying the
    count, the first and last match offsets, a sample of up to 5 matched
    messages and drill-downs to `hilog.matches` and `hilog.rules`.
- Named queries: `hilog.matches` (by rule, with `limit`), `hilog.rules`
  (the effective rule set with counts), `hilog.around` (lines in a
  nanosecond window, for correlating with a frame).
- Default rule set: HapRay's three `CreatePixelMap` rules
  (`no_dmp`, `big_image_with_target_size`, `big_image_without_target_size`,
  `image_same_size`) ported verbatim as a checked-in constant, so a capture
  with no user rules still produces HapRay's numbers.
- Report section title `hilog`; docs, skill, site and roadmap at release.

**Out of scope, deliberately**

- **`hilogtool` decryption.** HapRay shells out to a bundled Windows binary to
  decrypt `.log` files it was given. This package captures plaintext over
  `hdc shell hilog` instead, so there is nothing to decrypt and no opaque
  binary in the dependency surface. A scene whose `hilog/` directory holds
  encrypted `.log` files is reported as unreadable with that reason, never as
  zero matches.
- **Persistent on-device log rotation** (`hilog -w start -l 10M -n 1000`).
  That mode buffers on the device and is what HapRay's device suite uses for
  long runs; it needs a device-side file layout this package would then have
  to pull and merge. Streaming for the capture window answers the same
  question for a bounded scene, and a future workstream can add the
  persistent mode when a scenario needs it.
- **Log-based crash classification.** A crash is a hilog line, but labelling a
  fault tree from it is fault-tree work (P13/W5 material), not a hilog rule.

## Semantics

### Capture

- `hilog` writes to stdout on the device; `hdc shell hilog` streams it. The
  collector spawns it through the existing transport with the capture's
  duration, then terminates the stream.
- Device time is the authority for `ts`. The host records the capture window
  in `scene.json`; a line whose timestamp falls outside the window is kept but
  flagged, because a clock skew is information, not a reason to drop data.
- The collector requires the file to be non-empty. A capture that produced
  nothing is a `degraded` analyzer result naming that fact, never a zero.

### Line parsing

The standard hilog line is:

```
MM-DD HH:MM:SS.mmm  PID  TID  LEVEL  DOMAIN/TAG  message
```

- `level` is one of `D I W E F`; an unrecognised level keeps the character.
- `domain` and `tag` split on `/`.
- The timestamp has no year. The year is taken from the scene's `scene.json`
  capture time, and a line whose month/day would place it in the future
  relative to the capture is read as the previous year — the one ambiguity a
  year-less format has, resolved in the direction that cannot invent a
  future log.
- A line that does not match is a `raw` row: `parsed: false`, `message` is the
  whole line. It still counts in `hilog.lines.count` and
  `hilog.unparsed.count`.

### Rule evaluation

- Rules run against the **message**, not the whole line, so a rule cannot
  accidentally match a tag. A rule may opt into `scope: 'line'` when it needs
  the tag or level.
- Regex is JavaScript's, compiled with `i` and `m` — HapRay's
  `re.IGNORECASE | re.MULTILINE`. A rule whose regex fails to compile is a
  typed error naming the rule; it never silently drops.
- `groups` is 1-based; `0` means the whole match, as upstream.
- `conditions` with an expression: group references `$n` resolve to the
  captured string, converted to a number when possible; a non-numeric
  reference is a typed error (upstream silently substitutes `0`, which turns a
  typo into a confident wrong count).
- A rule with no `conditions` matches on every regex hit.
- Every rule is evaluated independently; one bad rule never stops the others,
  and the analyzer reports which rules failed to compile in a `degraded`
  metric rather than aborting.

### Determinism

- Rules are sorted by name before evaluation, so metric and evidence order do
  not depend on rule-file order.
- Matches are ordered by `(lineIndex, ruleName)`; sample messages keep their
  file order.
- No `Date.now()`: the capture window and the year both come from the scene.

## Capability and degradation

- `hilog.stream` is available when the device has the `hilog` binary. The
  probe records the `which hilog` output like every other capability.
- A scene with no `hilog.log` yields one `hilog.degraded` proxy naming the
  capture requirement (`collect --hilog`), never a zero.
- A scene whose log has lines but no rule matches yields real zero-count
  metrics plus one `hilog_match`-free result; zero matches is a measurement,
  not a degradation.
- A scene whose log is unparsable (every line `parsed: false`) degrades with
  the reason and still reports `hilog.lines.count`, so the reader can see the
  capture was not empty.

## CLI

- `ohos-perf collect --hilog` adds the capture. It is device-wide (no `--app`
  needed) like `--hidumper`.
- `ohos-perf analyze <dir>` includes the `hilog` section.
- `ohos-perf query <dir> hilog.matches --args '{"rule":"big_image_with_target_size"}'`.

## Testing

- Unit: line parsing (standard, truncated, no-year, future-month), rule
  matching (groups, `0`, conditions array, expression with arithmetic and
  conjunction, malformed regex, malformed expression), determinism (rule
  order, match order), and the degraded paths.
- Analyzer: counts, evidence samples and drill-downs, zero-match vs degraded.
- Query: `hilog.matches` / `hilog.rules` / `hilog.around` argument validation
  and `[]` on an absent log.
- Device: one capture on the Mate 60 asserting a non-empty `hilog.log` and
  `hilog.lines.count > 0`; skipped when no device is attached.

## Exit criteria

1. `collect --hilog` produces `hilog.log` and `hilog.jsonl` on a real device.
2. `analyze` reports the `hilog` section with per-rule counts and evidence.
3. A malformed rule is a typed error, not a silent skip.
4. The same scene and rules produce byte-identical output across runs.
5. The HapRay default rules produce the same counts on the same log.
