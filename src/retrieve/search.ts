import { db } from "../store/db.ts";
import { cjkQueryExpr, hasCjk } from "./cjk.ts";

export interface SearchHit {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  tags: string[];
  snippet: string;
  score: number;
  updated_at: number;
}

/**
 * Convert free-text query into a safe FTS5 MATCH expression.
 * Latin tokens keep the old behavior (prefix match on content/tags/type).
 * CJK runs become an OR of bigrams against the `cjk` column (see cjk.ts).
 * Mixed queries OR the two parts together.
 */
function toFtsQuery(q: string): string {
  const latin = (q.toLowerCase().match(/[a-z0-9_.\-]+/g) ?? [])
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" OR ");
  const cjk = hasCjk(q) ? cjkQueryExpr(q) : "";
  if (latin && cjk) return `(${latin}) OR {cjk}:(${cjk})`;
  if (cjk) return `{cjk}:(${cjk})`;
  return latin;
}

export function search(
  query: string,
  opts: { scopeKeys?: string[]; limit?: number; type?: string } = {},
): SearchHit[] {
  const q = toFtsQuery(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));

  const scopeFilter =
    opts.scopeKeys && opts.scopeKeys.length > 0
      ? ` AND m.scope_key IN (${opts.scopeKeys.map(() => "?").join(",")})`
      : "";
  const typeFilter = opts.type ? ` AND m.type = ?` : "";

  const sql = `
    SELECT m.id, m.scope_key, m.project_name, m.type, m.tags, m.updated_at,
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
  params.push(limit);

  const rows = db()
    .prepare(sql)
    .all(...(params as any[])) as Array<{
    id: string;
    scope_key: string;
    project_name: string;
    type: string;
    tags: string;
    updated_at: number;
    snippet: string;
    score: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    scope_key: r.scope_key,
    project_name: r.project_name,
    type: r.type,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    snippet: r.snippet ?? "",
    score: -r.score, // FTS5 bm25: lower = better; invert for intuition
    updated_at: r.updated_at,
  }));
}

export function list(
  scopeKey: string,
  opts: { type?: string; limit?: number } = {},
): SearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const typeFilter = opts.type ? ` AND type = ?` : "";
  const sql = `
    SELECT id, scope_key, project_name, type, tags, updated_at,
           substr(content, 1, 240) AS snippet
    FROM memories
    WHERE scope_key = ?${typeFilter}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  const params: unknown[] = [scopeKey];
  if (opts.type) params.push(opts.type);
  params.push(limit);

  const rows = db()
    .prepare(sql)
    .all(...(params as any[])) as Array<{
    id: string;
    scope_key: string;
    project_name: string;
    type: string;
    tags: string;
    updated_at: number;
    snippet: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    scope_key: r.scope_key,
    project_name: r.project_name,
    type: r.type,
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    snippet: r.snippet ?? "",
    score: 1,
    updated_at: r.updated_at,
  }));
}
