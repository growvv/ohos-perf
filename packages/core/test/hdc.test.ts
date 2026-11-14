import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Hdc, normalizeLocalPath } from '../src/transport/hdc';
import { HdcNotFoundError } from '../src/errors';

describe('Hdc', () => {
  it('builds argv for shell without shell-quoting the device path', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const argv = hdc.buildArgv('shell', { target: '127.0.0.1:10178', cmd: 'ls /data/local/tmp' });
    expect(argv).toEqual(['-t', '127.0.0.1:10178', 'shell', 'ls /data/local/tmp']);
  });

  it('sets MSYS_NO_PATHCONV in spawned env', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const env = hdc.buildEnv({ PATH: '/usr/bin' });
    expect(env.MSYS_NO_PATHCONV).toBe('1');
  });

  it('builds argv for recv with device path unmodified', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const argv = hdc.buildArgv('recv', {
      target: 't1', devicePath: '/data/local/tmp/a.htrace', localPath: 'out/a.htrace',
    });
    expect(argv).toEqual(['-t', 't1', 'file', 'recv', '/data/local/tmp/a.htrace', 'out/a.htrace']);
  });

  it('builds argv for send with local path first', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const argv = hdc.buildArgv('send', {
      target: 't1', localPath: 'out/a.htrace', devicePath: '/data/local/tmp/a.htrace',
    });
    expect(argv).toEqual(['-t', 't1', 'file', 'send', 'out/a.htrace', '/data/local/tmp/a.htrace']);
  });

  it('builds argv for tconn, fport and verbose target listing', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    expect(hdc.buildArgv('tconn', { target: '127.0.0.1:10178' }))
      .toEqual(['tconn', '127.0.0.1:10178']);
    expect(hdc.buildArgv('fport', { target: 't1', local: 8080, remote: 8081 }))
      .toEqual(['-t', 't1', 'fport', 'tcp:8080', 'tcp:8081']);
    expect(hdc.buildArgv('listTargets', {})).toEqual(['list', 'targets', '-v']);
  });

  it('does not mutate the base env in buildEnv', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const base = { PATH: '/usr/bin' };
    hdc.buildEnv(base);
    expect(base).toEqual({ PATH: '/usr/bin' });
  });
});

describe('Hdc.listTargets', () => {
  class StubHdc extends Hdc {
    readonly calls: string[][] = [];
    constructor(private readonly output: string) {
      super({ hdcPath: 'C:/fake/hdc.exe' });
    }
    protected override async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
      this.calls.push(args);
      return { stdout: this.output, stderr: '', code: 0 };
    }
  }

  it('parses the real -v format and only marks Connected as connected', async () => {
    const hdc = new StubHdc(
      '127.0.0.1:10178\t\tTCP\tOffline\tlocalhost\thdc\r\n'
      + 'REDACTED-DEVICE-SERIAL\t\tUSB\tConnected\tlocalhost\thdc\r\n'
      + 'unauth-device\t\tUSB\tUnauthorized\tlocalhost\thdc\r\n',
    );
    const targets = await hdc.listTargets();
    expect(hdc.calls[0]).toEqual(['list', 'targets', '-v']);
    expect(targets).toEqual([
      { id: '127.0.0.1:10178', connected: false, raw: '127.0.0.1:10178\t\tTCP\tOffline\tlocalhost\thdc' },
      { id: 'REDACTED-DEVICE-SERIAL', connected: true, raw: 'REDACTED-DEVICE-SERIAL\t\tUSB\tConnected\tlocalhost\thdc' },
      { id: 'unauth-device', connected: false, raw: 'unauth-device\t\tUSB\tUnauthorized\tlocalhost\thdc' },
    ]);
  });

  it('returns an empty array when hdc reports no matching target', async () => {
    const hdc = new StubHdc('[Fail]Not match target founded, check connect-key please\r\n');
    await expect(hdc.listTargets()).resolves.toEqual([]);
  });

  it('returns an empty array for [Empty] output', async () => {
    const hdc = new StubHdc('[Empty]\r\n');
    await expect(hdc.listTargets()).resolves.toEqual([]);
  });

  it('exposes the raw listing so DeviceNotFoundError can quote it', async () => {
    const raw = '127.0.0.1:10178\t\tTCP\tOffline\tlocalhost\thdc\r\n';
    const hdc = new StubHdc(raw);
    await expect(hdc.listTargetsRaw()).resolves.toEqual({
      targets: [
        { id: '127.0.0.1:10178', connected: false, raw: '127.0.0.1:10178\t\tTCP\tOffline\tlocalhost\thdc' },
      ],
      raw,
    });
  });

  it('throws on a server error instead of reporting zero devices', async () => {
    const hdc = new StubHdc('[Fail]Connect server failed\r\n');
    await expect(hdc.listTargets()).rejects.toThrow(/Connect server failed/);
    await expect(hdc.listTargetsRaw()).rejects.toThrow(/list targets failed/);
  });

  it('throws when hdc exits non-zero even with a clean listing', async () => {
    class ExitStub extends StubHdc {
      protected override async run(): Promise<{ stdout: string; stderr: string; code: number }> {
        return { stdout: 'REDACTED-DEVICE-SERIAL\t\tUSB\tConnected\tlocalhost\thdc\r\n', stderr: '', code: 3 };
      }
    }
    await expect(new ExitStub('').listTargets()).rejects.toThrow(/exit code 3/);
  });

  it('does not synthesise a target from a non-tabular line', async () => {
    const hdc = new StubHdc(
      'hdc: cannot connect to server\r\n'
      + 'REDACTED-DEVICE-SERIAL\t\tUSB\tConnected\tlocalhost\thdc\r\n',
    );
    const targets = await hdc.listTargets();
    expect(targets.map((t) => t.id)).toEqual(['REDACTED-DEVICE-SERIAL']);
  });
});

describe('Hdc command failure detection', () => {
  class StubHdc extends Hdc {
    readonly calls: string[][] = [];
    constructor(
      private readonly stdout: string,
      private readonly stderr = '',
      private readonly code = 0,
    ) {
      super({ hdcPath: 'C:/fake/hdc.exe' });
    }
    protected override async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
      this.calls.push(args);
      return { stdout: this.stdout, stderr: this.stderr, code: this.code };
    }
  }

  const RECV_OK = 'FileTransfer finish, Size:6, File count = 1, time:15ms rate:0.40kB/s\r\n';

  it('throws on recv failure even though hdc exits 0', async () => {
    const hdc = new StubHdc(
      '[Fail]Error opening file: no such file or directory, path:/data/local/tmp/x\r\n',
    );
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/recv failed/);
    expect(hdc.calls[0]).toEqual(['-t', 't1', 'file', 'recv', '/data/local/tmp/x', 'out/x']);
  });

  it('resolves recv when hdc reports a finished transfer', async () => {
    const hdc = new StubHdc(RECV_OK);
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).resolves.toBeUndefined();
  });

  it('rejects recv when output lacks the positive completion marker', async () => {
    // Guards the false-negative hole: absence of [Fail] is not success.
    const empty = new StubHdc('');
    await expect(empty.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/no success marker/);

    const garbage = new StubHdc('something unexpected happened\r\n');
    await expect(garbage.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/no success marker/);
  });

  it('rejects a non-zero exit even with a clean success marker', async () => {
    const hdc = new StubHdc(RECV_OK, '', 2);
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/exit code 2/);
    await expect(hdc.send('t1', 'out/x', '/data/local/tmp/x')).rejects.toThrow(/exit code 2/);
    await expect(hdc.fport('t1', 1, 2)).rejects.toThrow(/exit code 2/);
    await expect(hdc.shell('t1', 'echo hi')).rejects.toThrow(/exit code 2/);
  });

  it('tolerates a decorated [Fail] prefix on stdout', async () => {
    const hdc = new StubHdc('hdc: [Fail]Error opening file: no such file\r\n');
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/recv failed/);
  });

  it('ignores a benign stderr line when stdout carries the success marker', async () => {
    const hdc = new StubHdc(RECV_OK, '[Fail]noise from a helper\r\n');
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).resolves.toBeUndefined();
  });

  it('fails on stderr [Fail] when stdout has no success marker', async () => {
    const hdc = new StubHdc('', '[Fail]transfer aborted\r\n');
    await expect(hdc.recv('t1', '/data/local/tmp/x', 'out/x')).rejects.toThrow(/transfer aborted/);
  });

  it('keeps shell success for empty output with exit 0', async () => {
    const hdc = new StubHdc('');
    await expect(hdc.shell('t1', 'true')).resolves.toEqual({ stdout: '', stderr: '', code: 0 });
  });

  it('throws on send failure even though hdc exits 0', async () => {
    const hdc = new StubHdc('[Fail]Error opening file: no such file or directory, path:out/x\r\n');
    await expect(hdc.send('t1', 'out/x', '/data/local/tmp/x')).rejects.toThrow(/send failed/);
  });

  it('resolves send when hdc reports a finished transfer', async () => {
    const hdc = new StubHdc('FileTransfer finish, Size:3, File count = 1, time:19ms rate:0.16kB/s\r\n');
    await expect(hdc.send('t1', 'out/x', '/data/local/tmp/x')).resolves.toBeUndefined();
  });

  it('resolves fport only on Forwardport result:OK', async () => {
    const ok = new StubHdc('Forwardport result:OK\r\n');
    await expect(ok.fport('t1', 19999, 19999)).resolves.toBeUndefined();

    const noMarker = new StubHdc('some other output\r\n');
    await expect(noMarker.fport('t1', 19999, 19999)).rejects.toThrow(/no success marker/);

    const empty = new StubHdc('');
    await expect(empty.fport('t1', 19999, 19999)).rejects.toThrow(/no success marker/);
  });

  it('throws on fport failure and keeps tconn best-effort', async () => {
    const failing = new StubHdc('[Fail]Forward parament failed\r\n');
    await expect(failing.fport('t1', 19999, 19999)).rejects.toThrow(/fport failed/);

    // USB targets report this even though they are already usable; the
    // authoritative liveness check is listTargets().connected.
    const usb = new StubHdc('[Fail]CreateConnect failed\r\n');
    await expect(usb.tconn('REDACTED-DEVICE-SERIAL')).resolves.toBeUndefined();
  });

  it('does not swallow a missing hdc binary in tconn', async () => {
    class MissingHdc extends Hdc {
      constructor() {
        super({ hdcPath: 'C:/fake/hdc.exe' });
      }
      protected override async run(): Promise<never> {
        throw new HdcNotFoundError(['C:/fake/hdc.exe']);
      }
    }
    await expect(new MissingHdc().tconn('t1')).rejects.toBeInstanceOf(HdcNotFoundError);
  });
});

describe('normalizeLocalPath', () => {
  it('turns drive-letter forward-slash paths into backslash paths on win32', () => {
    expect(normalizeLocalPath('E:/a/b.htrace', 'win32')).toBe('E:\\a\\b.htrace');
  });

  it('leaves relative paths and non-Windows paths untouched', () => {
    expect(normalizeLocalPath('out/a.htrace', 'win32')).toBe('out/a.htrace');
    expect(normalizeLocalPath('/data/local/tmp/a.htrace', 'linux')).toBe('/data/local/tmp/a.htrace');
    expect(normalizeLocalPath('E:/a/b.htrace', 'linux')).toBe('E:/a/b.htrace');
  });
});

describe('Hdc.resolvePath', () => {
  it('returns an explicit hdcPath when the file exists', async () => {
    const hdc = new Hdc({ hdcPath: process.execPath, commonPaths: [], env: {} });
    await expect(hdc.resolvePath()).resolves.toBe(process.execPath);
  });

  it('throws HdcNotFoundError listing every candidate in order', async () => {
    const hdc = new Hdc({
      hdcPath: 'C:/nope/hdc.exe',
      env: { OHOS_PERF_HDC: 'C:/also-nope/hdc.exe', PATH: 'C:/path-nope' },
      commonPaths: [],
    });
    const err = await hdc.resolvePath().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HdcNotFoundError);
    const bin = process.platform === 'win32' ? 'hdc.exe' : 'hdc';
    expect((err as HdcNotFoundError).searchedPaths).toEqual([
      'C:/nope/hdc.exe',
      'C:/also-nope/hdc.exe',
      join('C:/path-nope', bin),
    ]);
  });
});
