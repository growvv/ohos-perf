import { describe, it, expect } from 'vitest';
import {
  CATEGORY_EXTENSIONS, CATEGORY_MAX_BYTES, buildInventory, categorize,
} from '../src/hap/inventory';
import { openZip } from '../src/hap/zip';
import { makeZip } from './helpers/hap-zip-writer';

describe('categorize', () => {
  it('maps the first extension of every category to that category', () => {
    for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
      for (const extension of extensions) {
        expect(categorize(extension), extension).toBe(category);
      }
    }
  });

  it('maps an unknown extension to other', () => {
    expect(categorize('xyz')).toBe('other');
    expect(categorize('')).toBe('other');
  });

  it('holds HapRay thresholds verbatim', () => {
    expect(CATEGORY_MAX_BYTES).toEqual({
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
    });
  });
});

describe('buildInventory', () => {
  it('sorts by path and lowercases the extension', () => {
    const archive = openZip(makeZip([
      { name: 'z/APP.PNG', data: new Uint8Array([1]) },
      { name: 'a.txt', data: new Uint8Array([2, 3]) },
    ]));
    const inventory = buildInventory(archive);
    expect(inventory.map((file) => file.path)).toEqual(['a.txt', 'z/APP.PNG']);
    expect(inventory[0]).toMatchObject({ extension: 'txt', category: 'other' });
    expect(inventory[1]).toMatchObject({ extension: 'png', category: 'images' });
  });

  it('reports an empty extension for a name with no dot', () => {
    const archive = openZip(makeZip([{ name: 'LICENSE', data: new Uint8Array([1]) }]));
    expect(buildInventory(archive)[0]).toMatchObject({ extension: '', category: 'other' });
  });

  it('does not treat a leading dot as an extension', () => {
    const archive = openZip(makeZip([{ name: '.hidden', data: new Uint8Array([1]) }]));
    expect(buildInventory(archive)[0]).toMatchObject({ extension: '', category: 'other' });
  });

  it('reports sizes, the CRC as hex and the compressed size', () => {
    const archive = openZip(makeZip([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }]));
    const [file] = buildInventory(archive);
    expect(file).toMatchObject({ size: 3 });
    expect(file!.crc32).toMatch(/^[0-9a-f]{8}$/);
    expect(file!.compressedSize).toBeGreaterThan(0);
  });
});
