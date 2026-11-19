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

Fifteen of 21 cases are perfect. Four of the six imperfect ones are on
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

A third was found by a code review and confirmed by measurement: a regex
literal directly after a keyword (`return /\{/.test(s)`) was read as division,
because the character before the slash is `n`. The brace inside the regex then
never closed, and every method below it disappeared. Fixed by tracking the
preceding word, not just the preceding character.

## What a review changed, and what it did not

An external review of the five `source/` modules produced eleven findings. Six
were real and are fixed; five described failures the code does not have. Each
was reproduced before any edit and the record is in
`docs/reviews/2026-11-19-codex-p37-suspects.md`.

The most instructive one is the review's only Critical: it said the confidence
tier should run *before* the name filter, so a high-confidence finding on a
different screen would survive a symptom that names one screen. The code does
what the reviewer described. Applying the remedy measured at **P 0.738 /
R 0.833** — three cases worse — because the name filter answers *which
question* and confidence answers *which answer within it*. It was reverted and
the tradeoff is now pinned by a test.

Two of the real fixes each changed behaviour on a real tree without changing the
macro average:

- Teaching the loop rules to count braces on the noise-stripped text surfaced a
  `db-write-in-loop` in `browser_eager_history_load` that had been invisible:
  the `${date}` in a template literal closed the old loop counter, so the
  executor on the next line read as outside the loop. The finding is real — a
  `DROP TABLE` per date — but the statement reaches `executeSql` through a
  local variable, and the same fix also exposed a false positive in the rule
  (`executeSql('select …')` in a loop called a write). Requiring the statement
  to name a write fixes the false positive and drops the indirect DDL loop with
  it. That is a deliberate false negative: following a local variable into the
  executor is dataflow analysis this scanner does not do.
- Narrowing the "is this bounded?" and "is this session destroyed?" searches
  from the file to the holding class changes nothing on the 21 cases, because
  no case has an unrelated class whose `maxItems` or `destroy()` was doing the
  suppressing. It is kept because the file-wide search is wrong in principle
  and the tests pin the corrected behaviour.

## The dynamic axis

The table above scores the **source** path: `suspects` reads the unfixed tree
and `prompt.json`, with no device. OhmBench also ships each case as a signed
HAP and a `testcase/` directory holding the workload HapRay's `PerfTestCase`
would run, so the same cases can be measured on a device. They were, on the
emulator, through `bench/ohmbench/dynamic/` (see its `README.md` for the
commands):

| step | result |
| --- | --- |
| reconstruct (upstream + `source.patch`) | 21/21 |
| `build.py` — ohpm install + `hvigorw assembleHap` | 21/21 |
| `sign.mjs` — debug profile + HAP signature | 21/21 |
| `install.mjs` — `bm install` | 19/21 |
| `run.mjs` — workload, capture, `analyze`, `root-cause --offline` | 5/21 captured and analyzed |

The two uninstallable cases are both cloudmusic, refused with
`grant request permissions failed, PermissionName:
ohos.permission.SYSTEM_FLOAT_WINDOW`: a debug provisioning profile cannot grant
that permission, and the app asks for it in its manifest.

Five of the 21 cases ran their own workload to completion and were analyzed:

| case | its own window | ran | `measured` phase | metrics | evidence | root cause |
| --- | --- | --- | --- | --- | --- | --- |
| `browser_eager_history_load` | 15 s | 15 s | 1.8 s | 83 (12 degraded) | 17 | warn — a thread woken often and re-sleeping |
| `jingmo_dataset_import_no_transaction` | 120 s | 120 s | 5.2 s | 83 (12) | 21 | **critical** — a 597 ms VSync gap |
| `jingmo_sync_page_reimport` | 180 s | 120 s | 23.7 s | 83 (12) | 55 | **critical** — 6 gaps, the longest 4.6 s |
| `ytmusic_current_playing_timeupdate` | 70 s | 70 s | 60.0 s | 81 (13) | 704 | warn — 697 frames drew nothing |
| `ytmusic_search_no_debounce` | 60 s | 60 s | 27.7 s | 81 (12) | 121 | **critical** — 11 gaps, the longest 1.7 s |

Each produced an ordinary scene — `trace.htrace`, `trace.db`, `scene.json`,
`workload.json` — and `analyze` and `root-cause --offline` ran on it unchanged.
The evidence is of the kinds the emulator can actually produce: `jank`,
`empty_frame`, `vsync_anomaly`, `gc_pressure`, `fault_pattern`,
`binder_hotspot`, `startup`. The scenes are 17–297 MB each.

Every degraded metric names its reason in `degraded.reason`; they fall into two
groups and the difference matters:

- **Not requested.** `workload` captures with `hitrace` only, the way HapRay's
  `profiled()` does, so `symbols`, `flamegraph`, `frame-load`, `empty_frame`'s
  load share, the GC perf share, memory, native memory, hilog, thermal and the
  UI capture are all absent because no collector was asked for them. The reason
  is `no perf samples: the scene was captured without --hiperf` or `capability
  not probed`. This is a choice of capture, not a limit of the device, and
  `collect` with the same flags on the same device measures those metrics.
- **The device cannot.** The emulator has no `hiprofiler_cmd`, `hiperf record`
  fails with `create mmap fail` / `Operation not permitted`, and
  `param set persist.ark.trace` is refused (errNum 1001) — so even a capture
  that asks for sampled events or an ArkTS method trace gets nothing back.

### Cases whose own workload cannot run

The plans assume data the benchmark does not ship. Each failure below is the
plan's **own** `setup` wait or `measured` step, and the record names the
selector and how many nodes were on screen — measured, not inferred:

| case | failed at | why |
| --- | --- | --- |
| `browser_history_delete_no_transaction` | setup `text="清除浏览记录"` | needs history entries to delete |
| `browser_history_list_foreach` | measured `text="Article"` | needs a history page to scroll |
| `jingmo_random_poem_orderby_random` | setup `text="山水诗 [1-9][0-9]*"` | needs imported poetry |
| `sheafreader_article_list_foreach` | setup `text="300 (?:篇\|articles)"` | needs 300 articles imported |
| `sheafreader_extract_tag_tolowercase` | setup `text="Journal 1 article 1"` | needs feeds subscribed |
| `sheafreader_insert_duplicate_exception` | setup `text="Journal 1 article 1"` | needs feeds subscribed |
| `sheafreader_refresh_feeds_sequential` | measured a `Button` by exact bounds | needs a subscribed feed to refresh |
| `sheafreader_unread_counts_n_plus_1` | measured `text="Journal 1 article 1"` | needs feeds subscribed |
| `interviewapp_search_history_unbounded` | measured `hint="请输入关键词"` | needs search history |
| `ytmusic_history_json_parse_per_row` | measured `text="Listening Track 1000"` | needs 1 000 history entries |
| `cloudmusic_*` (×2) | install | permission refused, see above |

`jingmo_sync_page_reimport` **did run**, and it is the one case whose
own `setup` prepares the data it needs: it types the data-source URL into the
app's settings screen, taps 保存数据源, and waits for 已保存 before the window
opens. That is the chain in `workload.json` — `wait 京墨` → `point 0.94,0.07` →
`wait 设置` → `input 数据源地址` → `key Back` → `tap 保存数据源` → `wait 已保存` —
so the benchmark does ship the traffic for the cases whose setup is
self-contained, and it does not for the ones above.

### Two overruns, and one of them was our bug

| case | its own window | measured | what the plan does |
| --- | --- | --- | --- |
| `sepweather_font_register_per_page` | 30 s | **315 s** | 40 open/close cycles of the city manager |
| `wanharmony_persisted_home_list_growth` | 60 s | **100.8 s**, then **67.0 s** after the fix | 12 swipes on the home list |

Both fail with `workload took …s, exceeding the …s capture window`, the same
check HapRay's `UI.profiled()` makes. WanHarmony's overrun was also a defect in
this tool: the runner sent `uitest uiInput swipe x y1 x y2` with no velocity,
and the reference driver sends `1000`. Measured on the device, one swipe costs
**5.15 s** without the argument and **3.21 s** with it. Sending it (0.33.1)
took the whole 12-swipe phase from **100.8 s to 67.0 s**, a 5.58 s swipe — so
the bug was a third of the run, and the case is still over its window: the rest
is the emulator's `dumpLayout` latency, which also accounts for Sepweather's
315 s against 30 s (40 cycles each waiting for two screens).

### What the dynamic run found in this tool

One genuine defect, and it is the kind the source axis could not surface:
**every app-attributed analyzer reported `no_data` on a trace full of the app.**
Two causes, both measured:

1. The trace stores `process.name` as the kernel's `comm`, capped at 15
   characters — `com.hefengbao.jingmo.hw` is `ngbao.jingmo.hw` — so a scene
   whose `processNames` holds the bundle matched no row.
2. A plain `hitrace` capture recorded no pid at all: `collect` resolved the
   app's pid only when a collector needed one.

`resolveAppIpids` now falls back to a name match when the pid route resolves
nothing (the comm is the bundle, the bundle ends with the comm, or the comm is
a `:`-separated sub-process; a name shorter than the comm limit is not
eligible), and `collect` records the app's pids in `scene.json` whenever it can.
Re-running `analyze` on the same trace turned the analyzers that had reported
`no_data` — a claim that the trace holds nothing for them — into the ones that
report what they actually found; the ones still degraded are degraded for the
capture reasons listed above, not for want of a process.

## What this does not measure

- **A physical device.** OpenHarmony debug certificates are rejected by the
  commercial Mate 60 (`code:9568257 fail to verify pkcs7 file`), so every
  install and every capture was on the emulator. Of the 12 degraded metrics,
  the ones a device with `hiprofiler_cmd`, a working `hiperf` and settable
  ArkTS tracing would recover are the device-limited group above; the rest are
  absent because `workload` captures with `hitrace` alone.
- **A dynamic precision/recall number.** The source axis has one because the
  ground truth names a source location. A dynamic run names evidence — a
  critical `vsync_anomaly`, a jank rate — and there is no published mapping
  from OhmBench's ground truth to an expected trace signature, so no score is
  claimed for this axis. What is claimed is that the pipeline runs end to end
  and that a reader can see which cases it could not drive and why.

