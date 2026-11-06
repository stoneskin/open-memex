/**
 * §20.4 (D88): graph traversal as a read path — a node's neighbours and
 * the shortest path between two memories. Pure over the extracted edge
 * list; the store layer (src/store/graph.ts) owns persistence and gets
 * edges back from here untouched.
 *
 * Traversal is undirected: a `supersedes` edge says new → old in the
 * frontmatter, but from the reader's side a chain link works both ways.
 * Every hop carries its edge (type + provenance + confidence + via) so a
 * query receipt can tell the reader which connection was travelled and
 * whether it was INFERRED — §20.3's rule that an inferred link must never
 * look like a fact that was in the source.
 *
 * Traversal never crosses into a node that is not in the node set: a
 * dangling id in an edge is lint's finding to report, not a ghost node
 * to walk through.
 */

import type { GraphEdge, GraphNode } from "./extract.ts";

export interface NeighbourHit {
  id: string;
  /** BFS depth at which this neighbour was reached (1 = direct). */
  depth: number;
  /** The edge(s) that reached this node, one per discovery path's shortest layer. */
  via: GraphEdge;
}

/** Undirected adjacency: id → outgoing + incoming edges. */
export function buildAdjacency(edges: GraphEdge[], nodeIds: Iterable<string>): Map<string, GraphEdge[]> {
  const known = new Set(nodeIds);
  const adj = new Map<string, GraphEdge[]>();
  for (const id of known) adj.set(id, []);
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    adj.get(e.from)!.push(e);
    const back: GraphEdge = { ...e, from: e.to, to: e.from };
    adj.get(e.to)!.push(back);
  }
  return adj;
}

/**
 * BFS neighbours of `startId`, nearest first (depth ascending, id
 * ascending within a depth — deterministic output). `maxDepth` caps the
 * walk; `maxNodes` caps the result the same way a search `limit` does.
 * The start node itself is never returned.
 */
export function graphNeighbours(
  startId: string,
  edges: GraphEdge[],
  nodeIds: Iterable<string>,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): NeighbourHit[] {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 1, 6));
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 20, 100));
  const adj = buildAdjacency(edges, nodeIds);
  if (!adj.has(startId)) return [];

  const visited = new Set<string>([startId]);
  const hits: NeighbourHit[] = [];
  let frontier: Array<{ id: string; via: GraphEdge }> = [];
  const enqueue = (edges: GraphEdge[]) => {
    for (const e of [...edges].sort((a, b) => a.to.localeCompare(b.to))) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      frontier.push({ id: e.to, via: e });
    }
  };
  enqueue(adj.get(startId)!);
  let depth = 1;
  for (; depth <= maxDepth && frontier.length > 0 && hits.length < maxNodes; depth++) {
    const layer = [...frontier]
      .sort((a, b) => a.id.localeCompare(b.id) || a.via.via.localeCompare(b.via.via))
      .slice(0, maxNodes - hits.length);
    for (const f of layer) hits.push({ id: f.id, depth, via: f.via });
    const next: Array<{ id: string; via: GraphEdge }> = [];
    for (const f of layer) {
      if (next.length + hits.length >= maxNodes) break;
      for (const e of adj.get(f.id) ?? []) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        next.push({ id: e.to, via: e });
      }
    }
    frontier = next;
  }
  return hits;
}

export interface PathResult {
  found: boolean;
  /** The edges travelled in order, from-first to to-last (traversal direction). */
  hops: GraphEdge[];
}

/**
 * Shortest path between two ids (BFS, undirected, `maxDepth` cap). Each
 * hop keeps the edge object in travel direction — the receipt reads
 * "A —[relates-to INFERRED/medium (shared-tag:x)]—> B", whether or not
 * that was the stored direction.
 */
export function shortestPath(
  fromId: string,
  toId: string,
  edges: GraphEdge[],
  nodeIds: Iterable<string>,
  opts: { maxDepth?: number } = {},
): PathResult {
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 4, 6));
  if (fromId === toId) return { found: true, hops: [] };
  const adj = buildAdjacency(edges, nodeIds);
  if (!adj.has(fromId) || !adj.has(toId)) return { found: false, hops: [] };

  const prev = new Map<string, GraphEdge>();
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;
    const next: string[] = [];
    for (const cur of frontier.sort((a, b) => a.localeCompare(b))) {
      for (const e of [...(adj.get(cur) ?? [])].sort((a, b) => a.to.localeCompare(b.to))) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        prev.set(e.to, e);
        if (e.to === toId) {
          // Walk back, then reverse into travel order.
          const hops: GraphEdge[] = [];
          let at = toId;
          while (at !== fromId) {
            const edge = prev.get(at)!;
            hops.unshift(edge);
            at = edge.from;
          }
          return { found: true, hops };
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return { found: false, hops: [] };
}
