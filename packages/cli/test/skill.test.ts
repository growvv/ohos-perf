import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const skill = readFileSync(join(root, 'skill/ohos-perf/SKILL.md'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const COMMANDS = new Set(['doctor', 'caps', 'collect', 'analyze', 'query', 'tools']);

describe('agent skill adapter', () => {
  it('has frontmatter with a name and a description', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    const frontmatter = skill.slice(4, skill.indexOf('\n---', 4));
    expect(frontmatter).toMatch(/^name: ohos-perf$/m);
    expect(frontmatter).toMatch(/^description: .{40,}$/m);
  });

  it('only invokes commands the CLI actually has', () => {
    const used = [...skill.matchAll(/ohos-perf ([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(3);
    for (const command of used) expect(COMMANDS).toContain(command);
  });

  it('describes the evidence-to-query workflow it relies on', () => {
    for (const needle of ['drillDown', 'ohos-perf tools --json', 'ohos-perf query',
      '--limit', '--json']) {
      expect(skill).toContain(needle);
    }
  });

  it('is linked from the README', () => {
    expect(readme).toContain('ohos-perf query');
    expect(readme).toContain('skill/ohos-perf');
  });
});
