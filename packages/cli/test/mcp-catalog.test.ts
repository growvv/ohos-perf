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

  it('leaves out the server itself: a tool that waits on stdin cannot be a tool', () => {
    // `mcp` is the transport an agent is already talking over. Exposing it
    // would offer a call that spawns a second server, reads a stdin nobody
    // writes, and hangs until the client gives up.
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('tools').description('list queries').action(() => {});
    p.command('mcp').description('serve every command over stdio').action(() => {});
    expect(buildCatalog(p).map((t) => t.name)).toEqual(['ohos-perf_tools']);
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

  it('types a variadic argument as an array, so a caller can pass more than one', () => {
    // `symbols recover <library> [addresses...]` takes a list. Typed as a
    // plain string, a client that sends the array the argv builder already
    // understands is refused by its own schema validator, and one that sends
    // a space-joined string gets a single malformed address.
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('recover').description('name addresses').argument('<library>')
      .argument('[addresses...]', 'references').action(() => {});
    const tool = buildCatalog(p)[0]!;
    const props = tool.inputSchema.properties as Record<string, { type: string; items?: { type: string } }>;
    expect(props.addresses).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: 'references',
    });
    expect(tool.inputSchema.required).toEqual(['library']);
    expect(tool.argv({ library: 'lib.so', addresses: ['a+0x1', 'b+0x2'] }))
      .toEqual(['recover', 'lib.so', 'a+0x1', 'b+0x2']);
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

  it('marks a required option as required, so a call is not doomed before it starts', () => {
    // `collect` cannot run without `--duration` and `--out`. If the schema
    // says nothing is required, a client builds the call without them and
    // gets a commander usage error — a failure the schema could have
    // prevented, on the agent's first attempt.
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('collect').description('capture')
      .requiredOption('--duration <seconds>', 'capture duration')
      .requiredOption('--out <dir>', 'scene output directory')
      .option('--app <name>', 'package')
      .action(() => {});
    const tool = buildCatalog(p)[0]!;
    expect(tool.inputSchema.required).toEqual(['duration', 'out']);
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

  it('repeats an option that was given a list, instead of joining it', () => {
    // `trend --label a --label b` is one label per report. `String(['a','b'])`
    // is `"a,b"` — a single label that matches no report — so an array has to
    // become one flag per item.
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('trend').description('aggregate').argument('<reports...>')
      .option('--out <dir>', 'output').option('--label <label>', 'a run label').action(() => {});
    const tool = buildCatalog(p)[0]!;
    expect(tool.argv({ reports: ['a.json', 'b.json'], out: 'o', label: ['first', 'second'] }))
      .toEqual(['trend', '--out', 'o', '--label', 'first', '--label', 'second', 'a.json', 'b.json']);
  });

  it('declares a repeatable option as an array, because commander cannot say so', () => {
    // `trend` gives `--label` the `collectLabels` parser; the schema has to
    // say "list" or a client validates its own array away.
    const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];
    const p = new Command('ohos-perf').name('ohos-perf');
    p.command('trend').description('aggregate').argument('<reports...>')
      .option('--out <dir>', 'output').option('--label <label>', 'a run label', collect).action(() => {});
    const tool = buildCatalog(p)[0]!;
    const props = tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props.label?.type).toBe('array');
    expect(props.out?.type).toBe('string');
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
