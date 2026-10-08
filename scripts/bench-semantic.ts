/**
 * Semantic-ranking experiment (the D77 embedding gate, Stone 2026-10-07).
 *
 * Question: does a local multilingual embedding + RRF hybrid beat the
 * lexical ceiling? Target: pooled LongMemEval-S R@5 40.6% / MRR 0.284.
 * Also measured on the synthetic fixture, esp. the 5 cross-lingual
 * vocabulary-mismatch queries (the slice Stone cares about).
 *
 * Model: paraphrase-multilingual-MiniLM-L12-v2 via the `transformers` npm
 * package (local, no API). Chosen multilingual because the mismatch slice
 * is EN<->ZH. Embeddings are cached to disk; cosine is brute-forced in JS
 * (22k x 384 is milliseconds).
 *
 * Modes:
 *   --pooled --data <longmemeval_s_cleaned.json>   22k sessions, 470 questions
 *   --fixture                                      51 synthetic memories, 41 queries
 *
 * Usage:
 *   HF_HUB_CACHE=~/workspace/bench-data/hf-cache node --experimental-strip-types \
 *     scripts/bench-semantic.ts --pooled --data ~/workspace/bench-data/longmemeval_s_cleaned.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const POOLED = args.includes("--pooled");
const dataIdx = args.indexOf("--data");
const dataPath = dataIdx === -1 ? "" : args[dataIdx + 1];
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx === -1 ? Infinity : Number(args[limitIdx + 1]);
const MODEL = (() => {
  const i = args.indexOf("--model");
  return i === -1 ? "Xenova/paraphrase-multilingual-MiniLM-L12-v2" : args[i + 1];
})();
const K = 10;
const DEPTH = 50;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sem-bench-"));
process.env.OPEN_MEMEX_HOME = HOME;

import { pipeline } from "@huggingface/transformers";
import { serialize, normalizeFrontmatter } from "../src/store/markdown.ts";
import { syncScope } from "../src/store/sync.ts";
import { search } from "../src/retrieve/search.ts";
import { memoriesDirPath } from "../src/paths.ts";

interface Doc {
  id: string;
  text: string;
}
interface Q {
  text: string;
  gold: Set<string>;
  note: string;
}

const docs: Doc[] = [];
const questions: Q[] = [];

if (POOLED) {
  if (!dataPath) throw new Error("missing --data");
  const items = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  let qi = 0;
  for (const item of items) {
    if (item.question_id.endsWith("_abs")) continue;
    if (qi >= LIMIT) break;
    const sids: string[] = item.haystack_session_ids;
    const gold = new Set<string>();
    for (const g of item.answer_session_ids) {
      const i = sids.indexOf(g);
      if (i !== -1) gold.add(`q${qi}-s${i}`);
    }
    if (gold.size === 0) continue;
    item.haystack_sessions.forEach((turns: Array<{ role: string; content: string }>, i: number) => {
      docs.push({
        id: `q${qi}-s${i}`,
        text: turns.map((t) => `${t.role}: ${t.content}`).join("\n").slice(0, 2000),
      });
    });
    questions.push({ text: item.question, gold, note: item.question_type });
    qi++;
  }
} else {
  const { MEMORIES, QUERIES } = await import("./retrieval-eval/fixture.ts");
  for (const m of MEMORIES) {
    docs.push({
      id: m.id,
      text: [m.body, ...(m.aliases ?? []), ...(m.tags ?? [])].join("\n").slice(0, 2000),
    });
  }
  for (const q of QUERIES.slice(0, LIMIT)) {
    questions.push({ text: q.query, gold: new Set(q.gold), note: q.note });
  }
}

console.log(`docs: ${docs.length}, questions: ${questions.length}, model: ${MODEL}`);

// Seed the FTS index (both modes) so the BM25 arm runs on the same corpus.
{
  const dir = memoriesDirPath("personal");
  fs.mkdirSync(dir, { recursive: true });
  const B = 2000;
  for (let i = 0; i < docs.length; i += B) {
    for (const d of docs.slice(i, i + B)) {
      const fm = normalizeFrontmatter({ id: d.id, scope: "personal", type: "fact", tags: [] });
      fs.writeFileSync(path.join(dir, `${d.id}.md`), serialize(fm, d.text), "utf8");
    }
    console.log(`  seeded ${Math.min(i + B, docs.length)}/${docs.length}`);
  }
  syncScope("personal");
}

// ---- embeddings (cached) ----
const cachePath = POOLED
  ? `${os.homedir()}/workspace/bench-data/emb-pooled.json`
  : `${os.homedir()}/workspace/bench-data/emb-fixture.json`;
let emb: number[][];
if (fs.existsSync(cachePath)) {
  console.log("loading cached embeddings…");
  emb = JSON.parse(fs.readFileSync(cachePath, "utf8"));
} else {
  console.log("loading model… (first run downloads ~470MB)");
  const extractor: any = await pipeline("feature-extraction", MODEL);
  emb = [];
  const B = 32;
  for (let i = 0; i < docs.length; i += B) {
    const batch = docs.map((d) => d.text).slice(i, i + B);
    const out: any = await extractor(batch, { pooling: "mean", normalize: true });
    const arr = out.tolist();
    for (const v of arr) emb.push(v);
    if (i % 320 === 0) console.log(`  embedded ${i}/${docs.length}`);
  }
  fs.writeFileSync(cachePath, JSON.stringify(emb));
  console.log("embeddings cached");
}
const DIM = emb[0].length;
console.log(`embedding dim: ${DIM}`);

const extractor: any = await pipeline("feature-extraction", MODEL);

function topVector(queryVec: number[], depth: number): string[] {
  const scores: Array<{ id: string; s: number }> = [];
  for (let i = 0; i < emb.length; i++) {
    const v = emb[i];
    let s = 0;
    for (let d = 0; d < DIM; d++) s += queryVec[d] * v[d];
    scores.push({ id: docs[i].id, s });
  }
  scores.sort((a, b) => b.s - a.s);
  return scores.slice(0, depth).map((x) => x.id);
}

function rrf(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

let bR5 = 0, bMRR = 0, vR5 = 0, vMRR = 0, hR5 = 0, hMRR = 0;
const missDetail: string[] = [];
let qi = 0;
for (const q of questions) {
  const bm25 = search(q.text, { scopeKeys: ["personal"], limit: DEPTH, synonyms: false }).map(
    (h) => h.id,
  );
  const qv: number[] = (await extractor(q.text, { pooling: "mean", normalize: true })).tolist()[0];
  const vec = topVector(qv, DEPTH);
  const hyb = rrf([bm25, vec]).slice(0, K);

  const rankIn = (top: string[]): number => {
    for (let r = 0; r < top.slice(0, K).length; r++) if (q.gold.has(top[r])) return r;
    return -1;
  };
  const rb = rankIn(bm25), rv = rankIn(vec), rh = rankIn(hyb);
  if (rb !== -1 && rb < 5) bR5++;
  if (rb !== -1) bMRR += 1 / (rb + 1);
  if (rv !== -1 && rv < 5) vR5++;
  if (rv !== -1) vMRR += 1 / (rv + 1);
  if (rh !== -1 && rh < 5) hR5++;
  if (rh !== -1) hMRR += 1 / (rh + 1);
  if (!POOLED && rh === -1) {
    missDetail.push(`  MISS(hybrid) query="${q.text}" gold=${[...q.gold].join(",")} [${q.note}] bm25rank=${rb} vecrank=${rv}`);
  }
  qi++;
  if (qi % 100 === 0) console.log(`  ... ${qi}/${questions.length}`);
}

const n = questions.length;
console.log(`\n==== semantic experiment (${POOLED ? "pooled 22k" : "fixture"}) ====`);
console.log(`BM25-only : R@5 ${(bR5 / n * 100).toFixed(1)}%  MRR ${(bMRR / n).toFixed(3)}`);
console.log(`vec-only  : R@5 ${(vR5 / n * 100).toFixed(1)}%  MRR ${(vMRR / n).toFixed(3)}`);
console.log(`hybrid RRF: R@5 ${(hR5 / n * 100).toFixed(1)}%  MRR ${(hMRR / n).toFixed(3)}`);
if (missDetail.length) console.log("hybrid misses:\n" + missDetail.join("\n"));
