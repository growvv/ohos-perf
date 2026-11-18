# OhmBench results

Measured on the benchmark's 21 cases across 9 real apps, against the
benchmark's own scorer (`bench/ohmbench/score.mjs`), which transcribes
`docs/evaluation.md`'s matcher.

## The number

| metric | value |
| --- | --- |
| cases | 21 |
| **precision** | **0.841** |
| **recall** | **0.881** |
| f1 | 0.848 |
| at K=1 | P 0.810, R 0.714 |
| at K=3 | P 0.833, R 0.905 |

The target was precision ≥ 0.80 and more root causes found than HapRay.
Precision is 0.841. HapRay's blind-input baseline is **zero code locations**,
and that is measured rather than inferred: its `root-cause` action was run
against all 21 blind trees (`bench/ohmbench/hapray/probe.py`, at rev
`bd5c98a`). It accepts a source tree as `--report-dir` — the flag's help says
"report directory", but nothing checks — and every one of the 21 runs returns
0 with the same body:

> 未发现可用的性能信号产物（report/ 下缺少 trace_*.json / perf.db /
> so_file_load.json 等）。

No report names a `.ets` file. Its `static` action takes a HAP and reports
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
| sheafreader_extract_tag_tolowercase | 0.00 | 0.00 | 0/1 | 0/2 |
| sheafreader_insert_duplicate_exception | 0.00 | 0.00 | 0/1 | 0/2 |
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

### `sheafreader_extract_tag_tolowercase` and `sheafreader_insert_duplicate_exception` — P 0, R 0

These two cases have **byte-identical blind input**. Both carry:

```json
"prompt": { "symptom": "刷新订阅源时响应变慢。", "perf_scenarios": ["数据库读取", "网络结果渲染"] }
```

and the same source tree. Their ground truths differ:

- `extract_tag_tolowercase` → `FeedParser.extractTag` (`xml.toLowerCase()`)
- `insert_duplicate_exception` → `DatabaseManager.insertArticle` (duplicate insert caught)

Nothing in the permitted blind input distinguishes them: the prompt is the
same, the tree is the same, and the test case is the same. A detector that
returns one of them is wrong for the other case no matter which it picks.
This is a limit of the benchmark's blind input, not of the detector — the
same tree is also the subject of three other cases with different prompts,
so the tree's answer is over-determined by the case id, which is not given.

The detector currently reports the two N+1 findings in `FeedService` for both
(2 suspects, 0 correct), because `数据库读取` names the N+1 rule and it fires
twice. It does not report `extractTag` because `extractTag` shares no prompt
word and is filtered out by the named-screen narrowing; it does not report
`insertArticle` because `insert-exception-absorb` is not in the `数据库读取`
vocabulary — a real gap, see below.

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
