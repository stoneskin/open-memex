/**
 * D96: opt-in cross-lingual rerank (EN<->ZH only).
 *
 * Cold-start position: BM25 is the retriever, embeddings only ever *reorder*
 * what BM25 already returned. The layout is identical to D79's reuse band —
 * a hit is eligible only when the query and the memory are written in
 * different scripts (one side has CJK, the other does not) *and* its cosine
 * clears `DEFAULT_RERANK_MIN_COSINE`. Eligible hits are re-sorted by cosine
 * inside their contiguous run; everything else — same-language hits and
 * cross-lingual hits with too little signal — keeps its exact BM25 slot and
 * acts as a barrier, so a run can never leapfrog them.
 *
 * Guardrails (D79, reused):
 * - the BM25 score is never modified, only the order inside a run;
 * - the caller has already split review tiers, so a rerank can never lift a
 *   draft over reviewed knowledge (search.ts resolves tiers before any
 *   caller-side reordering);
 * - a low-similarity cross-lingual hit is a "no signal" hit, not a loser:
 *   it stays exactly where BM25 put it.
 *
 * Pure by construction: smoke-pure.ts tests it without SQLite or a model.
 */

/**
 * Minimum cosine for a cross-lingual pair to participate. Set by the D96
 * fixture sweep (0.2 = the highest floor that still captures the measured
 * cross-lingual gains; 0.3 keeps one of six, 0.4+ is inert). Lower it only
 * with a new measurement.
 */
export const DEFAULT_RERANK_MIN_COSINE = 0.2;

export interface RerankHitInfo {
  cosine: number;
  /** 0-based BM25 slot before the rerank. */
  from: number;
  /** 0-based slot after the rerank. */
  to: number;
}

export interface RerankResult<T> {
  ordered: T[];
  info: Map<string, RerankHitInfo>;
  /** Hits that actually moved up, in their new order. */
  promotions: Array<{ id: string; promoted: number; cosine: number }>;
}

/**
 * Reorder one already-retrieved list. `cosines` carries only the hits the
 * caller considers cross-lingual (same-language hits must be absent, not
 * present with a low value — absence, not score, is what marks a barrier).
 */
export function rerankCrossLingual<T extends { id: string }>(
  hits: readonly T[],
  cosines: ReadonlyMap<string, number>,
  opts: { minCosine?: number } = {},
): RerankResult<T> {
  const minCosine = opts.minCosine ?? DEFAULT_RERANK_MIN_COSINE;
  const info = new Map<string, RerankHitInfo>();
  const ordered: T[] = [];
  const eligible = (h: T): boolean => {
    const c = cosines.get(h.id);
    return c !== undefined && Number.isFinite(c) && c >= minCosine;
  };

  let i = 0;
  while (i < hits.length) {
    if (!eligible(hits[i]!)) {
      info.set(hits[i]!.id, { cosine: cosines.get(hits[i]!.id) ?? NaN, from: i, to: i });
      ordered.push(hits[i]!);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < hits.length && eligible(hits[j]!)) j++;
    const run = hits.slice(i, j).map((h, k) => ({ h, k }));
    run.sort((a, b) => {
      const ca = cosines.get(a.h.id)!;
      const cb = cosines.get(b.h.id)!;
      return ca !== cb ? cb - ca : a.k - b.k;
    });
    run.forEach((x, k) => {
      info.set(x.h.id, { cosine: cosines.get(x.h.id)!, from: i + x.k, to: i + k });
      ordered.push(x.h);
    });
    i = j;
  }

  const promotions: RerankResult<T>["promotions"] = [];
  for (const h of ordered) {
    const i2 = info.get(h.id)!;
    if (i2.to < i2.from) {
      promotions.push({ id: h.id, promoted: i2.from - i2.to, cosine: i2.cosine });
    }
  }
  return { ordered, info, promotions };
}
