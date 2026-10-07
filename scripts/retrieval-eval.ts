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
    source: "retrieval-eval fixture",
  });
  fs.writeFileSync(path.join(dir, `${m.id}.md`), serialize(fm, m.body), "utf8");
}
const stats = syncScope("personal");
console.log(`seeded ${MEMORIES.length} memories (indexed: ${stats.added})\n`);

// --- run ---
let r1 = 0;
let r5 = 0;
let mrr = 0;
const misses: string[] = [];

for (const q of QUERIES) {
  const stats = { ftsQuery: "", candidates: 0, hiddenSuperseded: 0, hiddenExcluded: 0 };
  const hits = search(q.query, { scopeKeys: ["personal"], limit: 50, stats });
  const ids = hits.map((h) => h.id);
  let rank = -1;
  for (const g of q.gold) {
    const i = ids.indexOf(g);
    if (i !== -1 && (rank === -1 || i < rank)) rank = i;
  }
  if (rank === 0) r1++;
  if (rank !== -1 && rank < K) r5++;
  if (rank !== -1) mrr += 1 / (rank + 1);
  else misses.push(`  MISS  rank=-  query="${q.query}" gold=${q.gold.join(",")} [${q.note}]`);
  if (rank > 0) {
    console.log(`  rank=${rank + 1}  query="${q.query}" gold=${q.gold.join(",")} [${q.note}]`);
  }
}

const n = QUERIES.length;
console.log(`\n==== retrieval-eval: FTS5 baseline ====`);
console.log(`corpus : ${MEMORIES.length} memories (personal scope, single tier)`);
console.log(`queries: ${n}`);
console.log(`recall@1: ${(r1 / n).toFixed(3)} (${r1}/${n})`);
console.log(`recall@5: ${(r5 / n).toFixed(3)} (${r5}/${n})`);
console.log(`MRR     : ${(mrr / n).toFixed(3)}`);
if (misses.length > 0) {
  console.log(`\nmisses (${misses.length}):`);
  for (const m of misses) console.log(m);
}
