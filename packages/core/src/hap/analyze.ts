import { createHash } from 'node:crypto';
import type { AnalyzerSection } from '../analyze/engine';
import type { TimeRange } from '../types';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { buildInventory, CATEGORY_MAX_BYTES, type FileCategory, type InventoryFile } from './inventory';
import { matchHapRules, TECH_RULES, type RuleMatch } from './rules';
import { openZip, type ZipArchive } from './zip';

/*
 * A HAP as a measured document.
 *
 * Everything here is a fact about the archive's bytes: how many files, how
 * large, which ones are copies, which exceed their category's threshold, and
 * which rules matched. There is no "primary technology" and no score — a
 * guess rendered beside measurements reads like one of them.
 *
 * A package is not a captured scene, so the window is the archive itself:
 * `{ startNs: 0, endNs: 0 }` and provenance `collector: 'offline'` say so.
 */

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

export interface HapPackage {
  readonly name: string;
  readonly bundleName: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly appName: string;
}

export interface CategoryTotal {
  readonly name: FileCategory;
  readonly files: number;
  readonly size: number;
  readonly compressedSize: number;
}

export interface HapAnalysis {
  readonly schemaVersion: 1;
  readonly package: HapPackage;
  readonly totals: { files: number; size: number; compressedSize: number };
  readonly categories: CategoryTotal[];
  readonly technologies: RuleMatch[];
  readonly duplicates: DuplicateGroup[];
  readonly oversized: OversizedFile[];
  readonly largest: Array<{ path: string; size: number }>;
  /**
   * Every non-directory entry, measured: the population the totals, categories
   * and largest lists are taken from. This is what a caller opens when an
   * evidence item raises a question about one file.
   */
  readonly files: readonly InventoryFile[];
  readonly metrics: Metric[];
  readonly evidence: Evidence[];
}

/** The window every offline document reports: the package, not a run. */
const OFFLINE_WINDOW: TimeRange = { startNs: 0, endNs: 0 };
const LARGEST_COUNT = 10;
const EXPLAIN_PATHS = 5;

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The `module.json` app block, or empty fields when it is missing or unreadable.
 *
 * A `$string:` label is left empty on purpose: resolving it needs the resource
 * index, and a wrong label is worse than none.
 */
function readPackage(archive: ZipArchive): Omit<HapPackage, 'name'> {
  const empty = { bundleName: '', versionName: '', versionCode: 0, appName: '' };
  const entry = archive.entries.find((candidate) => candidate.name === 'module.json');
  if (entry === undefined) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(archive.read(entry)));
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const app = (parsed as { app?: unknown }).app;
  if (typeof app !== 'object' || app === null) return empty;
  const fields = app as { bundleName?: unknown; versionName?: unknown; versionCode?: unknown; label?: unknown };
  const label = typeof fields.label === 'string' && !fields.label.startsWith('$string:') ? fields.label : '';
  return {
    bundleName: typeof fields.bundleName === 'string' ? fields.bundleName : '',
    versionName: typeof fields.versionName === 'string' ? fields.versionName : '',
    versionCode: typeof fields.versionCode === 'number' ? fields.versionCode : 0,
    appName: label,
  };
}

/**
 * Duplicate groups, confirmed by SHA-256.
 *
 * Entries are grouped by `(size, crc32)` first — a cheap pair that only equal
 * content can share — and only groups with two or more members are inflated
 * and hashed. Two files that share a size but differ in content never reach
 * the hash step; a CRC collision does, and the hash then separates them.
 */
function findDuplicates(archive: ZipArchive, inventory: readonly InventoryFile[]): DuplicateGroup[] {
  const entriesByName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  const buckets = new Map<string, InventoryFile[]>();
  for (const file of inventory) {
    const key = `${file.size}:${file.crc32}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [file]);
    else bucket.push(file);
  }

  const byHash = new Map<string, InventoryFile[]>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (const file of bucket) {
      const entry = entriesByName.get(file.path);
      if (entry === undefined) continue;
      const digest = sha256(archive.read(entry));
      const group = byHash.get(digest);
      if (group === undefined) byHash.set(digest, [file]);
      else group.push(file);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [hash, files] of byHash) {
    if (files.length < 2) continue;
    const sorted = [...files].sort((a, b) => byString(a.path, b.path));
    const size = sorted[0]!.size;
    groups.push({
      sha256: hash,
      size,
      copies: sorted.length,
      wastedBytes: size * (sorted.length - 1),
      paths: sorted.map((file) => file.path),
    });
  }
  return groups.sort((a, b) => byString(a.sha256, b.sha256));
}

/** Files strictly above their category's threshold, largest first. */
function findOversized(inventory: readonly InventoryFile[]): OversizedFile[] {
  return inventory
    .filter((file) => file.size > CATEGORY_MAX_BYTES[file.category])
    .map((file) => ({
      path: file.path,
      category: file.category,
      size: file.size,
      threshold: CATEGORY_MAX_BYTES[file.category],
    }))
    .sort((a, b) => b.size - a.size || byString(a.path, b.path));
}

function categoryTotals(inventory: readonly InventoryFile[]): CategoryTotal[] {
  const totals = new Map<FileCategory, CategoryTotal>();
  for (const file of inventory) {
    const current = totals.get(file.category);
    totals.set(file.category, {
      name: file.category,
      files: (current?.files ?? 0) + 1,
      size: (current?.size ?? 0) + file.size,
      compressedSize: (current?.compressedSize ?? 0) + file.compressedSize,
    });
  }
  return [...totals.values()].sort((a, b) => byString(a.name, b.name));
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, EXPLAIN_PATHS).join(', ');
  return paths.length > EXPLAIN_PATHS ? `${shown}, and ${paths.length - EXPLAIN_PATHS} more` : shown;
}

function offlineProvenance(rows: number): Metric['provenance'] {
  return { collector: 'offline', table: 'hap', rows, device: 'offline' };
}

function buildMetrics(analysis: {
  totals: HapAnalysis['totals'];
  categories: readonly CategoryTotal[];
  technologies: readonly RuleMatch[];
  duplicates: readonly DuplicateGroup[];
  oversized: readonly OversizedFile[];
}): Metric[] {
  const metrics: Metric[] = [
    metric({
      id: 'hap.files.count', value: analysis.totals.files, unit: 'count',
      provenance: offlineProvenance(analysis.totals.files), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.size.bytes', value: analysis.totals.size, unit: 'bytes',
      provenance: offlineProvenance(analysis.totals.files), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.size.compressed.bytes', value: analysis.totals.compressedSize, unit: 'bytes',
      provenance: offlineProvenance(analysis.totals.files), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.techstack.count', value: analysis.technologies.length, unit: 'count',
      provenance: offlineProvenance(analysis.technologies.length), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.duplicates.groups', value: analysis.duplicates.length, unit: 'count',
      provenance: offlineProvenance(analysis.duplicates.length), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.duplicates.wasted.bytes',
      value: analysis.duplicates.reduce((sum, group) => sum + group.wastedBytes, 0),
      unit: 'bytes',
      provenance: offlineProvenance(analysis.duplicates.length), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
    metric({
      id: 'hap.oversized.count', value: analysis.oversized.length, unit: 'count',
      provenance: offlineProvenance(analysis.oversized.length), fidelity: 'exact', window: OFFLINE_WINDOW,
    }),
  ];

  const byType = new Map<string, number>();
  for (const match of analysis.technologies) {
    byType.set(match.type, (byType.get(match.type) ?? 0) + match.files.length);
  }
  for (const [type, files] of byType) {
    metrics.push(metric({
      id: `hap.techstack.${type}.files`, value: files, unit: 'count',
      provenance: offlineProvenance(files), fidelity: 'exact', window: OFFLINE_WINDOW,
    }));
  }
  for (const category of analysis.categories) {
    metrics.push(metric({
      id: `hap.category.${category.name}.bytes`, value: category.size, unit: 'bytes',
      provenance: offlineProvenance(category.files), fidelity: 'exact', window: OFFLINE_WINDOW,
    }));
  }

  return metrics.sort((a, b) => byString(a.id, b.id));
}

function buildEvidence(analysis: {
  package: HapPackage;
  technologies: readonly RuleMatch[];
  duplicates: readonly DuplicateGroup[];
  oversized: readonly OversizedFile[];
}): Evidence[] {
  const subject = { process: analysis.package.bundleName === '' ? analysis.package.name : analysis.package.bundleName };
  const items: Evidence[] = [];

  for (const match of analysis.technologies) {
    items.push(evidence({
      kind: 'tech_stack',
      severity: 'info',
      subject,
      window: OFFLINE_WINDOW,
      signals: {
        rule: match.ruleId,
        type: match.type,
        confidence: match.confidence,
        files: match.files.length,
        bytes: match.bytes,
      },
      explain:
        `${match.ruleName} (${match.type}) from rule ${match.ruleId}, ` +
        `confidence ${match.confidence.toFixed(2)}, ${match.files.length} file(s): ` +
        listPaths(match.files.map((file) => file.path)),
      drillDown: [],
      key: match.ruleId,
    }));
  }

  for (const group of analysis.duplicates) {
    items.push(evidence({
      kind: 'duplicate_asset',
      severity: 'warn',
      subject,
      window: OFFLINE_WINDOW,
      signals: {
        hash: group.sha256,
        size: group.size,
        copies: group.copies,
        wastedBytes: group.wastedBytes,
      },
      explain:
        `${group.copies} copies of a ${group.size}-byte file (sha256 ${group.sha256.slice(0, 12)}); ` +
        `${group.wastedBytes} bytes recoverable: ${listPaths(group.paths)}`,
      drillDown: [],
      key: group.sha256,
    }));
  }

  for (const file of analysis.oversized) {
    items.push(evidence({
      kind: 'oversized_asset',
      severity: 'info',
      subject,
      window: OFFLINE_WINDOW,
      signals: { category: file.category, size: file.size, threshold: file.threshold },
      explain:
        `${file.path} is ${file.size} bytes, above the ${file.category} limit of ${file.threshold} bytes`,
      drillDown: [],
      key: file.path,
    }));
  }

  return items.sort((a, b) => byString(a.kind, b.kind) || a.window.startNs - b.window.startNs || byString(a.id, b.id));
}

/**
 * Analyze one HAP's bytes into a deterministic document.
 *
 * `packageName` names the archive in the document (the caller's file name, not
 * an absolute path) so the same bytes under a different path stay identical.
 */
export function analyzeHap(bytes: Uint8Array, packageName: string): HapAnalysis {
  const archive = openZip(bytes);
  const inventory = buildInventory(archive);
  // Every entry is inflated once and CRC-checked, whatever the rules decide.
  // Rule matching excludes `resources/base/`, so an integrity check that
  // relied on the rules would leave the largest part of a package unverified.
  for (const entry of archive.entries) archive.read(entry);
  const packageBlock = readPackage(archive);
  const technologies = matchHapRules(TECH_RULES, archive, inventory);
  const duplicates = findDuplicates(archive, inventory);
  const oversized = findOversized(inventory);
  const categories = categoryTotals(inventory);
  const totals = {
    files: inventory.length,
    size: inventory.reduce((sum, file) => sum + file.size, 0),
    compressedSize: inventory.reduce((sum, file) => sum + file.compressedSize, 0),
  };
  const largest = [...inventory]
    .sort((a, b) => b.size - a.size || byString(a.path, b.path))
    .slice(0, LARGEST_COUNT)
    .map((file) => ({ path: file.path, size: file.size }));

  const analysis = {
    schemaVersion: 1 as const,
    package: { name: packageName, ...packageBlock },
    totals,
    categories,
    technologies,
    duplicates,
    oversized,
    largest,
  };

  return {
    ...analysis,
    files: inventory,
    metrics: buildMetrics(analysis),
    evidence: buildEvidence(analysis),
  };
}

/** Wrap an analysis as the `static-hap` section the report renderer takes. */
export function hapSection(analysis: HapAnalysis): AnalyzerSection {
  return {
    analyzerId: 'static-hap',
    status: 'measured',
    result: { metrics: analysis.metrics, evidence: analysis.evidence },
  };
}
