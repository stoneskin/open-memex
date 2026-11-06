/**
 * §20 (D88), D91: the graph's persistence. The graph is a DERIVED layer —
 * rebuildable from the Markdown source of truth at any time — so it stores
 * into SQLite beside the FTS index, into tables created with
 * CREATE TABLE IF NOT EXISTS outside the versioned schema (same treatment
 * as the D77 `memory_usage` counters): `rebuildIndexSchema` never has to
 * think about it, and `refreshGraph` is the healer for any staleness.
 *
 * Storage per scope key:
 * - `graph_edges` — the structural edge list (see graph/extract.ts).
 * - `graph_meta`  — build stamp + the rendered compiled outline. The
 *   outline is stored text: the session-start injection reads it and is
 *   never responsible for rendering.
 *
 * Project scope only in D91 (decision): personal memories stay out of the
 * graph per §20.5's sync rule; the entry point no-ops for the personal key
 * so the write-path hooks can call it unconditionally.
 */

import { db } from "./db.ts";
import type { MyOMemoryConfig } from "../config.ts";
import { PERSONAL_SCOPE } from "../scope.ts";
import {
  extractEdges,
  type GraphEdge,
  type GraphNode,
} from "../graph/extract.ts";
import { renderOutline } from "../graph/outline.ts";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  scope_key  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  edge_type  TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence TEXT NOT NULL,
  via        TEXT NOT NULL,
  PRIMARY KEY (scope_key, from_id, to_id, edge_type)
);
CREATE TABLE IF NOT EXISTS graph_meta (
  scope_key   TEXT PRIMARY KEY,
  built_at    TEXT NOT NULL,
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  outline     TEXT NOT NULL DEFAULT '',
  outline_ids TEXT NOT NULL DEFAULT '[]'
);
`;

let _graphSchemaReady = false;
function ensureSchema(): void {
  if (_graphSchemaReady) return;
  db().exec(GRAPH_SCHEMA);
  _graphSchemaReady = true;
}

export interface RefreshResult {
  scopeKey: string;
  nodes: number;
  edges: number;
  topics: number;
  /** Rendered outline line count the injection will show. */
  outlineLines: number;
}

/**
 * Rebuild the graph for one scope from the index in a single pass:
 * read rows → extract structural edges → replace the scope's edge set →
 * render + store the outline. Reads everything it needs up front so the
 * DELETE + INSERT sequence is short. The Markdown files are untouched.
 */
export function refreshGraph(scopeKey: string, cfg?: MyOMemoryConfig): RefreshResult {
  ensureSchema();
  // The index carries the chain as `superseded_by` (old → forward pointer,
  // §3.3); the frontmatter's back pointer (`supersedes` on the new file)
  // is not an indexed column. The graph derives the new → old direction
  // from the indexed one instead of adding yet another column the sync
  // layer must keep in lockstep.
  const rows = db()
    .prepare(
      `SELECT id, type, tags, content, status, superseded_by, derived_from
       FROM memories WHERE scope_key = ?`,
    )
    .all(scopeKey) as Array<{
    id: string;
    type: string;
    tags: string;
    content: string;
    status: string;
    superseded_by: string | null;
    derived_from: string | null;
  }>;
  // new → old: every row pointing forward via superseded_by means the
  // TARGET of that pointer is a newer memory that superseded it.
  const supersedesByTarget = new Map<string, string>();
  for (const r of rows) {
    if (r.superseded_by && r.superseded_by !== r.id) supersedesByTarget.set(r.superseded_by, r.id);
  }

  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    type: r.type,
    tags: r.tags ? r.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    body: r.content,
    supersedes: supersedesByTarget.get(r.id) ?? null,
    derived_from: r.derived_from,
    snippet: r.content.replace(/\s+/g, " ").trim().slice(0, 140),
  }));

  const edges: GraphEdge[] = extractEdges(nodes);

  const d = db();
  d.exec("BEGIN");
  try {
    d.prepare(`DELETE FROM graph_edges WHERE scope_key = ?`).run(scopeKey);
    const insert = d.prepare(
      `INSERT OR IGNORE INTO graph_edges
       (scope_key, from_id, to_id, edge_type, provenance, confidence, via)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges) {
      insert.run(scopeKey, e.from, e.to, e.type, e.provenance, e.confidence, e.via);
    }

    // The outline compiles the VISIBLE set (active memories — superseded
    // versions are history, not "what is in memory"; §20.4's query side
    // keeps the full graph including chains).
    const visible = nodes.filter((n) => n.status === "active");
    const visibleIds = new Set(visible.map((n) => n.id));
    const visibleEdges = edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );
    const linesCfg = cfg ?? { graphOutlineLines: 10 } as MyOMemoryConfig;
    const rendered = renderOutline(visible, visibleEdges, {
      maxLines: linesCfg.graphOutlineLines ?? 10,
    });
    d.prepare(
      `INSERT INTO graph_meta (scope_key, built_at, node_count, edge_count, outline, outline_ids)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         built_at = excluded.built_at,
         node_count = excluded.node_count,
         edge_count = excluded.edge_count,
         outline = excluded.outline,
         outline_ids = excluded.outline_ids`,
    ).run(
      scopeKey,
      new Date().toISOString(),
      nodes.length,
      edges.length,
      rendered.lines.join("\n"),
      JSON.stringify(rendered.exposureIds),
    );
    d.exec("COMMIT");
    return {
      scopeKey,
      nodes: nodes.length,
      edges: edges.length,
      topics: rendered.topics.length,
      outlineLines: rendered.lines.length,
    };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The write-path ingest hook (§20.4): deterministic extraction is cheap at
 * memory-store sizes, so every mutating surface refreshes the project
 * graph right after its write. Never throws — the memory write is the
 * source of truth and must not fail on a derived-layer hiccup; problems
 * say so on stderr like every other diagnostic. Personal scope no-ops.
 */
export function refreshGraphQuiet(scopeKey: string, cfg?: MyOMemoryConfig): boolean {
  if (!scopeKey || scopeKey === PERSONAL_SCOPE.key) return false;
  try {
    refreshGraph(scopeKey, cfg);
    return true;
  } catch (e) {
    console.error(
      `[open-memex] graph refresh failed (outlines and graph queries may be stale): ${(e as Error).message}`,
    );
    return false;
  }
}

export interface StoredGraph {
  builtAt: string;
  nodes: number;
  edges: number;
  outline: string;
  outlineIds: string[];
}

/**
 * Read the stored graph, building it first when never built (lazy first
 * ingest so a fresh install shows the outline on turn one without waiting
 * for an explicit `graph build`). Refresh is quiet — a failed derived-layer
 * build yields null and the injection proceeds without it.
 */
export function ensureGraph(scopeKey: string, cfg?: MyOMemoryConfig): StoredGraph | null {
  ensureSchema();
  const has = db()
    .prepare(`SELECT built_at FROM graph_meta WHERE scope_key = ?`)
    .get(scopeKey) as { built_at: string } | undefined;
  if (!has) refreshGraphQuiet(scopeKey, cfg);
  return getStoredGraph(scopeKey);
}

/** Read the stored outline for a scope, or null when never built. */
export function getStoredGraph(scopeKey: string): StoredGraph | null {
  ensureSchema();
  const row = db()
    .prepare(
      `SELECT built_at, node_count, edge_count, outline, outline_ids
       FROM graph_meta WHERE scope_key = ?`,
    )
    .get(scopeKey) as
    | { built_at: string; node_count: number; edge_count: number; outline: string; outline_ids: string }
    | undefined;
  if (!row) return null;
  let ids: string[] = [];
  try {
    ids = JSON.parse(row.outline_ids) as string[];
  } catch {
    ids = [];
  }
  return {
    builtAt: row.built_at,
    nodes: row.node_count,
    edges: row.edge_count,
    outline: row.outline,
    outlineIds: ids,
  };
}

/** All edges for a scope (query layer input). */
export function loadGraphEdges(scopeKey: string): GraphEdge[] {
  ensureSchema();
  const rows = db()
    .prepare(
      `SELECT from_id, to_id, edge_type, provenance, confidence, via
       FROM graph_edges WHERE scope_key = ?`,
    )
    .all(scopeKey) as Array<{
    from_id: string;
    to_id: string;
    edge_type: GraphEdge["type"];
    provenance: GraphEdge["provenance"];
    confidence: GraphEdge["confidence"];
    via: string;
  }>;
  return rows.map((r) => ({
    from: r.from_id,
    to: r.to_id,
    type: r.edge_type,
    provenance: r.provenance,
    confidence: r.confidence,
    via: r.via,
  }));
}

/** All nodes for a scope, as the query/lint layers see them. */
export function loadGraphNodes(scopeKey: string): GraphNode[] {
  const rows = db()
    .prepare(
      `SELECT id, type, tags, content, status FROM memories WHERE scope_key = ?`,
    )
    .all(scopeKey) as Array<{ id: string; type: string; tags: string; content: string; status: string }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    type: r.type,
    tags: r.tags ? r.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    body: r.content,
  }));
}

/**
 * Every id in the store across scopes (lint's cross-scope set): a propose
 * copy's derived_from legitimately points at the personal original, which
 * is not a node in the project graph — lint must skip it, not report it.
 */
export function loadAllMemoryIds(): string[] {
  ensureSchema();
  const rows = db()
    .prepare(`SELECT id FROM memories`)
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
