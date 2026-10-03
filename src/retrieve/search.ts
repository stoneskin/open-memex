import { db } from "../store/db.ts";
import { toFtsQuery } from "./query.ts";

export interface SearchHit {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  tags: string[];
  snippet: string;
  score: number;
  updated_at: number;
  status: string;
  review_state: string;
}

interface RawRow {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  tags: string;
  updated_at: number;
  snippet: string;
  score: number;
  status: string;
  superseded_by: string | null;
  review_state: string;
}

function toHit(r: RawRow): SearchHit {
  return {
    id: r.id,
    scope_key: r.scope_key,
    project_name: r.project_name,
    type: r.type,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    snippet: r.snippet ?? "",
    score: r.score,
    updated_at: r.updated_at,
    status: r.status,
    review_state: r.review_state ?? "draft",
  };
}

/**
 * D30: review-state ranking tiers for shared (project) memories.
 * Reviewed knowledge (approved/published) outranks unreviewed outbox drafts;
 * personal memories are always `draft` by design and are NOT demoted.
 * Stable: order within a tier keeps the incoming score/recency order.
 */
function reviewTier(r: RawRow): number {
  if (r.scope_key === "personal") return 1;
  if (r.review_state === "approved" || r.review_state === "published") return 0;
  if (r.review_state === "draft" || r.review_state === "rejected") return 2;
  return 1; // proposed and anything unexpected
}

/** D30: `[draft]` / `[proposed]` / … marker for project memories.
 *  Personal memories stay unmarked (always draft — the marker would be noise). */
export function hitStateLabel(h: Pick<SearchHit, "scope_key" | "review_state">): string {
  if (h.scope_key === "personal") return "";
  return ` [${h.review_state || "draft"}]`;
}

/**
 * Lifecycle-aware post-processing (§3.3):
 * - retracted / archived are excluded from retrieval (kept for audit);
 * - a superseded memory resolves to the newest of its chain (cycle-safe);
 * - D30: approved/published project memories rank first, project
 *   drafts/rejected rank after unreviewed content;
 * - deprecated stays visible as a warning but ranks after active.
 */
function resolveVisible(rows: RawRow[], limit: number): SearchHit[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fullRow = (id: string): RawRow | undefined => {
    const cached = byId.get(id);
    if (cached) return cached;
    const r = db()
      .prepare(
        `SELECT id, scope_key, project_name, type, tags, updated_at, status,
                superseded_by, review_state, substr(content, 1, 240) AS snippet
         FROM memories WHERE id = ?`,
      )
      .get(id) as
      | (Omit<RawRow, "score" | "snippet"> & { snippet: string })
      | undefined;
    if (!r) return undefined;
    const full: RawRow = { ...r, score: 0 };
    byId.set(id, full);
    return full;
  };

  const seen = new Set<string>();
  const tiers: SearchHit[][] = [[], [], [], []];
  const deprecated: SearchHit[] = [];

  for (const r of rows) {
    if (r.status === "retracted" || r.status === "archived") continue;
    let target = r;
    if (r.status === "superseded") {
      let cur = r;
      const chain = new Set([r.id]);
      while (cur.status === "superseded" && cur.superseded_by) {
        if (chain.has(cur.superseded_by)) break; // cycle guard
        chain.add(cur.superseded_by);
        const nxt = fullRow(cur.superseded_by);
        if (!nxt) break;
        cur = nxt;
      }
      if (cur.status === "retracted" || cur.status === "archived") continue;
      target = cur;
    }
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const hit = toHit(target);
    if (target.status === "deprecated") deprecated.push(hit);
    else tiers[reviewTier(target)].push(hit);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2], ...deprecated].slice(0, limit);
}

/**
 * FTS5 query construction lives in query.ts (pure, unit-tested): free-text
 * questions are split into content terms (OR-ed; bm25 ranks), with
 * function/question words filtered so they can't dilute the ranking.
 */
export function search(
  query: string,
  opts: { scopeKeys?: string[]; limit?: number; type?: string } = {},
): SearchHit[] {
  const q = toFtsQuery(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
  // Over-fetch: lifecycle filtering (chain resolution, exclusions) happens
  // after the FTS query, so candidates must survive it.
  const fetchLimit = Math.min(limit * 3 + 10, 150);

  const scopeFilter =
    opts.scopeKeys && opts.scopeKeys.length > 0
      ? ` AND m.scope_key IN (${opts.scopeKeys.map(() => "?").join(",")})`
      : "";
  const typeFilter = opts.type ? ` AND m.type = ?` : "";

  const sql = `
    SELECT m.id, m.scope_key, m.project_name, m.type, m.tags, m.updated_at,
           m.status, m.superseded_by, m.review_state,
           snippet(memories_fts, 0, '[', ']', ' ... ', 12) AS snippet,
           bm25(memories_fts) AS score
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?${scopeFilter}${typeFilter}
    ORDER BY score ASC
    LIMIT ?
  `;
  const params: unknown[] = [q];
  if (opts.scopeKeys && opts.scopeKeys.length > 0) params.push(...opts.scopeKeys);
  if (opts.type) params.push(opts.type);
  params.push(fetchLimit);

  const rows = db()
    .prepare(sql)
    .all(...(params as any[])) as Array<{
    id: string;
    scope_key: string;
    project_name: string;
    type: string;
    tags: string;
    updated_at: number;
    status: string;
    superseded_by: string | null;
    review_state: string;
    snippet: string;
    score: number;
  }>;

  // FTS5 bm25: lower = better; invert for intuition.
  const raw: RawRow[] = rows.map((r) => ({ ...r, score: -r.score }));
  return resolveVisible(raw, limit);
}

export function list(
  scopeKey: string,
  opts: { type?: string; limit?: number } = {},
): SearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const fetchLimit = Math.min(limit * 3 + 10, 150);
  const typeFilter = opts.type ? ` AND type = ?` : "";
  const sql = `
    SELECT id, scope_key, project_name, type, tags, updated_at, status,
           superseded_by, review_state, substr(content, 1, 240) AS snippet
    FROM memories
    WHERE scope_key = ?${typeFilter}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  const params: unknown[] = [scopeKey];
  if (opts.type) params.push(opts.type);
  params.push(fetchLimit);

  const rows = db()
    .prepare(sql)
    .all(...(params as any[])) as Array<{
    id: string;
    scope_key: string;
    project_name: string;
    type: string;
    tags: string;
    updated_at: number;
    status: string;
    superseded_by: string | null;
    review_state: string;
    snippet: string;
  }>;

  const raw: RawRow[] = rows.map((r) => ({ ...r, score: 1 }));
  return resolveVisible(raw, limit);
}
