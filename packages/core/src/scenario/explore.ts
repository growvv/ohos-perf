/**
 * Autonomous UI exploration, the deterministic replacement for HapRay's
 * `haptest` (parity row 4).
 *
 * The shape is HapRay's: dump the screen, hash it, tap a clickable element
 * nobody has tapped on this screen yet, repeat until the step budget runs out.
 * What changes is everything that made its output unusable as evidence.
 *
 * - **Every choice is a total order.** HapRay's `random` strategy walks
 *   whatever the RNG returns, so two runs of the same build explore different
 *   screens and neither can be reproduced. Here `random` is a seeded
 *   permutation: reproducible from the recorded seed, and different from the
 *   document order when you want to shake a walk out of a local minimum.
 * - **A tap that changed nothing is recorded as such.** HapRay counts every
 *   tap as a step forward. `no_change` separates "the screen moved" from "the
 *   element was dead", so coverage is the number of distinct states reached
 *   rather than the number of taps spent.
 * - **Visited is per screen.** A node id is only unique within one dump; two
 *   screens can both have `button1`. Remembering a tap globally would skip the
 *   second screen's element and report a screen as covered that never was.
 * - **An unparseable rect is skipped, not tapped at (0,0).** Tapping the
 *   origin is a gesture on whatever happens to be in the corner.
 *
 * The walk does not analyze and does not collect: it is the "get somewhere
 * interesting" half of a scenario, and the scene it leaves behind is what
 * `analyze`, `report` and `query` consume.
 */

import { createHash } from 'node:crypto';
import type { Gesture, GestureResult } from '../device/gesture';
import { OhosPerfError } from '../errors';
import { parseBounds, type UiNode } from '../query/ui';

/** The three orders HapRay offers, kept under their names. */
export type ExplorationStrategy = 'depth_first' | 'breadth_first' | 'random';

/** What exploration needs from a device. `Device` satisfies it structurally. */
export interface ExplorationDevice {
  /** The flattened on-screen tree, as `flattenUiTree` returns it. */
  dump(): Promise<readonly UiNode[]>;
  /** Tap the centre of `bounds`. Throws when the device refuses the gesture. */
  tap(bounds: string): Promise<void>;
}

export interface ExplorationState {
  readonly tree: readonly UiNode[];
  /** Identities already tapped *on this tree's screen*. */
  readonly visited: ReadonlySet<string>;
  readonly strategy: ExplorationStrategy;
  /** Required by `random`; ignored by the ordered strategies. */
  readonly seed?: number;
}

/** The next tap, or `undefined` when this screen has nothing left to offer. */
export interface ExplorationAction {
  readonly kind: 'tap';
  readonly nodeId: string;
  readonly bounds: string;
}

/** Whether a tap moved the screen. */
export type ExplorationOutcome = 'navigated' | 'no_change';

/** One tap, with the state hash either side of it. */
export interface ExplorationStep {
  readonly index: number;
  readonly nodeId: string;
  readonly bounds: string;
  /** The screen hash before the tap. */
  readonly before: string;
  /** The screen hash after it; equal to `before` means `no_change`. */
  readonly after: string;
  readonly outcome: ExplorationOutcome;
}

export interface ExplorationResult {
  readonly strategy: ExplorationStrategy;
  /** Present for `random`; the value is the one the walk actually used. */
  readonly seed?: number;
  readonly steps: readonly ExplorationStep[];
  /** Distinct screen hashes reached, including the one it started on. */
  readonly statesReached: number;
  /** True when it stopped because this screen had no unvisited clickable. */
  readonly exhausted: boolean;
}

export interface ExplorationOptions {
  /** Hard cap on taps. HapRay's default is 30. */
  readonly maxSteps: number;
  readonly strategy: ExplorationStrategy;
  /** Makes `random` reproducible. Defaults to 0, never to the clock. */
  readonly seed?: number;
}

/** The seed `random` falls back to; a fixed value, so an unseeded walk repeats. */
const DEFAULT_SEED = 0;

/** Digest width: enough to separate states, short enough to read in a report. */
const DIGEST_CHARS = 16;

/**
 * One line per node, with every field a person would call "a different screen".
 *
 * Length prefixes keep two fields from running together (`"ab"|"c"` must not
 * hash like `"a"|"bc"`), and the separator is a character no inspector field
 * contains. Order is preserved: the same elements in a different order are a
 * different screen, which is what makes a scrolled list a new state.
 */
function canonical(tree: readonly UiNode[]): string {
  const line = (node: UiNode): string =>
    [
      node.depth,
      node.type,
      node.bundleName,
      node.abilityName,
      node.text,
      node.id,
      node.bounds,
      node.clickable ? '1' : '0',
      node.enabled ? '1' : '0',
      node.scrollable ? '1' : '0',
    ]
      .map((field) => `${String(field).length}:${String(field)}`)
      .join('\u001f');
  return tree.map(line).join('\u001e');
}

/** A short hex digest of a screen, stable across runs and hosts. */
export function hashTree(tree: readonly UiNode[]): string {
  return createHash('sha256')
    .update(canonical(tree))
    .digest('hex')
    .slice(0, DIGEST_CHARS);
}

/**
 * mulberry32 — a small, fast, seeded generator.
 *
 * Not for cryptography; for turning one integer into a repeatable sequence.
 * `Math.random` would make the walk unreproducible, which is the defect this
 * module exists to remove.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher–Yates shuffle of a copy; the input is left alone. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = mulberry32(seed);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(next() * (index + 1));
    const held = out[index]!;
    out[index] = out[pick]!;
    out[pick] = held;
  }
  return out;
}

/**
 * A node's identity within one screen.
 *
 * `inspectorId` when the dump carries one, otherwise its type, text and rect —
 * the same triple a person would use to point at it. Identical siblings are
 * told apart by occurrence, so two `OK` buttons are two tap targets rather than
 * one that gets visited twice.
 */
function identities(tree: readonly UiNode[]): Map<UiNode, string> {
  const seen = new Map<string, number>();
  const out = new Map<UiNode, string>();
  for (const node of tree) {
    const base =
      node.id !== '' ? node.id : `at:${node.type}|${node.text}|${node.bounds}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    out.set(node, occurrence === 1 ? base : `${base}#${occurrence}`);
  }
  return out;
}

/** The rect a node occupies, parsed on demand when the tree did not carry one. */
function rectOf(node: UiNode): UiNode['boundsRect'] {
  return node.boundsRect ?? parseBounds(node.bounds);
}

/**
 * The next tap on one screen.
 *
 * Returns `undefined` when every enabled, parseable clickable has been tapped
 * here — the signal that this screen is done, not that the walk is over.
 */
export function planNextAction(state: ExplorationState): ExplorationAction | undefined {
  const ids = identities(state.tree);
  const candidates = state.tree.filter(
    (node) =>
      node.clickable &&
      node.enabled &&
      rectOf(node) !== undefined &&
      !state.visited.has(ids.get(node)!),
  );
  if (candidates.length === 0) return undefined;

  let ordered: readonly UiNode[];
  switch (state.strategy) {
    case 'depth_first':
      // Document order is the dump's pre-order: parents before children, and
      // each subtree before its next sibling.
      ordered = candidates;
      break;
    case 'breadth_first':
      // Shallow before deep, and document order within a depth. Sorting is
      // stable, so equal depths keep the dump's order.
      ordered = [...candidates].sort((a, b) => a.depth - b.depth);
      break;
    case 'random':
      ordered = shuffled(candidates, state.seed ?? DEFAULT_SEED);
      break;
  }

  const node = ordered[0]!;
  return { kind: 'tap', nodeId: ids.get(node)!, bounds: node.bounds };
}

/**
 * Walk the app until the step budget runs out or the screen is exhausted.
 *
 * `statesReached` counts distinct hashes rather than taps, so a walk that
 * bounced between two screens reports two states however many steps it spent.
 * The returned steps carry the hash either side of each tap: a saved run can be
 * re-read without the device, and two runs that disagree can be compared by
 * hash instead of by prose.
 */
export async function explore(
  device: ExplorationDevice,
  options: ExplorationOptions,
): Promise<ExplorationResult> {
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) {
    throw new Error(
      `explore: maxSteps must be a positive integer (got ${String(options.maxSteps)})`,
    );
  }
  const seed = options.strategy === 'random' ? (options.seed ?? DEFAULT_SEED) : undefined;

  const steps: ExplorationStep[] = [];
  const states = new Set<string>();
  const visitedByScreen = new Map<string, Set<string>>();

  let tree = await device.dump();
  let hash = hashTree(tree);
  states.add(hash);
  let exhausted = false;

  while (steps.length < options.maxSteps) {
    const visited = visitedByScreen.get(hash) ?? new Set<string>();
    const action = planNextAction({
      tree,
      visited,
      strategy: options.strategy,
      ...(seed === undefined ? {} : { seed }),
    });
    if (action === undefined) {
      exhausted = true;
      break;
    }
    visited.add(action.nodeId);
    visitedByScreen.set(hash, visited);

    await device.tap(action.bounds);

    tree = await device.dump();
    const after = hashTree(tree);
    states.add(after);
    steps.push({
      index: steps.length,
      nodeId: action.nodeId,
      bounds: action.bounds,
      before: hash,
      after,
      outcome: after === hash ? 'no_change' : 'navigated',
    });
    hash = after;
  }

  return {
    strategy: options.strategy,
    ...(seed === undefined ? {} : { seed }),
    steps,
    statesReached: states.size,
    exhausted,
  };
}

/**
 * What {@link explorationDevice} needs from its caller.
 *
 * A structural subset of `Device`, so a real device satisfies it and a test can
 * supply a script. `now` and `sleep` are injected for the same reason the
 * scenario runner takes a clock: a settle that waited in real time would make
 * the test slow and the walk untestable.
 */
export interface ExplorationHost {
  /** The flattened on-screen tree, as `Device.uiTree` returns it. */
  dump(): Promise<readonly UiNode[]>;
  /** One tap at the centre of `bounds`. */
  tap(bounds: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ExplorationDeviceOptions {
  /**
   * How long a tap may take to change the screen before the walk calls it
   * dead. HapRay spends a fixed 5 s on every action; 5 s is a ceiling here,
   * paid in full only by an element that does nothing.
   */
  readonly settleMs?: number;
  /** How often to look while settling. */
  readonly pollMs?: number;
}

/** HapRay's fixed collection window, kept as the default ceiling. */
const DEFAULT_SETTLE_MS = 5000;

/** Fast enough to notice a screen transition, slow enough not to flood the device. */
const DEFAULT_POLL_MS = 250;

/**
 * Turn a host into the device {@link explore} drives.
 *
 * The one thing this adds is the settle: after each tap it re-dumps until the
 * screen changes or `settleMs` runs out, and caches the settled tree. Without
 * it a dump taken 20 ms after a tap catches the outgoing screen, the walk
 * hashes a screen it is about to leave, and the next tap aims at a node that
 * no longer exists — which is why HapRay waits a flat 5 s and calls it a
 * collection window. Polling pays that 5 s only when the element is dead.
 *
 * The cached tree is the one `explore` reads next, so a settle is never paid
 * for twice.
 */
export function explorationDevice(
  host: ExplorationHost,
  options: ExplorationDeviceOptions = {},
): ExplorationDevice {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error(`explorationDevice: pollMs must be a positive integer (got ${String(pollMs)})`);
  }
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) {
    throw new Error(`explorationDevice: settleMs must be a non-negative integer (got ${String(settleMs)})`);
  }

  let settled: readonly UiNode[] | undefined;

  const read = async (): Promise<readonly UiNode[]> => {
    if (settled === undefined) settled = await host.dump();
    return settled;
  };

  return {
    dump: read,
    async tap(bounds) {
      const before = hashTree(await read());
      await host.tap(bounds);
      // The screen it was just on cannot be the answer, so the first look is
      // the earliest possible change; each further look waits one poll.
      const deadline = host.now() + settleMs;
      for (;;) {
        const next = await host.dump();
        if (hashTree(next) !== before) {
          settled = next;
          return;
        }
        const remaining = deadline - host.now();
        if (remaining <= 0) {
          settled = next;
          return;
        }
        await host.sleep(Math.min(pollMs, remaining));
      }
    },
  };
}

/** The device surface {@link deviceExplorationHost} needs. `Device` satisfies it. */
export interface ExplorationTargetDevice {
  readonly id: string;
  /** A fresh flattened dump, as `Device.uiTree` returns. */
  uiTree(): Promise<readonly UiNode[]>;
  gesture(g: Gesture): Promise<GestureResult>;
}

/** What a settle needs from the host clock; injectable so tests never sleep. */
export interface ExplorationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The marker `uitest uiInput` prints when it accepted an injection. */
const ACCEPTED_MARKER = 'No Error';

/**
 * Adapt a real device to {@link ExplorationHost}.
 *
 * Two jobs, both of them refusals the exploration layer cannot make itself.
 *
 * - **Bounds become a point here.** The walk deals only in the `bounds` string
 *   it read, so the conversion to a click has one home. A string that does not
 *   parse is refused: HapRay taps (0,0) in that case, which is a gesture on
 *   whatever occupies the corner.
 * - **The target must still be on screen.** Between the dump and the tap a
 *   screen can move; clicking the old coordinates then hits whatever slid into
 *   place. The tap re-dumps and refuses when no node carries those bounds.
 *
 * Acceptance is the `No Error` marker, the same rule every other gesture path
 * enforces — `uitest uiInput` exits 0 even when it refuses the gesture.
 */
export function deviceExplorationHost(
  device: ExplorationTargetDevice,
  options: ExplorationDeviceOptions & { clock?: ExplorationClock } = {},
): ExplorationDevice {
  const clock: ExplorationClock = options.clock ?? {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const settleOptions: ExplorationDeviceOptions = {
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  };
  return explorationDevice(
    {
      dump: () => device.uiTree(),
      tap: async (bounds) => {
        const point = centreOfBounds(bounds);
        const tree = await device.uiTree();
        if (!tree.some((candidate) => candidate.bounds === bounds)) {
          throw new OhosPerfError(
            `exploration: no node on the current screen carries these bounds` +
              ` ${JSON.stringify(bounds)}; the target is not on the screen any more`,
            { code: 'SCENARIO_EXPLORE_STALE' },
          );
        }
        const result = await device.gesture({ action: 'click', x: point.x, y: point.y });
        if (!result.output.includes(ACCEPTED_MARKER)) {
          throw new OhosPerfError(
            `exploration: uitest uiInput click did not report "${ACCEPTED_MARKER}":` +
              ` ${result.output === '' ? '(no output)' : result.output}`,
            { code: 'SCENARIO_ACTION_FAILED' },
          );
        }
      },
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    },
    settleOptions,
  );
}

/** The centre of a `bounds` string, or a refusal naming the string. */
function centreOfBounds(bounds: string): { x: number; y: number } {
  const rect = parseBounds(bounds);
  if (rect === undefined) {
    throw new OhosPerfError(
      `exploration: ${JSON.stringify(bounds)} is not a "[l,t][r,b]" bounds string;` +
        ' it has no centre to tap',
      { code: 'SCENARIO_EXPLORE_STALE' },
    );
  }
  return {
    x: Math.round((rect.left + rect.right) / 2),
    y: Math.round((rect.top + rect.bottom) / 2),
  };
}
