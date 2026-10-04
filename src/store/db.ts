import { createRequire } from "node:module";
import { paths } from "../paths.ts";
import {
  MIN_NODE_VERSION,
  nativeDriverFloorMessage,
  nodeSupportsNativeDriver,
} from "../runtime-floor.ts";

// Runtime-agnostic SQLite:
//   - Inside opencode (Bun runtime): bun:sqlite (built-in, no native module load)
//   - Under Node CLI: better-sqlite3
// Both expose the same shape: new Database(path), .exec(sql), .prepare(sql).{run,all,get}, .close()
const require = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDatabase = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDatabaseCtor = new (path: string) => AnyDatabase;

function loadDatabase(): AnyDatabaseCtor {
  if (isBun) {
    // bun:sqlite is a built-in module; only resolvable under the Bun runtime.
    return require("bun:sqlite").Database as AnyDatabaseCtor;
  }
  // D74: better-sqlite3 13 is built against Node-API 10, which Node gained in
  // 22.14.0. Below that floor `require` succeeds and `new Database()` then
  // segfaults the process with no diagnostic — so refuse before we can crash
  // and say what to do instead (upstream: WiseLibs/better-sqlite3#1514).
  if (!nodeSupportsNativeDriver(process.versions.node)) {
    throw new Error(nativeDriverFloorMessage());
  }
  return require("better-sqlite3") as AnyDatabaseCtor;
}

let _db: AnyDatabase | null = null;

const TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  scope_key    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'private',
  project_name TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'fact',
  role         TEXT NOT NULL DEFAULT 'knowledge',
  importance   TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'active',
  tags         TEXT NOT NULL DEFAULT '',
  aliases      TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  cjk          TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  superseded_by TEXT,
  source       TEXT NOT NULL DEFAULT '',
  file_path    TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'draft'
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
  ON memories(scope_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
`;

// The `cjk` column holds pre-tokenized CJK unigrams+bigrams (see
// src/retrieve/cjk.ts). FTS5's unicode61 treats a CJK run as one token, so
// without this column CJK substring search cannot work. Kept as a separate
// column (rather than a custom tokenizer) so both runtimes stay on stock
// SQLite with zero native dependencies.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  aliases,
  type,
  cjk,
  scope_key UNINDEXED,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, aliases, type, cjk, scope_key)
  VALUES (new.rowid, new.content, new.tags, new.aliases, new.type, new.cjk, new.scope_key);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, aliases, type, cjk, scope_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.aliases, old.type, old.cjk, old.scope_key);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, aliases, type, cjk, scope_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.aliases, old.type, old.cjk, old.scope_key);
  INSERT INTO memories_fts(rowid, content, tags, aliases, type, cjk, scope_key)
  VALUES (new.rowid, new.content, new.tags, new.aliases, new.type, new.cjk, new.scope_key);
END;
`;

/** Current index schema version. Bump when TABLE_SCHEMA/FTS_SCHEMA change. */
const SCHEMA_VERSION = 7;

function userVersion(d: AnyDatabase): number {
  const row = d.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Any schema change: the query layer is fully derived from markdown (D1),
 * so wipe it and let the next syncScope() repopulate. The markdown files
 * themselves are untouched — `migrate --to-v2` handles the file format.
 * NOTE ordering matters: triggers are dropped BEFORE the wipe, and the FTS
 * table is rebuilt after. FTS5's 'delete' command corrupts
 * (SQLITE_CORRUPT_VTAB) when it targets a rowid that was never indexed, so
 * the wipe must not fire any FTS trigger while the index is out of sync
 * with the table (found 2026-09-26).
 */
function rebuildIndexSchema(d: AnyDatabase): void {
  d.exec(`DROP TRIGGER IF EXISTS memories_ai;
          DROP TRIGGER IF EXISTS memories_ad;
          DROP TRIGGER IF EXISTS memories_au;`);
  d.exec("DELETE FROM memories");
  d.exec(`DROP TABLE IF EXISTS memories_fts;`);
  d.exec(`DROP TABLE IF EXISTS memories;`);
  d.exec(TABLE_SCHEMA);
  d.exec(FTS_SCHEMA);
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function db(): AnyDatabase {
  if (_db) return _db;
  const { indexDb } = paths();
  const Database = loadDatabase();
  const d = new Database(indexDb);
  d.exec("PRAGMA journal_mode = WAL;");
  // Multiple processes share this index (CLI, one MCP server per editor,
  // the opencode plugin). Without a busy timeout, bun:sqlite defaults to
  // 0 — any overlapping write fails instantly. 5s matches the tolerance
  // better-sqlite3 was already giving the CLI/MCP side (D57).
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec("PRAGMA synchronous = NORMAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(TABLE_SCHEMA);
  d.exec(FTS_SCHEMA);
  if (userVersion(d) < SCHEMA_VERSION) rebuildIndexSchema(d);
  _db = d;
  return d;
}

/** Close the DB. Only used by tests / CLI teardown. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Which backend this process is using. Useful for diagnostics. */
export function backendName(): "bun:sqlite" | "better-sqlite3" {
  return isBun ? "bun:sqlite" : "better-sqlite3";
}
