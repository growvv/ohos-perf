# P14 — UI capture, analysis and comparison (HapRay parity W6)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.9.0`
**Builds on:** P13 scenario runner (`0.8.0`); HapRay `9386e4e`
**Gap-analysis rows:** 7 (UI capture per step), 31 (UI animation analysis), 32
(UI comparison)

## Why this phase

`collect --uitest` already dumps the on-screen tree into `ui.json`, and
`query ui.get` reads it. What is missing is everything that turns a screen into
a comparable observation: there is no screenshot, so a change in *pixels* is
invisible; there is no analysis, so the tree never reaches a report; and there
is no way to ask "what changed on screen between these two captures", which is
the question a performance fix is usually validated with.

HapRay answers those with three modules that share one flaw: they were written
against a capture path that no longer exists. `capture_ui.py` writes
`screenshot_page_<i>.png` and `element_tree_page_<i>.txt`, while
`ui_compare_action.py` globs for `screenshot_start_*.png`/`screenshot_end_*.png`,
so the comparison finds nothing. The standalone `ui` action calls a
`CaptureUI.capture_ui` method that does not exist. `UIAnalyzer` drops detected
animations because of an inverted `if not regions`. The tree comparator matches
children **by index**, so one inserted node shifts every later comparison, and
it needs OpenCV and Pillow for an 8×8 dHash.

P14 builds the capability out of what this package already has — `uitest`,
the scenario runner's per-step scenes, Node's `zlib` — and fixes the four
properties HapRay gets wrong.

## Scope

**In scope**

- **Screenshot capture.** `collect --screenshot` runs `uitest screenCap` and
  pulls the PNG into `screenshot.png`, with the same discipline as the other
  collectors: a fixed device path, the tool's own `ScreenCap saved to` marker
  (hdc exits 0 even when the device refuses), a size check, a pull, and a
  magic-byte check so a truncated transfer never becomes a scene artifact.
  New capability row `ui.capture`, gated on the `uitest` binary and the
  measured marker.
- **A pure-TypeScript PNG codec.** Decode the 8-bit, non-interlaced colour
  types the device produces (0 grey, 2 RGB, 4 grey+alpha, 6 RGBA), and encode
  RGBA for marked images. `zlib.inflateSync`/`deflateSync` plus the five PNG
  row filters. Palette, 16-bit and interlaced images are refused with a typed
  error naming which, never silently mis-decoded.
- **Image comparison.** A 64-bit dHash (9×8 box-averaged greyscale, horizontal
  gradient) and a bounded pixel diff: both images are downscaled to at most
  256 px wide with the same box filter, compared channel-wise against a
  documented tolerance, and reported as a changed-pixel ratio. Similarity is
  `1 - hamming/64`; the two numbers answer different questions (structure vs.
  pixels) and both are reported.
- **Identity-based tree comparison.** Nodes are matched by a computed identity
  — `bundleName`, `type`, `id`, and `text` — not by index. Siblings are matched
  in document order within an identity bucket, so an inserted node adds one
  difference instead of shifting the rest. Attribute diffs apply a documented
  ignore list and a 5 px geometry tolerance; every difference records which
  rule decided it.
- **`ui` analyzer.** Reads `ui.json` and `screenshot.png` from the scene and
  emits `ui.nodes.count`, `ui.nodes.clickable`, `ui.nodes.text`,
  `ui.tree.depth.max`, `ui.screenshot.width`/`height`, `ui.screenshot.dhash`,
  plus `no_data` evidence when neither artifact exists. It flows through
  `analyze` and `report` unchanged, so the report gains a UI section with the
  screenshot embedded from a copied asset.
- **`ohos-perf ui-compare <a> <b> --out <dir>`.** Two scenes (or two
  step-scene directories from a `run`) produce `ui-diff.json` and
  `ui-diff.html`, the latter self-contained except for two marked PNGs written
  beside it. Exit code 1 when the comparison could not be made (a missing
  artifact on one side), 0 when it was made — including when the screens are
  identical.
- **One new query:** `ui.tree` — the raw tree with every attribute the diff
  uses, so a difference is drillable. `ui.get` stays as it is. There is no
  `ui.diff` query: a comparison is a file `ui-compare` writes, and no query in
  this package reads outside the scene it is given.

**Out of scope, deliberately**

- **A separate `ui_animate.json` artifact.** HapRay's animation analysis is a
  start/end capture pair compared with the same two comparators. P13 already
  makes every capture point a scene, so "the animation" is
  `ui-compare step-a/round-1 step-b/round-1` — the same information, from one
  code path, with the two captures' own timestamps. Adding a second artifact
  name for the same computation would be a second thing to keep correct.
- **HapRay's animation classification** (dHash < 85 marks animation, < 50
  major, < 70 moderate, < 85 minor). Those thresholds are unvalidated and
  device-resolution dependent, and "this region animated" is not a performance
  measurement. P14 reports similarity and changed-pixel ratio with the
  thresholds it uses stated in the output; it does not label a region
  "animated".
- **A DOM renderer, canvas, or browser.** Marked images are written by the PNG
  encoder; the HTML is hand-written and uses no scripts.
- **Scale/resolution normalisation across devices.** Comparing a phone capture
  with a tablet capture is refused with a reason rather than silently rescaled:
  a rescaled diff would report layout differences as pixel differences.
- **HapRay's `inspector_page_<i>.json`.** It is Hypium's `UiTree.dump_to_file`
  output — a different, larger document than `uitest dumpLayout` produces.
  `ui.json` is the single tree source; a second one would be a second format to
  keep in step.

## Semantics

### Capture

`screenshot.png` is written by the collector, not by the device path, and only
after the bytes are verified to start with the PNG signature. `scene.json`
gains `capture.screenshot: { bytes, width, height }`; a capture that ran but
produced a zero-byte screen is a failure, not a zero-sized image.

The screenshot is device-wide (the whole screen, status bar and navigation bar
included), exactly like `ui.json`. Both are recorded as such in the metadata,
and both are filtered by the caller.

### Determinism

Every UI artifact is a function of the bytes captured, never of the clock:

- `ui-diff.json` is byte-identical for identical inputs; it carries no
  timestamps of its own. The two scenes' `capture.startedAtMs` are read from
  their own `scene.json` and copied, so they are inputs, not the output's clock.
- Marked PNGs are byte-identical: the encoder writes no `tEXt`/`tIME` chunks,
  and the region order is the diff's own deterministic order.
- dHash and pixel diff are integer arithmetic over a fixed downscale, so two
  runs over the same files agree exactly.
- `ui-diff.html` embeds the JSON summary and references the two PNGs by
  relative name; no date, no version drift beyond the package version.

### Comparison rules

- **Resolution.** Both screenshots must have the same dimensions. A mismatch
  is `UI_SIZE_MISMATCH` naming both sizes: the trees' `bounds` are in the same
  space as the pixels, so a cross-resolution diff would compare different
  things.
- **Missing side.** A scene with no `screenshot.png` or no `ui.json` yields a
  typed error naming which artifact and which side. It is not an empty diff: a
  missing screen is not an unchanged screen.
- **Identity.** `identity = bundleName + '|' + type + '|' + id + '|' + text`,
  with `id` used only when non-empty and `text` only when non-empty. Two
  siblings with the same identity are paired in document order; the third one
  on one side only is reported `added` or `removed`.
- **Ignored attributes.** `id`, `accessibilityId`, `rsNode`, `frameProxy`,
  `frameRecord`, `contentConstraint`, `parentLayoutConstraint`,
  `user defined constraint` — HapRay's list, kept because those fields are
  renderer state that changes between two identical screens.
- **Geometry tolerance.** `bounds` is parsed into a rect; a difference in any
  of left/top/right/bottom smaller than 5 px is not a difference. A larger one
  is reported with both rects.
- **Image tolerance.** Per-channel difference greater than 8 (of 255) counts a
  pixel as changed. The threshold is in the output, not only in the docs.

### The UI analyzer

`requires: ['ui.tree']` would skip the analyzer on a device without `uitest`,
but a scene can carry a `ui.json` from another device. The analyzer therefore
requires nothing and decides from the artifacts it is given:

- Neither artifact: one `ui.degraded` proxy (`no UI capture in this scene`) and
  a `no_data` evidence item.
- Tree only: tree metrics exact, `ui.screenshot.*` degraded with a reason.
- Screenshot only: image metrics exact, tree metrics degraded with a reason.

`ui.screenshot.dhash` is a 16-character hex string, emitted as a metric with
`unit: 'hash'` and `fidelity: 'exact'` — it is a computed value, not a
measurement, and the metric id says so.

### The report

The `ui` section renders like every other section. When the scene has a
screenshot, `report` copies it to `<out>/assets/screenshot.png` and the HTML
shows it with `<img src="assets/screenshot.png">`. A missing screenshot renders
the degraded reason instead of a broken image. The report stays free of
scripts and network access; an `assets/` directory beside it is not a
dependency.

## CLI

```
ohos-perf collect --screenshot            # adds screenshot.png to the scene
ohos-perf ui-compare <sceneA> <sceneB> --out <dir> [--json]
```

`ui-compare` writes `ui-diff.json`, `ui-diff.html`, `ui-diff-marked-a.png` and
`ui-diff-marked-b.png`. `--json` prints the `UiDiff` to stdout instead of the
human summary (the files are still written). Human output is one line per
finding class — added, removed, changed attributes, changed regions — then the
two similarities.

`collect --screenshot` is independent of `--uitest`: a screenshot without a
tree is a valid capture, and the analyzer says which half is missing.

## Capability handling

One new row: `ui.capture`, collector `uitest`, gated on the binary and on the
measured `ScreenCap saved to` marker. The row exists so an agent can ask
"can this device screenshot?" before asking for one. `ui.tree` already exists
and is unchanged.

`collect --screenshot` requires `ui.capture` and throws `MISSING_CAPABILITY`
with the matrix's reason before any device call.

## Testing

- PNG: decode each supported colour type from a hand-built buffer, round-trip
  encode→decode, every filter type (0–4) exercised, and each refusal path
  (palette, 16-bit, interlaced, bad signature, truncated IDAT) naming its
  reason.
- Image: dHash on synthetic images (identical → distance 0, inverted → 64),
  similarity monotonicity, changed-pixel ratio on a known one-pixel edit,
  region marking writes the requested rectangles.
- Tree: identity matching with an inserted node (one `added`, nothing else
  shifted), removed node, attribute change inside and outside the 5 px
  tolerance, ignored attribute, duplicate-identity pairing in order.
- Analyzer: tree only, screenshot only, both, neither; exact vs. degraded
  metrics and the `no_data` evidence.
- Compare: resolution mismatch, missing artifact per side, identical scenes
  (zero differences, exit 0), and byte-identical output across two runs.
- Collector: the marker, the size check, the signature check, and a failed
  capture leaving no `screenshot.png` behind.
- CLI: argument validation, exit codes, `--json` shape.
- Device (skipped without a device): a real `uitest screenCap` produces a PNG
  the decoder reads with non-zero dimensions.

## Exit criteria

1. `collect --screenshot` on the emulator produces a `screenshot.png` the
   decoder reads, and `scene.json` records its size.
2. `analyze` reports the `ui` section's tree and image metrics for that scene;
   a scene without either artifact reports the degraded reason, not zeros.
3. `ui-compare` between two step scenes from one `run` writes four files, and
   two runs over the same inputs produce byte-identical `ui-diff.json` and
   marked PNGs.
4. An inserted UI node is reported as one `added` difference, not a cascade of
   changed siblings.
5. `report` shows the screenshot from `assets/` and the HTML opens offline.
