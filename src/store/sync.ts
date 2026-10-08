import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { cjkIndexText } from "../retrieve/cjk.ts";
import { expansionVariantsForDoc } from "../retrieve/synonyms.ts";
import { contentHash, repairChain } from "./lifecycle.ts";
import {
  iterMemoryFiles,
  iterInRepoMemoryFiles,
  readMemoryFile,
  timeToMs,
  type MemoryFile,
} from "./markdown.ts";
import { projectRoot, paths } from "../paths.ts";
import { loadConfig } from "../config.ts";

const UPSERT_SQL = `
  INSERT INTO memories (id, scope_key, scope, visibility, project_name, type, role, importance, status, tags, aliases, expansions, alias, target, content, cjk, content_hash, superseded_by, source, file_path, mtime_ms, created_at, updated_at, review_state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    aliases      = excluded.aliases,
    expansions   = excluded.expansions,
    alias        = excluded.alias,
    target       = excluded.target,
    content      = excluded.content,
    cjk          = excluded.cjk,
    content_hash = excluded.content_hash,
    superseded_by = excluded.superseded_by,
    source       = excluded.source,
    review_state = excluded.review_state,
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
  // D80 index-time expansion, D83: curated synonym/translation variants for
  // the memory's keywords are indexed in their own `expansions` column —
  // never mixed into `aliases`, which holds only user/authored alternate
  // phrasings (so `(aka: …)` attribution stays honest). The CJK bigram
  // column still covers expansions, so CJK variants stay substring-
  // searchable. Derived at sync time — the Markdown file stays the source
  // of truth.
  const supplied = fm.aliases ?? [];
  const have = new Set(supplied.map((a) => a.toLowerCase()));
  const auto = expansionVariantsForDoc(body + "\n" + tags).filter(
    (a) => !have.has(a.toLowerCase()),
  );
  const aliases = supplied.join(",");
  const expansions = auto.join(",");
  // D81: user-defined alias vocabulary (single nickname → referent pair).
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
    aliases,
    expansions,
    fm.alias ?? "",
    fm.target ?? "",
    body,
    cjkIndexText(body + "\n" + tags + "\n" + aliases + "\n" + expansions),
    contentHash(body),
    fm.superseded_by ?? null,
    fm.source ?? "",
    filePath,
    mtimeMs,
    timeToMs(fm.created_at),
    timeToMs(fm.updated_at),
    fm.review_state ?? "draft",
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

export function syncScope(scopeKey: string, kind: SyncKind = "auto"): SyncStats {
  const d = db();
  const stats: SyncStats = { added: 0, updated: 0, removed: 0, scanned: 0 };

  const existing = d
    .prepare(`SELECT id, file_path, mtime_ms FROM memories WHERE scope_key = ?`)
    .all(scopeKey) as Array<{ id: string; file_path: string; mtime_ms: number }>;
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const seen = new Set<string>();

  // 2B/D26: project scopes have two homes — the appdata outbox (drafts,
  // branch-independent) and the in-repo dir (submitted memories, following
  // the current branch). No migration: appdata files stay put until an
  // explicit `submit` moves them. On the near-impossible id collision the
  // in-repo (submitted) copy wins, so scan appdata first.
  const filePaths: string[] = [];
  if (scopeKey.startsWith("project__")) {
    const root = projectRoot();
    const memoryDir = loadConfig().memoryDir;
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

  recordSync(scopeKey, kind, stats);
  return stats;
}

// ---------------------------------------------------------------------------
// D31: last-sync visibility
// ---------------------------------------------------------------------------

/** What triggered the sync — shown in sync-status so the user can see it. */
export type SyncKind = "session" | "request" | "cli" | "submit" | "pull" | "push" | "auto";

export interface SyncStateEntry {
  lastSyncAt: string; // RFC 3339
  lastSyncKind: SyncKind;
  added: number;
  updated: number;
  removed: number;
  scanned: number;
}

function syncStatePath(): string {
  return path.join(paths().root, "sync-state.json");
}

/** Best-effort: a failed write never breaks the sync itself. */
export function recordSync(scopeKey: string, kind: SyncKind, stats: SyncStats): void {
  try {
    const p = syncStatePath();
    let all: Record<string, SyncStateEntry> = {};
    if (fs.existsSync(p)) {
      try {
        all = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, SyncStateEntry>;
      } catch {
        /* corrupt — start fresh */
      }
    }
    all[scopeKey] = {
      lastSyncAt: new Date().toISOString(),
      lastSyncKind: kind,
      added: stats.added,
      updated: stats.updated,
      removed: stats.removed,
      scanned: stats.scanned,
    };
    fs.writeFileSync(p, JSON.stringify(all, null, 2), "utf8");
  } catch {
    /* visibility is advisory — never fail a sync over it */
  }
}

export function readSyncState(scopeKey: string): SyncStateEntry | null {
  try {
    const p = syncStatePath();
    if (!fs.existsSync(p)) return null;
    const all = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    const e = all?.[scopeKey] as SyncStateEntry | undefined;
    if (!e || typeof e.lastSyncAt !== "string") return null;
    return e;
  } catch {
    return null;
  }
}
