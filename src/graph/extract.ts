/**
 * §20.3 (D88): the graph layer — structural edges only, extracted by
 * deterministic rules. No LLM, no network: everything here runs on the
 * memory rows already on this machine.
 *
 * Borrowing Graphify's tree-sitter principle (§20.5): structure is
 * *extracted*, not inferred. What the memory states in frontmatter
 * (supersedes chain, derived_from) and in its body (an explicit mention of
 * another memory's id) becomes an EXTRACTED edge — explicit evidence in
 * the source, confidence `high`. What the system merely notices (two
 * active memories sharing a tag) is an INFERRED edge — a suggestion, never
 * presented as a fact (§11's trust model). Inferred edges are always
 * marked, so a graph hit can never quietly become "the source said so".
 *
 * Whether `related` enters the frontmatter is a v0.3 protocol decision
 * (§20.8); until then edges live only in this derived layer. The layer is
 * rebuildable: `graph build` re-derives everything from the Markdown
 * source of truth (D1).
 */

export type EdgeType = "supersedes" | "derived-from" | "relates-to";
export type Provenance = "EXTRACTED" | "INFERRED";
export type Confidence = "high" | "medium" | "low";

/** One memory row as the graph sees it — a projection of the index. */
export interface GraphNode {
  id: string;
  status: string;
  type: string;
  tags: string[];
  body: string;
  /** Frontmatter `supersedes` (on the NEW memory, points BACK at the old). */
  supersedes?: string | null;
  /** Frontmatter `derived_from` (propose-copies point at the personal original). */
  derived_from?: string | null;
  /** Optional pre-truncated one-liner for outline rendering. */
  snippet?: string;
}

/** One directed edge with provenance (§20.3). */
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  provenance: Provenance;
  confidence: Confidence;
  /** What produced the edge (e.g. `shared-tag:deploy,ci`), for query receipts. */
  via: string;
}

/**
 * The deterministic confidence ladder for shared-tag edges: one shared tag
 * is the weakest signal, two starts to connect, three or more together are
 * a strong one. Decision D91 keeps this fixed — an agent reading a graph
 * hit gets the same meaning on every install.
 */
export function sharedTagConfidence(sharedCount: number): Confidence {
  if (sharedCount >= 3) return "high";
  if (sharedCount === 2) return "medium";
  return "low";
}

/**
 * Crockford-base32 alphabet ULID (0-9, A-Z minus I, L, O, U) delimited by
 * non-alphanumerics. The look-arounds keep a longer prefixed token from
 * matching as a "mention": only a standalone id in the body counts as
 * explicit evidence. The class must exclude L as well as I/O/U — a token
 * like `FLATBATTERYWELLSXXQZABCDEF` is a word, not an id, and an EXTRACTED
 * edge means the source said it explicitly.
 */
const ULID_RE = /(?<![0-9A-Z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Z])/g;

/**
 * Per-node cap on INFERRED shared-tag edges. A dense tag vocabulary would
 * otherwise grow the stored layer quadratically; the cap keeps, per node,
 * the top neighbours by (shared count desc, id asc) — deterministic — and
 * never drops an EXTRACTED edge.
 */
export const MAX_SHARED_TAG_EDGES_PER_NODE = 12;

/**
 * The node count above which shared-tag inference is skipped entirely.
 * At that scale the O(n²) pair scan stops being cheap; the LLM half of
 * §20, not more low-confidence edges, is the answer there.
 */
export const MAX_SHARED_TAG_NODES = 2000;

/** One edge per (from, to, type). Used while collecting raw candidates. */
function dedupInsert(list: GraphEdge[], edge: GraphEdge): void {
  for (const e of list) {
    if (e.from === edge.from && e.to === edge.to && e.type === edge.type) return;
  }
  list.push(edge);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Extract all structural edges for a set of nodes (§20.3):
 *
 * - `supersedes`   — frontmatter chain, new → old (EXTRACTED / high).
 * - `derived-from` — frontmatter `derived_from`, copy → original (EXTRACTED / high).
 * - `relates-to`   — EXTRACTED when one body explicitly mentions another
 *                    memory's ULID; INFERRED (with the shared-tag
 *                    confidence ladder) when two active memories share
 *                    tags. One edge per unordered pair; the EXTRACTED
 *                    body-mention beats the INFERRED link for the same pair.
 *
 * Edges are returned sorted (from, to, type) so two builds over the same
 * data produce byte-identical output — the graph must behave like a
 * derived index, not like a fickle cache.
 */
export function extractEdges(nodes: GraphNode[]): GraphEdge[] {
  const raw: GraphEdge[] = [];

  for (const n of nodes) {
    if (n.supersedes && n.supersedes !== n.id) {
      dedupInsert(raw, {
        from: n.id,
        to: n.supersedes,
        type: "supersedes",
        provenance: "EXTRACTED",
        confidence: "high",
        via: "supersede-chain",
      });
    }
    if (n.derived_from && n.derived_from !== n.id) {
      dedupInsert(raw, {
        from: n.id,
        to: n.derived_from,
        type: "derived-from",
        provenance: "EXTRACTED",
        confidence: "high",
        via: "derive",
      });
    }
  }

  // Body mentions are stored even when the mentioned id is dangling —
  // lint enumerates it (graph/lint.ts); the query layer simply never
  // traverses into a node that does not exist.
  for (const n of nodes) {
    const mentioned = n.body.match(ULID_RE) ?? [];
    for (const m of mentioned) {
      if (m === n.id || m === n.supersedes || m === n.derived_from) continue;
      dedupInsert(raw, {
        from: n.id,
        to: m,
        type: "relates-to",
        provenance: "EXTRACTED",
        confidence: "high",
        via: "body-mention",
      });
    }
  }

  // Shared-tag inference scans ACTIVE memories only (a superseded version
  // of a fact would otherwise double every inference) and is canonicalized
  // to the unordered pair so `relates-to` stays one edge per pair.
  if (nodes.length > 0 && nodes.length <= MAX_SHARED_TAG_NODES) {
    const active = nodes.filter((n) => n.status === "active");
    const tagSets = new Map<string, Set<string>>();
    for (const n of active) tagSets.set(n.id, new Set(n.tags));

    const candidates = new Map<string, Array<{ to: string; shared: string[] }>>();
    const pairShared = new Map<string, string[]>();
    const listFor = (id: string): Array<{ to: string; shared: string[] }> => {
      let list = candidates.get(id);
      if (!list) {
        list = [];
        candidates.set(id, list);
      }
      return list;
    };

    for (let i = 0; i < active.length; i++) {
      const a = active[i]!;
      const aSet = tagSets.get(a.id)!;
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]!;
        const bSet = tagSets.get(b.id)!;
        const shared: string[] = [];
        for (const t of aSet) if (bSet.has(t)) shared.push(t);
        if (shared.length === 0) continue;
        shared.sort();
        pairShared.set(pairKey(a.id, b.id), shared);
        listFor(a.id)!.push({ to: b.id, shared });
        listFor(b.id)!.push({ to: a.id, shared });
      }
    }

    for (const [id, list] of candidates) {
      list.sort(
        (x, y) => y.shared.length - x.shared.length || x.to.localeCompare(y.to),
      );
      for (const c of list.slice(0, MAX_SHARED_TAG_EDGES_PER_NODE)) {
        // Canonical direction + skip self-order duplicates: emit each
        // unordered pair exactly once, from the smaller id's own list.
        if (id >= c.to) continue;
        dedupInsert(raw, {
          from: id,
          to: c.to,
          type: "relates-to",
          provenance: "INFERRED",
          confidence: sharedTagConfidence(pairShared.get(pairKey(id, c.to))!.length),
          via: `shared-tag:${pairShared.get(pairKey(id, c.to))!.join(",")}`,
        });
      }
    }
  }

  // Collapse relates-to to one edge per unordered pair, canonicalized to
  // the smaller id as `from`; the EXTRACTED body-mention beats the
  // INFERRED shared-tag edge for the same pair. The cap is per node, so
  // the two sides of a pair can disagree on which of them kept the edge —
  // canonicalizing here, after collection, is what makes the result
  // independent of which candidate list the edge happened to survive in.
  const relates = new Map<string, GraphEdge>();
  const out: GraphEdge[] = [];
  for (const e of raw) {
    if (e.type !== "relates-to") {
      out.push(e);
      continue;
    }
    const from = e.from < e.to ? e.from : e.to;
    const to = e.from < e.to ? e.to : e.from;
    const k = pairKey(from, to);
    const cur = relates.get(k);
    if (!cur || (cur.provenance === "INFERRED" && e.provenance === "EXTRACTED")) {
      relates.set(k, { ...e, from, to });
    }
  }
  for (const e of relates.values()) out.push(e);

  out.sort(
    (x, y) =>
      x.from === y.from
        ? x.to === y.to
          ? x.type.localeCompare(y.type)
          : x.to.localeCompare(y.to)
        : x.from.localeCompare(y.from),
  );
  return out;
}
