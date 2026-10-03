import fs from "node:fs";
import { db } from "./db.ts";
import {
  readMemoryFile,
  iterInRepoMemoryFiles,
  iterMemoryFiles,
} from "./markdown.ts";
import { similarity, NEAR_DUP_THRESHOLD } from "./lifecycle.ts";
import { projectRoot } from "../paths.ts";
import { loadConfig } from "../config.ts";

// Memory health audit (D57). Read-only: reports, never mutates.
// Checks, per open question "retrieval explainability & memory health":
//   - near-duplicate pairs among active memories (same dedup yardstick
//     as write-time: Jaccard >= 0.8) that were never superseded;
//   - stale actives: untouched for STALE_DAYS, still in the retrieval /
//     injection pool;
//   - broken supersede chains: superseded_by pointing at a missing id;
//   - personal files inside the in-repo memory dir (iron-rule breach:
//     personal memory must never land in a shared repo);
//   - index/file drift after sync (should be zero; reported if not).

export const STALE_DAYS = 90;

interface AuditRow {
  id: string;
  scope_key: string;
  status: string;
  updated_at: number;
  superseded_by: string | null;
  content: string;
  file_path: string;
}

export interface DuplicatePair {
  a: string;
  b: string;
  scopeKey: string;
  score: number;
}

export interface AuditReport {
  totalMemories: number;
  duplicatePairs: DuplicatePair[];
  stale: { id: string; scopeKey: string; ageDays: number }[];
  brokenChains: { id: string; scopeKey: string; missingTarget: string }[];
  personalInRepo: string[];
  drift: { filesNotIndexed: number; rowsMissingFiles: number };
}

export function runAudit(scopeKeys: string[]): AuditReport {
  const d = db();
  const rows = d
    .prepare(
      `SELECT id, scope_key, status, updated_at, superseded_by, content, file_path
       FROM memories`,
    )
    .all() as AuditRow[];
  const inScope = rows.filter((r) => scopeKeys.includes(r.scope_key));
  const ids = new Set(rows.map((r) => r.id));

  // Near-duplicate pairs: active only, same scope. O(n^2) per scope with a
  // length pre-filter; local stores are small enough for this to be fine.
  const pairs: DuplicatePair[] = [];
  const byScope = new Map<string, AuditRow[]>();
  for (const r of inScope) {
    if (r.status !== "active") continue;
    const arr = byScope.get(r.scope_key) ?? [];
    arr.push(r);
    byScope.set(r.scope_key, arr);
  }
  for (const [scopeKey, arr] of byScope) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!;
        const b = arr[j]!;
        const la = a.content.length;
        const lb = b.content.length;
        if (Math.min(la, lb) / Math.max(la, lb) < 0.5) continue;
        const score = similarity(a.content, b.content);
        if (score >= NEAR_DUP_THRESHOLD) {
          pairs.push({ a: a.id, b: b.id, scopeKey, score });
        }
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const now = Date.now();
  const stale = inScope
    .filter((r) => r.status === "active")
    .map((r) => ({ id: r.id, scopeKey: r.scope_key, ageDays: Math.floor((now - r.updated_at) / 86_400_000) }))
    .filter((s) => s.ageDays >= STALE_DAYS)
    .sort((x, y) => y.ageDays - x.ageDays);

  const brokenChains = inScope
    .filter((r) => r.superseded_by && !ids.has(r.superseded_by))
    .map((r) => ({ id: r.id, scopeKey: r.scope_key, missingTarget: r.superseded_by! }));

  // Personal files must never sit in the in-repo dir. Read-only: this only
  // parses frontmatter of files already in the repo tree.
  const personalInRepo: string[] = [];
  try {
    const root = projectRoot();
    const memoryDir = loadConfig().memoryDir;
    for (const fp of iterInRepoMemoryFiles(root, memoryDir)) {
      const mf = readMemoryFile(fp);
      if (mf && mf.fm.scope === "personal") personalInRepo.push(fp);
    }
  } catch {
    // No project root (e.g. personal-only usage): nothing to scan.
  }

  // Drift: index rows whose file vanished, and files on disk the index
  // never picked up. syncScope normally heals both before audit runs.
  const indexedPaths = new Set(rows.map((r) => r.file_path));
  let rowsMissingFiles = 0;
  for (const r of inScope) {
    if (!r.file_path || !fs.existsSync(r.file_path)) rowsMissingFiles++;
  }
  let filesNotIndexed = 0;
  for (const key of scopeKeys) {
    for (const fp of iterMemoryFiles(key)) {
      if (!indexedPaths.has(fp)) filesNotIndexed++;
    }
  }

  return {
    totalMemories: inScope.length,
    duplicatePairs: pairs,
    stale,
    brokenChains,
    personalInRepo,
    drift: { filesNotIndexed, rowsMissingFiles },
  };
}
