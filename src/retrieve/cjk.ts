// CJK retrieval helpers (pure logic, no sqlite).
//
// FTS5's `porter unicode61` tokenizer treats a run of CJK ideographs as one
// token ("中文记忆" is a single token), so substring queries never match, and
// the old query builder dropped CJK characters entirely. Per D8 the default
// CJK strategy is bigram: at write time we pre-tokenize CJK runs into
// space-separated unigrams + overlapping bigrams stored in the `cjk` FTS
// column; at query time the CJK part of the query becomes an OR of bigrams
// against that column. Unigrams are included so single-character queries
// ("猫") still match. Works identically on bun:sqlite and better-sqlite3
// with no native tokenizer dependency.

const CJK_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u{20000}-\u{2A6DF}]/u;

const CJK_RUN_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u{20000}-\u{2A6DF}]+/gu;

/** True if the string contains any CJK (Han/Hiragana/Katakana/Hangul) character. */
export function hasCjk(s: string): boolean {
  return CJK_RE.test(s);
}

/**
 * Build the index text for the `cjk` FTS column: for every CJK run emit each
 * character (unigram) then every overlapping bigram, space-separated.
 * "中文记忆" -> "中 文 记 忆 中文 文记 记忆". Non-CJK text yields "".
 */
export function cjkIndexText(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(CJK_RUN_RE)) {
    const chars = [...m[0]];
    for (const ch of chars) out.push(ch);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out.join(" ");
}

/** Escape a raw token for embedding in a double-quoted FTS5 phrase. */
function esc(t: string): string {
  return t.replace(/"/g, '""');
}

/**
 * Convert the CJK runs of a query into an FTS5 expression for the `cjk`
 * column. Multi-char runs become an OR of bigrams (recall-oriented; bm25
 * ranks docs matching more bigrams higher). Single chars stay unigrams.
 * Returns "" when the query has no CJK.
 *
 * Options: `dropBigrams` filters question bigrams (什么/怎么/…) when other
 * terms remain; `maxTerms` caps the term count (applied after dedupe).
 */
export function cjkQueryExpr(
  query: string,
  opts: { dropBigrams?: ReadonlySet<string>; maxTerms?: number } = {},
): string {
  const parts: string[] = [];
  for (const m of query.matchAll(CJK_RUN_RE)) {
    const chars = [...m[0]];
    if (chars.length === 1) {
      parts.push(`"${esc(chars[0])}"`);
    } else {
      for (let i = 0; i + 1 < chars.length; i++) {
        parts.push(`"${esc(chars[i] + chars[i + 1])}"`);
      }
    }
  }
  let terms = [...new Set(parts)];
  if (opts.dropBigrams && terms.length > 1) {
    const kept = terms.filter(
      (t) => !opts.dropBigrams!.has(t.slice(1, -1).replace(/""/g, '"')),
    );
    if (kept.length > 0) terms = kept;
  }
  if (opts.maxTerms && terms.length > opts.maxTerms) {
    terms = terms.slice(0, opts.maxTerms);
  }
  return terms.join(" OR ");
}
