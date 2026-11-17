import type { ZipArchive } from './zip';

/*
 * What a HAP ships, measured per file.
 *
 * The categories and their size thresholds are HapRay's `FILE_CATEGORIES`
 * table copied verbatim (hap_size_analyzer.py), so an oversized file means the
 * same thing in both tools. The category is a filing label, not a verdict: a
 * large binary is not "bad", it is large.
 */

export type FileCategory =
  | 'images' | 'videos' | 'audio' | 'fonts' | 'scripts'
  | 'styles' | 'binaries' | 'bytecode' | 'data' | 'other';

/** One archive entry, measured. Paths are archive names, forward slashes. */
export interface InventoryFile {
  readonly path: string;
  readonly size: number;
  readonly compressedSize: number;
  /** 8 lowercase hex chars. */
  readonly crc32: string;
  /** Lowercase, without the dot; `''` when the name has no extension. */
  readonly extension: string;
  readonly category: FileCategory;
}

/** HapRay's extension table, verbatim. */
export const CATEGORY_EXTENSIONS: Readonly<Record<FileCategory, readonly string[]>> = {
  images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'],
  videos: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm'],
  audio: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  fonts: ['ttf', 'otf', 'woff', 'woff2'],
  scripts: ['js', 'ts', 'py', 'sh', 'bat'],
  styles: ['css', 'scss', 'less'],
  binaries: ['so', 'dll', 'dylib', 'exe'],
  bytecode: ['abc'],
  data: ['json', 'xml', 'csv', 'yaml', 'yml'],
  other: [],
};

/**
 * HapRay's per-category "max optimal size", in bytes.
 *
 * The fractions are HapRay's decimal megabytes (0.5, 0.2), converted once here
 * so no caller has to guess whether a threshold is 500000 or 524288.
 */
export const CATEGORY_MAX_BYTES: Readonly<Record<FileCategory, number>> = {
  images: 1024 * 1024,
  videos: 10 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
  fonts: 2 * 1024 * 1024,
  scripts: Math.round(0.5 * 1024 * 1024),
  styles: Math.round(0.2 * 1024 * 1024),
  binaries: 5 * 1024 * 1024,
  bytecode: 2 * 1024 * 1024,
  data: 1024 * 1024,
  other: 1024 * 1024,
};

/** The category a lowercase extension belongs to; unknown is `other`. */
export function categorize(extension: string): FileCategory {
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.includes(extension)) return category as FileCategory;
  }
  return 'other';
}

/**
 * The extension of an archive path: the text after the last dot in the
 * basename, lowercased. A basename with no dot, or one that starts with the
 * dot (`.hidden`), has none.
 */
export function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '';
  return basename.slice(dot + 1).toLowerCase();
}

/** Every non-directory entry, sorted by path. */
export function buildInventory(archive: ZipArchive): InventoryFile[] {
  return archive.entries
    .map((entry) => {
      const extension = extensionOf(entry.name);
      return {
        path: entry.name,
        size: entry.size,
        compressedSize: entry.compressedSize,
        crc32: entry.crc32.toString(16).padStart(8, '0'),
        extension,
        category: categorize(extension),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
