/**
 * D79 (first slice): reuse-signal ranking.
 *
 * D77-L2 already records `retrieved_count` (exposure) and the useful split
 * (explicit confirmations only). This module turns that telemetry into a
 * deliberately small ranking nudge: inside a near-tied BM25 band, memories
 * with a high `reuse_rate` move ahead of equally relevant memories that were
 * only ever retrieved.
 *
 * Guardrails (D77, non-negotiable):
 * - the score itself is never modified — feedback only reorders a band, so
 *   `search --explain` still shows the raw BM25 number;
 * - only memories with `retrieved_count >= FEEDBACK_MIN_RETRIEVED` participate;
 *   new/rare memories keep their exact BM25 slot (no cold-start penalty),
 *   and an eligible run never jumps over one of them;
 * - `reuse_rate` is signal strength, not a probability (it may exceed 1.0);
 *   it is never used as a hard prune threshold;
 * - band membership is anchored to the band head's score, so a large score gap
 *   cannot be crossed. Review tiers are reordered separately by search.ts —
 *   feedback never lifts a draft over reviewed knowledge.
 *
 * Pure by construction: smoke-pure.ts tests it without opening SQLite.
 */

/** Minimum exposure before a memory may be reordered by feedback. */
export const FEEDBACK_MIN_RETRIEVED = 3;

/**
 * A hit is in the same band as the band head while its score is at least
 * this fraction of the head's. 0.8 = within 20%, i.e. a near-tie, not a
 * relevance gap. Measured on the D79 fixture (see docs/design/decisions.md).
 */
export const DEFAULT_FEEDBACK_BAND_RATIO = 0.8;

export interface FeedbackSignal {
  retrieved: number;
  useful: number;
}

export interface FeedbackHitInfo {
  retrieved: number;
  useful: number;
  /** useful / retrieved; null when never retrieved. May exceed 1.0. */
  rate: number | null;
  /** Has enough exposure to participate (useful may still be 0). */
  eligible: boolean;
}

export interface FeedbackRankOptions {
  minRetrieved?: number;
  bandRatio?: number;
}

export interface FeedbackRankResult<T> {
  ordered: T[];
  info: Map<string, FeedbackHitInfo>;
}

/**
 * Reorder one review tier. Callers pass a tier's hits in BM25 order. Within
 * each near-tied band, only contiguous runs of eligible hits are re-sorted by
 * reuse_rate (descending, stable); ineligible hits keep their exact slot. So a
 * memory with too little telemetry is never pushed down by this mechanism.
 */
export function applyFeedbackRanking<T extends { id: string; score: number }>(
  hits: readonly T[],
  usage: ReadonlyMap<string, FeedbackSignal>,
  opts: FeedbackRankOptions = {},
): FeedbackRankResult<T> {
  const minRetrieved = opts.minRetrieved ?? FEEDBACK_MIN_RETRIEVED;
  const bandRatio = opts.bandRatio ?? DEFAULT_FEEDBACK_BAND_RATIO;
  const info = new Map<string, FeedbackHitInfo>();
  for (const h of hits) {
    const u = usage.get(h.id);
    const retrieved = Math.max(0, Number(u?.retrieved) || 0);
    const useful = Math.max(0, Number(u?.useful) || 0);
    const rate = retrieved > 0 ? useful / retrieved : null;
    info.set(h.id, {
      retrieved,
      useful,
      rate,
      eligible: retrieved >= minRetrieved,
    });
  }

  const ordered: T[] = [];
  let i = 0;
  while (i < hits.length) {
    const head = hits[i]!;
    const threshold = head.score > 0 ? head.score * bandRatio : head.score;
    let j = i + 1;
    while (j < hits.length && hits[j]!.score >= threshold) j++;
    const band = hits.slice(i, j);
    ordered.push(...reorderBand(band, info));
    i = j;
  }
  return { ordered, info };
}

function reorderBand<T extends { id: string }>(
  band: readonly T[],
  info: ReadonlyMap<string, FeedbackHitInfo>,
): T[] {
  if (band.length < 2) return [...band];
  const out = [...band];
  let i = 0;
  while (i < band.length) {
    if (!info.get(band[i]!.id)!.eligible) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < band.length && info.get(band[j]!.id)!.eligible) j++;
    if (j - i > 1) {
      // Stable sort of the run only. Ineligible hits are barriers, so a run
      // can never jump over a memory with too little telemetry.
      const run = band.slice(i, j).map((h, k) => ({ h, k }));
      run.sort((a, b) => {
        const ra = info.get(a.h.id)!.rate ?? 0;
        const rb = info.get(b.h.id)!.rate ?? 0;
        return ra !== rb ? rb - ra : a.k - b.k;
      });
      run.forEach((x, k) => (out[i + k] = x.h));
    }
    i = j;
  }
  return out;
}
