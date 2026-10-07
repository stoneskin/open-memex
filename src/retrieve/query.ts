// Search query construction (pure logic, no sqlite).
//
// Free-text questions — "how do we configure the SSO login", "中文记忆怎么
// 检索" — are the natural way users and agents ask, but fed raw into FTS5
// they dilute ranking: question words ("how", "什么", "怎么") match
// everything and drag the score. So the query builder keeps the existing
// shape (Latin prefix terms OR-ed, CJK bigrams OR-ed against the `cjk`
// column, bm25 ranks) and additionally drops a small set of function words
// on both sides, dedupes, and caps term counts so a rambling sentence
// cannot crowd out its own content words. If filtering would empty a
// side, the unfiltered terms are used — a query must never be made worse
// than the raw one.

import { cjkQueryExpr, hasCjk } from "./cjk.ts";

/** English function words that carry no retrieval signal in questions. */
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "without", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "how", "what", "why", "when", "where", "which", "who", "whom", "we", "i",
  "you", "he", "she", "it", "they", "them", "us", "me", "my", "our", "your",
  "his", "her", "its", "their", "this", "that", "these", "those", "there",
  "here", "can", "could", "should", "would", "will", "shall", "may", "might",
  "please", "if", "then", "than", "so", "as", "at", "by", "from", "into",
  "about", "over", "under", "again", "once", "just",
]);

/** Chinese question bigrams — the CJK counterpart of the list above. */
const CJK_QUESTION_BIGRAMS = new Set([
  "什么", "怎么", "如何", "为何", "为什", "哪些", "哪个", "请问",
]);

const MAX_TERMS = 24;

function latinTerms(q: string, useStopwords = true): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9_.\-]+/g) ?? [];
  const kept = useStopwords
    ? raw.filter((t) => t.length > 1 && !LATIN_STOPWORDS.has(t))
    : raw.filter((t) => t.length > 1);
  const chosen = kept.length > 0 ? kept : raw;
  return [...new Set(chosen)].slice(0, MAX_TERMS);
}

/**
 * Convert free-text query into a safe FTS5 MATCH expression.
 * Latin tokens keep the old behavior (prefix match on content/tags/type).
 * CJK runs become an OR of bigrams against the `cjk` column (see cjk.ts).
 * Mixed queries OR the two parts together.
 *
 * Flags are ablation toggles (all default to the shipped behavior):
 * - stopwords: false  → skip function-word filtering
 * - orJoin: false     → AND the terms instead of OR
 * - prefix: false     → exact term match instead of `term*`
 */
export function toFtsQuery(
  q: string,
  flags: { stopwords?: boolean; orJoin?: boolean; prefix?: boolean } = {},
): string {
  const useStopwords = flags.stopwords !== false;
  const useOr = flags.orJoin !== false;
  const usePrefix = flags.prefix !== false;
  const joiner = useOr ? " OR " : " AND ";
  const latin = latinTerms(q, useStopwords)
    .map((t) => (usePrefix ? `"${t.replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`))
    .join(joiner);
  const cjk = hasCjk(q)
    ? cjkQueryExpr(q, { dropBigrams: useStopwords ? CJK_QUESTION_BIGRAMS : undefined, maxTerms: MAX_TERMS })
    : "";
  if (latin && cjk) return `(${latin}) ${useOr ? "OR" : "AND"} {cjk}:(${cjk})`;
  if (cjk) return `{cjk}:(${cjk})`;
  return latin;
}
