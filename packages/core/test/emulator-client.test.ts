import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmulatorClient, EmulatorCommandError, EmulatorNotFoundError } from '../src/device/emulator';

// Fixtures captured from HarmonyOS Emulator 6.1.1.200 on 2026-11-16:
//   list-details.json  <- Emulator.exe -list -details
//   image-list.json    <- Emulator.exe -imageList -downloaded true (first two rows)
//   list-empty.txt     <- Emulator.exe -list -details with no instances
//   start-failure.txt  <- Emulator.exe -start NoSuch (no trailing newline)
const FIXTURES = fileURLToPath(new URL('./fixtures/emulator/', import.meta.url));
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

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

describe('EmulatorClient.listDetailed', () => {
  it('parses the real -details JSON, reading isRunning as a string', async () => {
    const client = new StubEmulator({ stdout: fixture('list-details.json') });
    const [instance] = await client.listDetailed();
    expect(instance).toEqual({
      name: 'ProbePhone',
      running: false,
      apiVersion: '24',
      imageDir: 'system-image/HarmonyOS-6.1.1/phone_all_x86/',
      instancePath: 'E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed/ProbePhone',
      uuid: '1813e81f-a5ec-4cd2-b347-b5074c756dbd',
      osVersion: 'HarmonyOS 6.1.1(24)',
    });
    expect(client.calls[0].args).toEqual(['-list', '-details']);
  });

  it('passes -path when an instance root is configured', async () => {
    const client = new StubEmulator(
      { stdout: '[]' },
      { emulatorPath: BIN, instancePath: 'C:/Users/me/DevEco Studio/instances' },
    );
    await client.listDetailed();
    expect(client.calls[0].args).toEqual([
      '-list', '-details', '-path', 'C:/Users/me/DevEco Studio/instances',
    ]);
  });

  it('reads [Empty] as zero instances', async () => {
    const client = new StubEmulator({ stdout: fixture('list-empty.txt') });
    await expect(client.listDetailed()).resolves.toEqual([]);
  });

  it('sorts instances by name', async () => {
    const rows = JSON.stringify([
      { name: 'beta', isRunning: 'false', instancePath: '/b' },
      { name: 'alpha', isRunning: 'false', instancePath: '/a' },
    ]);
    const client = new StubEmulator({ stdout: rows });
    await expect(client.listDetailed()).resolves.toEqual([
      { name: 'alpha', running: false, instancePath: '/a' },
      { name: 'beta', running: false, instancePath: '/b' },
    ]);
  });
});

describe('EmulatorClient.imageList', () => {
  it('parses downloaded images without stringifying the flag', async () => {
    const client = new StubEmulator({ stdout: fixture('image-list.json') });
    const images = await client.imageList();
    expect(images[0]).toEqual({
      deviceType: 'foldable',
      osVersion: 'HarmonyOS 6.1.1(24)',
      downloaded: true,
      softwareVersion: '6.1.0.126',
      releaseType: 'Release',
    });
    expect(client.calls[0].args).toEqual(['-imageList', '-downloaded', 'true']);
  });
});

describe('EmulatorClient failure classification', () => {
  it('throws on "Unable to …" even though the exit code is 0', async () => {
    const client = new StubEmulator({ stdout: fixture('start-failure.txt'), code: 0 });
    const error = await client.listDetailed().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorCommandError);
    expect((error as EmulatorCommandError).output).toContain('Unable to start the emulator');
  });

  it('throws on an "Emulator: " line', async () => {
    const client = new StubEmulator({ stdout: "Emulator: Unknown option 'bogus'.\r\n" });
    await expect(client.listDetailed()).rejects.toThrow(/Unknown option/);
  });

  it('does not treat the warnings a real -start prints as failure', async () => {
    const warnings = [
      'Windows Hypervisor Platform accelerator is operational',
      "D:\\Application\\DevEco Studio\\tools\\emulator\\Emulator.exe: GLib: g_hash_table_remove_all: assertion 'hash_table != NULL' failed",
      '[dshow @ 000001E1FD218080] Could not enumerate video devices (or none found).',
    ].join('\r\n');
    const client = new StubEmulator({ stdout: warnings });
    // No JSON to parse, so the parse error is what proves the scan passed.
    await expect(client.listDetailed()).rejects.toThrow(/JSON/);
  });

  it('fails loudly when a future build returns a non-zero exit code', async () => {
    const client = new StubEmulator({ stdout: '[]', code: 1 });
    await expect(client.listDetailed()).rejects.toThrow(EmulatorCommandError);
  });
});

describe('EmulatorClient mutating commands', () => {
  const withPaths = (): StubEmulator => new StubEmulator(
    { stdout: '' },
    {
      emulatorPath: BIN,
      instancePath: 'C:/Users/me/DevEco Studio/instances',
      imageRoot: 'C:/Users/me/DevEco Studio/sdk',
    },
  );

  it('builds -start argv with the instance root as one element', async () => {
    const client = withPaths();
    await client.startInstance('ProbePhone');
    expect(client.calls[0]).toEqual({
      command: BIN,
      args: [
        '-start', 'ProbePhone',
        '-instancePath', 'C:/Users/me/DevEco Studio/instances',
        '-imageRoot', 'C:/Users/me/DevEco Studio/sdk',
      ],
    });
  });

  it('builds -stop argv without -imageRoot', async () => {
    const client = withPaths();
    await client.stopInstance('ProbePhone');
    expect(client.calls[0].args).toEqual([
      '-stop', 'ProbePhone', '-instancePath', 'C:/Users/me/DevEco Studio/instances',
    ]);
  });

  it('builds -create argv from every supplied field', async () => {
    const client = withPaths();
    await client.createInstance({
      name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)',
      screenProfile: 'Mate 60', memoryGb: 6, storageGb: 8,
    });
    expect(client.calls[0].args).toEqual([
      '-create', 'SpecProbe',
      '-deviceType', 'phone',
      '-osVersion', 'HarmonyOS 6.1.1(24)',
      '-screenProfile', 'Mate 60',
      '-memory', '6',
      '-storage', '8',
      '-instancePath', 'C:/Users/me/DevEco Studio/instances',
      '-imageRoot', 'C:/Users/me/DevEco Studio/sdk',
    ]);
  });

  it('omits optional -create flags that were not supplied', async () => {
    const client = new StubEmulator({ stdout: '' }, { emulatorPath: BIN });
    await client.createInstance({ name: 'A', deviceType: 'phone', osVersion: 'V' });
    expect(client.calls[0].args).toEqual([
      '-create', 'A', '-deviceType', 'phone', '-osVersion', 'V',
    ]);
  });

  it('treats a silent exit-0 no-op as success at this layer', async () => {
    // The binary prints nothing and exits 0 when it rejects a create; the
    // lifecycle layer is what verifies the instance exists afterwards.
    const client = new StubEmulator({ stdout: '' });
    await expect(client.createInstance({ name: 'A', deviceType: 'phone', osVersion: 'V' }))
      .resolves.toBeUndefined();
  });
});
