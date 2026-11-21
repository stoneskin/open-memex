/**
 * D96: local embedding runtime for the opt-in cross-lingual rerank.
 *
 * Local-first, no API: the model runs through `@huggingface/transformers`
 * (ONNX, CPU) and is downloaded into `<data root>/models/` on first use.
 * Vectors are cached in SQLite (`embedding_vectors`, keyed by a hash of the
 * embedded text), so a warm store never re-embeds a memory.
 *
 * The package is deliberately NOT a dependency of open-memex: it pulls
 * ~100-500 MB of model + onnxruntime, and the default install must stay
 * zero-download. When the flag is on and the package is missing, the rerank
 * degrades to plain BM25 with one stderr warning — never an error.
 *
 * Nothing here loads a model unless the caller already decided that a
 * cross-lingual candidate exists; a same-language search pays zero cost.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { dataRootPath } from "../paths.ts";
import { db } from "../store/db.ts";
import { loadVectors, saveVector } from "../store/embeddings.ts";
import { hasCjk } from "./cjk.ts";
import { rerankCrossLingual, type RerankHitInfo } from "./rerank.ts";
import { hitReviewTier, type SearchHit } from "./search.ts";

/** The model the D96 gate measured. User-configurable via `embeddingModel`. */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

/** Package name, spelled once so the dynamic import stays non-literal (it is optional). */
const PACKAGE = "@huggingface/transformers";

type Embedder = (
  texts: string[],
  opts: { pooling: "mean"; normalize: true },
) => Promise<{ tolist(): number[][] }>;

interface Runtime {
  embedder: Embedder;
}

let runtimeCache: { model: string; promise: Promise<Runtime | null> } | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // stdout is the MCP protocol channel — diagnostics go to stderr.
  process.stderr.write(`[open-memex] ${message}\n`);
}

/** Cache root the ONNX model files are downloaded into (never the repo). */
export function embeddingModelDir(): string {
  return path.join(dataRootPath(), "models");
}

async function loadRuntime(model: string): Promise<Runtime | null> {
  try {
    const spec = PACKAGE;
    const mod: any = await import(spec);
    const cacheDir = embeddingModelDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    mod.env.cacheDir = cacheDir;
    const pipeline = mod.pipeline;
    // D96: the gate measured q8 identical to fp32 on the fixture at ~1/4 the
    // download (113 MB vs 449 MB). If a user override lacks a quantized file,
    // the load fails and we degrade to BM25 with a warning.
    const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
    return { embedder: extractor as Embedder };
  } catch (err) {
    warnOnce(
      `load:${model}`,
      `cross-lingual rerank is on but the local embedding runtime is unavailable (${(err as Error).message}). ` +
        `Install it with: npm install -g ${PACKAGE}. Search falls back to BM25.`,
    );
    return null;
  }
}

function runtime(model: string): Promise<Runtime | null> {
  if (runtimeCache?.model !== model) runtimeCache = { model, promise: loadRuntime(model) };
  return runtimeCache.promise;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** The text a memory contributes to the embedding — the same fields the bench embedded. */
function memoryText(content: string, aliases: string, tags: string): string {
  const split = (s: string): string[] =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return [content, ...split(aliases), ...split(tags)]
    .filter((s) => s.trim().length > 0)
    .join("\n")
    .slice(0, 2000);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export interface RerankOutcome {
  hits: SearchHit[];
  /** Why the rerank did not run: "off" | "no-cross-lingual-hits" | "model-unavailable". */
  skipped?: "off" | "no-cross-lingual-hits" | "model-unavailable";
  /** How many returned hits were cross-lingual candidates. */
  candidates: number;
  info: Map<string, RerankHitInfo>;
  promotions: Array<{ id: string; promoted: number; cosine: number }>;
}

/**
 * Rerank an already-retrieved list for EN<->ZH queries only.
 *
 * Called after `search()`, so BM25 has already chosen the set and the review
 * tiers are already ordered; this only reorders within each contiguous tier
 * block. A query with no cross-lingual hit returns immediately and never
 * loads a model.
 */
export async function applyCrossLingualRerank(
  query: string,
  hits: SearchHit[],
  cfg: { crossLingualRerank: boolean; embeddingModel: string },
): Promise<RerankOutcome> {
  const untouched: RerankOutcome = { hits, candidates: 0, info: new Map(), promotions: [] };
  if (!cfg.crossLingualRerank) return { ...untouched, skipped: "off" };
  if (hits.length === 0) return { ...untouched, skipped: "no-cross-lingual-hits" };

  const queryCjk = hasCjk(query);
  const ids = hits.map((h) => h.id);
  const rows = db()
    .prepare(
      `SELECT id, content, COALESCE(aliases, '') AS aliases, COALESCE(tags, '') AS tags
       FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{ id: string; content: string; aliases: string; tags: string }>;
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Cross-lingual = the memory's script differs from the query's. Everything
  // else is a barrier that keeps its exact BM25 slot.
  const texts = new Map<string, string>();
  for (const h of hits) {
    const r = byId.get(h.id);
    if (!r) continue;
    if (hasCjk(r.content) === queryCjk) continue;
    texts.set(h.id, memoryText(r.content, r.aliases, r.tags));
  }
  if (texts.size === 0) return { ...untouched, skipped: "no-cross-lingual-hits" };

  const rt = await runtime(cfg.embeddingModel);
  if (!rt) return { ...untouched, skipped: "model-unavailable" };

  const hashes = new Map<string, string>();
  for (const [id, text] of texts) hashes.set(id, hashText(text));
  let cached: Map<string, number[]>;
  try {
    cached = loadVectors(cfg.embeddingModel, [...new Set(hashes.values())]);
  } catch {
    cached = new Map();
  }
  const pending = [...texts].filter(([id]) => !cached.has(hashes.get(id)!));
  if (pending.length > 0) {
    const vectors = await rt.embedder(pending.map(([, text]) => text), {
      pooling: "mean",
      normalize: true,
    });
    const list = vectors.tolist();
    pending.forEach(([id], i) => {
      const vec = list[i]!;
      cached.set(hashes.get(id)!, vec);
      try {
        saveVector(cfg.embeddingModel, hashes.get(id)!, vec);
      } catch (err) {
        // A cache that cannot be written is a slowdown, not a failure.
        warnOnce("vector-cache-write", `could not cache the embedding (${(err as Error).message})`);
      }
    });
  }

  const queryVector = (await rt.embedder([query], { pooling: "mean", normalize: true })).tolist()[0]!;
  const cosines = new Map<string, number>();
  for (const id of texts.keys()) {
    const v = cached.get(hashes.get(id)!);
    if (v) cosines.set(id, cosine(queryVector, v));
  }

  // Rerank inside each contiguous review-tier block — a draft can never be
  // lifted over reviewed knowledge (D30).
  const ordered: SearchHit[] = [];
  const info = new Map<string, RerankHitInfo>();
  const promotions: RerankOutcome["promotions"] = [];
  let i = 0;
  while (i < hits.length) {
    const tier = hitReviewTier(hits[i]!);
    let j = i + 1;
    while (j < hits.length && hitReviewTier(hits[j]!) === tier) j++;
    const block = rerankCrossLingual(hits.slice(i, j), cosines);
    for (const [id, x] of block.info) {
      info.set(id, { ...x, from: x.from + i, to: x.to + i });
    }
    for (const p of block.promotions) promotions.push(p);
    ordered.push(...block.ordered);
    i = j;
  }
  return { hits: ordered, candidates: texts.size, info, promotions };
}
