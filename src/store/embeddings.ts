/**
 * D96: disk cache for the cross-lingual rerank's text embeddings.
 *
 * Vectors are keyed by `(model, sha256(text))` — not by memory id — so an
 * edited memory re-embeds under a new key while an unchanged one stays warm
 * across supersede chains, scope moves, and index rebuilds. `model` is part of
 * the key so changing `embeddingModel` can never mix two vector spaces.
 *
 * Like the D77 counters and the D91 graph, this is derived local telemetry:
 * it lives in a `CREATE TABLE IF NOT EXISTS` table outside the versioned
 * index schema and is never dropped by `rebuildIndexSchema`. It never leaves
 * the machine and never appears in Markdown.
 *
 * Vectors are stored as little-endian float32 BLOBs: 1.5 KB for the 384-dim
 * default model, versus ~8 KB as JSON. Rows are written one per new text, so
 * a save costs O(1), not a rewrite of the whole cache.
 */
import { db } from "./db.ts";

function encode(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true);
  return bytes;
}

function decode(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 4);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Load the cached vectors for `hashes`. Missing hashes are simply absent. */
export function loadVectors(model: string, hashes: readonly string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (hashes.length === 0) return out;
  const d = db();
  // SQLite's default variable limit is 999; chunk well below it.
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const rows = d
      .prepare(
        `SELECT hash, vector FROM embedding_vectors
         WHERE model = ? AND hash IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(model, ...chunk) as Array<{ hash: string; vector: Uint8Array | Buffer }>;
    for (const r of rows) {
      const bytes = new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
      out.set(r.hash, decode(bytes));
    }
  }
  return out;
}

/** Insert or replace one vector. Idempotent on `(model, hash)`. */
export function saveVector(model: string, hash: string, values: readonly number[]): void {
  db()
    .prepare(
      `INSERT INTO embedding_vectors (model, hash, dim, vector) VALUES (?, ?, ?, ?)
       ON CONFLICT(model, hash) DO UPDATE SET dim = excluded.dim, vector = excluded.vector`,
    )
    .run(model, hash, values.length, encode(values));
}

/** Cache size for this model — `doctor` and the D96 docs quote this. */
export function countVectors(model: string): number {
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM embedding_vectors WHERE model = ?`)
    .get(model) as { n: number };
  return row.n;
}

/** Drop every vector for one model (a model switch or an explicit reset). */
export function clearVectors(model: string): number {
  const d = db();
  const before = countVectors(model);
  d.prepare(`DELETE FROM embedding_vectors WHERE model = ?`).run(model);
  return before;
}
