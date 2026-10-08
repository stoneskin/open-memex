/**
 * D83: BM25 column weights for the FTS index.
 *
 * Split out of `search.ts` deliberately: `smoke-pure.ts` must keep running
 * with no SQLite dependency (its header says "pure-logic, no
 * bun:sqlite"), and importing `search.ts` pulls in `store/db.ts` at module
 * load. This module holds the tunable constant and nothing else, so the
 * guard test can import it without opening a database.
 *
 * `expansions` (D80-derived synonym/translation variants) sits strictly below
 * `aliases` so the preference is explicit rather than incidental: a body
 * match outranks an expansion-only match, and a user-authored alias outranks
 * a derived one. This is not cosmetic — measured on equal-length docs, at
 * weight 1.0 a direct body match and an expansion-only match score
 * *identically* (-3.983 vs -3.983), leaving the order to tiebreaks. Any
 * weight < 1.0 breaks that tie in the right direction.
 *
 * The value is the highest one the checked-in fixture cannot distinguish from
 * 1.0 (`scripts/retrieval-eval.ts`: R@1 0.750 / R@5 0.977 / MRR 0.857 hold
 * from 1.0 down to 0.75; 0.5 already costs MRR, and below 0.35 R@5 breaks).
 * So the ordering guarantee is free, and the fixture is the gate that keeps
 * it honest — retune by re-running the sweep, not by feel.
 *
 * Known non-fix: this does NOT repair D80's `how do we ship` rank-8 case.
 * That is per-column length norm (one variant among many in a long
 * `expansions` field), not a weighting problem; see D83's update.
 */

/** Weight for the D80 `expansions` column. */
export const DEFAULT_EXPANSIONS_WEIGHT = 0.75;

/**
 * Full weight vector for `memories_fts`, in declaration order.
 * MUST stay in sync with FTS_SCHEMA column order in `store/db.ts`:
 * `[content, tags, aliases, expansions, type, cjk]`.
 */
export const BM25_WEIGHTS: readonly number[] = [1, 1, 1, DEFAULT_EXPANSIONS_WEIGHT, 1, 1];