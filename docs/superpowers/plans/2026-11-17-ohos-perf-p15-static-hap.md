# P15 Offline Static HAP Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a HAP/HSP/ZIP package offline into a deterministic file inventory, detect the technologies it embeds by rule, find duplicate and oversized assets, and render the result as `hap.json` plus an offline `hap.html`.

**Architecture:** A ZIP reader over `node:zlib` (`src/hap/zip.ts`) feeds an inventory (`src/hap/inventory.ts`), which a data-driven rule set (`src/hap/rules.ts`) matches. An analysis builder (`src/hap/analyze.ts`) turns all three into metrics and evidence, and the existing report layer renders them. The CLI command is `hap`.

**Tech Stack:** TypeScript ESM, `node:zlib` (`inflateRawSync`), `node:crypto` (`sha256`), zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p15-static-hap-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`. `node:zlib`, `node:crypto` and `node:fs` only.
- Determinism (D5): identical archive bytes produce byte-identical `hap.json` and `hap.html`. No `Date.now()`, no absolute path inside the document, no locale-dependent sort.
- Every unknown-key or shape violation is a typed `OhosPerfError` with a code.
- `packages/core/src/index.ts` is the public surface: a new exported value must be added to `packages/core/test/types.test.ts`'s `VALUE_EXPORTS`, and core must be rebuilt (`npm run build -w @ohos-perf/core`) before the CLI sees it.
- Unit suite command: `npm run test:unit`. Typecheck: `npm run typecheck -w @ohos-perf/core` and `-w @ohos-perf/cli`.
- The device capability matrix keeps exactly 23 rows: `static.hap` is offline and has no device rule.

## Review Focus

- **A ZIP entry whose CRC disagrees with its data.** Reading it anyway produces a plausible wrong inventory. It must fail naming the entry.
- **Two files with equal size and different content.** Grouping by `(size, crc32)` alone reports a false duplicate; the SHA-256 confirmation must be what decides.
- **An entry name containing `..` or a drive letter.** Nothing is extracted, but a package that would escape a directory must not be described as normal.
- **A HAP with no matching rule.** The output must report zero technologies, never a "primary technology" guess.
- **A rule with an invalid regex.** It must be refused when the rule set loads, naming the rule, not skipped silently at match time.

---

### Task 1: The ZIP reader

**Files:**
- Create: `packages/core/src/hap/zip.ts`
- Test: `packages/core/test/hap-zip.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ZipEntry {
    /** The entry name exactly as stored, forward slashes. */
    readonly name: string;
    readonly size: number;
    readonly compressedSize: number;
    readonly crc32: number;
    readonly method: number;
  }
  export interface ZipArchive {
    /** Non-directory entries, in central-directory order. */
    readonly entries: readonly ZipEntry[];
    /** Inflated bytes, CRC-checked. Throws on a mismatch or a bad stream. */
    read(entry: ZipEntry): Uint8Array;
  }
  export function openZip(bytes: Uint8Array): ZipArchive;
  export function isZip(bytes: Uint8Array): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/hap-zip.test.ts`. Build archives with a local helper that writes a real ZIP (local headers, central directory, EOCD) so the reader is exercised against the format, not against itself. Cover: a stored entry round-trips its bytes; a deflated entry round-trips; a multi-entry archive preserves central-directory order; a directory entry is absent from `entries`; `isZip` is true for an archive and false for a PNG; and each refusal names its code — `HAP_NOT_ZIP` (no EOCD), `HAP_CRC_MISMATCH` (a flipped payload byte, naming the entry), `HAP_UNSUPPORTED_METHOD` (method 12), `HAP_ENCRYPTED_ENTRY` (flag bit 0), `HAP_ZIP64_UNSUPPORTED` (an `0xffffffff` size), `HAP_UNSAFE_PATH` (`../evil` and `C:/evil`).

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --project unit packages/core/test/hap-zip.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `openZip`**

Find the EOCD by scanning backwards for `0x06054b50` from the end (the comment is at most 65535 bytes, so scan the last 65557). Read the central-directory count and offset; refuse ZIP64 when the count, size or offset is `0xffffffff`. For each central header (`0x02014b50`), read name, method, CRC, sizes and local-header offset, then read the local header (`0x04034b50`) to get its name and extra lengths and the data start. Skip names ending in `/`. `read` inflates with `inflateRawSync` for method 8 and slices for method 0, then compares `crc32` of the result against the central record and throws `HAP_CRC_MISMATCH` naming the entry and both CRCs. `crc32` is already implemented in `src/report/xlsx.ts`; move it to `src/hap/crc.ts` and import it from both, so there is one implementation.

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run --project unit packages/core/test/hap-zip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hap packages/core/src/report/xlsx.ts packages/core/test/hap-zip.test.ts
git commit -m "feat(core): read ZIP archives without a native dependency"
```

---

### Task 2: The inventory

**Files:**
- Create: `packages/core/src/hap/inventory.ts`
- Test: `packages/core/test/hap-inventory.test.ts`

**Interfaces:**
- Consumes: `ZipArchive`, `ZipEntry`.
- Produces:
  ```ts
  export type FileCategory =
    | 'images' | 'videos' | 'audio' | 'fonts' | 'scripts'
    | 'styles' | 'binaries' | 'bytecode' | 'data' | 'other';
  export interface InventoryFile {
    readonly path: string;
    readonly size: number;
    readonly compressedSize: number;
    readonly crc32: string;      // 8 lowercase hex chars
    readonly extension: string;  // lowercase, no dot; '' when none
    readonly category: FileCategory;
  }
  export const CATEGORY_EXTENSIONS: Readonly<Record<FileCategory, readonly string[]>>;
  export const CATEGORY_MAX_BYTES: Readonly<Record<FileCategory, number>>;
  export function categorize(extension: string): FileCategory;
  export function buildInventory(archive: ZipArchive): InventoryFile[];
  ```
  `CATEGORY_EXTENSIONS` and `CATEGORY_MAX_BYTES` are HapRay's `FILE_CATEGORIES` table, copied verbatim: images `png jpg jpeg gif bmp webp svg` (1 MiB), videos `mp4 avi mov wmv flv webm` (10 MiB), audio `mp3 wav aac ogg flac` (5 MiB), fonts `ttf otf woff woff2` (2 MiB), scripts `js ts py sh bat` (0.5 MiB), styles `css scss less` (0.2 MiB), binaries `so dll dylib exe` (5 MiB), bytecode `abc` (2 MiB), data `json xml csv yaml yml` (1 MiB), other `[]` (1 MiB).

- [ ] **Step 1: Write the failing tests**

Cover: every category's first extension maps to that category; an unknown extension maps to `other`; a name with no extension has `extension: ''` and category `other`; the extension is lowercased (`A.PNG` → `png`); `buildInventory` sorts by path and skips nothing (directory entries never reach it); `CATEGORY_MAX_BYTES` holds HapRay's exact thresholds.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/core/test/hap-inventory.test.ts`

- [ ] **Step 3: Implement** — the extension is the text after the last `.` in the basename, lowercased; a basename with no `.` (or one starting with `.`) has none. Sort with a plain `<` comparison.

- [ ] **Step 4: Run and confirm pass.**

- [ ] **Step 5: Commit** — `feat(core): inventory a HAP's files by category`

---

### Task 3: Technology-stack rules

**Files:**
- Create: `packages/core/src/hap/rules.ts`
- Test: `packages/core/test/hap-rules.test.ts`

**Interfaces:**
- Consumes: `InventoryFile`, `ZipArchive` (for content and magic rules).
- Produces:
  ```ts
  export type RuleMatchKind = 'filename' | 'path' | 'extension' | 'magic' | 'content' | 'combined';
  export interface FileRule {
    readonly kind: RuleMatchKind;
    readonly patterns?: readonly string[];
    readonly extensions?: readonly string[];
    readonly bytes?: readonly number[];
    readonly offset?: number;
    readonly operator?: 'and' | 'or' | 'not';
    readonly rules?: readonly FileRule[];
  }
  export interface TechRule {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly confidence: number;
    readonly fileRules: readonly FileRule[];
    readonly requireMetadata?: boolean;
    /** A rule that only matches when the named entry exists and holds text. */
    readonly metadataPatterns?: ReadonlyArray<{ field: string; source: 'content' | 'path' | 'filename'; pattern: string; captureGroup?: number }>;
  }
  export interface RuleMatch {
    readonly ruleId: string;
    readonly ruleName: string;
    readonly type: string;
    readonly confidence: number;
    readonly files: InventoryFile[];
    readonly bytes: number;
    readonly metadata: Readonly<Record<string, string>>;
  }
  export const TECH_RULES: readonly TechRule[];
  export function validateRules(rules: readonly TechRule[]): void;   // throws HAP_BAD_RULE
  export function matchRules(rules: readonly TechRule[], archive: ZipArchive, inventory: readonly InventoryFile[]): RuleMatch[];
  ```

- [ ] **Step 1: Write the failing tests**

Cover each kind on a hand-built archive: `filename` (a regex over the basename), `path` (a regex over the full entry name), `extension`, `magic` (bytes at an offset), `content` (a regex over the inflated text), and `combined` with `and`, `or` and `not` (the last meaning "the first matches and none of the rest do"). A `requireMetadata` rule matches only when a metadata pattern found something. A rule matching two files reports both, with `bytes` summed. `validateRules` throws `HAP_BAD_RULE` naming the rule for an invalid regex and for an unknown `kind`. Confidence is `rule.confidence × match confidence` where a pattern carries its own confidence, and `rule.confidence` otherwise. Then assert the shipped `TECH_RULES` include, by id, `Flutter`, `RN_LibReact`, `Hermes_Engine`, `KMP_LibKn`, `Lynx_Framework`, `Qt_Framework`, `Unity_Engine`, `Taro_Framework`, `Weex_Framework`, `Cangjie_Framework` and `CMP_Skiko`, and that every shipped rule validates.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement** — port HapRay's `techstack-config.yaml` into typed data. Every rule's `fileRules` become one `FileRule` (the YAML's single-entry lists collapse to the entry). The content rule reads the entry's inflated text as UTF-8. Rules run in `TECH_RULES` order; the output is sorted by `(type, ruleId)`.

- [ ] **Step 4: Run and confirm pass.**

- [ ] **Step 5: Commit** — `feat(core): detect a HAP's technology stack from data rules`

---

### Task 4: Duplicates, oversized assets and the analysis document

**Files:**
- Create: `packages/core/src/hap/analyze.ts`
- Test: `packages/core/test/hap-analyze.test.ts`

**Interfaces:**
- Consumes: `ZipArchive`, `InventoryFile`, `RuleMatch`, `CATEGORY_MAX_BYTES`.
- Produces:
  ```ts
  export interface DuplicateGroup {
    readonly sha256: string;
    readonly size: number;
    readonly copies: number;
    readonly wastedBytes: number;
    readonly paths: readonly string[];
  }
  export interface OversizedFile {
    readonly path: string;
    readonly category: FileCategory;
    readonly size: number;
    readonly threshold: number;
  }
  export interface HapAnalysis {
    readonly schemaVersion: 1;
    readonly package: { name: string; bundleName: string; versionName: string; versionCode: number; appName: string };
    readonly totals: { files: number; size: number; compressedSize: number };
    readonly categories: Array<{ name: FileCategory; files: number; size: number; compressedSize: number }>;
    readonly technologies: RuleMatch[];
    readonly duplicates: DuplicateGroup[];
    readonly oversized: OversizedFile[];
    readonly largest: Array<{ path: string; size: number }>;
    readonly metrics: Metric[];
    readonly evidence: Evidence[];
  }
  export function analyzeHap(bytes: Uint8Array, packageName: string): HapAnalysis;
  export function hapSection(analysis: HapAnalysis): AnalyzerSection;
  ```

- [ ] **Step 1: Write the failing tests**

Cover: two identical files produce one group with `copies: 2` and `wastedBytes` equal to one file's size; two files with equal size and different content produce no group; three copies of one file give `wastedBytes = size × 2`; a file one byte over a category threshold is oversized and one at the threshold is not; `module.json` supplies `bundleName`/`versionName`/`versionCode`, and a literal `app.label` supplies `appName` while a `$string:` label leaves it empty; a missing `module.json` leaves every package field empty rather than inventing one; metrics and evidence are sorted and carry `collector: 'offline'`, `table: 'hap'`; a package with no rule match has `technologies: []` and no `tech_stack` evidence; the same bytes analyzed twice produce identical JSON.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement** — group by `${size}:${crc32}`, inflate only groups with two or more members, hash each with SHA-256, and keep the groups where a hash has two or more paths. `largest` is the top 10 by `(-size, path)`. Metrics use the ids in the spec. Evidence items use `key: ruleId` / `key: sha256` / `key: path` so two items never collide on one id. `hapSection` wraps the analysis as an `AnalyzerSection` with `analyzerId: 'static-hap'` and `status: 'measured'`.

- [ ] **Step 4: Run and confirm pass.**

- [ ] **Step 5: Commit** — `feat(core): analyze a HAP into metrics and evidence`

---

### Task 5: The `hap` command

**Files:**
- Modify: `packages/cli/src/commands.ts` (`HapRequest`, `HapOutput`, `runHap`), `packages/cli/src/deps.ts` (`hap`), `packages/cli/src/program.ts` (the command)
- Modify: `packages/core/src/report/model.ts` (`static-hap` title), `packages/core/src/index.ts` (exports)
- Test: `packages/cli/test/hap.test.ts`, `packages/core/test/types.test.ts` (export list)

**Interfaces:**
- Consumes: `analyzeHap`, `hapSection`, `buildReport`, `renderReportHtml`.
- Produces: `CliDeps.hap(req: HapRequest): Promise<HapOutput>`; `runHap(deps, req, opts)`; the CLI command `hap <package>`.

- [ ] **Step 1: Write the failing tests**

CLI: `hap <file> --json` prints the analysis; `hap <missing>` exits 1 naming the path and calls no dep; a non-HAP extension exits 1; `--out <dir>` writes `hap.json` and `hap.html`, and `hap.html` contains no `<script>` and the technology names; `--target` is rejected. Types: the new exports are in `VALUE_EXPORTS`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement** — `deps.hap` reads the file, calls `analyzeHap`, and on `--out` builds a one-section report model (`app.packageName` from the analysis, `device: 'offline'`, the archive's own window `{0, 0}`) and writes both files. `runHap` prints the human summary: package, files/size, technologies with their rule ids, duplicate groups and wasted bytes, oversized count.

- [ ] **Step 4: Run and confirm pass**, then rebuild core and run the full suite:
`npm run build -w @ohos-perf/core && npm run test:unit && npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`

- [ ] **Step 5: Commit** — `feat(cli): inspect a HAP offline with hap`

---

### Task 6: Docs and release `0.10.0`

**Files:**
- Modify: `README.md`, `site/index.html`, `skill/ohos-perf/SKILL.md`, `CHANGELOG.md`, the three manifests, `package-lock.json`
- Test: the unit suite

- [ ] **Step 1:** Docs — README `## Static HAP inspection` plus `hap` in the CLI list, the metric table's `hap.*` rows, and roadmap P15 → `shipped in 0.10.0`; site P15 card and roadmap row; skill `## Static HAP inspection`; CHANGELOG `## 0.10.0`.
- [ ] **Step 2:** Bump the three manifests and the cli→core pin to `0.10.0`, update `package-lock.json`, rebuild both packages, run the unit suite and both typechecks.
- [ ] **Step 3:** Commit, tag `v0.10.0`, push `master --tags`, create the GitHub release.

## Self-review notes

- Spec coverage: ZIP reader (Task 1), inventory (Task 2), rules (Task 3), duplicates/oversized/analysis (Task 4), command (Task 5), docs and release (Task 6). The spec's `hap.files` query is deliberately dropped — see its "no drill-down" note; the full inventory is in `hap.json`. `static.hap` is a `CapabilityId` but has no device rule, so the matrix keeps 23 rows.
