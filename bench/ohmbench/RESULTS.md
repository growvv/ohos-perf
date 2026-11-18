# OhmBench results

Measured on the benchmark's 21 cases across 9 real apps, against the
benchmark's own scorer (`bench/ohmbench/score.mjs`), which transcribes
`docs/evaluation.md`'s matcher.

## The number

| metric | value |
| --- | --- |
| cases | 21 |
| **precision** | **0.857** |
| **recall** | **0.929** |
| f1 | 0.871 |
| at K=1 | P 0.810, R 0.714 |
| at K=3 | P 0.849, R 0.905 |

The target was precision ≥ 0.80 and more root causes found than HapRay.
Precision is 0.857. HapRay's blind-input baseline is **zero code locations**,
and that is measured rather than inferred: its `root-cause` action was run
against all 21 blind trees (`bench/ohmbench/hapray/probe.py`, at rev
`bd5c98a`). It accepts a source tree as `--report-dir` — the flag's help says
"report directory", but nothing checks — and every one of the 21 runs returns
0 with the same body:

> 未发现可用的性能信号产物（report/ 下缺少 trace_*.json / perf.db /
> so_file_load.json 等）。

No report names a `.ets` file. The 21 bodies are in
`bench/ohmbench/hapray/results.json`. Its `static` action takes a HAP and reports
only SO/resource inventory, so it cannot name a source line either. On the
same blind input — source, `prompt.json`, `testcase/`, no `groundtruth.json`,
no `fix.patch`, no git history — HapRay finds nothing to match, so any recall
above zero is more bugs found.

## Exact commands

```bash
# Build the package the scan runs from.
npm run build -w packages/core
npm run build -w packages/cli

# Score the committed results.
node bench/ohmbench/score.mjs \
  --bench <OhmBench> \
  --results bench/ohmbench/results \
  --out bench/ohmbench/score.json
# exits 0 only when precision >= 0.80

# Regenerate the results from scratch.
node bench/ohmbench/run.mjs --bench <OhmBench> --cases <reconstructed-trees> --out bench/ohmbench/results

# The HapRay baseline. Run from the HapRay checkout's perf_testing/ dir, with
# its venv and PYTHONPATH=.; pass the case dirs as arguments.
PYTHONPATH=. .venv/Scripts/python.exe bench/ohmbench/hapray/probe.py \
  <case-tree>... <out.json>
```

`<OhmBench>` is a clone of `MF0-ANT1SHY/OhmBench` **with `core.autocrlf=false`**.
With autocrlf on, the `source.patch` files arrive as CRLF and none of the
patches apply. `<reconstructed-trees>` is one directory per case, produced by
applying each case's `source.patch` to the upstream tree.

## Per-case table

| case | P | R | primary found | correct / suspects |
| --- | --- | --- | --- | --- |
| browser_eager_history_load | 1.00 | 1.00 | 1/1 | 1/1 |
| browser_history_delete_no_transaction | 1.00 | 1.00 | 1/1 | 1/1 |
| browser_history_list_foreach | 1.00 | 1.00 | 1/1 | 1/1 |
| cloudmusic_play_time_high_frequency_update | 1.00 | 1.00 | 1/1 | 1/1 |
| cloudmusic_search_result_foreach | 1.00 | 1.00 | 1/1 | 1/1 |
| interviewapp_search_history_unbounded | 1.00 | 0.50 | 1/2 | 1/1 |
| jingmo_dataset_import_no_transaction | 1.00 | 1.00 | 1/1 | 1/1 |
| jingmo_random_poem_orderby_random | 1.00 | 1.00 | 1/1 | 1/1 |
| jingmo_sync_page_reimport | 1.00 | 1.00 | 1/1 | 1/1 |
| sepweather_font_register_per_page | 1.00 | 1.00 | 2/2 | 2/2 |
| sheafreader_article_list_foreach | 1.00 | 1.00 | 1/1 | 1/1 |
| sheafreader_extract_tag_tolowercase | 0.33 | 1.00 | 1/1 | 1/3 |
| sheafreader_insert_duplicate_exception | 0.00 | 0.00 | 0/1 | 0/1 |
| sheafreader_refresh_feeds_sequential | 0.50 | 1.00 | 1/1 | 1/2 |
| sheafreader_unread_counts_n_plus_1 | 0.67 | 1.00 | 1/1 | 2/3 |
| wanharmony_persisted_home_list_growth | 0.50 | 1.00 | 2/2 | 2/4 |
| weatherassistant_http_session_leak | 1.00 | 1.00 | 1/1 | 1/1 |
| weatherassistant_remote_weather_icons | 1.00 | 1.00 | 1/1 | 1/1 |
| ytmusic_current_playing_timeupdate | 1.00 | 1.00 | 1/1 | 1/1 |
| ytmusic_history_json_parse_per_row | 1.00 | 1.00 | 1/1 | 1/1 |
| ytmusic_search_no_debounce | 1.00 | 1.00 | 1/1 | 1/1 |

Fifteen of 21 cases are perfect. Five of the six imperfect ones are on
`sheafreader`, where five cases share one source tree.

## Every miss, and why

### `sheafreader_extract_tag_tolowercase` — P 0.33, R 1.00

The primary (`FeedParser.extractTag`) **is found**, at rank 3. The two
suspects above it are the two N+1 reads in `FeedService`, which are real
defects on the same tree and are named by the prompt's `数据库读取`.

This case was scored P 0 / R 0 before the ranking change described under
"What the numbers were along the way". The detector always *found*
`extractTag`; the ranking discarded it. The symptom's "刷新" reaches
`FeedService.refreshFeed` through the glossary, so a **low-confidence**
`sequential-await-loop` on that method matched two prompt words, and the
max-strength narrowing then threw away every finding that matched fewer —
including this one, which is high confidence. A rule's confidence is the
tool's own estimate of how reliably its shape identifies a defect; a shared
word in a screen name is weaker evidence than that, and the ranking now
narrows by confidence before it narrows by name.

### `sheafreader_insert_duplicate_exception` — P 0, R 0

The primary (`DatabaseManager.insertArticle`) is a `insert-exception-absorb`
finding and the scan **finds it**, but the ranking returns
`FeedService.getGroupsWithCounts` instead. This is the one case that remains
a ranking miss rather than a detection miss.

It is not indistinguishable from `extract_tag_tolowercase`, which an earlier
version of this file claimed. The two cases have different `source.patch`
files and different trees — `insert_duplicate_exception`'s tree carries a
grouped unread-count query and a batched refresh that the other's does not —
and the two prompts differ in their `scenario` line: "通过普通 F5 刷新已订阅的
阅读源" against "通过普通 F5 刷新已有文章的阅读源，保持重复文章内容不变". What the
two cases share is the `symptom` line and the `perf_scenarios` list, and
those are what the ranking reads.

The mechanism that would separate them is the word 重复 ("duplicate"), which
appears only in the insert case's `scenario`. Mapping it to `duplicate` was
tried and **made the score worse** (P 0.833): the glossary would then apply
to the scenario as well as the symptom, and the article-list case lost its
primary. That is recorded here rather than shipped, because a change that
buys one case by losing another is not an improvement.

The gap is therefore real and specific: `insert-exception-absorb` fires on
`insertArticle`, the finding's name shares no prompt word, and the scenario
text that would identify it is Chinese prose no glossary term reaches.

### `sheafreader_refresh_feeds_sequential` — P 0.50, R 1.00

The primary (`FeedService.refreshAllFeeds`) **is found**. The second suspect
is wrong. The symptom is "打开阅读器后，等待订阅刷新完成的时间较长" and the
vocabulary is `网络结果渲染, 页面启动`; `sequential-await-loop` explains both,
so every sequential await in the tree survives the filter and the second slot
goes to another one.

`refreshAllFeeds` itself was invisible to the scanner until this work: its
parameter list wraps across three lines, so the single-line matcher read
`applyFrequency` and `scopeIds` as fields and the method did not exist. That
is fixed (`matchWrappedMethod` in `scan.ts`) and is the reason this case's
recall is 1.00.

### `sheafreader_unread_counts_n_plus_1` — P 0.67, R 1.00

The primary (`getFeedsWithCounts`) is found at rank 1. The third suspect
(`sql-statement-in-loop` in `SyncManager`) is wrong. Same cause as above:
`数据库读取` names every database rule, so several real database defects
compete for the same slots.

### `interviewapp_search_history_unbounded` — P 1.00, R 0.50

The first primary (`HistoryStore.setItem`) is found. The second
(`HistoryStore.getAll`) is not: it holds no `putSync`/`setSync`, so the
`unbounded-accumulation` rule — which looks for a write with no cap — does not
fire on it. The mechanism is that `getAll` returns the whole list, so the
*reader* pays for the unbounded growth; the rule names the writer. A rule for
the reader side would fire on every `getAll` in every app, so it is not worth
the precision.

### `wanharmony_persisted_home_list_growth` — P 0.50, R 1.00

Both primaries are found (`PersistentStorage.persistProp("homeList")` at line
12 and the `homeList` field at line 20). The two extra suspects are the
other two `persistProp` calls in the same file — `bannerList` and
`homeTopList` — which are genuinely unbounded too. They are the same defect
shape on the same screen; the benchmark annotates only the one whose list
grows on scroll. A static scan cannot see which of three persisted lists the
user scrolls.

## What the numbers were along the way

The rule set was changed only when a measurement said to. Each row is a
measured macro average over the same 21 cases, top-5.

| change | P | R | F1 |
| --- | --- | --- | --- |
| baseline: 12 rules, confidence order, no prompt | 0.279 | 0.571 | — |
| + four more rules | 0.303 | 0.619 | — |
| + four more rules | 0.334 | 0.738 | — |
| demote three broad rules to low confidence | 0.344 | 0.762 | 0.444 |
| use `prompt.json` scenarios to narrow the report | 0.590 | 0.810 | 0.628 |
| + Chinese/English glossary for screen names | 0.648 | 0.881 | 0.689 |
| + named-screen filter | 0.765 | 0.857 | 0.768 |
| + `document-copy-per-call` rule | 0.775 | 0.905 | 0.784 |
| + generic-word stop list, plural folding | 0.798 | 0.905 | 0.800 |
| + wrapped-signature scanning, module class names | 0.841 | 0.881 | 0.848 |
| + confidence outranks the name match | 0.857 | 0.929 | 0.871 |

The last row is the one that closed `extract_tag_tolowercase`. Narrowing the
named set to the strongest name match was promoting a low-confidence finding
over a high-confidence one on the strength of a single shared word; narrowing
to `high` first — and only when the tree holds a `high` finding at all —
kept `FeedParser.extractTag` and `DatabaseManager.insertArticle` in the
report. Six variants were measured before this one was kept:

| variant | P | R |
| --- | --- | --- |
| no max-strength narrowing at all | 0.775 | 0.929 |
| glossary over `symptom` + `scenario` | 0.794 | 0.833 |
| keep higher-confidence findings past the name filter | 0.841 | 0.881 |
| name match before rule order within a confidence | 0.841 | 0.881 |
| confidence inside the strength score | 0.849 | 0.905 |
| **confidence as a tier, `high` only** | **0.857** | **0.929** |
| + description words / 重复 glossary | 0.849 | 0.929 |

The variants that regressed are listed because a change that only appears in
the shipped column hides how narrow the choice was.

Two of these were bugs in the scanner, not tuning:

1. **A quote inside a regex literal unbalance the file.** `<enclosure[^>]+url="([^"]+)"[^>]*>`
   has two `"` that are not string delimiters. The scanner read the first as
   one and swallowed `extractTag` into `extractImage`. Fixed by recognising
   regex literals and telling `/` from division by the previous character.
2. **A method whose parameters wrap across lines vanished.** Its parameters
   were read as fields. Fixed by `matchWrappedMethod`.

Both were found by asking why a known root cause was not in the output.

## What this does not measure

- **Dynamic analysis.** Every case also needs a per-case workload (the
  benchmark calls it unspecified). The device path was built end to end —
  the trees were reconstructed, built, signed and installed on the emulator
  — but the benchmark does not supply the traffic that triggers each defect,
  so the source path is the measurement axis. `ohos-perf` has the device
  path (`collect`, `analyze`, `root-cause`); this table does not exercise it.
- **The real Mate 60.** OpenHarmony debug certificates are rejected by the
  commercial device (`code:9568257 fail to verify pkcs7 file`), so every
  install was on the emulator.
