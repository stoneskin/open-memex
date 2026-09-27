import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { cjkIndexText } from "../retrieve/cjk.ts";
import { contentHash, repairChain } from "./lifecycle.ts";
import {
  iterMemoryFiles,
  iterInRepoMemoryFiles,
  migrateScopeToRepo,
  readMemoryFile,
  timeToMs,
  type MemoryFile,
} from "./markdown.ts";
import { projectRoot } from "../paths.ts";
import { loadConfig } from "../config.ts";

const UPSERT_SQL = `
  INSERT INTO memories (id, scope_key, scope, visibility, project_name, type, role, importance, status, tags, content, cjk, content_hash, superseded_by, source, file_path, mtime_ms, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    scope_key    = excluded.scope_key,
    scope        = excluded.scope,
    visibility   = excluded.visibility,
    project_name = excluded.project_name,
    type         = excluded.type,
    role         = excluded.role,
    importance   = excluded.importance,
    status       = excluded.status,
    tags         = excluded.tags,
    content      = excluded.content,
    cjk          = excluded.cjk,
    content_hash = excluded.content_hash,
    superseded_by = excluded.superseded_by,
    source       = excluded.source,
    file_path    = excluded.file_path,
    mtime_ms     = excluded.mtime_ms,
    updated_at   = excluded.updated_at
`;

export function upsertFromFile(mf: MemoryFile): void {
  // Chain integrity (§3.3): every write path through Core validates the
  // supersedes/superseded_by pair and auto-completes a missing side.
  const { warnings, repaired } = repairChain(mf);
  for (const w of warnings) console.warn(`[open-memex] chain: ${w}`);
  const mtimeOf = (m: MemoryFile): number => {
    try {
      return fs.statSync(m.filePath).mtimeMs;
    } catch {
      return m.mtimeMs; // file vanished mid-repair; keep the old mtime
    }
  };
  writeRow(
    mf,
    repaired.some((r) => r.filePath === mf.filePath) ? mtimeOf(mf) : mf.mtimeMs,
  );
  for (const r of repaired) {
    if (r.filePath === mf.filePath) continue;
    writeRow(r, mtimeOf(r));
  }
}

function writeRow(mf: MemoryFile, mtimeMs: number): void {
  const { fm, body, filePath } = mf;
  const tags = (fm.tags ?? []).join(",");
  db().prepare(UPSERT_SQL).run(
    fm.id,
    fm.scope_key,
    fm.scope,
    fm.visibility,
    fm.project_name,
    fm.type,
    fm.role,
    fm.importance,
    fm.status,
    tags,
    body,
    cjkIndexText(body + "\n" + tags),
    contentHash(body),
    fm.superseded_by ?? null,
    fm.source ?? "",
    filePath,
    mtimeMs,
    timeToMs(fm.created_at),
    timeToMs(fm.updated_at),
  );
}

export function deleteFromIndex(id: string): void {
  db().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

export interface SyncStats {
  added: number;
  updated: number;
  removed: number;
  scanned: number;
}

export function syncScope(scopeKey: string): SyncStats {
  const d = db();
  const stats: SyncStats = { added: 0, updated: 0, removed: 0, scanned: 0 };

  const existing = d
    .prepare(`SELECT id, file_path, mtime_ms FROM memories WHERE scope_key = ?`)
    .all(scopeKey) as Array<{ id: string; file_path: string; mtime_ms: number }>;
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const seen = new Set<string>();

  // 2B/D24: project scopes live in the repo dir. Drain any legacy appdata
  // files first, then scan both locations (appdata first so the in-repo copy
  // wins on the near-impossible id collision).
  const filePaths: string[] = [];
  if (scopeKey.startsWith("project__")) {
    const root = projectRoot();
    const memoryDir = loadConfig().memoryDir;
    migrateScopeToRepo(scopeKey, root, memoryDir);
    for (const fp of iterMemoryFiles(scopeKey)) filePaths.push(fp);
    for (const fp of iterInRepoMemoryFiles(root, memoryDir)) filePaths.push(fp);
  } else {
    for (const fp of iterMemoryFiles(scopeKey)) filePaths.push(fp);
  }

  for (const fp of filePaths) {
    const mf = readMemoryFile(fp);
    if (!mf) continue;
    stats.scanned++;
    seen.add(mf.fm.id);
    const prev = existingById.get(mf.fm.id);
    if (!prev) {
      upsertFromFile(mf);
      stats.added++;
    } else if (prev.mtime_ms !== mf.mtimeMs || prev.file_path !== mf.filePath) {
      upsertFromFile(mf);
      stats.updated++;
    }
  }

  for (const row of existing) {
    if (!seen.has(row.id) || !fs.existsSync(row.file_path)) {
      deleteFromIndex(row.id);
      stats.removed++;
    }
  }

  return stats;
}
