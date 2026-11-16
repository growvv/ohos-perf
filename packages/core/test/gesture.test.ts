import { describe, it, expect } from 'vitest';
import { GestureDriver } from '../src/device/gesture';
import type { Gesture } from '../src/device/gesture';
import { OhosPerfError } from '../src/errors';

function fakeHdc(reply: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: Array<{ target: string; cmd: string }> = [];
  return {
    calls,
    async shell(target: string, cmd: string) {
      calls.push({ target, cmd });
      return {
        stdout: reply.stdout ?? 'No Error\r\n',
        stderr: reply.stderr ?? '',
        code: reply.code ?? 0,
      };
    },
  };
}

const driver = new GestureDriver();

describe('GestureDriver command building', () => {
  it('clicks at the requested coordinates and echoes the gesture', async () => {
    const hdc = fakeHdc();
    const gesture: Gesture = { action: 'click', x: 500, y: 800 };
    const result = await driver.perform(hdc, 't1', gesture);
    expect(hdc.calls).toEqual([{ target: 't1', cmd: 'uitest uiInput click 500 800' }]);
    expect(result).toEqual({ gesture, output: 'No Error' });
  });

  it('appends a velocity only when one is given', async () => {
    const withVelocity = fakeHdc();
    await driver.perform(withVelocity, 't1',
      { action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200, velocity: 600 });
    const plain = fakeHdc();
    await driver.perform(plain, 't1',
      { action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200 });
    expect(withVelocity.calls[0].cmd).toBe('uitest uiInput swipe 500 800 500 200 600');
    expect(plain.calls[0].cmd).toBe('uitest uiInput swipe 500 800 500 200');
  });

  it('accepts named and numeric keys', async () => {
    const named = fakeHdc();
    await driver.perform(named, 't1', { action: 'key', key: 'Home' });
    const code = fakeHdc();
    await driver.perform(code, 't1', { action: 'key', key: 2 });
    expect(named.calls[0].cmd).toBe('uitest uiInput keyEvent Home');
    expect(code.calls[0].cmd).toBe('uitest uiInput keyEvent 2');
  });

  it('single-quotes text so spaces and shell metacharacters stay one argument', async () => {
    const hdc = fakeHdc();
    await driver.perform(hdc, 't1',
      { action: 'inputText', x: 500, y: 500, text: "it's; $(reboot) `x`" });
    expect(hdc.calls[0].cmd)
      .toBe(`uitest uiInput inputText 500 500 'it'\\''s; $(reboot) \`x\`'`);
  });

  it('types at the focused field with the text command', async () => {
    const hdc = fakeHdc();
    await driver.perform(hdc, 't1', { action: 'text', text: 'hello world' });
    expect(hdc.calls[0].cmd).toBe("uitest uiInput text 'hello world'");
  });
});

describe('GestureDriver validation', () => {
  it('rejects a negative or fractional coordinate without touching the device', async () => {
    const hdc = fakeHdc();
    for (const x of [-1, 1.5, Number.NaN]) {
      await expect(driver.perform(hdc, 't1', { action: 'click', x, y: 0 }))
        .rejects.toMatchObject({ code: 'UITEST_BAD_GESTURE' });
    }
    expect(hdc.calls).toEqual([]);
  });

  it('rejects a velocity outside 200..40000 instead of letting the device substitute its default', async () => {
    const hdc = fakeHdc();
    for (const velocity of [199, 40001]) {
      await expect(driver.perform(hdc, 't1', {
        action: 'swipe', fromX: 0, fromY: 0, toX: 1, toY: 1, velocity,
      })).rejects.toMatchObject({ code: 'UITEST_BAD_GESTURE' });
    }
    expect(hdc.calls).toEqual([]);
  });

  it('rejects an unknown key name', async () => {
    const hdc = fakeHdc();
    await expect(driver.perform(hdc, 't1', { action: 'key', key: 'NotAKey' }))
      .rejects.toMatchObject({ code: 'UITEST_BAD_GESTURE' });
    expect(hdc.calls).toEqual([]);
  });

  it('rejects empty text and control characters', async () => {
    const hdc = fakeHdc();
    for (const text of ['', 'a\nb', 'a\u0000b', 'a\u007fb']) {
      await expect(driver.perform(hdc, 't1', { action: 'text', text }))
        .rejects.toMatchObject({ code: 'UITEST_BAD_GESTURE' });
    }
    expect(hdc.calls).toEqual([]);
  });
});

describe('GestureDriver failure classification', () => {
  it('treats a device refusal at host exit 0 as a failure', async () => {
    // Measured: `uitest uiInput click abc def` exits 1 on the device, but
    // `hdc shell` returns 0. Only the marker proves acceptance.
    const hdc = fakeHdc({
      stdout: 'Please confirm that the coordinate values are correct. \r\n\r\nUSAGE : …',
      code: 0,
    });
    const err = await driver.perform(hdc, 't1', { action: 'click', x: 500, y: 500 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OhosPerfError);
    expect(err).toMatchObject({ code: 'UITEST_INPUT_FAILED' });
    expect((err as Error).message).toContain('Please confirm that the coordinate values are correct.');
  });

  it('wraps a transport failure in UITEST_INPUT_FAILED', async () => {
    const hdc = {
      async shell() {
        throw new OhosPerfError('hdc shell failed: exit code 127', { code: 'HDC_SHELL_FAILED' });
      },
    };
    await expect(driver.perform(hdc, 't1', { action: 'key', key: 'Home' }))
      .rejects.toMatchObject({ code: 'UITEST_INPUT_FAILED' });
  });

  it('keeps a non-marker warning visible in the result when the marker is present', async () => {
    const hdc = fakeHdc({
      stdout: 'The swipe velocity out of range, the default value will be used. \r\n\r\nNo Error\r\n',
    });
    const result = await driver.perform(hdc, 't1',
      { action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200 });
    expect(result.output).toContain('velocity out of range');
  });
});
