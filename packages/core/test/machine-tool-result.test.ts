import { describe, it, expect } from 'vitest';
import {
  TOOL_RESULT_FILE,
  TOOL_RESULT_SCHEMA_VERSION,
  buildToolResult,
  parseToolResult,
  renderToolResultFile,
  renderToolResultLine,
} from '../src/machine/tool-result';

/*
 * P33 — the machine-readable tool-result envelope.
 *
 * HapRay's `machine_output.py` writes a `hapray-tool-result.json` with a
 * `schema_version` and never reads it back, so a consumer has no way to notice
 * that the contract changed under it. This module is the contract as data: a
 * builder that stamps it, a parser that refuses anything it does not
 * recognise, and two renderers — one line for stdout, two-space-indented for a
 * file.
 */

describe('buildToolResult', () => {
  it('stamps the schema, the tool identity and the version', () => {
    const result = buildToolResult({
      toolVersion: '0.28.0', command: 'analyze', exitCode: 0, payload: { metrics: [] },
    });
    expect(result).toEqual({
      schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
      toolId: 'ohos-perf',
      toolVersion: '0.28.0',
      command: 'analyze',
      success: true,
      exitCode: 0,
      outputs: { payload: { metrics: [] } },
    });
  });

  it('calls a non-zero exit unsuccessful', () => {
    expect(buildToolResult({ toolVersion: '1', command: 'gate', exitCode: 2 }).success).toBe(false);
    expect(buildToolResult({ toolVersion: '1', command: 'gate', exitCode: 1 }).success).toBe(false);
  });

  it('carries an error only when one was given', () => {
    const ok = buildToolResult({ toolVersion: '1', command: 'analyze', exitCode: 0 });
    expect(ok).not.toHaveProperty('error');
    expect(ok).not.toHaveProperty('outputs.payload');
    const bad = buildToolResult({
      toolVersion: '1', command: 'analyze', exitCode: 1,
      error: { code: 'SCENE_NO_INPUT', message: 'nothing to ingest' },
    });
    expect(bad.error).toEqual({ code: 'SCENE_NO_INPUT', message: 'nothing to ingest' });
    expect(bad.success).toBe(false);
  });

  it('drops an undefined code rather than writing a null', () => {
    const result = buildToolResult({
      toolVersion: '1', command: 'analyze', exitCode: 1, error: { message: 'boom' },
    });
    expect(JSON.parse(JSON.stringify(result)).error).toEqual({ message: 'boom' });
  });

  it('rejects an empty command and a non-integer exit code', () => {
    expect(() => buildToolResult({ toolVersion: '1', command: '', exitCode: 0 }))
      .toThrow(/command/);
    expect(() => buildToolResult({ toolVersion: '1', command: 'analyze', exitCode: 1.5 }))
      .toThrow(/exitCode/);
  });
});

describe('parseToolResult', () => {
  const good = {
    schemaVersion: '1.0', toolId: 'ohos-perf', toolVersion: '0.28.0',
    command: 'analyze', success: true, exitCode: 0, outputs: { payload: { a: 1 } },
  };

  it('round-trips a document the builder produced', () => {
    expect(parseToolResult(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('refuses an unknown schema version, naming the value', () => {
    expect(() => parseToolResult({ ...good, schemaVersion: '2.0' }))
      .toThrow(/2\.0/);
  });

  it('refuses another tool\'s envelope', () => {
    expect(() => parseToolResult({ ...good, toolId: 'hapray' })).toThrow(/hapray/);
  });

  it('refuses a success flag that contradicts the exit code', () => {
    // A reader must never have to decide which of the two fields to believe.
    expect(() => parseToolResult({ ...good, exitCode: 1 })).toThrow(/success/);
  });

  it('refuses a missing required field, naming it', () => {
    const { command: _drop, ...rest } = good;
    expect(() => parseToolResult(rest)).toThrow(/command/);
  });

  it('refuses a non-object', () => {
    expect(() => parseToolResult([])).toThrow(/object/);
  });

  it('returns a fresh object rather than the input', () => {
    const input = JSON.parse(JSON.stringify(good));
    const parsed = parseToolResult(input);
    expect(parsed).not.toBe(input);
    expect(parsed.outputs).not.toBe(input.outputs);
  });
});

describe('rendering', () => {
  const result = buildToolResult({
    toolVersion: '0.28.0', command: 'analyze', exitCode: 0, payload: { metrics: [1, 2] },
  });

  it('renders one line with no interior whitespace', () => {
    const line = renderToolResultLine(result);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(line).not.toContain(': ');
    expect(JSON.parse(line)).toEqual(result);
  });

  it('renders a file with two-space indent and a trailing newline', () => {
    const text = renderToolResultFile(result);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": "1.0"');
    expect(JSON.parse(text)).toEqual(result);
  });

  it('names the file this package writes', () => {
    expect(TOOL_RESULT_FILE).toBe('ohos-perf-tool-result.json');
  });
});
