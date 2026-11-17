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
import { irreversibleReason } from './guard';

/** The three orders HapRay offers, kept under their names. */
export type ExplorationStrategy = 'depth_first' | 'breadth_first' | 'random';

/** Which way a scroll gesture's content moves. */
export type ScrollDirection = 'up' | 'down';

/** What exploration needs from a device. `Device` satisfies it structurally. */
export interface ExplorationDevice {
  /** The flattened on-screen tree, as `flattenUiTree` returns it. */
  dump(): Promise<readonly UiNode[]>;
  /** Tap the centre of `bounds`. Throws when the device refuses the gesture. */
  tap(bounds: string): Promise<void>;
  /** Swipe inside a scrollable node. Absent when the device cannot scroll. */
  swipe?(bounds: string, direction: ScrollDirection): Promise<void>;
  /** Press the system back button. Absent when the device cannot go back. */
  back?(): Promise<void>;
}

export interface ExplorationState {
  readonly tree: readonly UiNode[];
  /** Identities already tapped *on this tree's screen*. */
  readonly visited: ReadonlySet<string>;
  readonly strategy: ExplorationStrategy;
  /** Required by `random`; ignored by the ordered strategies. */
  readonly seed?: number;
  /**
   * The bundle the walk must stay inside. Nodes from another bundle are not
   * offered and not tapped; a screen with none of this app's nodes means the
   * walk has left the app.
   */
  readonly app?: string;
}

/** The next tap, or `undefined` when this screen has nothing left to offer. */
export interface ExplorationAction {
  readonly kind: 'tap';
  readonly nodeId: string;
  readonly bounds: string;
}

/**
 * What a step did.
 *
 * `navigated` reached a different page, `updated` changed the screen without
 * changing the page (new data on the same template, a scroll), and `no_change`
 * left the screen exactly as it was.
 */
export type ExplorationOutcome = 'navigated' | 'updated' | 'no_change';

/** What a step performed. */
export type ExplorationStepKind = 'tap' | 'scroll' | 'back';

/** One step, with the state hash either side of it. */
export interface ExplorationStep {
  readonly index: number;
  readonly kind: ExplorationStepKind;
  /** Present for a tap: the identity of the node that was tapped. */
  readonly nodeId?: string;
  /** Present for a tap or a scroll: the bounds the gesture was aimed at. */
  readonly bounds?: string;
  /** The screen hash before the step. */
  readonly before: string;
  /** The screen hash after it; equal to `before` means `no_change`. */
  readonly after: string;
  readonly outcome: ExplorationOutcome;
  /** Who picked this step: the deterministic order, or a supplied chooser. */
  readonly decidedBy: 'strategy' | 'model';
  /** The chooser's one-line reason, for a step it decided. */
  readonly reason?: string;
}

export interface ExplorationResult {
  readonly strategy: ExplorationStrategy;
  /** Present for `random`; the value is the one the walk actually used. */
  readonly seed?: number;
  readonly steps: readonly ExplorationStep[];
  /** Distinct screen hashes reached, including the one it started on. */
  readonly statesReached: number;
  /** Distinct page templates reached, including the one it started on. */
  readonly pagesReached: number;
  /** The page hashes in first-reach order, the way a reader follows the walk. */
  readonly pages: readonly string[];
  /** How many scroll steps were spent. */
  readonly scrolls: number;
  /** How many back steps were spent. */
  readonly backs: number;
  /**
   * Why the walk ended: the step cap, nothing left to try, the model asked to
   * stop, or the walk left the target app and could not return.
   */
  readonly stoppedBy: 'budget' | 'exhausted' | 'model' | 'left_app';
  /** True when it stopped because nothing was left to tap, scroll or return to. */
  readonly exhausted: boolean;
  /**
   * What a supplied chooser proposed, when one was supplied: how many proposals
   * the walk used, and every answer it refused with the reason. A refusal is
   * evidence, not an error — the deterministic order decides instead.
   */
  readonly proposals?: {
    readonly used: number;
    readonly refused: number;
    readonly refusals: readonly { readonly step: number; readonly detail: string }[];
  };
}

/** One element a chooser may name, as the walk saw it. */
export interface ExplorationCandidate {
  /** The identity the walk records for this element; the answer must match it. */
  readonly identity: string;
  readonly type: string;
  readonly text: string;
  readonly bounds: string;
  readonly depth: number;
}

/** Everything a chooser is shown about the moment it decides. */
export interface ExplorationChoiceContext {
  /** The bundle the walk must stay inside, when one was named. */
  readonly app?: string;
  /** Zero-based index of the step being decided. */
  readonly step: number;
  readonly maxSteps: number;
  /** The exact tree the offer was computed from. */
  readonly screen: readonly UiNode[];
  /** The elements the chooser may choose, in document order. */
  readonly candidates: readonly ExplorationCandidate[];
  /** The steps already taken, oldest first. */
  readonly history: readonly ExplorationStep[];
  /** Whether this step could scroll. */
  readonly canScroll: boolean;
  /** Whether this step could go back. */
  readonly canBack: boolean;
}

/** What a chooser answers: one action, or a refusal it could not parse a choice from. */
export type ExplorationProposal =
  | { readonly kind: 'tap'; readonly identity: string; readonly reason: string }
  | { readonly kind: 'scroll'; readonly direction: ScrollDirection; readonly reason: string }
  | { readonly kind: 'back'; readonly reason: string }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'refusal'; readonly detail: string };

/**
 * An optional decision-maker consulted at each step that has an element to
 * choose. Its answer is verified against the offer before it decides anything;
 * a name that was not offered is recorded as a refusal.
 */
export type ExplorationChooser = (
  context: ExplorationChoiceContext,
) => Promise<ExplorationProposal>;

export interface ExplorationOptions {
  /** Hard cap on steps. HapRay's default is 30. */
  readonly maxSteps: number;
  readonly strategy: ExplorationStrategy;
  /** Makes `random` reproducible. Defaults to 0, never to the clock. */
  readonly seed?: number;
  /** The bundle the walk must stay inside. */
  readonly app?: string;
  /**
   * A model (or anything else) that may choose each step. Absent means the
   * deterministic order decides every step. With a chooser, irreversible
   * targets are not offered at all.
   */
  readonly choose?: ExplorationChooser;
}

/** How many scrolls one exact screen gets before the walk calls it exhausted. */
const SCROLLS_PER_SCREEN = 3;

/** How many backs one exact screen gets; a dead back key must not eat the budget. */
const BACKS_PER_SCREEN = 1;

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
  return digest(canonical(tree));
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, DIGEST_CHARS);
}

/**
 * One line per node, with only what a person would call "a different page".
 *
 * HapRay asks a vision model whether two screens are the same page and accepts
 * the answer unchecked. The question has a deterministic form: the same app
 * and ability, the same node types in the same order at the same depths, and
 * the same flags. Text, inspector ids and rects change with the data or with a
 * scroll — precisely the differences HapRay's own prompt calls "minor" and
 * "a scrolled version of the same page". Those are left out here, so the
 * answer is measured rather than guessed.
 */
function pageCanonical(tree: readonly UiNode[]): string {
  const line = (node: UiNode): string =>
    [
      node.bundleName,
      node.abilityName,
      node.depth,
      node.type,
      node.clickable ? '1' : '0',
      node.enabled ? '1' : '0',
      node.scrollable ? '1' : '0',
    ]
      .map((field) => `${String(field).length}:${String(field)}`)
      .join('\u001f');
  return tree.map(line).join('\u001e');
}

/** A short digest of a page's structure: two trees with the same shape share it. */
export function hashPageShape(tree: readonly UiNode[]): string {
  return digest(pageCanonical(tree));
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
  const first = orderCandidates(candidatesOf(state), state.strategy, state.seed)[0];
  if (first === undefined) return undefined;
  return { kind: 'tap', nodeId: first.identity, bounds: first.node.bounds };
}

/** The deterministic order for one strategy. */
function orderCandidates(
  candidates: readonly Candidate[],
  strategy: ExplorationStrategy,
  seed: number | undefined,
): readonly Candidate[] {
  switch (strategy) {
    case 'depth_first':
      // Document order is the dump's pre-order: parents before children, and
      // each subtree before its next sibling.
      return candidates;
    case 'breadth_first':
      // Shallow before deep, and document order within a depth. Sorting is
      // stable, so equal depths keep the dump's order.
      return [...candidates].sort((a, b) => a.node.depth - b.node.depth);
    case 'random':
      return shuffled(candidates, seed ?? DEFAULT_SEED);
  }
}

/** A candidate as a chooser sees it. */
function offerOf(candidate: Candidate): ExplorationCandidate {
  return {
    identity: candidate.identity,
    type: candidate.node.type,
    text: candidate.node.text,
    bounds: candidate.node.bounds,
    depth: candidate.node.depth,
  };
}

/** A node a walk may act on, with the identity it is visited under. */
interface Candidate {
  readonly node: UiNode;
  readonly identity: string;
}

/**
 * Every enabled, parseable clickable nobody has tapped on this screen, in
 * document order, restricted to the app the walk was asked to stay inside.
 *
 * `bundleName === ''` is accepted: a dump that does not attribute a node to a
 * bundle cannot prove it belongs to another app, and treating it as foreign
 * would make exploration impossible on such a device.
 */
function candidatesOf(state: ExplorationState): Candidate[] {
  const ids = identities(state.tree);
  const out: Candidate[] = [];
  for (const node of state.tree) {
    if (!node.clickable || !node.enabled) continue;
    if (rectOf(node) === undefined) continue;
    if (state.app !== undefined && node.bundleName !== '' && node.bundleName !== state.app) continue;
    const identity = ids.get(node)!;
    if (state.visited.has(identity)) continue;
    out.push({ node, identity });
  }
  return out;
}

/**
 * The first node on the screen a scroll can target, if any.
 *
 * Restricted to the app the walk was asked to stay inside, for the same
 * reason {@link candidatesOf} is: a scroll is an action on that app's screen,
 * and swiping another bundle's list is exploration of a process the caller did
 * not name. `bundleName === ''` is accepted, as in `candidatesOf`.
 */
function scrollableNode(tree: readonly UiNode[], app: string | undefined): UiNode | undefined {
  return tree.find(
    (node) =>
      node.scrollable &&
      node.enabled &&
      rectOf(node) !== undefined &&
      (app === undefined || node.bundleName === '' || node.bundleName === app),
  );
}

/** True when the tree belongs entirely to apps other than the one named. */
function isOutsideApp(tree: readonly UiNode[], app: string | undefined): boolean {
  if (app === undefined) return false;
  const bundles = tree
    .map((node) => node.bundleName)
    .filter((bundle) => bundle !== '');
  return bundles.length > 0 && !bundles.includes(app);
}

/** What one walk step will do, before it is performed. */
type Decision =
  | { readonly kind: 'tap'; readonly nodeId: string; readonly bounds: string }
  | { readonly kind: 'scroll'; readonly bounds: string; readonly direction: ScrollDirection }
  | { readonly kind: 'back' };

/** The last trail entry with this page, or -1. */
function trailIndexFor(trail: ReadonlyArray<{ page: string }>, page: string): number {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (trail[index]!.page === page) return index;
  }
  return -1;
}

/**
 * Walk the app until the step budget runs out or nothing is left to try.
 *
 * `statesReached` counts distinct hashes rather than steps, so a walk that
 * bounced between two screens reports two states however many steps it spent.
 * The returned steps carry the hash either side of each action: a saved run can
 * be re-read without the device, and two runs that disagree can be compared by
 * hash instead of by prose.
 *
 * Navigation is measured, not assumed. A scroll is spent only when a
 * scrollable node is on screen and this exact screen has had fewer than
 * {@link SCROLLS_PER_SCREEN}; a back only when the trail has a parent and this
 * screen has had fewer than {@link BACKS_PER_SCREEN}. The trail itself is
 * updated from the page the screen actually became, so a tap that lands on an
 * earlier page rewinds it exactly as a back would — HapRay's state stack does
 * the same thing, but asks a model whether the page matches.
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
  const pages = new Set<string>();
  const visitedByScreen = new Map<string, Set<string>>();
  const scrollsByScreen = new Map<string, number>();
  const backsByScreen = new Map<string, number>();
  const proposals = options.choose === undefined
    ? undefined
    : { used: 0, refused: 0, refusals: [] as Array<{ step: number; detail: string }> };

  let tree = await device.dump();
  let hash = hashTree(tree);
  let page = hashPageShape(tree);
  states.add(hash);
  pages.add(page);
  const trail: Array<{ hash: string; page: string }> = [{ hash, page }];
  let stoppedBy: ExplorationResult['stoppedBy'] = 'budget';

  while (steps.length < options.maxSteps) {
    const state: ExplorationState = {
      tree,
      visited: visitedByScreen.get(hash) ?? new Set<string>(),
      strategy: options.strategy,
      ...(seed === undefined ? {} : { seed }),
      ...(options.app === undefined ? {} : { app: options.app }),
    };
    // Outside the app there is nothing to scroll toward: a swipe on another
    // bundle's list would explore a screen the caller did not name, and it can
    // change the tree on every swipe, which resets the per-screen budget and
    // spends the whole run there. The walk backs out or stops instead.
    const outside = isOutsideApp(tree, options.app);
    const target = outside ? undefined : scrollableNode(tree, options.app);
    const canScroll =
      device.swipe !== undefined &&
      target !== undefined &&
      (scrollsByScreen.get(hash) ?? 0) < SCROLLS_PER_SCREEN;
    const canBack =
      device.back !== undefined &&
      trail.length > 1 &&
      (backsByScreen.get(hash) ?? 0) < BACKS_PER_SCREEN;

    // With a model steering, a target that names an irreversible act is not
    // offered at all. The deterministic pick comes from the same filtered set,
    // so a refused proposal cannot fall back onto one either.
    const all = candidatesOf(state);
    const allowed = options.choose === undefined
      ? all
      : all.filter((candidate) => irreversibleReason(candidate.node) === undefined);
    const ordered = orderCandidates(allowed, options.strategy, seed);

    let decision: Decision | undefined;
    let decidedBy: 'strategy' | 'model' = 'strategy';
    let reason: string | undefined;

    if (options.choose !== undefined && allowed.length > 0) {
      const proposal = await options.choose({
        ...(options.app === undefined ? {} : { app: options.app }),
        step: steps.length,
        maxSteps: options.maxSteps,
        screen: tree,
        candidates: allowed.map(offerOf),
        history: steps.slice(),
        canScroll,
        canBack,
      });

      let refusal: string | undefined;
      switch (proposal.kind) {
        case 'tap': {
          const match = allowed.find(
            (candidate) => candidate.identity === proposal.identity,
          );
          if (match === undefined) {
            refusal =
              `the chooser named ${JSON.stringify(proposal.identity)}, which is not`
              + ` among the ${allowed.length} offered element(s)`;
          } else {
            decision = { kind: 'tap', nodeId: match.identity, bounds: match.node.bounds };
            decidedBy = 'model';
            reason = proposal.reason;
          }
          break;
        }
        case 'scroll':
          if (!canScroll) {
            refusal =
              'the chooser asked to scroll, but this screen has no scrollable node'
              + ' left to swipe';
          } else {
            decision = {
              kind: 'scroll',
              bounds: target!.bounds,
              direction: proposal.direction,
            };
            decidedBy = 'model';
            reason = proposal.reason;
          }
          break;
        case 'back':
          if (!canBack) {
            refusal =
              'the chooser asked to go back, but the walk has no earlier page to'
              + ' return to';
          } else {
            decision = { kind: 'back' };
            decidedBy = 'model';
            reason = proposal.reason;
          }
          break;
        case 'stop':
          // The model ending the walk is a distinct outcome: the budget was
          // not spent and the screen was not exhausted.
          stoppedBy = 'model';
          break;
        case 'refusal':
          refusal = proposal.detail;
          break;
      }

      if (proposals !== undefined) {
        if (decision !== undefined) proposals.used += 1;
        if (refusal !== undefined) {
          proposals.refused += 1;
          proposals.refusals.push({ step: steps.length, detail: refusal });
        }
      }
      if (stoppedBy === 'model') break;
    }

    if (decision === undefined) {
      if (outside) {
        // The screen belongs to another app: return to the trail rather than
        // act here, and end with the named outcome when there is no way back.
        if (canBack) decision = { kind: 'back' };
      } else {
        const first = ordered[0];
        if (first !== undefined) {
          decision = { kind: 'tap', nodeId: first.identity, bounds: first.node.bounds };
        } else if (canScroll) {
          decision = { kind: 'scroll', bounds: target!.bounds, direction: 'up' };
        } else if (canBack) {
          decision = { kind: 'back' };
        }
      }
    }
    if (decision === undefined) {
      stoppedBy = outside ? 'left_app' : 'exhausted';
      break;
    }

    switch (decision.kind) {
      case 'tap': {
        const visited = visitedByScreen.get(hash) ?? new Set<string>();
        visited.add(decision.nodeId);
        visitedByScreen.set(hash, visited);
        await device.tap(decision.bounds);
        break;
      }
      case 'scroll':
        scrollsByScreen.set(hash, (scrollsByScreen.get(hash) ?? 0) + 1);
        await device.swipe!(decision.bounds, decision.direction);
        break;
      case 'back':
        backsByScreen.set(hash, (backsByScreen.get(hash) ?? 0) + 1);
        await device.back!();
        break;
    }

    tree = await device.dump();
    const after = hashTree(tree);
    const afterPage = hashPageShape(tree);
    states.add(after);
    pages.add(afterPage);
    const outcome =
      after === hash ? 'no_change' : afterPage === page ? 'updated' : 'navigated';
    steps.push({
      index: steps.length,
      kind: decision.kind,
      ...(decision.kind === 'tap'
        ? { nodeId: decision.nodeId, bounds: decision.bounds }
        : decision.kind === 'scroll'
          ? { bounds: decision.bounds }
          : {}),
      before: hash,
      after,
      outcome,
      decidedBy,
      ...(reason === undefined ? {} : { reason }),
    });

    // The trail is the path of pages, not a log of gestures: a back that lands
    // on the parent and a tap that lands on an earlier page are the same event
    // to it, and both are measured rather than assumed.
    const match = trailIndexFor(trail, afterPage);
    if (match !== -1) {
      trail.length = match + 1;
      trail[match] = { hash: after, page: afterPage };
    } else if (afterPage !== page) {
      trail.push({ hash: after, page: afterPage });
    } else {
      trail[trail.length - 1] = { hash: after, page: afterPage };
    }
    hash = after;
    page = afterPage;
  }

  return {
    strategy: options.strategy,
    ...(seed === undefined ? {} : { seed }),
    steps,
    statesReached: states.size,
    pagesReached: pages.size,
    pages: [...pages],
    scrolls: steps.filter((step) => step.kind === 'scroll').length,
    backs: steps.filter((step) => step.kind === 'back').length,
    stoppedBy,
    exhausted: stoppedBy === 'exhausted',
    ...(proposals === undefined ? {} : { proposals }),
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
  /** One swipe inside `bounds`. Absent when the host cannot scroll. */
  swipe?(bounds: string, direction: ScrollDirection): Promise<void>;
  /** One system back. Absent when the host cannot go back. */
  back?(): Promise<void>;
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

  /**
   * Perform one action and wait for the screen it produced.
   *
   * The screen it was just on cannot be the answer, so the first look is the
   * earliest possible change; each further look waits one poll. Every action
   * settles the same way: a tap, a scroll and a back all move a screen.
   */
  const act = async (perform: () => Promise<void>): Promise<void> => {
    const before = hashTree(await read());
    await perform();
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
  };

  return {
    dump: read,
    tap: (bounds) => act(() => host.tap(bounds)),
    ...(host.swipe === undefined
      ? {}
      : { swipe: (bounds: string, direction: ScrollDirection) => act(() => host.swipe!(bounds, direction)) }),
    ...(host.back === undefined ? {} : { back: () => act(() => host.back!()) }),
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
  const perform = async (gesture: Gesture, label: string): Promise<void> => {
    const result = await device.gesture(gesture);
    if (!result.output.includes(ACCEPTED_MARKER)) {
      throw new OhosPerfError(
        `exploration: uitest uiInput ${label} did not report "${ACCEPTED_MARKER}":` +
          ` ${result.output === '' ? '(no output)' : result.output}`,
        { code: 'SCENARIO_ACTION_FAILED' },
      );
    }
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
        await perform({ action: 'click', x: point.x, y: point.y }, 'click');
      },
      swipe: async (bounds, direction) => {
        const rect = rectOfBounds(bounds);
        const tree = await device.uiTree();
        const target = tree.find((candidate) => candidate.bounds === bounds);
        if (target === undefined) {
          throw new OhosPerfError(
            `exploration: no node on the current screen carries these bounds` +
              ` ${JSON.stringify(bounds)}; the target is not on the screen any more`,
            { code: 'SCENARIO_EXPLORE_STALE' },
          );
        }
        if (!target.scrollable) {
          throw new OhosPerfError(
            `exploration: the node at ${JSON.stringify(bounds)} is not scrollable,` +
              ' so a swipe on it would drag whatever happens to be under that rect',
            { code: 'SCENARIO_EXPLORE_STALE' },
          );
        }
        const { from, to } = swipePoints(rect, direction);
        await perform(
          { action: 'swipe', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y },
          `swipe ${direction}`,
        );
      },
      back: () => perform({ action: 'key', key: 'Back' }, 'key Back'),
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    },
    settleOptions,
  );
}

/** The rect a `bounds` string names, or a refusal naming the string. */
function rectOfBounds(bounds: string): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const rect = parseBounds(bounds);
  if (rect === undefined) {
    throw new OhosPerfError(
      `exploration: ${JSON.stringify(bounds)} is not a "[l,t][r,b]" bounds string;` +
        ' it has no swipe path',
      { code: 'SCENARIO_EXPLORE_STALE' },
    );
  }
  return rect;
}

/**
 * The two points of a scroll inside a rect.
 *
 * HapRay's `swipes_up` is a finger moving up the screen, which reveals content
 * below; `up` keeps that meaning. Both points stay inside the rect, so the
 * gesture lands on the scrollable node rather than on a neighbour.
 */
function swipePoints(
  rect: { left: number; top: number; right: number; bottom: number },
  direction: ScrollDirection,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const x = Math.round((rect.left + rect.right) / 2);
  const height = rect.bottom - rect.top;
  const upper = Math.round(rect.top + height * 0.2);
  const lower = Math.round(rect.top + height * 0.8);
  return direction === 'up'
    ? { from: { x, y: lower }, to: { x, y: upper } }
    : { from: { x, y: upper }, to: { x, y: lower } };
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
