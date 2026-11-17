import { describe, it, expect } from 'vitest';
import { analyzeHap, hapSection, type HapAnalysis } from '../src/hap/analyze';
import { makeZip, type TestEntry } from './helpers/hap-zip-writer';

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);

const MODULE_JSON = JSON.stringify({
  app: { bundleName: 'com.example.demo', versionCode: 42, versionName: '1.2.3', label: 'Demo' },
});

function bytes(entries: TestEntry[]): Uint8Array {
  return makeZip(entries);
}

function analyze(entries: TestEntry[]): HapAnalysis {
  return analyzeHap(bytes(entries), 'demo.hap');
}

function metricIds(analysis: HapAnalysis): string[] {
  return analysis.metrics.map((entry) => entry.id);
}

function metricValue(analysis: HapAnalysis, id: string): number | string | undefined {
  return analysis.metrics.find((entry) => entry.id === id)?.value;
}

describe('analyzeHap — package block', () => {
  it('reads the bundle name, versions and a literal label from module.json', () => {
    const analysis = analyze([
      { name: 'module.json', data: text(MODULE_JSON) },
      { name: 'libs/libx.so', data: text('x') },
    ]);
    expect(analysis.package).toEqual({
      name: 'demo.hap',
      bundleName: 'com.example.demo',
      versionName: '1.2.3',
      versionCode: 42,
      appName: 'Demo',
    });
  });

  it('leaves the app name empty for a $string: label rather than resolving it', () => {
    const analysis = analyze([{
      name: 'module.json',
      data: text(JSON.stringify({
        app: { bundleName: 'com.example.demo', versionCode: 1, versionName: '1.0.0', label: '$string:app_name' },
      })),
    }]);
    expect(analysis.package.appName).toBe('');
    expect(analysis.package.bundleName).toBe('com.example.demo');
  });

  it('reports an empty app block when module.json is absent', () => {
    const analysis = analyze([{ name: 'libs/libx.so', data: text('x') }]);
    expect(analysis.package).toEqual({
      name: 'demo.hap',
      bundleName: '',
      versionName: '',
      versionCode: 0,
      appName: '',
    });
  });

  it('reports an empty app block when module.json is not valid JSON', () => {
    const analysis = analyze([{ name: 'module.json', data: text('{ not json') }]);
    expect(analysis.package.bundleName).toBe('');
  });
});

describe('analyzeHap — totals and categories', () => {
  it('counts every file and sums both sizes', () => {
    const analysis = analyze([
      { name: 'a.txt', data: text('hello') },
      { name: 'b.png', data: text('world!') },
    ]);
    expect(analysis.totals.files).toBe(2);
    expect(analysis.totals.size).toBe(11);
    expect(analysis.totals.compressedSize).toBeGreaterThan(0);
    expect(analysis.schemaVersion).toBe(1);
  });

  it('reports one entry per category present, sorted by name', () => {
    const analysis = analyze([
      { name: 'a.png', data: text('x') },
      { name: 'b.json', data: text('y') },
      { name: 'c.unknown', data: text('z') },
    ]);
    expect(analysis.categories.map((entry) => entry.name)).toEqual(['data', 'images', 'other']);
    expect(analysis.categories.map((entry) => entry.files)).toEqual([1, 1, 1]);
  });

  it('lists the ten largest files by size then path', () => {
    const entries: TestEntry[] = [];
    for (let index = 0; index < 12; index++) {
      entries.push({ name: `f${String(index).padStart(2, '0')}.bin`, data: new Uint8Array(index + 1) });
    }
    const analysis = analyze(entries);
    expect(analysis.largest).toHaveLength(10);
    expect(analysis.largest[0]).toEqual({ path: 'f11.bin', size: 12 });
    expect(analysis.largest.map((entry) => entry.path)).not.toContain('f00.bin');
  });
});

describe('analyzeHap — duplicates', () => {
  it('reports two identical files as one group with one file wasted', () => {
    const body = text('identical bytes');
    const analysis = analyze([
      { name: 'a/one.png', data: body },
      { name: 'b/two.png', data: body },
    ]);
    expect(analysis.duplicates).toHaveLength(1);
    const [group] = analysis.duplicates;
    expect(group!.copies).toBe(2);
    expect(group!.size).toBe(body.length);
    expect(group!.wastedBytes).toBe(body.length);
    expect(group!.paths).toEqual(['a/one.png', 'b/two.png']);
    expect(group!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not report two files of equal size and different content', () => {
    const analysis = analyze([
      { name: 'a.bin', data: text('aaaa') },
      { name: 'b.bin', data: text('bbbb') },
    ]);
    expect(analysis.duplicates).toEqual([]);
  });

  it('charges every copy but one', () => {
    const body = text('three copies');
    const analysis = analyze([
      { name: 'a.bin', data: body },
      { name: 'b.bin', data: body },
      { name: 'c.bin', data: body },
    ]);
    expect(analysis.duplicates[0]!.copies).toBe(3);
    expect(analysis.duplicates[0]!.wastedBytes).toBe(body.length * 2);
  });

  it('sorts groups by hash', () => {
    const first = text('first body');
    const second = text('second body');
    const analysis = analyze([
      { name: 'a1.bin', data: first }, { name: 'a2.bin', data: first },
      { name: 'b1.bin', data: second }, { name: 'b2.bin', data: second },
    ]);
    const hashes = analysis.duplicates.map((group) => group.sha256);
    expect(hashes).toEqual([...hashes].sort());
  });
});

describe('analyzeHap — oversized assets', () => {
  const over = new Uint8Array(1024 * 1024 + 1);
  const at = new Uint8Array(1024 * 1024);

  it('reports a file one byte over its category threshold', () => {
    const analysis = analyze([{ name: 'big.png', data: over }]);
    expect(analysis.oversized).toEqual([{
      path: 'big.png',
      category: 'images',
      size: 1024 * 1024 + 1,
      threshold: 1024 * 1024,
    }]);
  });

  it('does not report a file exactly at the threshold', () => {
    expect(analyze([{ name: 'at.png', data: at }]).oversized).toEqual([]);
  });

  it('sorts oversized files by size then path', () => {
    const analysis = analyze([
      { name: 'a.png', data: over },
      { name: 'b.png', data: new Uint8Array(1024 * 1024 + 5) },
    ]);
    expect(analysis.oversized.map((file) => file.path)).toEqual(['b.png', 'a.png']);
  });
});

describe('analyzeHap — metrics and evidence', () => {
  it('emits the spec metrics, sorted, with offline provenance', () => {
    const analysis = analyze([
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
      { name: 'a.png', data: new Uint8Array(1024 * 1024 + 1) },
    ]);
    expect(metricValue(analysis, 'hap.files.count')).toBe(2);
    expect(metricValue(analysis, 'hap.size.bytes')).toBe(1024 * 1024 + 1 + text('Dart VM version: 3.4.1 (stable)').length);
    expect(metricValue(analysis, 'hap.techstack.count')).toBe(2);
    expect(metricValue(analysis, 'hap.oversized.count')).toBe(1);
    expect(metricValue(analysis, 'hap.duplicates.groups')).toBe(0);
    expect(metricValue(analysis, 'hap.duplicates.wasted.bytes')).toBe(0);
    expect(metricValue(analysis, 'hap.techstack.Flutter.files')).toBe(1);
    expect(metricValue(analysis, 'hap.category.images.bytes')).toBe(1024 * 1024 + 1);
    expect(metricIds(analysis)).toEqual([...metricIds(analysis)].sort());
    for (const entry of analysis.metrics) {
      expect(entry.fidelity).toBe('exact');
      expect(entry.provenance).toMatchObject({ collector: 'offline', table: 'hap' });
    }
  });

  it('names each technology match in evidence and names up to five paths', () => {
    const analysis = analyze([
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
    ]);
    const item = analysis.evidence.find((entry) => entry.kind === 'tech_stack' && entry.signals.rule === 'Flutter');
    expect(item).toBeDefined();
    expect(item!.signals).toMatchObject({ rule: 'Flutter', type: 'Flutter', files: 1 });
    expect(item!.explain).toContain('Flutter');
    expect(item!.explain).toContain('libs/libflutter.so');
    expect(item!.drillDown).toEqual([]);
  });

  it('emits one duplicate_asset item per group and one oversized_asset item per file', () => {
    const body = text('same');
    const analysis = analyze([
      { name: 'a.png', data: body },
      { name: 'b.png', data: body },
      { name: 'c.png', data: new Uint8Array(1024 * 1024 + 1) },
    ]);
    const duplicates = analysis.evidence.filter((entry) => entry.kind === 'duplicate_asset');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.signals).toMatchObject({ size: 4, copies: 2 });
    const oversized = analysis.evidence.filter((entry) => entry.kind === 'oversized_asset');
    expect(oversized).toHaveLength(1);
    expect(oversized[0]!.signals).toMatchObject({ category: 'images', threshold: 1024 * 1024 });
  });

  it('emits no tech_stack evidence when nothing matches', () => {
    const analysis = analyze([{ name: 'a.txt', data: text('nothing') }]);
    expect(analysis.technologies).toEqual([]);
    expect(analysis.evidence.filter((entry) => entry.kind === 'tech_stack')).toEqual([]);
    expect(metricValue(analysis, 'hap.techstack.count')).toBe(0);
  });

  it('gives every evidence item a unique id', () => {
    const body = text('same');
    const analysis = analyze([
      { name: 'a.png', data: body }, { name: 'b.png', data: body },
      { name: 'big1.png', data: new Uint8Array(1024 * 1024 + 1) },
      { name: 'big2.png', data: new Uint8Array(1024 * 1024 + 2) },
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
      { name: 'libs/libskikobridge.so', data: text('x') },
    ]);
    const ids = analysis.evidence.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('analyzeHap — determinism', () => {
  it('produces identical JSON for the same bytes', () => {
    const entries: TestEntry[] = [
      { name: 'module.json', data: text(MODULE_JSON) },
      { name: 'a.png', data: text('same') },
      { name: 'b.png', data: text('same') },
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
    ];
    expect(JSON.stringify(analyze(entries))).toBe(JSON.stringify(analyze(entries)));
  });
});

describe('hapSection', () => {
  it('wraps the analysis as a measured static-hap section', () => {
    const analysis = analyze([{ name: 'a.txt', data: text('x') }]);
    const section = hapSection(analysis);
    expect(section.analyzerId).toBe('static-hap');
    expect(section.status).toBe('measured');
    expect(section.result.metrics).toBe(analysis.metrics);
    expect(section.result.evidence).toBe(analysis.evidence);
  });
});
