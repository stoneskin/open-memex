/**
 * Retrieval eval (D77, layer 1): offline FTS5 baseline on a synthetic fixture.
 *
 * Usage: node --experimental-strip-types scripts/retrieval-eval.ts
 *
 * Seeds a scratch OPEN_MEMEX_HOME with the fixture memories (all personal
 * scope, so every memory sits in the same review tier and the measured
 * ranking is pure BM25), runs each fixture query through search(), and
 * reports recall@1 / recall@5 / MRR plus a per-query miss table.
 *
 * The fixture (scripts/retrieval-eval/fixture.ts) was written BEFORE the
 * first run. Do not tune the fixture to the results — a miss is a finding,
 * not a bug in the fixture.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-eval-"));
process.env.OPEN_MEMEX_HOME = HOME;

import { MEMORIES, QUERIES } from "./retrieval-eval/fixture.ts";
import { serialize, normalizeFrontmatter } from "../src/store/markdown.ts";
import { syncScope } from "../src/store/sync.ts";
import { search } from "../src/retrieve/search.ts";
import { recordRetrieved, recordUseful } from "../src/store/usage.ts";
import { memoriesDirPath } from "../src/paths.ts";

const K = 5;

// --- seed ---
const dir = memoriesDirPath("personal");
fs.mkdirSync(dir, { recursive: true });
for (const m of MEMORIES) {
  const fm = normalizeFrontmatter({
    id: m.id,
    scope: "personal",
    type: m.type,
    tags: m.tags,
    aliases: m.aliases,
    alias: m.alias,
    target: m.target,
    source: "retrieval-eval fixture",
  });
  fs.writeFileSync(path.join(dir, `${m.id}.md`), serialize(fm, m.body), "utf8");
}
const stats = syncScope("personal");
// D79: seed the D77-L2 counters the feedback slice needs. This is the
// "telemetry a real user already produced" — written through the same store
// API as the tool surfaces, not injected into the ranking. The baseline
// (feedback off) ignores it; the weighted run reads it.
for (const m of MEMORIES) {
  if (!m.usage) continue;
  for (let i = 0; i < m.usage.retrieved; i++) recordRetrieved([m.id]);
  for (let i = 0; i < (m.usage.usefulSelf ?? 0); i++) recordUseful(m.id, "self", "tool");
}
console.log(`seeded ${MEMORIES.length} memories (indexed: ${stats.added})\n`);

// --- run ---
interface Metrics {
  n: number;
  r1: number;
  r5: number;
  mrr: number;
  ranks: Map<string, number>; // query -> 0-based rank, -1 = miss
}

// D79: ablation knob for tuning the band by measurement. The shipped value
// lives in src/retrieve/feedback.ts; this env var exists only so the sweep
// (0.95 → 0.65) is reproducible without editing source.
const bandEnv = process.env.RETRIEVAL_FEEDBACK_BAND;
const bandRatio = bandEnv ? Number(bandEnv) : undefined;

function run(feedback: boolean): Metrics {
  const ranks = new Map<string, number>();
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const q of QUERIES) {
    const stats = { ftsQuery: "", candidates: 0, hiddenSuperseded: 0, hiddenExcluded: 0, aliasExpansions: [] as string[] };
    const hits = search(q.query, {
      scopeKeys: ["personal"],
      limit: 50,
      stats,
      feedback,
      feedbackBandRatio: bandRatio,
    });
    const ids = hits.map((h) => h.id);
    let rank = -1;
    for (const g of q.gold) {
      const i = ids.indexOf(g);
      if (i !== -1 && (rank === -1 || i < rank)) rank = i;
    }
    ranks.set(q.query, rank);
    if (rank === 0) r1++;
    if (rank !== -1 && rank < K) r5++;
    if (rank !== -1) mrr += 1 / (rank + 1);
  }
  return { n: QUERIES.length, r1, r5, mrr, ranks };
}

function metricsFor(queries: typeof QUERIES, ranks: Map<string, number>): Metrics {
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const q of queries) {
    const rank = ranks.get(q.query) ?? -1;
    if (rank === 0) r1++;
    if (rank !== -1 && rank < K) r5++;
    if (rank !== -1) mrr += 1 / (rank + 1);
  }
  return { n: queries.length, r1, r5, mrr, ranks };
}

function row(label: string, m: Metrics): string {
  return `${label.padEnd(10)} recall@1 ${(m.r1 / m.n).toFixed(3)} (${m.r1}/${m.n})  recall@5 ${(m.r5 / m.n).toFixed(3)} (${m.r5}/${m.n})  MRR ${(m.mrr / m.n).toFixed(3)}`;
}

const baseline = run(false);
const weighted = run(true);

// Per-query misses and non-top-1 ranks for the baseline (the regression view).
const misses: string[] = [];
for (const q of QUERIES) {
  const rank = baseline.ranks.get(q.query) ?? -1;
  if (rank === -1) {
    misses.push(`  MISS  rank=-  query="${q.query}" gold=${q.gold.join(",")} [${q.note}]`);
  } else if (rank > 0) {
    const after = weighted.ranks.get(q.query) ?? -1;
    const changed = after !== rank ? `  → rank=${after + 1} with feedback` : "";
    console.log(`  rank=${rank + 1}  query="${q.query}" gold=${q.gold.join(",")} [${q.note}]${changed}`);
  }
}

console.log(`\n==== retrieval-eval: baseline vs D79 feedback ====`);
console.log(`corpus : ${MEMORIES.length} memories (personal scope, single tier)`);
console.log(`queries: ${QUERIES.length}`);
if (bandRatio !== undefined) console.log(`band   : ${bandRatio} (RETRIEVAL_FEEDBACK_BAND override)`);
console.log(row("baseline", baseline));
console.log(row("feedback", weighted));

const feedbackQueries = QUERIES.filter((q) => q.slice === "feedback");
if (feedbackQueries.length > 0) {
  const w = weighted.ranks;
  const b = baseline.ranks;
  console.log(`\nfeedback slice (${feedbackQueries.length} queries):`);
  console.log(row("baseline", metricsFor(feedbackQueries, b)));
  console.log(row("feedback", metricsFor(feedbackQueries, w)));
  for (const q of feedbackQueries) {
    const rb = (b.get(q.query) ?? -1) + 1;
    const rw = (w.get(q.query) ?? -1) + 1;
    console.log(`  ${rb} → ${rw}  query="${q.query}" gold=${q.gold.join(",")}`);
  }
}

if (misses.length > 0) {
  console.log(`\nmisses (${misses.length}):`);
  for (const m of misses) console.log(m);
}
