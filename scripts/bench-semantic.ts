/**
 * Semantic-ranking gate bench (D77 origin, re-measured for the D96 gate).
 *
 * Question the gate answers: does a local multilingual embedding layer beat
 * the measured lexical ceiling, and at what tax (model size, load time,
 * per-query latency, disk cache)?
 *
 * Target: pooled LongMemEval-S R@5 40.6% (the lexical ceiling, D77).
 * Product slice: the checked-in retrieval fixture's EN<->ZH cross-lingual
 * queries — the only slice where a multilingual model can plausibly help.
 *
 * Model: any `@huggingface/transformers` feature-extraction model. Default is
 * `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (the 2026-10-07 choice).
 * Local only, no API. Embeddings are cached to disk; cosine is brute-forced
 * in JS. Vectors never leave the machine.
 *
 * Arms:
 *   bm25    the shipped lexical pipeline (no model needed)
 *   vec     vector-only ranking over the whole corpus (upper bound)
 *   rrf     naive RRF fusion of BM25 + vector (§4.7 measured this as harmful)
 *   rerank  BM25-first, embeddings only reorder cross-lingual hits inside the
 *           BM25 candidate pool (the only shape this project would ship)
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-semantic.ts --arms bm25
 *   node --experimental-strip-types scripts/bench-semantic.ts --cache-dir <dir>
 *   node --experimental-strip-types scripts/bench-semantic.ts --pooled \
 *     --data <longmemeval_s_cleaned.json> --cache-dir <dir>
 *
 * `--cache-dir` (or OPEN_MEMEX_BENCH_DATA) holds the vector caches and the
 * Hugging Face model download (`<cache-dir>/hf`). It defaults to
 * `~/workspace/bench-data` — the 2026-10-07 location. Nothing is written into
 * the repo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const POOLED = args.includes("--pooled");
const LIMIT = Number(opt("--limit") ?? Infinity);
const DEPTH = Number(opt("--depth") ?? 50);
const MODEL = opt("--model") ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
/** ONNX precision. `fp32` is the 2026-10-07 parity run; `q8` is what a
 *  download-on-first-use feature would plausibly ship. */
const DTYPE = opt("--dtype") ?? "fp32";
const CACHE_DIR =
  opt("--cache-dir") ?? process.env.OPEN_MEMEX_BENCH_DATA ?? path.join(os.homedir(), "workspace", "bench-data");
const ARMS = new Set((opt("--arms") ?? "bm25,vec,rrf,rerank").split(",").map((s) => s.trim()));
const JSON_OUT = opt("--json");
/** Similarity floors swept by the `rerank` arm. */
const FLOORS = (opt("--floors") ?? "0.2,0.3,0.4,0.5,0.6").split(",").map(Number);
const K = 5;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
}
function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sem-bench-"));
process.env.OPEN_MEMEX_HOME = HOME;
const START = Date.now();

import { serialize, normalizeFrontmatter } from "../src/store/markdown.ts";
import { syncScope } from "../src/store/sync.ts";
import { search } from "../src/retrieve/search.ts";
import { hasCjk } from "../src/retrieve/cjk.ts";
import { rerankCrossLingual } from "../src/retrieve/rerank.ts";
import { memoriesDirPath } from "../src/paths.ts";

interface Doc {
  id: string;
  /** Text the embedding model sees (body + captured aliases + tags). */
  text: string;
  /** Markdown body written to the index — fixture mode keeps this identical
   *  to retrieval-eval so the BM25 arm reproduces the published baseline. */
  body: string;
  /** EN/ZH by script; the cross-lingual trigger is query script != doc script. */
  lang: "en" | "zh";
}
interface Q {
  text: string;
  gold: Set<string>;
  note: string;
  lang: "en" | "zh";
}

const docs: Doc[] = [];
const questions: Q[] = [];
/** Fixture frontmatter, written verbatim so the BM25 arm reproduces the
 *  checked-in retrieval-eval baseline exactly (aliases/tags in their real
 *  FTS columns, not folded into the body). */
let fixtureMemories: Array<Record<string, unknown>> | null = null;

if (POOLED) {
  const dataPath = opt("--data") ?? "";
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
      const text = turns.map((t) => `${t.role}: ${t.content}`).join("\n").slice(0, 2000);
      docs.push({ id: `q${qi}-s${i}`, text, body: text, lang: hasCjk(text) ? "zh" : "en" });
    });
    const text: string = item.question;
    questions.push({ text, gold, note: item.question_type, lang: hasCjk(text) ? "zh" : "en" });
    qi++;
  }
} else {
  const { MEMORIES, QUERIES } = await import("./retrieval-eval/fixture.ts");
  fixtureMemories = MEMORIES;
  for (const m of MEMORIES) {
    const text = [m.body, ...(m.aliases ?? []), ...(m.tags ?? [])].join("\n").slice(0, 2000);
    docs.push({ id: m.id, text, body: m.body, lang: hasCjk(m.body) ? "zh" : "en" });
  }
  for (const q of QUERIES.slice(0, LIMIT)) {
    questions.push({
      text: q.query,
      gold: new Set(q.gold),
      note: q.note,
      lang: hasCjk(q.query) ? "zh" : "en",
    });
  }
}

console.log(`docs: ${docs.length}, questions: ${questions.length}, model: ${MODEL} (${DTYPE})`);
console.log(`cache dir: ${CACHE_DIR}`);
const byId = new Map(docs.map((d) => [d.id, d]));

// Seed the FTS index so the BM25 arm runs on the same corpus.
{
  const dir = memoriesDirPath("personal");
  fs.mkdirSync(dir, { recursive: true });
  const B = 2000;
  for (let i = 0; i < docs.length; i += B) {
    for (const d of docs.slice(i, i + B)) {
      // Fixture mode reproduces retrieval-eval's frontmatter exactly, so the
      // BM25 arm equals the published baseline; pooled mode has none.
      const fmDef = fixtureMemories?.find((m) => (m as { id: string }).id === d.id) as
        | {
            type?: string;
            tags?: string[];
            aliases?: string[];
            alias?: string;
            target?: string;
          }
        | undefined;
      const fm = normalizeFrontmatter({
        id: d.id,
        scope: "personal",
        type: fmDef?.type ?? "fact",
        tags: fmDef?.tags ?? [],
        aliases: fmDef?.aliases,
        alias: fmDef?.alias,
        target: fmDef?.target,
        source: fmDef ? "retrieval-eval fixture" : undefined,
      });
      fs.writeFileSync(path.join(dir, `${d.id}.md`), serialize(fm, d.body), "utf8");
    }
    if (docs.length > B) console.log(`  seeded ${Math.min(i + B, docs.length)}/${docs.length}`);
  }
  syncScope("personal");
}

// ---- BM25 arm (always measured: it is both a result and the rerank pool) ----
const bm25Ranks = new Map<string, number>();
const bm25Raw = new Map<string, string[]>();
const bm25Ms: number[] = [];
for (const q of questions) {
  const t0 = performance.now();
  const ids = search(q.text, { scopeKeys: ["personal"], limit: DEPTH, synonyms: false }).map((h) => h.id);
  bm25Ms.push(performance.now() - t0);
  bm25Raw.set(q.text, ids);
  let rank = -1;
  for (const g of q.gold) {
    const i = ids.indexOf(g);
    if (i !== -1 && (rank === -1 || i < rank)) rank = i;
  }
  bm25Ranks.set(q.text, rank);
}

interface Metrics {
  n: number;
  r1: number;
  r5: number;
  mrr: number;
}
function metrics(ranks: Map<string, number>, qs: Q[]): Metrics {
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const q of qs) {
    const rank = ranks.get(q.text) ?? -1;
    if (rank === 0) r1++;
    if (rank !== -1 && rank < K) r5++;
    if (rank !== -1) mrr += 1 / (rank + 1);
  }
  return { n: qs.length, r1, r5, mrr };
}
function fmt(m: Metrics): string {
  return `R@1 ${(m.r1 / m.n * 100).toFixed(1)}%  R@5 ${(m.r5 / m.n * 100).toFixed(1)}%  MRR ${(m.mrr / m.n).toFixed(3)}  (n=${m.n})`;
}

/**
 * The product shape: BM25 retrieves, embeddings may only reorder contiguous
 * runs of cross-lingual hits whose cosine clears `floor`. This calls the
 * SHIPPED pure rule (`src/retrieve/rerank.ts`), so the bench cannot drift
 * from the product's ordering; the arm only supplies cosines.
 */
function rerankOrder(ids: string[], queryLang: "en" | "zh", sim: (id: string) => number, floor: number): string[] {
  const cosines = new Map<string, number>();
  for (const id of ids) {
    const d = byId.get(id);
    if (d && d.lang !== queryLang) cosines.set(id, sim(id));
  }
  return rerankCrossLingual(ids.map((id) => ({ id })), cosines, { minCosine: floor }).ordered.map((h) => h.id);
}

function rankOf(ids: string[], gold: Set<string>): number {
  let rank = -1;
  for (const g of gold) {
    const i = ids.indexOf(g);
    if (i !== -1 && (rank === -1 || i < rank)) rank = i;
  }
  return rank;
}

const results: Record<string, Metrics> = {};
const ranksByArm = new Map<string, Map<string, number>>();
function record(arm: string, ranks: Map<string, number>) {
  ranksByArm.set(arm, ranks);
  results[arm] = metrics(ranks, questions);
}

record("bm25", bm25Ranks);

const crossQs = questions.filter((q) => {
  const goldLangs = [...q.gold].map((g) => byId.get(g)?.lang).filter(Boolean);
  return goldLangs.length > 0 && goldLangs.some((l) => l !== q.lang);
});
const sameQs = questions.filter((q) => !crossQs.includes(q));

let tax: {
  modelLoadMs: number;
  modelBytes: number;
  docEmbedMs: number;
  docEmbedPerDocMs: number;
  queryEmbedMedianMs: number;
  queryEmbedP95Ms: number;
  cacheBytes: number;
  rssMb: number;
  dim: number;
} | null = null;

if (ARMS.size > 0 && !(ARMS.size === 1 && ARMS.has("bm25"))) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(CACHE_DIR, "hf");
  fs.mkdirSync(env.cacheDir, { recursive: true });

  const slug = MODEL.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cachePath = path.join(CACHE_DIR, `emb-${slug}-${DTYPE}-${POOLED ? "pooled" : "fixture"}.json`);

  let vectors: number[][] | null = null;
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
        model: string;
        dim: number;
        ids: string[];
        vectors: number[][];
      };
      if (cached.model === `${MODEL}::${DTYPE}` && cached.ids.length === docs.length && cached.ids.every((id, i) => id === docs[i]!.id)) {
        vectors = cached.vectors;
        console.log(`vectors: cache hit ${cachePath} (${cached.dim}-dim)`);
      } else {
        console.log("vectors: cache is stale (model or corpus changed) — recomputing");
      }
    } catch {
      console.log("vectors: cache unreadable — recomputing");
    }
  }

  console.log("loading model… (first run downloads it into the cache dir)");
  const tLoad = performance.now();
  const extractor: any = await pipeline("feature-extraction", MODEL, { dtype: DTYPE as any });
  const modelLoadMs = performance.now() - tLoad;

  let docEmbedMs = 0;
  if (!vectors) {
    console.log(`embedding ${docs.length} docs…`);
    const tDocs = performance.now();
    vectors = [];
    const B = 32;
    for (let i = 0; i < docs.length; i += B) {
      const batch = docs.map((d) => d.text).slice(i, i + B);
      const out: any = await extractor(batch, { pooling: "mean", normalize: true });
      for (const v of out.tolist()) vectors.push(v);
      if (docs.length > 320 && i % 320 === 0) console.log(`  embedded ${i}/${docs.length}`);
    }
    docEmbedMs = performance.now() - tDocs;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ model: `${MODEL}::${DTYPE}`, dim: vectors[0]!.length, ids: docs.map((d) => d.id), vectors }),
    );
    console.log(`vectors cached: ${cachePath}`);
  }
  const DIM = vectors[0]!.length;

  const cos = (qv: number[], v: number[]): number => {
    let s = 0;
    for (let d = 0; d < DIM; d++) s += qv[d]! * v[d]!;
    return s;
  };
  const vecById = new Map<string, number[]>();
  docs.forEach((d, i) => vecById.set(d.id, vectors![i]!));

  const vecRanks = new Map<string, number>();
  const rrfRanks = new Map<string, number>();
  const rerankRanks = new Map<number, Map<string, number>>();
  for (const f of FLOORS) rerankRanks.set(f, new Map());
  const queryEmbedMs: number[] = [];

  let qi = 0;
  for (const q of questions) {
    const t0 = performance.now();
    const qv: number[] = (await extractor(q.text, { pooling: "mean", normalize: true })).tolist()[0];
    queryEmbedMs.push(performance.now() - t0);

    const vecOrder = docs
      .map((d) => ({ id: d.id, s: cos(qv, vecById.get(d.id)!) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.id);
    vecRanks.set(q.text, rankOf(vecOrder, q.gold));

    const rrf = (lists: string[][], k = 60): string[] => {
      const scores = new Map<string, number>();
      for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
      return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    };
    rrfRanks.set(q.text, rankOf(rrf([bm25Raw.get(q.text)!, vecOrder]), q.gold));

    const simById = new Map<string, number>();
    for (const id of bm25Raw.get(q.text)!) simById.set(id, cos(qv, vecById.get(id)!));
    for (const f of FLOORS) {
      const order = rerankOrder(bm25Raw.get(q.text)!, q.lang, (id) => simById.get(id) ?? -1, f);
      rerankRanks.get(f)!.set(q.text, rankOf(order, q.gold));
    }

    qi++;
    if (questions.length > 100 && qi % 100 === 0) console.log(`  ... ${qi}/${questions.length}`);
  }

  record("vec", vecRanks);
  record("rrf", rrfRanks);
  for (const f of FLOORS) record(`rerank@${f}`, rerankRanks.get(f)!);

  tax = {
    modelLoadMs,
    modelBytes: dirBytes(path.join(env.cacheDir!, MODEL)),
    docEmbedMs,
    docEmbedPerDocMs: docs.length ? docEmbedMs / docs.length : 0,
    queryEmbedMedianMs: median(queryEmbedMs),
    queryEmbedP95Ms: p95(queryEmbedMs),
    cacheBytes: fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0,
    rssMb: process.memoryUsage().rss / 1024 / 1024,
    dim: DIM,
  };
}

// ---- report ----
const armOrder = ["bm25", ...Object.keys(results).filter((a) => a !== "bm25")];
console.log(`\n==== semantic gate (${POOLED ? "pooled LongMemEval-S" : "retrieval fixture"}) ====`);
console.log(`corpus : ${docs.length} docs, ${questions.length} questions, BM25 depth ${DEPTH}`);
for (const arm of armOrder) console.log(`${arm.padEnd(12)} ${fmt(results[arm]!)}`);

if (crossQs.length > 0) {
  console.log(`\ncross-lingual slice (${crossQs.length} queries, gold script != query script):`);
  for (const arm of armOrder) console.log(`${arm.padEnd(12)} ${fmt(metrics(ranksByArm.get(arm)!, crossQs))}`);
  console.log(`\nsame-language slice (${sameQs.length} queries — rerank must not change these):`);
  for (const arm of armOrder) console.log(`${arm.padEnd(12)} ${fmt(metrics(ranksByArm.get(arm)!, sameQs))}`);

  console.log("\ncross-lingual per-query ranks (1-based, - = miss):");
  const show = armOrder.filter((a) => a === "bm25" || a === "vec" || a === "rrf" || a.startsWith("rerank@"));
  for (const q of crossQs) {
    const cells = show.map((a) => {
      const r = ranksByArm.get(a)!.get(q.text) ?? -1;
      return `${a.replace("rerank@", "r@")}=${r === -1 ? "-" : r + 1}`;
    });
    console.log(`  ${JSON.stringify(q.text).padEnd(46)} [${q.note}] ${cells.join(" ")}`);
  }
}

if (tax) {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
  console.log("\n---- tax (measured on this machine) ----");
  console.log(`model files      : ${mb(tax.modelBytes)} MB (${path.join(CACHE_DIR, "hf", MODEL)} @ ${DTYPE})`);
  console.log(`model load       : ${(tax.modelLoadMs / 1000).toFixed(2)} s (cold, one process)`);
  console.log(`doc embedding    : ${(tax.docEmbedMs / 1000).toFixed(2)} s total, ${tax.docEmbedPerDocMs.toFixed(1)} ms/doc (${docs.length} docs)`);
  console.log(`query embedding  : ${tax.queryEmbedMedianMs.toFixed(1)} ms median, ${tax.queryEmbedP95Ms.toFixed(1)} ms p95`);
  console.log(`vector cache     : ${mb(tax.cacheBytes)} MB on disk (${tax.dim}-dim)`);
  console.log(`process RSS      : ${tax.rssMb.toFixed(0)} MB after load`);
  console.log(`total wall       : ${((Date.now() - START) / 1000).toFixed(1)} s`);
} else {
  console.log("\n(tax not measured — model arms not requested)");
}

console.log(`\nbm25 latency: ${median(bm25Ms).toFixed(2)} ms median, ${p95(bm25Ms).toFixed(2)} ms p95`);

if (JSON_OUT) {
  const payload = {
    mode: POOLED ? "pooled" : "fixture",
    model: MODEL,
    dtype: DTYPE,
    docs: docs.length,
    questions: questions.length,
    depth: DEPTH,
    arms: Object.fromEntries(
      armOrder.map((a) => [
        a,
        {
          all: results[a],
          crossLingual: crossQs.length ? metrics(ranksByArm.get(a)!, crossQs) : null,
          sameLanguage: sameQs.length ? metrics(ranksByArm.get(a)!, sameQs) : null,
        },
      ]),
    ),
    tax,
    bm25Latency: { medianMs: median(bm25Ms), p95Ms: p95(bm25Ms) },
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2));
  console.log(`json: ${JSON_OUT}`);
}
