/**
 * §20.4 / D88: the compiled outline — one compact topic map of what is in
 * memory, derived from the structural graph and injected at session start.
 *
 * Injection-cost discipline (2026-10-19): "important but not every turn"
 * stays on-demand, so this renderer exposes a line cap (D91: default 10)
 * and nothing more. Topics are components of active memories joined ONLY
 * by medium/high INFERRED shared-tag edges — a low-confidence edge (one
 * shared tag) never contributes to a topic. That is the guard against the
 * universal-tag collapse: one common tag across the whole store produces
 * only low band edges, so the store cannot silently fuse into a single
 * "topic" that says nothing. Body-mention / supersedes / derived-from
 * edges are EXTRACTED evidence for queries and lint, not topic glue —
 * two memories can point at each other in prose without belonging to
 * the same cluster.
 */

import type { GraphEdge, GraphNode } from "./extract.ts";

export interface OutlineTopic {
  /** The most representative shared tag inside the topic. */
  name: string;
  ids: string[];
  size: number;
  /** Member ids whose one-liners actually appear in the rendered line. */
  snippetIds: string[];
}

export interface OutlineResult {
  /** Rendered lines (topics first, disclosure last), capped by maxLines. */
  lines: string[];
  topics: OutlineTopic[];
  /** Ids named in the lines — the outline is a retrieval surface (D77-L2). */
  exposureIds: string[];
  /** Rendered topics that did not fit the cap. */
  droppedTopics: number;
  /** Active memories not in any topic (disclosed, never listed). */
  outsideCount: number;
}

function oneLine(s: string, max = 120): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max - 3) + "..." : trimmed;
}

/** Union-find over string ids. Both-sides threading keeps the same shape
 *  as the package's other pure modules (small, no deps). */
class UnionFind {
  private parent = new Map<string, string>();
  find(id: string): string {
    if (!this.parent.has(id)) this.parent.set(id, id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Render the outline. `nodes` must be the visible set (active memories —
 * the caller filters; superseded versions belong to history, not to the
 * "what is in memory" map). `edges` must already be scoped to those nodes.
 */
export function renderOutline(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { maxLines?: number } = {},
): OutlineResult {
  // Floor 1, ceiling 30 (the same bound `config set graphOutlineLines`
  // enforces) — a hand-edited config file must not be able to blow up the
  // session-start injection.
  const maxLines = Math.min(30, Math.max(1, opts.maxLines ?? 10));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const uf = new UnionFind();
  for (const n of nodes) uf.find(n.id);
  for (const e of edges) {
    if (e.provenance !== "INFERRED") continue;
    if (e.confidence !== "medium" && e.confidence !== "high") continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    uf.union(e.from, e.to);
  }

  const components = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const root = uf.find(n.id);
    const list = components.get(root);
    if (list) list.push(n);
    else components.set(root, [n]);
  }

  const topics: OutlineTopic[] = [];
  let outside = 0;
  for (const members of components.values()) {
    if (members.length < 2) {
      outside++;
      continue;
    }
    // Topic name: the tag with the most occurrences among members
    // (counted per member), ties broken lexicographically. A universal
    // tag can win here when a topic is real anyway — that is fine; what
    // it can never do by itself is CREATE the component (only medium+ 
    // edges join).
    const counts = new Map<string, number>();
    for (const m of members) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    let name = "";
    let best = 0;
    for (const [t, c] of counts) {
      if (c > best || (c === best && (name === "" || t < name))) {
        name = t;
        best = c;
      }
    }
    if (!name) name = "related";
    // Snippet members: largest-tag-bearing members first, stable by id.
    const ordered = [...members].sort((x, y) => {
      const cx = x.tags.includes(name) ? 1 : 0;
      const cy = y.tags.includes(name) ? 1 : 0;
      return cy - cx || x.id.localeCompare(y.id);
    });
    topics.push({
      name,
      size: members.length,
      ids: members.map((m) => m.id),
      snippetIds: ordered.slice(0, 2).map((m) => m.id),
    });
  }

  topics.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name) || a.ids[0]!.localeCompare(b.ids[0]!));

  const shown = topics.slice(0, maxLines);
  const dropped = topics.length - shown.length;
  const lines: string[] = [];
  const exposureIds: string[] = [];
  for (const t of shown) {
    const members = t.ids
      .map((id) => byId.get(id)!)
      .filter(Boolean);
    const tagMembers = members.filter((m) => m.tags.includes(t.name));
    const snippets = (tagMembers.length > 0 ? tagMembers : members)
      .slice(0, 2)
      .map((m) => oneLine(m.snippet ?? m.body));
    lines.push(`- ${t.name} (${t.size}): ${snippets.join(" | ")}`);
    for (const id of t.snippetIds) exposureIds.push(id);
  }
  if (dropped > 0) lines.push(`(+${dropped} more topic${dropped === 1 ? "" : "s"} not shown)`);
  if (outside > 0) {
    lines.push(`(+${outside} memor${outside === 1 ? "y" : "ies"} not in any topic)`);
  }

  return { lines, topics: shown, exposureIds, droppedTopics: dropped, outsideCount: outside };
}
