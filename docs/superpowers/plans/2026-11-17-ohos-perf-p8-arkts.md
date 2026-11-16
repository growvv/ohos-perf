# P8 ArkTS-Side Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ui.gesture` genuinely drivable with a measured `uitest uiInput` driver and an `ohos-perf gesture` CLI group, and make `coverage` report the honest "no collector" verdict instead of claiming `hiprofiler_cmd` serves it.

**Architecture:** `packages/core/src/device/gesture.ts` holds `GestureDriver`, the only code that builds and classifies `uitest uiInput` commands. `Device.gesture()` gates on the existing `ui.gesture` capability and delegates. The CLI parses positionals into the `Gesture` union and renders one line; it holds no device logic. The capability matrix changes two rules: `coverage` moves to the `bjc_cov` binary gate plus an always-false verdict, and `js.heap`'s reason records the measured `hidumper` permission gate.

**Tech Stack:** TypeScript (ESM), Vitest, commander, npm workspaces. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p8-arkts-design.md` — read it first. Its §3 (measured facts) and §4 (design) are the authority this plan argues from.

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- **`uitest uiInput`'s host exit code is always 0**, even when the device-side tool exits 1. Success is the stdout marker `No Error`, never `$?`. This is the single measured fact the driver exists for.
- **Validate before the shell call.** The device accepts out-of-screen coordinates, and it silently substitutes its default velocity outside `200..40000`; the driver must reject what it cannot guarantee happened.
- **Text is untrusted shell input.** Single-quote it (`'` → `'\''`) and reject control characters. A gesture text must never be able to end the command or start another.
- Every new value export goes into `VALUE_EXPORTS` in `packages/core/test/types.test.ts`; every type named in a public signature is exported from `packages/core/src/index.ts`.
- The CLI failure contract is unchanged: empty stdout, one message on stderr, exit 1.
- A capability is reported available only when this package can drive it. That is why `coverage` becomes unavailable and `ui.gesture` gains code.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Measured facts

From the spec §3, repeated because tasks use them verbatim.

| Fact | Value |
| --- | --- |
| Success output | stdout `No Error\r\n`, stderr empty, host exit 0 |
| Device-side refusal | exit 1 inside the device shell (`Please confirm that the coordinate values are correct.`, `Invalid parameters.`), **host exit still 0** |
| Commands measured | `click <x> <y>`, `swipe <fx> <fy> <tx> <ty> [velocity]`, `keyEvent <Back|Home|Power|code>`, `inputText <x> <y> <text>`, `text <text>` |
| Velocity range | `200..40000`; outside it the tool prints `The swipe velocity out of range, the default value will be used.` and still `No Error` |
| Injection proof | layout dump 69,529 → `keyEvent Home` → 158,734 bytes |
| `bjc_cov` | `which bjc_cov` empty; no `*cov*` in `/bin` or `/system/bin` |
| `hidumper --mem-jsheap` | `[Permission Check Failed] … needs a debug-signed application.` on release apps and `com.ohos.sceneboard` |
| Mate 60 matrix after P8 | **19 / 21** (js.heap and coverage unavailable) |

## Review Focus

1. **A device refusal at host exit 0 is reported as success.** Task 1's marker test feeds the measured `Please confirm…` output with `code: 0` and requires `UITEST_INPUT_FAILED`.
2. **Text escapes the command.** Task 1 quotes spaces, apostrophes and shell metacharacters (`;`, `$()`, backticks) and requires one single-quoted argv fragment.
3. **Out-of-range velocity silently becomes the default.** Task 1's validation test asserts `perform` made no shell call.
4. **A gesture lands on the wrong device.** Task 4's deps test pins that `--target` reaches the connector.
5. **`coverage` flips back to available on a hiprofiler device.** Task 5 pins `available: false` both with and without `bjc_cov`.

---

### Task 1: `GestureDriver` in core

**Files:**
- Create: `packages/core/src/device/gesture.ts`
- Create: `packages/core/test/gesture.test.ts`
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)

**Interfaces:**
- Produces: `Gesture` (union), `GestureResult` (`{ gesture, output }`), `class GestureDriver { perform(hdc: Pick<Hdc, 'shell'>, target: string, gesture: Gesture): Promise<GestureResult> }`.
- Error codes: `UITEST_BAD_GESTURE` for input validation, `UITEST_INPUT_FAILED` for a device refusal or an `HDC_SHELL_FAILED` wrap.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/gesture.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/gesture.test.ts`
Expected: FAIL — `Failed to resolve import "../src/device/gesture"`.

- [ ] **Step 3: Implement `packages/core/src/device/gesture.ts`**

Signature and rules:

```ts
import { OhosPerfError } from '../errors';
import type { Hdc } from '../transport/hdc';

/** The marker `uitest uiInput` prints when it accepted the injection. */
const ACCEPTED_MARKER = 'No Error';
const VELOCITY_MIN = 200;
const VELOCITY_MAX = 40_000;
const KEY_NAMES = /^(?:Back|Home|Power)$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type Gesture =
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | { readonly action: 'swipe'; readonly fromX: number; readonly fromY: number;
      readonly toX: number; readonly toY: number; readonly velocity?: number }
  | { readonly action: 'key'; readonly key: string | number }
  | { readonly action: 'inputText'; readonly x: number; readonly y: number; readonly text: string }
  | { readonly action: 'text'; readonly text: string };

export interface GestureResult {
  readonly gesture: Gesture;
  readonly output: string;
}

export class GestureDriver {
  async perform(
    hdc: Pick<Hdc, 'shell'>,
    target: string,
    gesture: Gesture,
  ): Promise<GestureResult> { /* validate, build, run, check marker */ }
}
```

Implementation requirements:
- `assertCoordinate(field, value)`: safe integer `>= 0`, else `UITEST_BAD_GESTURE` with `` `gesture ${field} must be a non-negative integer (got ${String(value)})` ``.
- `assertVelocity`: integer in `200..40000`, else `` `gesture velocity must be an integer from 200 to 40000 (got ${String(velocity)})` ``.
- `assertKey`: a positive safe integer or a string matching `Back|Home|Power`, else `` `gesture key must be Back, Home, Power or a positive key code (got ${JSON.stringify(key)})` ``.
- `assertText`: non-empty and free of control characters, messages `gesture text must not be empty` / `gesture text must not contain control characters`.
- `quote(text)` returns `` `'${text.replace(/'/g, "'\\''")}'` ``.
- Build the five command strings exactly as the tests pin.
- Run `hdc.shell(target, cmd)`. On an `OhosPerfError` whose `code === 'HDC_SHELL_FAILED'`, throw `UITEST_INPUT_FAILED` with the transport message and `cause`. If the combined stdout+stderr lacks `No Error`, throw `` `uitest uiInput ${gesture.action} did not report "${ACCEPTED_MARKER}" (exit ${result.code}: ${detail(result)})` `` with code `UITEST_INPUT_FAILED`, where `detail` mirrors `collectors/uitest.ts` (first five trimmed non-empty lines joined with ` | `, plus ` ... (N more lines)`).
- Return `{ gesture, output: (result.stdout.trim() || result.stderr.trim()) }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/gesture.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Export the new surface**

In `packages/core/src/index.ts`, under "Device and capabilities", add:

```ts
export { GestureDriver } from './device/gesture';
export type { Gesture, GestureResult } from './device/gesture';
```

Add `'GestureDriver'` to `VALUE_EXPORTS` in `packages/core/test/types.test.ts` (alphabetical position near `FTRACE_CATEGORIES`/`GcAnalyzer` is fine; the test sorts before comparing).

- [ ] **Step 6: Verify the built surface**

Run: `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/types.test.ts packages/core/test/index.test.ts`
Expected: PASS. If the declarations test reports stale `dist`, rerun the build.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/device/gesture.ts packages/core/test/gesture.test.ts \
  packages/core/src/index.ts packages/core/test/types.test.ts
git commit -m "feat(core): drive uitest uiInput through a measured GestureDriver

The host exit code is always 0, so acceptance is the 'No Error' marker.
Text is single-quoted, velocity and keys are validated before the shell
call, and the Mate 60's silent out-of-range velocity fallback becomes an
error instead of a different gesture.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `Device.gesture` and its capability gate

**Files:**
- Modify: `packages/core/src/device/device.ts` (`DeviceDeps`, new method)
- Create: `packages/core/test/device-gesture.test.ts`
- Create: `packages/core/test/gesture.device.test.ts`

**Interfaces:**
- Consumes: `GestureDriver`, `Gesture`, `GestureResult` from Task 1.
- Produces: `DeviceDeps.gesture?: GestureDriver`; `Device.gesture(request: Gesture): Promise<GestureResult>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/device-gesture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Device } from '../src/device/device';
import type { Gesture } from '../src/device/gesture';

const probe = {
  identity: {
    abi: 'aarch64', productName: 'BRA-AL00', softwareVersion: 'BRA-AL00 7.0.0.111',
    osFullName: 'OpenHarmony-7.0.0.111', deviceType: 'phone', isEmulator: false,
  },
  abi: 'aarch64',
  isEmulator: false,
  binaries: { hitrace: true, hiperf: true, hidumper: true, hiprofiler_cmd: true, uitest: true },
  hiperfHwEvents: ['hw-cpu-cycles'], hiperfSwEvents: [],
  probes: {},
};

const hdc = { shell: async () => ({ stdout: '', stderr: '', code: 0 }) };

it('delegates to the injected driver with the device id', async () => {
  const seen: Array<{ target: string; gesture: Gesture }> = [];
  const device = new Device('t1', probe as never, {
    hdc: hdc as never,
    gesture: {
      perform: async (_hdc, target, gesture) => {
        seen.push({ target, gesture });
        return { gesture, output: 'No Error' };
      },
    } as never,
  });
  const gesture: Gesture = { action: 'key', key: 'Home' };
  const result = await device.gesture(gesture);
  expect(seen).toEqual([{ target: 't1', gesture }]);
  expect(result).toEqual({ gesture, output: 'No Error' });
});

it('refuses to gesture when uitest is absent, naming the matrix reason', async () => {
  const noUitest = { ...probe, binaries: { ...probe.binaries, uitest: false } };
  const device = new Device('t1', noUitest as never, { hdc: hdc as never });
  await expect(device.gesture({ action: 'key', key: 'Home' })).rejects.toMatchObject({
    code: 'MISSING_CAPABILITY',
    message: expect.stringContaining('uitest not present on device'),
  });
});
```

Create `packages/core/test/gesture.device.test.ts` (device acceptance, same
skip-when-no-device pattern as `collect-capture.device.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { connect } from '../src/device/device';

function attachedHdc(): string | undefined { /* copy attachedHdc() from collect-capture.device.test.ts */ }

const HDC = attachedHdc();

describe.skipIf(HDC === undefined)('ui.gesture on hardware', () => {
  it('injects a Home key and sees the tool accept it', async () => {
    const device = await connect({ hdcPath: HDC! });
    expect((await device.capabilities()).has('ui.gesture')).toBe(true);
    const result = await device.gesture({ action: 'key', key: 'Home' });
    expect(result.output).toContain('No Error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/device-gesture.test.ts`
Expected: FAIL — `device.gesture is not a function`.
Run (device attached): `npx vitest run --project device packages/core/test/gesture.device.test.ts`
Expected: FAIL — same reason. With no device it is skipped, which is acceptable evidence only for the unit half.

- [ ] **Step 3: Implement the method**

In `DeviceDeps`, add `gesture?: GestureDriver;`. In `Device`, after `shell()`:

```ts
/**
 * Inject a UI gesture. The capability gate is the same contract `collect`
 * uses: an unavailable `ui.gesture` throws before any device call.
 */
async gesture(request: Gesture): Promise<GestureResult> {
  const caps = await this.capabilities();
  if (!caps.has('ui.gesture')) {
    const reason = caps.get('ui.gesture')?.reason;
    throw new OhosPerfError(
      `gesture requires ui.gesture capability` + (reason ? ` (${reason})` : ''),
      { code: 'MISSING_CAPABILITY' },
    );
  }
  const hdc = this.requireHdc();
  return (this.deps.gesture ?? new GestureDriver()).perform(hdc, this.id, request);
}
```

Import `GestureDriver` and the types at the top of `device.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit packages/core/test/device-gesture.test.ts`
Expected: PASS, 2 tests.
Run (device attached): `npx vitest run --project device packages/core/test/gesture.device.test.ts`
Expected: PASS, 1 test. With no device: skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/device/device.ts packages/core/test/device-gesture.test.ts \
  packages/core/test/gesture.device.test.ts
git commit -m "feat(core): gate Device.gesture on ui.gesture and delegate to the driver

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: CLI parsing and `runGesture`

**Files:**
- Create: `packages/cli/src/gesture.ts`
- Create: `packages/cli/test/gesture.test.ts`
- Modify: `packages/cli/src/commands.ts` (`GestureRequest`, `CliDeps.gesture`, `runGesture`)
- Modify: `packages/cli/src/deps.ts` (`gestureDevice` override, `gesture` member)
- Modify: `packages/cli/test/deps.test.ts` (target forwarding)
- Modify: every `CliDeps` fake: `packages/cli/test/program.test.ts`, `commands.test.ts`, `compare-cli.test.ts`, `query-cli.test.ts`, `emulator-cli.test.ts`

**Interfaces:**
- Consumes: `Gesture`, `GestureResult` from core.
- Produces: `parseCoordinate(raw: string, label: string): number`, `parseVelocity(raw: string): number`, `parseKey(raw: string): string | number`, `GestureRequest { gesture: Gesture; target?: string }`, `CliDeps.gesture(req): Promise<GestureResult>`, `runGesture(deps, req, { json? }): Promise<CliResult>`, and `RealDepsOverrides.gestureDevice?: (target?: string) => Promise<{ id: string; gesture(g: Gesture): Promise<GestureResult> }>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/gesture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CliDeps } from '../src/commands';
import { runGesture } from '../src/commands';
import { parseCoordinate, parseKey, parseVelocity } from '../src/gesture';
import type { Gesture } from '@ohos-perf/core';

function deps(result?: { gesture: Gesture; output: string }): CliDeps {
  return {
    version: '1.0.0',
    doctor: { resolveHdc: async () => '/hdc', resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }), connectDevice: async () => { throw new Error('x'); } },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => { throw new Error('x'); },
    gesture: async () => result ?? { gesture: { action: 'key', key: 'Home' }, output: 'No Error' },
    query: async () => { throw new Error('x'); },
    tools: () => [],
    compare: async () => { throw new Error('x'); },
    emulator: { list: async () => [], start: async () => { throw new Error('x'); }, stop: async () => { throw new Error('x'); }, create: async () => { throw new Error('x'); } },
  };
}

describe('parseGesture arguments', () => {
  it('accepts a non-negative whole coordinate and rejects the rest', () => {
    expect(parseCoordinate('500', '<x>')).toBe(500);
    for (const raw of ['-1', '1.5', 'abc', '']) {
      expect(() => parseCoordinate(raw, '<x>')).toThrow(/invalid <x>: expected a non-negative whole number/);
    }
  });

  it('accepts only the measured velocity range', () => {
    expect(parseVelocity('200')).toBe(200);
    expect(parseVelocity('40000')).toBe(40_000);
    for (const raw of ['199', '40001', 'abc']) {
      expect(() => parseVelocity(raw)).toThrow(/expected a whole number from 200 to 40000/);
    }
  });

  it('accepts Back, Home, Power and positive key codes', () => {
    expect(parseKey('Back')).toBe('Back');
    expect(parseKey('2')).toBe(2);
    for (const raw of ['back', 'NotAKey', '0', '-2']) {
      expect(() => parseKey(raw)).toThrow(/expected Back, Home, Power or a positive key code/);
    }
  });
});

describe('runGesture rendering', () => {
  it('prints one accepted line for each action', async () => {
    const cases: Array<[Gesture, string]> = [
      [{ action: 'click', x: 500, y: 800 }, 'click 500 800 accepted\n'],
      [{ action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200, velocity: 600 },
        'swipe 500,800 -> 500,200 (velocity 600) accepted\n'],
      [{ action: 'key', key: 'Home' }, 'key Home accepted\n'],
      [{ action: 'inputText', x: 500, y: 500, text: 'hi' }, 'input 500 500 "hi" accepted\n'],
      [{ action: 'text', text: 'hi' }, 'text "hi" accepted\n'],
    ];
    for (const [gesture, line] of cases) {
      const r = await runGesture(deps({ gesture, output: 'No Error' }), { gesture }, {});
      expect(r).toEqual({ stdout: line, stderr: '', exitCode: 0 });
    }
  });

  it('prints the core result as JSON', async () => {
    const gesture: Gesture = { action: 'key', key: 'Home' };
    const r = await runGesture(deps({ gesture, output: 'No Error' }), { gesture }, { json: true });
    expect(JSON.parse(r.stdout)).toEqual({ gesture, output: 'No Error' });
  });

  it('maps a failure to exit 1 with empty stdout', async () => {
    const d = deps();
    d.gesture = async () => { throw new Error('uitest not present on device'); };
    const r = await runGesture(d, { gesture: { action: 'key', key: 'Home' } }, {});
    expect(r).toEqual({ stdout: '', stderr: 'uitest not present on device\n', exitCode: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/gesture.test.ts`
Expected: FAIL — `Failed to resolve import "../src/gesture"` and `runGesture` undefined.

- [ ] **Step 3: Implement `packages/cli/src/gesture.ts`**

```ts
const COORDINATE = /^\d+$/;

export function parseCoordinate(raw: string, label: string): number {
  if (!COORDINATE.test(raw)) {
    throw new Error(`invalid ${label}: expected a non-negative whole number, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${label}: expected a non-negative whole number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseVelocity(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 200 || value > 40_000) {
    throw new Error(`invalid --velocity: expected a whole number from 200 to 40000, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseKey(raw: string): string | number {
  if (raw === 'Back' || raw === 'Home' || raw === 'Power') return raw;
  if (/^[1-9]\d*$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  throw new Error(
    `invalid <key>: expected Back, Home, Power or a positive key code, got ${JSON.stringify(raw)}`,
  );
}
```

- [ ] **Step 4: Add `runGesture` to `commands.ts`**

```ts
export interface GestureRequest {
  gesture: Gesture;
  target?: string;
}

/** Human summary of one gesture; the accepted word is backed by the marker. */
function gestureSummary(gesture: Gesture): string {
  switch (gesture.action) {
    case 'click': return `click ${gesture.x} ${gesture.y}`;
    case 'swipe': {
      const velocity = gesture.velocity === undefined ? '' : ` (velocity ${gesture.velocity})`;
      return `swipe ${gesture.fromX},${gesture.fromY} -> ${gesture.toX},${gesture.toY}${velocity}`;
    }
    case 'key': return `key ${gesture.key}`;
    case 'inputText': return `input ${gesture.x} ${gesture.y} ${JSON.stringify(gesture.text)}`;
    case 'text': return `text ${JSON.stringify(gesture.text)}`;
  }
}

export async function runGesture(
  deps: CliDeps,
  req: GestureRequest,
  opts: { json?: boolean },
): Promise<CliResult> {
  try {
    const result = await deps.gesture(req);
    if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
    return { stdout: `${gestureSummary(req.gesture)} accepted\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 };
  }
}
```

Add to `CliDeps`: `gesture(req: GestureRequest): Promise<GestureResult>;` and import
the two types from `@ohos-perf/core`.

- [ ] **Step 5: Update every `CliDeps` fake**

Add a stub member next to `collect` in each fake:

```ts
gesture: async () => ({ gesture: { action: 'key', key: 'Home' }, output: 'No Error' }),
```

Files: `packages/cli/test/program.test.ts`, `commands.test.ts`, `compare-cli.test.ts`,
`query-cli.test.ts`, `emulator-cli.test.ts`, and `gesture.test.ts` (already has one).
`deps.test.ts` uses `realDeps()` and needs no fake.

- [ ] **Step 6: Wire `realDeps` so the required member compiles**

Add to `RealDepsOverrides`:

```ts
/** Device used by `gesture`; replaced in tests to avoid a real device. */
gestureDevice?: (target?: string) => Promise<{
  id: string;
  gesture(g: Gesture): Promise<GestureResult>;
}>;
```

In `realDeps`, below `collectDevice`:

```ts
const gestureDevice = overrides.gestureDevice ??
  ((target) => connect(target === undefined ? {} : { target }));
```

and in the returned object:

```ts
async gesture(req) {
  const device = await gestureDevice(req.target);
  return device.gesture(req.gesture);
},
```

Add the target-forwarding test to `deps.test.ts`:

```ts
it('forwards --target to the gesture connector', async () => {
  const asked: (string | undefined)[] = [];
  const deps = realDeps('0.0.0', {
    gestureDevice: async (target) => {
      asked.push(target);
      return { id: target ?? 'first', gesture: async (g) => ({ gesture: g, output: 'No Error' }) };
    },
  });
  const gesture = { action: 'key', key: 'Home' } as const;
  await deps.gesture({ gesture, target: '127.0.0.1:5555' });
  await deps.gesture({ gesture });
  expect(asked).toEqual(['127.0.0.1:5555', undefined]);
});
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npx vitest run --project unit packages/cli/test/gesture.test.ts packages/cli/test/deps.test.ts`
Expected: PASS (gesture 6 tests; deps suite green).
Run: `npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: clean — `realDeps` now satisfies the required `gesture` member.
(Test files are outside the tsconfig, so fake completeness is proven by the root build in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/gesture.ts packages/cli/test/gesture.test.ts \
  packages/cli/src/commands.ts packages/cli/src/deps.ts packages/cli/test/deps.test.ts \
  packages/cli/test/program.test.ts packages/cli/test/commands.test.ts \
  packages/cli/test/compare-cli.test.ts packages/cli/test/query-cli.test.ts \
  packages/cli/test/emulator-cli.test.ts
git commit -m "feat(cli): parse gesture arguments and render the accepted line

The CLI dependency is required, so realDeps must satisfy it in the same
step that adds it to CliDeps; the command wiring follows separately.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `ohos-perf gesture` command wiring

**Files:**
- Modify: `packages/cli/src/program.ts`
- Create: `packages/cli/test/gesture-cli.test.ts`

**Interfaces:**
- Consumes: `runGesture`, `GestureRequest`, the parsers and `deps.gesture` from Task 3.
- Produces: the five `ohos-perf gesture` subcommands.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/gesture-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CliDeps } from '../src/commands';
import { buildProgram } from '../src/program';
import type { Gesture } from '@ohos-perf/core';

function deps(): CliDeps { /* same literal as gesture.test.ts, with a recording gesture */ }

async function parse(argv: string[]) {
  const emitted: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
  const program = buildProgram(deps(), {
    writeOut: () => {}, writeErr: () => {}, emit: (r) => emitted.push(r),
  }, { exitOverride: true });
  await program.parseAsync(['node', 'ohos-perf', ...argv]);
  return emitted;
}

it.each([
  [['gesture', 'click', '500', '800'], { action: 'click', x: 500, y: 800 }],
  [['gesture', 'swipe', '500', '800', '500', '200', '--velocity', '600'],
    { action: 'swipe', fromX: 500, fromY: 800, toX: 500, toY: 200, velocity: 600 }],
  [['gesture', 'key', 'Home'], { action: 'key', key: 'Home' }],
  [['gesture', 'input', '500', '500', 'hello'], { action: 'inputText', x: 500, y: 500, text: 'hello' }],
  [['gesture', 'text', 'hello'], { action: 'text', text: 'hello' }],
])('maps %j to the core gesture', async (argv, expected) => {
  const seen: Gesture[] = [];
  const emitted = await parseWith((req) => { seen.push(req.gesture); return { gesture: req.gesture, output: 'No Error' }; }, argv);
  expect(seen).toEqual([expected]);
  expect(emitted[0].exitCode).toBe(0);
});

it('forwards --target to the gesture request', async () => { /* expect { gesture, target: '127.0.0.1:5555' } */ });

it('rejects an invalid coordinate without calling the device', async () => {
  let called = false;
  const emitted = await parseWith(() => { called = true; return { gesture: { action: 'text', text: '' }, output: '' }; },
    ['gesture', 'click', '-1', '500']);
  expect(called).toBe(false);
  expect(emitted[0]).toMatchObject({ stdout: '', exitCode: 1 });
  expect(emitted[0].stderr).toMatch(/invalid <x>/);
});

it('emits the core result under --json', async () => { /* JSON.parse(stdout) deep-equals { gesture, output } */ });
```

Factor `parseWith(gestureImpl, argv)` in the file so each test injects its own
`deps.gesture` while the rest of the fake stays fixed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/gesture-cli.test.ts`
Expected: FAIL — commander reports `unknown command 'gesture'`.

- [ ] **Step 3: Wire the command group in `program.ts`**

After the emulator group, add:

```ts
const gesture = program
  .command('gesture')
  .description('inject a UI gesture on the attached device');

const withGestureTargets = (cmd: Command): Command =>
  cmd
    .option('--target <id>', 'inject on this hdc target instead of the first connected one')
    .option('--json', 'print the result as JSON');

const emitGesture = async (
  io: ProgramIo,
  deps: CliDeps,
  build: () => Gesture,
  opts: { target?: string; json?: boolean },
): Promise<void> => {
  let gesture: Gesture;
  try {
    gesture = build();
  } catch (err) {
    io.emit({ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 });
    return;
  }
  io.emit(await runGesture(deps, {
    gesture,
    ...(opts.target === undefined ? {} : { target: opts.target }),
  }, { json: opts.json }));
};
```

Subcommand actions build the union with `parseCoordinate`/`parseVelocity`/`parseKey`:

- `click <x> <y>` → `{ action: 'click', x: parseCoordinate(x, '<x>'), y: parseCoordinate(y, '<y>') }`
- `swipe <from-x> <from-y> <to-x> <to-y>` (+ `--velocity`) → the four coordinates, velocity only when the flag is present
- `key <key>` → `{ action: 'key', key: parseKey(key) }`
- `input <x> <y> <text>` → `{ action: 'inputText', x, y, text }`
- `text <text>` → `{ action: 'text', text }`

`emitGesture` uses the action's `opts` exactly as passed (`target`, `json`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit packages/cli/test/gesture-cli.test.ts`
Expected: PASS (8 tests).
Run: `npx tsc -p packages/cli/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/program.ts packages/cli/test/gesture-cli.test.ts
git commit -m "feat(cli): add the ohos-perf gesture command group

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Honest `coverage`, richer `js.heap` reason, and the `bjc_cov` probe

**Files:**
- Modify: `packages/core/src/device/capability.ts`
- Modify: `packages/core/src/device/probe.ts` (add `bjc_cov` to `BINARIES`)
- Modify: `packages/core/test/capability.test.ts`
- Modify: `packages/core/test/probe.test.ts`
- Modify: `test/fixtures/README.md` (note the older snapshots predate `bjc_cov`)

**Interfaces:**
- Produces: `coverage` → `collector: 'bjc_cov'`, `available: false`; reason is
  `bjc_cov not present on device` when the binary is absent and
  `no coverage collector in this package consumes bjc_cov output` when present.
- Produces: `js.heap` reason ends with the `hidumper --mem-jsheap` permission gate.
- Produces: the probe runs 14 commands (six `which` entries).

- [ ] **Step 1: Write the failing tests**

In `capability.test.ts`, update the collector-mapping test and add:

```ts
it('serves coverage from bjc_cov, and never claims it available', () => {
  const present = buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, bjc_cov: true } });
  const absent = buildMatrix({ ...FULL_DEVICE, binaries: { ...FULL_DEVICE.binaries, bjc_cov: false } });
  expect(present.get('coverage')!.available).toBe(false);
  expect(present.get('coverage')!.collector).toBeUndefined();
  expect(absent.get('coverage')!.reason).toBe('bjc_cov not present on device');
  expect(present.get('coverage')!.reason)
    .toBe('no coverage collector in this package consumes bjc_cov output');
});

it('names both js.heap gates in the reason', () => {
  const s = buildMatrix(FULL_DEVICE).get('js.heap')!;
  expect(s.available).toBe(false);
  expect(s.reason).toContain('js_heap_*');
  expect(s.reason).toContain('debug-signed or profilerable');
});
```

Remove `coverage` from the "fixed hiprofiler reason" list and add the missing
`bjc_cov: false` member to the `FULL_DEVICE`/`EMULATOR` fixtures (absent means
the fixed reason). In `probe.test.ts`, add `'which bjc_cov'` after
`'which uitest'` in `COMMAND_SEQUENCE`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/capability.test.ts packages/core/test/probe.test.ts`
Expected: FAIL — coverage still reports `hiprofiler`, and the probe sequence differs.

- [ ] **Step 3: Change the rules**

In `capability.ts`, replace `hiprofiler('coverage')` with the rule quoted in
the spec §4.3, and replace the `js.heap` `unavailableReason` with:

```ts
'unavailableReason':
  'no analyzer in this package consumes js_heap_* tables;' +
  ' hidumper --mem-jsheap needs a debug-signed or profilerable app',
```

Add a comment above `ui.gesture`:

```ts
// Driven by GestureDriver over `uitest uiInput`, measured working on plain
// shell. The old "needs AAMS" note belonged to `uitest uiRecord`.
```

In `probe.ts`, add `'bjc_cov'` to `BINARIES` and update the fixed-order comment
to "five params, six `which`, the hiprofiler list, then hiperf".

- [ ] **Step 4: Note the fixture provenance**

`test/fixtures/README.md`: add one paragraph stating that `probe-real.txt` and
`probe-emulator.txt` were recorded before P8 and contain no `which bjc_cov`
line, so the runner treats it as absent — matching the 2026-11-17 Mate 60
measurement (`which bjc_cov` empty).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit packages/core/test/capability.test.ts packages/core/test/probe.test.ts`
Expected: PASS.
Run: `npm run test:unit`
Expected: PASS. The new `bjc_cov` probe command does not change any other verdict.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/device/capability.ts packages/core/src/device/probe.ts \
  packages/core/test/capability.test.ts packages/core/test/probe.test.ts \
  test/fixtures/README.md
git commit -m "fix(core): stop claiming coverage, and probe bjc_cov

coverage was available wherever hiprofiler_cmd existed, but nothing in
the package consumes bjc_cov output (and the binary is absent on the Mate
60). js.heap keeps its verdict and now names the measured hidumper
permission gate.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Skill, docs, counts, and the full suite

**Files:**
- Modify: `skill/ohos-perf/SKILL.md`
- Modify: `packages/cli/test/skill.test.ts`
- Modify: `README.md`, `CHANGELOG.md`, `site/index.html`

**Interfaces:**
- Consumes: the command surface from Task 4 and the matrix verdicts from Task 5.

- [ ] **Step 1: Write the failing skill assertions**

In `packages/cli/test/skill.test.ts`, update the `--target` sentence test to
require `gesture` in the list of commands that accept it, and add:

```ts
it('documents driving the UI before a capture', () => {
  const skill = readFileSync(SKILL, 'utf8');
  expect(skill).toContain('ohos-perf gesture click');
  expect(skill).toContain('ohos-perf gesture key');
  expect(skill).toContain('accepted');
});
```

Run: `npx vitest run --project unit packages/cli/test/skill.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 2: Update the skill**

Add a workflow step after the capability matrix:

```md
3. Drive the app to the state you want to measure, then capture it:
   `ohos-perf gesture click 500 800 --json`,
   `ohos-perf gesture swipe 500 800 500 200 --velocity 600 --json`,
   `ohos-perf gesture key Home --json`,
   `ohos-perf gesture input 500 500 "hello" --json`,
   `ohos-perf gesture text "hello" --json`.
   Each prints `{ gesture, output }`; `accepted` in human output means the
   device tool printed its `No Error` marker, not that a widget reacted. A
   velocity outside 200–40000 and a key other than Back/Home/Power or a
   positive code are rejected before anything touches the device.
```

Renumber the following steps, and extend the `--target` sentence to
"`collect`, `caps`, `doctor` and `gesture`".

- [ ] **Step 3: Update README**

- Remove `ui.gesture` from "Not implemented yet"; say `coverage` is
  unavailable because no collector consumes `bjc_cov` (absent on the Mate 60),
  and keep the `js.heap` verdict with the debug-signed/profilerable clause.
- Add the five `gesture` commands to the CLI section (and `--target`).
- Roadmap: replace the "exploring" row with P8 shipped-in-`master`; keep the
  UI-animation-diff gap named in the prose.
- Mate 60 matrix count: **19 / 21** (was 20/21), with `coverage` and `js.heap`
  named as the two unavailable rows.

- [ ] **Step 4: Update CHANGELOG**

Under Unreleased:
- Added: `GestureDriver` and `ohos-perf gesture {click,swipe,key,input,text}`;
  `ui.gesture` is now drivable.
- Fixed: `coverage` no longer reports available through `hiprofiler_cmd`; the
  probe checks `bjc_cov`.
- Changed: `js.heap`'s reason names the measured `hidumper --mem-jsheap`
  permission gate.
- Removed: the `ui.gesture` "needs AAMS" claim (it belonged to `uiRecord`).

- [ ] **Step 5: Update the site**

`site/index.html`: the capabilities table already marks `coverage` and
`js.heap` unavailable; add `bjc_cov` to the coverage route text, add the
`gesture` commands to the quickstart/CLI block in both locales, and update
the test-count stat tiles after Step 7 prints the real numbers.

- [ ] **Step 6: Run the full suite and build**

```bash
npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli
npm run test:unit
npm run test:device        # with the Mate 60 attached
npx tsc -p packages/core/tsconfig.json --noEmit
npx tsc -p packages/cli/tsconfig.json --noEmit
```

Expected: all green. Record the exact unit/device counts for Step 7.

- [ ] **Step 7: Put the measured counts into the docs**

Replace the README's test counts and the site's stat tiles with the numbers
Step 6 printed. On a clean checkout the unit count drops by the skipped
`types.test` declarations tests (3) and the device count by the skipped
device suite — follow the existing README convention (`976 + 32` in P7) and
print both.

- [ ] **Step 8: Commit**

```bash
git add skill/ohos-perf/SKILL.md packages/cli/test/skill.test.ts \
  README.md CHANGELOG.md site/index.html
git commit -m "docs: document gesture injection and the honest coverage verdict

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-review

- **Spec coverage:** §4.1 → Task 1; §4.2 → Task 2; §4.3 → Task 5; §4.4 → Tasks 3–4;
  §6 → each task's tests (device acceptance in Task 2); §7 → Tasks 1, 3, 5;
  §8 → Task 6.
- **Type consistency:** `Gesture`/`GestureResult`/`GestureDriver` are named
  identically in all tasks; `perform(hdc, target, gesture)` and
  `runGesture(deps, req, { json })` signatures match their consumers.
- **Review Focus:** each of the five lines has a named test in Tasks 1, 4 and 5.
- **Proportion:** no task writes production code the tests and signatures do
  not determine; the largest block is Task 1's test file, which is the
  contract for the measured protocol.
