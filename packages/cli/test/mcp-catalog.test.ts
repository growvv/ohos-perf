import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildCatalog, toolName } from '../src/mcp-catalog';

function sample(): Command {
  const p = new Command('ohos-perf').name('ohos-perf');
  p.command('analyze')
    .description('analyze a captured scene directory')
    .argument('<scene-dir>', 'directory containing trace.db')
    .option('--app <packageName>', 'app package name')
    .option('--json', 'print the analysis result as JSON')
    .action(() => {});
  const emulator = p.command('emulator').description('manage emulator instances');
  emulator.command('list').description('list instances').option('--json', 'JSON').action(() => {});
  return p;
}

describe('buildCatalog', () => {
  it('makes one tool per leaf command, never for a group', () => {
    const names = buildCatalog(sample()).map((t) => t.name);
    expect(names).toEqual(['ohos-perf_analyze', 'ohos-perf_emulator_list']);
  });

  it('flattens the path so the name is an identifier', () => {
    expect(toolName(['emulator', 'list'])).toBe('ohos-perf_emulator_list');
  });

  it('turns a required argument into a required string property', () => {
    const tool = buildCatalog(sample())[0]!;
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties['scene-dir']).toMatchObject({ type: 'string' });
    expect(schema.properties['scene-dir']!.description).toContain('trace.db');
    expect(schema.required).toEqual(['scene-dir']);
  });

  it('turns an option into an optional property, and a boolean into a flag', () => {
    const tool = buildCatalog(sample())[0]!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['app']).toMatchObject({ type: 'string', description: 'app package name' });
    expect((tool.inputSchema as { required: string[] }).required).not.toContain('app');
  });

  it('types a valueless option as a boolean', () => {
    // A flag takes no value, so its argument is `true` or absent — never a
    // string, which is what a caller would have to pass for a valued option.
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('collect').description('capture').option('--procfs', 'sample /proc').action(() => {});
    const props = (buildCatalog(p)[0]!.inputSchema as {
      properties: Record<string, { type: string }>;
    }).properties;
    expect(props['procfs']).toMatchObject({ type: 'boolean' });
    expect(buildCatalog(p)[0]!.argv({ procfs: true })).toEqual(['collect', '--procfs']);
  });

  it('leaves --json and --machine-json out: a tool call always speaks JSON', () => {
    const tool = buildCatalog(sample())[0]!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['json']).toBeUndefined();
    expect(props['machineJson']).toBeUndefined();
  });

  it('turns arguments into argv, options first so a negative positional is not a flag', () => {
    const tool = buildCatalog(sample())[0]!;
    expect(tool.argv({ 'scene-dir': '/scene', app: 'com.demo' }))
      .toEqual(['analyze', '--app', 'com.demo', '/scene']);
  });

  it('omits an option that was not supplied, rather than passing undefined', () => {
    const tool = buildCatalog(sample())[0]!;
    expect(tool.argv({ 'scene-dir': '/scene' })).toEqual(['analyze', '/scene']);
  });

  it('marks a scene reader read-only and a device driver not', () => {
    const [analyze] = buildCatalog(sample());
    expect(analyze!.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    });
  });

  it('sorts by name so a client prompt cache is stable', () => {
    const p = new Command('ohos-perf').name('ohos-perf');
    for (const name of ['zeta', 'alpha']) p.command(name).description(name).action(() => {});
    expect(buildCatalog(p).map((t) => t.name)).toEqual(['ohos-perf_alpha', 'ohos-perf_zeta']);
  });
});
