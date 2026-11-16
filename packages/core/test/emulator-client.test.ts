import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { EmulatorClient, EmulatorNotFoundError } from '../src/device/emulator';

const BIN = 'C:/fake/Emulator.exe';

class StubEmulator extends EmulatorClient {
  readonly calls: { command: string; args: string[] }[] = [];
  constructor(
    private readonly result: { stdout?: string; stderr?: string; code?: number },
    opts: ConstructorParameters<typeof EmulatorClient>[0] = { emulatorPath: BIN },
  ) {
    super(opts);
  }
  // The search order has its own tests; every other test wants a fixed
  // command so the argv assertions stay readable.
  override async resolvePath(): Promise<string> {
    return BIN;
  }
  protected override async spawnProcess(command: string, args: string[]) {
    this.calls.push({ command, args });
    return { stdout: this.result.stdout ?? '', stderr: this.result.stderr ?? '', code: this.result.code ?? 0 };
  }
}

describe('EmulatorClient.resolvePath', () => {
  // A real file, so the existence check is exercised rather than mocked.
  const REAL = process.execPath;

  it('prefers the explicit path', async () => {
    const client = new EmulatorClient({ emulatorPath: REAL, env: { PATH: '' }, commonPaths: [] });
    await expect(client.resolvePath()).resolves.toBe(REAL);
  });

  it('reads OHOS_PERF_EMULATOR when no explicit path is given', async () => {
    const client = new EmulatorClient({ env: { OHOS_PERF_EMULATOR: REAL, PATH: '' }, commonPaths: [] });
    await expect(client.resolvePath()).resolves.toBe(REAL);
  });

  it('lists every candidate in search order when nothing is found', async () => {
    // The PATH entry must not contain the host's delimiter by accident: a
    // drive letter on Windows uses ':' but ':' splits PATH on POSIX.
    const pathDir = process.platform === 'win32' ? 'C:/nope/bin' : '/nope/bin';
    const client = new EmulatorClient({
      emulatorPath: 'C:/nope/a.exe',
      env: { OHOS_PERF_EMULATOR: 'C:/nope/b.exe', PATH: pathDir },
      commonPaths: ['C:/nope/c.exe'],
    });
    const error = await client.resolvePath().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorNotFoundError);
    const bin = process.platform === 'win32' ? 'Emulator.exe' : 'Emulator';
    expect((error as EmulatorNotFoundError).searchedPaths).toEqual([
      'C:/nope/a.exe', 'C:/nope/b.exe', 'C:/nope/c.exe', join(pathDir, bin),
    ]);
  });
});

describe('EmulatorClient.version', () => {
  it('parses the banner the real binary prints', async () => {
    const client = new StubEmulator({ stdout: 'HarmonyOS Emulator :6.1.1.200\r\n' });
    await expect(client.version()).resolves.toBe('6.1.1.200');
    expect(client.calls[0]).toEqual({ command: BIN, args: ['-version'] });
  });

  it('fails loudly on an unrecognised banner instead of returning garbage', async () => {
    const client = new StubEmulator({ stdout: 'something else entirely' });
    await expect(client.version()).rejects.toThrow(/unrecognised -version output/);
  });
});
