# P15 — Offline static HAP inspection (HapRay parity W7)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.10.0`
**Builds on:** P14 UI capture and diff (`0.9.0`); HapRay `9386e4e`
**Gap-analysis rows:** 25 (static HAP tech-stack analysis), 26 (HapSize
inventory), 27 (static report artifacts)

## Why this phase

Every command so far starts from a device: `collect` drives one, `analyze`
reads what it captured, `ui-compare` compares two captures. An app package on
disk has answers no capture can give — what native libraries it ships, which
cross-platform frameworks it embeds, which assets are duplicated, how big the
package really is once compressed — and those answers need no device, no
`hdc`, and no trace.

HapRay answers them with a Node static analyzer (`tools/static_analyzer`) and a
separate Python size analyzer (`ext/hapsize`). Both are heavier than the
question: the static analyzer needs a bundled `hapray-sa-cmd.js`, `jszip`,
`arkanalyzer` and `sql.js` WASM; the size analyzer reads every file to hash it,
then attaches business metrics (ROI, UX scores, "estimated savings in money")
that no measurement supports. Neither can be called from this package without
dragging a Node bundle and a Python environment along.

P15 builds the inspection out of Node's own `zlib` and the report layer that
already exists, and keeps only the parts of HapRay's output that are facts.

## Scope

**In scope**

- **A ZIP reader** (`src/hap/zip.ts`) over Node's `zlib.inflateRawSync`.
  Reads the end-of-central-directory record, then the central directory, then
  each entry's local header; supports stored (method 0) and deflate (method 8)
  entries. Entry bytes are inflated on demand, never all at once. Every entry
  is CRC-checked against its central-directory record, so a corrupted archive
  is a typed error instead of a plausible wrong inventory.
- **A deterministic file inventory** (`src/hap/inventory.ts`): per file
  `path`, `size`, `compressedSize`, `crc32`, lowercase `extension` and a
  category from HapRay's own extension table. Sorted by path; no timestamps.
- **Technology-stack detection as data** (`src/hap/rules.ts`): HapRay's
  `techstack-config.yaml` ported into a typed rule list — SO, Flutter, Flutter
  assets, RN (libreact/libjsi/libjsinspector), Hermes, RN bundles, KMP, Compose
  Multiplatform, Lynx, Qt, Unity, Taro, Weex, Cangjie, and the third-party
  library rules (logan, leveldb, libpag, mmkv, ijkplayer, …). Rule kinds:
  `filename`, `path`, `extension`, `magic`, `content`, `combined`.
  Every match records **which rule decided it** and how many files it matched.
- **Duplicate and oversized asset detection.** Duplicates are found without
  inflating the whole archive: entries are grouped by `(size, crc32)` first,
  and only groups with two or more members are inflated and hashed with
  SHA-256 to confirm. An oversized file is one above its category's threshold
  from HapRay's table (images 1 MiB, videos 10 MiB, audio 5 MiB, fonts 2 MiB,
  scripts 0.5 MiB, styles 0.2 MiB, binaries 5 MiB, bytecode 2 MiB, data 1 MiB,
  other 1 MiB).
- **`ohos-perf hap <package.hap> [--out <dir>] [--json]`.** `--json` prints
  `{ analysis, capabilities }` — the typed `HapAnalysis` and the one-row
  `static.hap` matrix; `--out` writes `hap.json` (the same document) and
  `hap.html` (the existing report renderer, one `static-hap` section). Human
  output names the app, the file count and size, the detected technologies,
  duplicates and the largest files.
- **One new capability row: `static.hap`.** Offline by construction, so it
  has no device probe rule and never appears in a device matrix; the `hap`
  command's own output carries a one-row matrix with it available, so a
  consumer reads capabilities the same way it does everywhere else.

**Out of scope, deliberately**

- **HapSize's business metrics.** ROI, UX scores, quality scores and
  "estimated savings" are not measurements; the inventory reports bytes, not
  money.
- **ELF symbol extraction.** HapRay's `soDependencies`/`soExports`/`soImports`
  and the Flutter build-key extractors need an ELF reader (HapRay ships
  `elfy.ts`, 1465 lines). The rules still detect those libraries by filename;
  the metadata fields those extractors fill are absent rather than guessed.
  P16 is where symbol work lands.
- **`arkanalyzer`, `bjc`, `sql.js` and the Node bundle.** None is needed to
  read a ZIP and match file names; requiring one would make the command
  unrunnable on a clean checkout.
- **`resources.index` label resolution.** HapRay resolves `$string:` labels
  through the resource index. A wrong label is worse than no label, so
  `app.label` is present only when `module.json` carries a literal string.
- **Extraction to disk.** Nothing is written outside `--out`; the archive is
  read in memory, so a hostile entry name cannot escape anywhere.
- **Nested archives.** HapRay recurses into archives inside a HAP. A HAP
  inside a HAP is not a package the device would install; the inner file is
  inventoried as a file like any other.

## Semantics

### The archive

`openZip(bytes)` validates before it reports:

- No end-of-central-directory record → `HAP_NOT_ZIP` (the file is not a ZIP).
- A ZIP64 marker (`0xffffffff` count, size or offset) → `HAP_ZIP64_UNSUPPORTED`.
  HapRay's `jszip` handles ZIP64; a package that needs it is over 4 GiB, and
  refusing with a reason beats half-reading it.
- An encrypted entry (general-purpose flag bit 0) → `HAP_ENCRYPTED_ENTRY`,
  naming the entry.
- A method other than 0 or 8 → `HAP_UNSUPPORTED_METHOD`, naming the method.
- An entry name that is absolute or contains a `..` segment → `HAP_UNSAFE_PATH`.
  Nothing is extracted, but a package that would escape a directory is not a
  package this tool will describe as normal.
- A CRC mismatch on read → `HAP_CRC_MISMATCH`, naming the entry and both CRCs.
  A short or corrupt deflate stream is the same error, never a padded buffer.

The inventory includes directory entries? No — HapRay skips them, and a
directory has no content to measure. They are counted in neither the file
count nor the size.

### Determinism

- `hap.json` is a function of the archive's bytes: files sorted by path,
  categories by name, technologies by rule id, duplicates by hash, largest by
  `(-size, path)`. No clock, no absolute path — the archive is named by its
  basename, and `--json` reports the path the caller gave.
- `hap.html` renders from that document through the existing report model, so
  it is byte-identical for identical inputs and opens offline.
- CRC32 and SHA-256 are both content hashes; the report says which one a
  duplicate group was confirmed with.

### Detection

- A rule matches when its file rule matches one or more entries. A `combined`
  rule applies `and`/`or`/`not` over its sub-rules, exactly as HapRay does
  (`not` means "the first matches and none of the rest do").
- Confidence is `rule.confidence × match confidence` when the match carries
  one, and `rule.confidence` otherwise — HapRay's arithmetic, kept so a
  comparison against its output is meaningful.
- A rule with `requireMetadata` matches only when at least one metadata field
  was extracted, and the metadata is reported beside the match. No metadata,
  no match — never a match with an empty explanation.
- **No match is `unknown`.** The output lists what matched; it does not print
  a "primary technology" guess. HapRay's `primaryTechStack` picks the highest
  confidence, which turns a heuristic into a verdict.
- Rules are validated when the module loads: an invalid regex or an unknown
  rule kind is a `HAP_BAD_RULE` error naming the rule, not a silently skipped
  pattern.

### Metrics and evidence

Metrics (`static-hap` section), all `exact`, provenance `collector: 'offline'`,
`table: 'hap'`:

| Metric | Meaning |
| --- | --- |
| `hap.files.count` | non-directory entries |
| `hap.size.bytes` | summed uncompressed size |
| `hap.size.compressed.bytes` | summed compressed size |
| `hap.techstack.count` | distinct technologies matched |
| `hap.techstack.<type>.files` | files matching that technology type |
| `hap.duplicates.groups` | duplicate groups confirmed by SHA-256 |
| `hap.duplicates.wasted.bytes` | bytes recoverable by keeping one copy per group |
| `hap.oversized.count` | files above their category threshold |
| `hap.category.<name>.bytes` | summed size per category |

Evidence:

- One `tech_stack` item per matched rule: `signals` carry `rule`, `type`,
  `confidence`, `files`, `bytes`; the explain names the rule and up to five
  matching paths.
- One `duplicate_asset` item per duplicate group: `signals` carry `hash`,
  `size`, `copies`; the explain lists the paths.
- One `oversized_asset` item per file above its threshold: `signals` carry
  `category`, `size`, `threshold`; the explain names the category's limit.

There is no `hap.files` query and no drill-down handle on these items. Every
query in this package reads a captured scene, and a HAP is not one; adding a
query that reads a document the scene does not carry would be a second
context for the query layer to keep correct. The full per-file inventory —
paths, sizes, hashes, categories — is in `hap.json`, which is what a caller
opens when an evidence item raises a question.

## CLI

```
ohos-perf hap <package.hap> [--out <dir>] [--json]
```

- A path that is not a file, or has no `.hap`/`.hsp`/`.zip` extension, exits 1
  naming the path; nothing is written.
- `--json` prints `{ analysis, capabilities }` with a stable key order:
  `analysis` is the `HapAnalysis` document, `capabilities` the one-row
  `static.hap` matrix. The caller's `--out` path is not in it — the document
  is a function of the archive's bytes, not of the invocation.
- `--out <dir>` creates the directory and writes `hap.json` and `hap.html`;
  the human line lists both.
- The command never touches a device, so it takes no `--target` and rejects it.

## Capability handling

`static.hap` joins `CapabilityId`. It has no device rule — a device cannot
make a package on disk readable — so `buildMatrix` never emits it and the
device matrix keeps its 23 rows. The `hap` command's output carries its own
one-row matrix (`available: true`, collector `offline`, fidelity `exact`), so
a consumer that reads capabilities everywhere reads them here too.

## Testing

- ZIP: a stored entry, a deflate entry, a multi-entry archive with a
  directory, CRC mismatch, encrypted flag, method 12, ZIP64 marker, unsafe
  path, truncated archive, and an archive with no EOCD — each refusal naming
  its code.
- Inventory: extension and category assignment for every category in the
  table, unknown extension → `other`, sorted paths, directory entries skipped.
- Rules: filename, path, extension, magic, content and each `combined`
  operator; a rule with `requireMetadata` matching only with metadata; a bad
  regex refused at load; a rule matching two files reporting both.
- Duplicates: two identical files found, two files with equal size but
  different content not reported, wasted bytes = size × (copies − 1).
- Oversized: one file just under and one just over a category threshold.
- Analysis: bundle name and version read from `module.json`; a missing
  `module.json` reports an empty app block rather than inventing one.
- Report: `hap --out` writes both files, and two runs are byte-identical.
- CLI: `--json` shape, exit 1 on a missing path, `--out` artifact list.

## Exit criteria

1. `ohos-perf hap <fixture.hap>` on a fixture with two identical assets and a
   `libflutter.so` reports one duplicate group with the correct wasted bytes
   and the Flutter match with the rule that decided it.
2. A HAP with no matching rule reports `hap.techstack.count` 0 and no
   technology evidence — never a guessed stack.
3. Two runs over the same package produce byte-identical `hap.json` and
   `hap.html`.
4. A corrupted entry fails with `HAP_CRC_MISMATCH` naming the entry.
5. The device capability matrix still reports 23 rows and contains no
   `static.hap`.
