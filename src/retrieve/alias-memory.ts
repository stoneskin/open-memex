/**
 * D81: user-defined alias vocabulary as query-time expansion.
 *
 * An alias memory carries `alias:` (the nickname, e.g. 香蕉计划) and
 * `target:` (what it refers to, e.g. 支付系统重构项目) frontmatter on any
 * memory type. Unlike D80's index-time curated map (static, shared by all
 * users), alias memories are dynamic user vocabulary:
 * - defining one takes effect on the next query — no reindex;
 * - aliases are scope-aware (a project codename stays in its project,
 *   a personal nickname stays personal).
 *
 * Search flow (search.ts):
 *  1. Round 1 searches the query as-is.
 *  2. Query terms are looked up against the alias registry (trigger A:
 *     an exact registry hit, not a count heuristic — the D79 trigger that
 *     fired 0/470 is not repeated).
 *  3. Each expansion round rewrites the query with the other side of the
 *     relation — bidirectional (alias→target and target→alias), depth < 3,
 *     cycle-safe.
 *  4. Rounds merge by normalized-max (mergeRounds): each round's scores are
 *     divided by that round's best, so an alias-side champion competes
 *     evenly with a literal-side champion — alias matches are never
 *     down-weighted for coming from a later round.
 */
import { db } from "../store/db.ts";
import { latinTerms } from "./query.ts";

export interface AliasEntry {
  id: string;
  scope_key: string;
  alias: string;
  target: string;
}

/**
 * All alias definitions visible to these scopes. One cheap query per
 * search() call — no cache, so a newly saved alias memory applies on the
 * very next query.
 */
export function loadAliasEntries(scopeKeys?: string[]): AliasEntry[] {
  const filter =
    scopeKeys && scopeKeys.length > 0
      ? `AND scope_key IN (${scopeKeys.map(() => "?").join(",")})`
      : "";
  return db()
    .prepare(
      `SELECT id, scope_key, alias, target FROM memories
       WHERE alias <> '' AND target <> '' AND status = 'active' ${filter}`,
    )
    .all(...((scopeKeys ?? []) as unknown[])) as AliasEntry[];
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** CJK: substring (no tokenizer). Latin: whole-token match. */
function termInQuery(query: string, term: string): boolean {
  if (CJK_RE.test(term)) return query.includes(term);
  const tokens = new Set(latinTerms(query));
  return tokens.has(term.toLowerCase());
}

function replaceTerm(query: string, term: string, replacement: string): string {
  if (CJK_RE.test(term)) return query.replace(term, replacement);
  return query.replace(
    new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"),
    replacement,
  );
}

/**
 * Rewrite the query once: every alias entry with a matching side swaps in
 * the other side. All matching entries apply in one pass (a chain A→B→C
 * can resolve within a single round). Returns null when nothing matched.
 */
export function rewriteQueryOnce(
  query: string,
  entries: AliasEntry[],
): string | null {
  let out = query;
  let changed = false;
  for (const e of entries) {
    if (termInQuery(out, e.alias)) {
      out = replaceTerm(out, e.alias, e.target);
      changed = true;
    } else if (termInQuery(out, e.target)) {
      out = replaceTerm(out, e.target, e.alias);
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * Plan the expansion rounds for a query. Pure — takes the registry entries
 * explicitly so tests don't need a database. Returns the rewritten queries
 * only (rounds 2+); the caller prepends the original query. Depth < 3:
 * at most two expansion rounds. Cycle-safe via the seen set.
 */
export function planAliasExpansions(
  query: string,
  entries: AliasEntry[],
): string[] {
  const out: string[] = [];
  const seen = new Set([query]);
  let current = query;
  for (let depth = 0; depth < 2; depth++) {
    const next = rewriteQueryOnce(current, entries);
    if (!next || seen.has(next)) break;
    seen.add(next);
    out.push(next);
    current = next;
  }
  return out;
}

/**
 * D81 merge: per-round score normalization + max.
 *
 * BM25 scores are query-dependent (different terms → different IDFs and
 * query lengths), so raw scores from two rounds are incomparable — like
 * comparing °C with °F. Each round is first divided by its own best
 * (n=1.0 means "this round's champion"), then final = max across rounds.
 * An alias-side champion (n=1.0) outranks a mediocre literal match
 * (n=0.4): the two sides' champions start even, which is exactly "no
 * down-weighting for being a synonym/alias". The kept row (and its
 * snippet) comes from the round where the doc scored its best.
 */
export function mergeRounds<T extends { id: string; score: number }>(
  rounds: T[][],
): Array<{ doc: T; score: number; rounds: number }> {
  const acc = new Map<string, { doc: T; best: number; rounds: number }>();
  rounds.forEach((docs) => {
    const mx = docs.reduce((m, d) => Math.max(m, d.score), 0);
    for (const d of docs) {
      const n = mx > 0 ? d.score / mx : 0;
      const cur = acc.get(d.id);
      if (!cur) acc.set(d.id, { doc: d, best: n, rounds: 1 });
      else {
        cur.rounds += 1;
        if (n > cur.best) {
          cur.best = n;
          cur.doc = d;
        }
      }
    }
  });
  return [...acc.values()]
    .map((v) => ({ doc: v.doc, score: v.best, rounds: v.rounds }))
    .sort((a, b) => b.score - a.score || b.rounds - a.rounds);
}
