/**
 * HapFlow static/dynamic integration (HapRay parity row 29).
 *
 * HapRay produces `fileDepGraph.json`, `moduleDepGraph.json` and
 * `hierarchical_integrated_data.json` from a Homecheck checkout — a Node
 * process with `node_modules` and a 16 GiB heap — and assigns a file to a HAR
 * by path segments and basename. Its viewer is a log-only stub.
 *
 * This port keeps the arithmetic and drops the prerequisites: the file list
 * and module declarations are inputs, so the graph is a deterministic pure
 * function. There is no Homecheck checkout to keep in sync and no heap
 * requirement.
 *
 * Ownership is segment-aware. HapRay compares path prefixes as strings, so
 * `feature-detail/…` would match a module called `feature`; here a path is
 * split into segments and the longest matching module path wins, which is what
 * a person reading the tree would say.
 */

/** A module (HAR or HSP) and the directory it owns. */
export interface ModuleDecl {
  readonly name: string;
  /** The directory prefix, relative to the project root, e.g. `feature`. */
  readonly path: string;
}

/** One file and the module that owns it, if any. */
export interface DepGraphFile {
  readonly path: string;
  /** Absent when no module's path is a segment-prefix of this file's path. */
  readonly module?: string;
}

/** One import edge between two files. */
export interface DepGraphEdge {
  readonly from: string;
  readonly to: string;
}

/** How many edges cross from one module to another. */
export interface HarEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

/** A dependency cycle's cost: the sum of the modules' durations along it. */
export interface TimingCycle {
  readonly modules: readonly string[];
  readonly ms: number;
}

export interface DepGraph {
  readonly files: readonly DepGraphFile[];
  readonly edges: readonly DepGraphEdge[];
  /** Cross-module edge counts, sorted by `(from, to)`. */
  readonly harEdges: readonly HarEdge[];
  /** Only non-empty when per-module durations were supplied. */
  readonly timingCycles: readonly TimingCycle[];
}

/** The segments of a path, with Windows separators normalized. */
function segments(path: string): string[] {
  return path.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
}

/** `path` is `prefix` or sits under it, by whole segments. */
function underSegments(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (path[index] !== prefix[index]) return false;
  }
  return true;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the dependency graph.
 *
 * `files` are project-relative paths; `modules` declare ownership; `edges`
 * are imports between those paths. Output order is fixed — files by path,
 * edges by `(from, to)`, cross-module counts by `(from, to)` — so two runs
 * over the same input produce identical JSON.
 */
export function buildDepGraph(
  files: readonly string[],
  modules: readonly ModuleDecl[],
  edges: readonly DepGraphEdge[] = [],
  durationsMs: Readonly<Record<string, number>> = {},
): DepGraph {
  const moduleSegments = modules.map((module) => ({
    name: module.name,
    segments: segments(module.path),
  }));

  /** The longest module path that is a segment-prefix of `path`. */
  const owner = (path: string): string | undefined => {
    const parts = segments(path);
    let best: { name: string; length: number } | undefined;
    for (const module of moduleSegments) {
      if (!underSegments(parts, module.segments)) continue;
      if (best === undefined || module.segments.length > best.length) {
        best = { name: module.name, length: module.segments.length };
      }
    }
    return best?.name;
  };

  const graphFiles: DepGraphFile[] = [...files]
    .sort(compare)
    .map((path) => {
      const module = owner(path);
      return module === undefined ? { path } : { path, module };
    });
  const ownerOf = new Map(graphFiles.map((file) => [file.path, file.module]));

  const graphEdges: DepGraphEdge[] = [...edges]
    .map((edge) => ({ from: edge.from, to: edge.to }))
    .sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));

  const counts = new Map<string, HarEdge>();
  for (const edge of graphEdges) {
    const from = ownerOf.get(edge.from);
    const to = ownerOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { from, to, count: 1 });
    else counts.set(key, { from, to, count: existing.count + 1 });
  }
  const harEdges = [...counts.values()].sort(
    (a, b) => compare(a.from, b.from) || compare(a.to, b.to),
  );

  const timingCycles = computeTimingCycles(harEdges, durationsMs);

  return { files: graphFiles, edges: graphEdges, harEdges, timingCycles };
}

/**
 * One `timingCycle` per cross-module edge, when durations are supplied.
 *
 * HapRay sums the durations on a path; with a flat module graph the path is
 * the edge itself, so the cycle is the two endpoints' durations. A module with
 * no duration contributes nothing, and an input with no durations produces no
 * cycles rather than zero-millisecond ones.
 */
function computeTimingCycles(
  harEdges: readonly HarEdge[],
  durationsMs: Readonly<Record<string, number>>,
): TimingCycle[] {
  const modules = Object.keys(durationsMs);
  if (modules.length === 0) return [];
  const cycles: TimingCycle[] = [];
  for (const edge of harEdges) {
    const from = durationsMs[edge.from];
    const to = durationsMs[edge.to];
    if (from === undefined || to === undefined) continue;
    cycles.push({ modules: [edge.from, edge.to], ms: from + to });
  }
  return cycles;
}
