import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { paths, memoriesDirPath } from "../paths.ts";
import { cjkIndexText } from "../retrieve/cjk.ts";
import {
  parse,
  serialize,
  ulid,
  msToRfc3339,
  type Frontmatter,
  type MemoryFile,
  type MemoryStatus,
} from "./markdown.ts";

/**
 * Dedup + lifecycle (V2-DESIGN §3.3, §3.4).
 *
 * - Dedup on write: exact content hash → idempotent add; fuzzy token
 *   overlap (Jaccard ≥ 0.8, CJK-bigram aware) → near-duplicate notice.
 * - Lifecycle: active → superseded | deprecated | retracted | archived.
 *   Superseding never overwrites: the old memory keeps its history with a
 *   bidirectional supersedes/superseded_by chain. Retrieval (§3.3) returns
 *   only the newest of a chain and excludes retracted/archived.
 */

/** sha256 of whitespace-normalized body. Stored in the index (derived). */
export function contentHash(body: string): string {
  const norm = body.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

function tokenSet(text: string): Set<string> {
  const latin = text.toLowerCase().match(/[a-z0-9_\-]+/g) ?? [];
  const cjk = cjkIndexText(text).split(" ").filter(Boolean);
  return new Set([...latin, ...cjk]);
}

/** Jaccard similarity over latin tokens + CJK bigrams. 1 = identical. */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DuplicateCandidate {
  id: string;
  score: number;
  snippet: string;
}

export interface DupResult {
  exact?: DuplicateCandidate;
  near: DuplicateCandidate[];
}

export const NEAR_DUP_THRESHOLD = 0.8;

interface IndexRow {
  id: string;
  content_hash: string;
  content: string;
}

/** Find exact + near duplicates of `body` among ACTIVE memories in scope. */
export function findDuplicates(
  scopeKey: string,
  body: string,
  excludeId?: string,
): DupResult {
  const hash = contentHash(body);
  const rows = db()
    .prepare(
      `SELECT id, content_hash, content FROM memories
       WHERE scope_key = ? AND status = 'active'`,
    )
    .all(scopeKey) as IndexRow[];

  let exact: DuplicateCandidate | undefined;
  const near: DuplicateCandidate[] = [];
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (r.content_hash && r.content_hash === hash) {
      exact = { id: r.id, score: 1, snippet };
      continue;
    }
    const score = similarity(body, r.content);
    if (score >= NEAR_DUP_THRESHOLD) near.push({ id: r.id, score, snippet });
  }
  near.sort((x, y) => y.score - x.score);
  return { exact, near: near.slice(0, 3) };
}

/** Locate a memory file by id: index first, then a full dir scan fallback. */
export function findMemoryFile(id: string): MemoryFile | null {
  const { memories } = paths();
  let filePath: string | null = null;
  try {
    const row = db()
      .prepare(`SELECT scope_key FROM memories WHERE id = ?`)
      .get(id) as { scope_key: string } | undefined;
    if (row) {
      const p = path.join(memoriesDirPath(row.scope_key), `${id}.md`);
      if (fs.existsSync(p)) filePath = p;
    }
  } catch {
    // index unavailable — fall through to scan
  }
  if (!filePath && fs.existsSync(memories)) {
    for (const entry of fs.readdirSync(memories, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(memories, entry.name, `${id}.md`);
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }
  }
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parse(raw);
  if (!parsed) return null;
  const st = fs.statSync(filePath);
  return { fm: parsed.fm, body: parsed.body, filePath, mtimeMs: st.mtimeMs };
}

export function rewriteMemoryFile(mf: MemoryFile): void {
  fs.writeFileSync(mf.filePath, serialize(mf.fm, mf.body), "utf8");
}

export interface ChainRepairResult {
  warnings: string[];
  /** Linked memories whose files were rewritten; caller should re-index them. */
  repaired: MemoryFile[];
}

/**
 * Chain integrity (§3.3): supersedes/superseded_by must be pairwise
 * consistent. A missing side is auto-completed and reported — a broken chain
 * must never silently degrade retrieval. Dangling pointers (target file
 * gone) can only be reported.
 */
export function repairChain(mf: MemoryFile): ChainRepairResult {
  const warnings: string[] = [];
  const repaired: MemoryFile[] = [];
  const fm = mf.fm;

  if (fm.supersedes) {
    const prev = findMemoryFile(fm.supersedes);
    if (!prev) {
      warnings.push(
        `${fm.id}: supersedes target ${fm.supersedes} not found (dangling)`,
      );
    } else if (prev.fm.superseded_by !== fm.id) {
      prev.fm.superseded_by = fm.id;
      if (prev.fm.status === "active") prev.fm.status = "superseded";
      prev.fm.updated_at = msToRfc3339(Date.now());
      rewriteMemoryFile(prev);
      repaired.push(prev);
      warnings.push(
        `${fm.id}: auto-completed ${prev.fm.id}.superseded_by → ${fm.id}`,
      );
    }
  }

  if (fm.superseded_by) {
    const next = findMemoryFile(fm.superseded_by);
    if (!next) {
      warnings.push(
        `${fm.id}: superseded_by target ${fm.superseded_by} not found (dangling)`,
      );
    } else if (next.fm.supersedes !== fm.id) {
      next.fm.supersedes = fm.id;
      next.fm.updated_at = msToRfc3339(Date.now());
      rewriteMemoryFile(next);
      repaired.push(next);
      warnings.push(
        `${fm.id}: auto-completed ${next.fm.id}.supersedes → ${fm.id}`,
      );
    }
  }

  return { warnings, repaired };
}

export interface SupersedeInput {
  body: string;
  type?: string;
  tags?: string[];
  source?: string;
}

/**
 * Replace an active memory with a new one. The old memory is NOT overwritten:
 * it becomes `status: superseded` with a forward pointer; the new memory
 * points back. History preserved; retrieval returns the newest (§3.4).
 */
export function supersede(
  oldId: string,
  input: SupersedeInput,
): { oldMf: MemoryFile; newMf: MemoryFile } {
  const oldMf = findMemoryFile(oldId);
  if (!oldMf) throw new Error(`no memory with id ${oldId}`);
  if (oldMf.fm.status !== "active") {
    throw new Error(
      `cannot supersede memory with status '${oldMf.fm.status}' (id ${oldId}); only active memories can be superseded`,
    );
  }

  const now = msToRfc3339(Date.now());
  const newFm: Frontmatter = {
    ...oldMf.fm,
    id: ulid(),
    type: input.type ?? oldMf.fm.type,
    tags: input.tags ?? oldMf.fm.tags,
    source: input.source ?? oldMf.fm.source,
    status: "active",
    created_at: now,
    updated_at: now,
    supersedes: oldId,
    superseded_by: null,
  };
  const dir = path.dirname(oldMf.filePath);
  const newPath = path.join(dir, `${newFm.id}.md`);
  fs.writeFileSync(newPath, serialize(newFm, input.body), "utf8");
  const st = fs.statSync(newPath);
  const newMf: MemoryFile = {
    fm: newFm,
    body: input.body,
    filePath: newPath,
    mtimeMs: st.mtimeMs,
  };

  oldMf.fm.status = "superseded";
  oldMf.fm.superseded_by = newFm.id;
  oldMf.fm.updated_at = now;
  rewriteMemoryFile(oldMf);

  return { oldMf, newMf };
}

const SETTABLE_STATUSES: ReadonlyArray<MemoryStatus> = [
  "active",
  "deprecated",
  "retracted",
  "archived",
];

export function isSettableStatus(s: string): s is MemoryStatus {
  return (SETTABLE_STATUSES as ReadonlyArray<string>).includes(s);
}

/**
 * Direct lifecycle transition. `superseded` is NOT settable here — it is
 * managed exclusively by `supersede()` so the chain stays consistent.
 */
export function setStatus(id: string, status: MemoryStatus): MemoryFile {
  if (!isSettableStatus(status)) {
    throw new Error(
      `invalid status '${status}'; use one of: ${SETTABLE_STATUSES.join(", ")}`,
    );
  }
  const mf = findMemoryFile(id);
  if (!mf) throw new Error(`no memory with id ${id}`);
  if (mf.fm.status === "superseded") {
    throw new Error(
      `memory ${id} is superseded (chain-managed); supersede it again instead of changing status directly`,
    );
  }
  mf.fm.status = status;
  mf.fm.updated_at = msToRfc3339(Date.now());
  rewriteMemoryFile(mf);
  return mf;
}
