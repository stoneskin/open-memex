/**
 * D77-L2: per-memory online reuse counters — `retrieved_count` (exposure:
 * returned by search / list / first-turn injection) and useful counts,
 * split into `useful_self` (the author's own reuse — personal memories and
 * unpublished project drafts) and `useful_team` (reuse of reviewed project
 * knowledge). Derived: reuse_rate = (useful_self + useful_team) /
 * retrieved_count; "zombie memories" (retrieved, never useful) surface in
 * the D77-L3 report.
 *
 * Counters live in SQLite, NOT in frontmatter (D77): they are volatile
 * local telemetry, the Markdown source of truth never rewrites itself with
 * every retrieval, and they never leave the machine. The table is keyed by
 * memory id and deliberately sits OUTSIDE the rebuildable index schema —
 * `rebuildIndexSchema` drops `memories`/`memories_fts` but must not touch
 * counters (the ids survive a rebuild because the files carry them).
 *
 * Restraint rules (D77): useful only via explicit signal — `memory_useful`,
 * a human approve at review, or a behavioral reference (supersede).
 * Passive surfacing increments ONLY retrieved_count; unguarded exposure
 * must never refresh usefulness (the self-reinforcing retrieval loop).
 *
 * `reuse_rate` is the useful/retrieved ratio, not a probability: an explicit
 * confirmation does not require a matching recorded exposure in the same
 * counter window (a human can confirm a memory that paid off before counters
 * existed, or confirm the same payoff twice), so the ratio can exceed 1.0.
 * Read it as signal strength, not a percentage.
 */
import { db } from "./db.ts";

export type UsefulKind = "self" | "team";

export interface MemoryUsage {
  id: string;
  retrieved_count: number;
  useful_self: number;
  useful_team: number;
  last_retrieved_at: string; // RFC 3339, "" when never
  last_useful_at: string | null; // RFC 3339
  updated_at: string; // RFC 3339
}

export function usefulKindFor(scope: unknown, reviewState: unknown): UsefulKind {
  if (scope === "personal") return "self";
  // No identity system (D77): reviewed project knowledge reused = the team
  // story; everything else still reads as the author's own utility.
  if (reviewState === "approved" || reviewState === "published") return "team";
  return "self";
}

const INSERT_RETRIEVED_SQL = `
  INSERT INTO memory_usage (id, retrieved_count, useful_self, useful_team, last_retrieved_at, last_useful_at, updated_at)
  VALUES (?, 1, 0, 0, ?, NULL, ?)
  ON CONFLICT(id) DO UPDATE SET
    retrieved_count = memory_usage.retrieved_count + 1,
    last_retrieved_at = excluded.last_retrieved_at,
    updated_at = excluded.updated_at
`;

function insertUsefulSql(self: boolean): string {
  const col = self ? "useful_self" : "useful_team";
  return `
  INSERT INTO memory_usage (id, retrieved_count, useful_self, useful_team, last_retrieved_at, last_useful_at, updated_at)
  VALUES (?, 0, ${self ? 1 : 0}, ${self ? 0 : 1}, '', ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    ${col} = memory_usage.${col} + 1,
    last_useful_at = excluded.last_useful_at,
    updated_at = excluded.updated_at
`;
}

function rfc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Count one exposure each for the ids actually returned to a caller
 * (already limited/filtered — callers record the final hits, not the
 * candidate pool). Unknown/id-side dupes are absorbed: ids arrive deduped
 * (resolution collapses chains anyway); anything not in the index yet is
 * still counted — a just-saved memory can be hit in the same query that
 * created it only after upsert, so the index row exists by contract; a
 * missing one gets a row with last_retrieved_at set and no harm done.
 */
export function recordRetrieved(ids: readonly string[], atMs: number = Date.now()): number {
  if (ids.length === 0) return 0;
  // No explicit transaction wrapper: both drivers' .transaction() returns a
  // deferred callable (calling it must NOT execute), and the common surface
  // here is stmt-exec only. Per-row autocommit on WAL is plenty for the
  // ≤50 ids one retrieval returns.
  const d = db();
  const at = rfc(atMs);
  const stmt = d.prepare(INSERT_RETRIEVED_SQL);
  for (const id of ids) stmt.run(id, at, at);
  return new Set(ids).size;
}

export const VIA_VALUES = ["tool", "supersede", "promote"] as const;
export type UsefulVia = (typeof VIA_VALUES)[number];

/**
 * Count one explicit useful signal. The upsert is a single statement, so it
 * is atomic on both drivers — there is deliberately no separate existence
 * check: a memory can be valid on disk while its index row is momentarily
 * missing (schema rebuild, or `findMemoryFile`'s file-scan fallback), and a
 * guard keyed on `memories` would silently drop a real supersede/approve
 * signal. The explicit surfaces (`memory_useful`, CLI `useful`) do their own
 * not-found check before calling, so an agent's typo id never lands here.
 * A concurrent hard forget can still leave an orphaned row; `listUsage`
 * inner-joins `memories`, so orphans never surface in reports.
 */
export function recordUseful(
  id: string,
  kind: UsefulKind,
  _via: UsefulVia,
  atMs: number = Date.now(),
): MemoryUsage {
  const d = db();
  const at = rfc(atMs);
  d.prepare(insertUsefulSql(kind === "self")).run(id, at, at);
  // getUsage cannot miss the row just upserted.
  return getUsage(id)!;
}

export function getUsage(id: string): MemoryUsage | null {
  const row = db()
    .prepare(
      `SELECT id, retrieved_count, useful_self, useful_team,
              last_retrieved_at, last_useful_at, updated_at
       FROM memory_usage WHERE id = ?`,
    )
    .get(id) as MemoryUsage | undefined;
  if (!row) return null;
  row.retrieved_count = Number(row.retrieved_count) || 0;
  row.useful_self = Number(row.useful_self) || 0;
  row.useful_team = Number(row.useful_team) || 0;
  return row;
}

/** D77: useful_count = useful_self + useful_team — both count as useful. */
export function usefulCount(u: Pick<MemoryUsage, "useful_self" | "useful_team">): number {
  return u.useful_self + u.useful_team;
}

/** reuse_rate = useful / retrieved (0 when the memory was never retrieved). */
export function reuseRate(u: MemoryUsage): number | null {
  const n = usefulCount(u);
  if (u.retrieved_count <= 0) return null;
  return n / u.retrieved_count;
}

/** D77-L3's selection helpers ride the same table scan for free. */
export function listUsage(scopeKey?: string): MemoryUsage[] {
  const sql = scopeKey
    ? `SELECT u.id, u.retrieved_count, u.useful_self, u.useful_team,
              u.last_retrieved_at, u.last_useful_at, u.updated_at
       FROM memory_usage u JOIN memories m ON m.id = u.id
       WHERE m.scope_key = ?`
    : `SELECT u.id, u.retrieved_count, u.useful_self, u.useful_team,
              u.last_retrieved_at, u.last_useful_at, u.updated_at
       FROM memory_usage u`;
  const args = scopeKey ? [scopeKey] : [];
  const rows = db().prepare(sql).all(...(args as unknown[])) as MemoryUsage[];
  for (const r of rows) {
    r.retrieved_count = Number(r.retrieved_count) || 0;
    r.useful_self = Number(r.useful_self) || 0;
    r.useful_team = Number(r.useful_team) || 0;
  }
  return rows;
}

/**
 * Drop one memory's telemetry. ONLY the hard-forget path calls this (the
 * memory is gone for good); plain index removal — which fires on a branch
 * switch, when in-repo files transiently disappear — must NOT prune here,
 * or switching branches would wipe counters the files will resurrect.
 * Superseded/deprecated/retracted memories keep their rows: their history
 * is part of the reuse story.
 */
export function deleteUsage(id: string): void {
  db().prepare(`DELETE FROM memory_usage WHERE id = ?`).run(id);
}
