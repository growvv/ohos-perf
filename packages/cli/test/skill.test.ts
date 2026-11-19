import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

// A Windows checkout with core.autocrlf=true (this repo commits no
// .gitattributes) turns these files into CRLF; the assertions below are about
// content, so line endings are normalised before they run.
function readNormalized(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const skill = readNormalized(join(root, 'skill/ohos-perf/SKILL.md'));
const readme = readNormalized(join(root, 'README.md'));

const COMMANDS = new Set([
  'doctor', 'caps', 'collect', 'analyze', 'query', 'tools', 'compare', 'report',
  'emulator', 'gesture', 'hap', 'run', 'ui-compare', 'root-cause', 'gate',
  'mcp', 'workload',
]);

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

  it('documents every collector flag and the baseline comparison', () => {
    for (const needle of ['--procfs', '--hiprofiler', '--hiperf', '--hidumper', '--uitest',
      'ohos-perf compare', 'incomparable', 'ui.get']) {
      expect(skill).toContain(needle);
    }
  });

  it('tells an agent how to reach the same commands as MCP tools', () => {
    // An agent that can attach an MCP server should not shell out: the tool
    // call returns the envelope as structured content, with no text to parse.
    for (const needle of ['ohos-perf mcp', 'tools/list', 'tools/call', 'structuredContent']) {
      expect(skill).toContain(needle);
    }
  });

  it('tells an agent how to boot an emulator when no device is attached', () => {
    // The step exists so an agent with no phone does not stop at `doctor`;
    // each command it names must be real, which the command-set test enforces.
    for (const needle of [
      'ohos-perf emulator list --json',
      'ohos-perf emulator start',
      'ohos-perf emulator stop',
      '--target',
      'already downloaded',
    ]) {
      expect(skill).toContain(needle);
    }
  });

  it('names only the commands that accept --target, because the rest reject it', () => {
    // `analyze`, `query`, `compare` and `tools` read a scene, not a device:
    // `ohos-perf analyze ./scene --target X` exits 1 with `unknown option`.
    // An agent following "pass it to every later command" would break itself.
    expect(skill).not.toMatch(/every later command with\s+`--target/);
    expect(skill).toMatch(/collect`, `caps`, `doctor` and `gesture`/);
  });

  it('documents driving the UI before a capture', () => {
    // Gestures are a separate command; the skill has to say so, otherwise an
    // agent expects `collect` to accept a gesture script.
    for (const needle of [
      'ohos-perf gesture click',
      'ohos-perf gesture swipe',
      'ohos-perf gesture key',
      'ohos-perf gesture input',
      'ohos-perf gesture text',
      'accepted',
      'navigate first, then capture',
    ]) {
      expect(skill).toContain(needle);
    }
  });

  it('is linked from the README', () => {
    expect(readme).toContain('ohos-perf query');
    expect(readme).toContain('skill/ohos-perf');
  });

  it('documents the scenario runner and what an agent must not claim about it', () => {
    // A marker is an annotation, not a trace event, and a failed action keeps
    // its scene — an agent that gets either wrong reports a trace it never had.
    for (const needle of [
      'ohos-perf run scenario.json --out',
      'capture.startedAtMs',
      'not a trace event',
      'keeps its scene',
      '--keep-going',
      '--only',
    ]) {
      expect(skill).toContain(needle);
    }
  });
});
