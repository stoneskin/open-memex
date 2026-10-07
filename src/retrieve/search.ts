import { db } from "../store/db.ts";
import { toFtsQuery } from "./query.ts";

export interface SearchHit {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  tags: string[];
  /** D61: capture-time aliases stored on this memory (search hits only). */
  aliases: string[];
  snippet: string;
  score: number;
  updated_at: number;
  status: string;
  review_state: string;
  /** D68: provenance + creation time for the plain-language inventory. */
  source: string;
  created_at: number;
}

interface RawRow {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  tags: string;
  aliases?: string;
  updated_at: number;
  snippet: string;
  score: number;
  status: string;
  superseded_by: string | null;
  review_state: string;
  source?: string;
  created_at?: number;
}

function toHit(r: RawRow): SearchHit {
  const aliases = r.aliases ? r.aliases.split(",").map((a) => a.trim()).filter(Boolean) : [];
  let snippet = r.snippet ?? "";
  // D61: the snippet highlights matches in the body column only. When the
  // match came through an alias (body shows no highlight), say so — the
  // hit otherwise looks unrelated to the query.
  if (aliases.length > 0 && !/\[[^\]]+\]/.test(snippet)) {
    snippet += ` (aka: ${aliases.join(", ")})`;
  }
  return {
    id: r.id,
    scope_key: r.scope_key,
    project_name: r.project_name,
    type: r.type,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    aliases,
    snippet,
    score: r.score,
    updated_at: r.updated_at,
    status: r.status,
    review_state: r.review_state ?? "draft",
    source: r.source ?? "",
    created_at: r.created_at ?? r.updated_at ?? 0,
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

/** Optional diagnostics out-param for `search --explain` (D57). */
export interface SearchStats {
  ftsQuery: string;
  candidates: number;
  hiddenSuperseded: number;
  hiddenExcluded: number;
}

/**
 * Lifecycle-aware post-processing (§3.3):
 * - retracted / archived are excluded from retrieval (kept for audit);
 * - a superseded memory resolves to the newest of its chain (cycle-safe);
 * - D30: approved/published project memories rank first, project
 *   drafts/rejected rank after unreviewed content;
 * - deprecated stays visible as a warning but ranks after active.
 */
function resolveVisible(rows: RawRow[], limit: number, stats?: SearchStats): SearchHit[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fullRow = (id: string): RawRow | undefined => {
    const cached = byId.get(id);
    if (cached) return cached;
    const r = db()
      .prepare(
        `SELECT id, scope_key, project_name, type, tags, updated_at, status,
                superseded_by, review_state, source, created_at, substr(content, 1, 240) AS snippet
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
    if (r.status === "retracted" || r.status === "archived") {
      if (stats) stats.hiddenExcluded++;
      continue;
    }
    let target = r;
    if (r.status === "superseded") {
      if (stats) stats.hiddenSuperseded++;
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
  opts: {
    scopeKeys?: string[];
    limit?: number;
    type?: string;
    stats?: SearchStats;
    /** Ablation toggles for query construction (default = shipped behavior). */
    stopwords?: boolean;
    orJoin?: boolean;
    prefix?: boolean;
  } = {},
): SearchHit[] {
  const qflags = { stopwords: opts.stopwords, orJoin: opts.orJoin, prefix: opts.prefix };
  const q = toFtsQuery(query, qflags);
  if (opts.stats) {
    opts.stats.ftsQuery = q;
    opts.stats.candidates = 0;
    opts.stats.hiddenSuperseded = 0;
    opts.stats.hiddenExcluded = 0;
  }
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
    SELECT m.id, m.scope_key, m.project_name, m.type, m.tags, m.aliases, m.updated_at,
           m.status, m.superseded_by, m.review_state, m.source, m.created_at,
           snippet(memories_fts, 0, '[', ']', ' ... ', 12) AS snippet,
           bm25(memories_fts) AS score
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?${scopeFilter}${typeFilter}
    ORDER BY score ASC
    LIMIT ?
  `;
  type Row = {
    id: string;
    scope_key: string;
    project_name: string;
    type: string;
    tags: string;
    updated_at: number;
    status: string;
    superseded_by: string | null;
    review_state: string;
    source: string;
    created_at: number;
    snippet: string;
    score: number;
  };
  const fetchFts = (matchExpr: string): RawRow[] => {
    const params: unknown[] = [matchExpr];
    if (opts.scopeKeys && opts.scopeKeys.length > 0) params.push(...opts.scopeKeys);
    if (opts.type) params.push(opts.type);
    params.push(fetchLimit);
    const rows = db()
      .prepare(sql)
      .all(...(params as any[])) as Row[];
    // FTS5 bm25: lower = better; invert for intuition.
    return rows.map((r) => ({ ...r, score: -r.score }));
  };

  const raw: RawRow[] = fetchFts(q);

  // D80: vocabulary mismatch is solved at index time (synonyms.ts expands
  // curated variants into the aliases column at sync time), so the query
  // side is a single FTS round — no trigger, no second chance.
  if (opts.stats) opts.stats.candidates = raw.length;
  return resolveVisible(raw, limit, opts.stats);
}

export function list(
  scopeKey: string,
  opts: { type?: string; limit?: number; include?: "active" | "all" } = {},
): SearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const fetchLimit = Math.min(limit * 3 + 10, 150);
  const typeFilter = opts.type ? ` AND type = ?` : "";
  const sql = `
    SELECT id, scope_key, project_name, type, tags, updated_at, status,
           superseded_by, review_state, source, created_at, substr(content, 1, 240) AS snippet
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
    source: string;
    created_at: number;
    snippet: string;
  }>;

  const raw: RawRow[] = rows.map((r) => ({ ...r, score: 1 }));
  if (opts.include === "all") {
    // D68: the audit view — every row as stored (superseded versions,
    // retracted, archived), no chain collapsing, capped at limit.
    return raw.slice(0, limit).map(toHit);
  }
  return resolveVisible(raw, limit);
}

/**
 * True totals for the inventory's truncation disclosure (D68). Under
 * `active` the visible set is the newest of each chain, which in a
 * consistent store is exactly the rows whose status is active/deprecated.
 *
 * D70: one deliberate exception — a `superseded` row whose chain target is
 * missing (a dangling pointer, which the read path self-heals with a
 * warning) is returned as a visible hit by resolveVisible but is not
 * counted here, so the total can read one low in that state. Not worth
 * widening the query for a self-healing case; the disclosure stays honest
 * in every state a user can reach deliberately.
 */
export function countList(
  scopeKey: string,
  opts: { type?: string; include?: "active" | "all" } = {},
): number {
  const typeFilter = opts.type ? ` AND type = ?` : "";
  const statusFilter =
    opts.include === "all" ? "" : ` AND status IN ('active', 'deprecated')`;
  const params: unknown[] = [scopeKey];
  if (opts.type) params.push(opts.type);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE scope_key = ?${statusFilter}${typeFilter}`,
    )
    .get(...(params as any[])) as { n: number };
  return row.n;
}
