import { createRequire } from "node:module";
import { paths } from "../paths.ts";

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
  return require("better-sqlite3") as AnyDatabaseCtor;
}

let _db: AnyDatabase | null = null;

const TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  scope_key    TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,
  project_name TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'note',
  tags         TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  file_path    TEXT NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  cjk          TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
  ON memories(scope_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
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
  type,
  cjk,
  scope_key UNINDEXED,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, type, cjk, scope_key)
  VALUES (new.rowid, new.content, new.tags, new.type, new.cjk, new.scope_key);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, type, cjk, scope_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.type, old.cjk, old.scope_key);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, type, cjk, scope_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.type, old.cjk, old.scope_key);
  INSERT INTO memories_fts(rowid, content, tags, type, cjk, scope_key)
  VALUES (new.rowid, new.content, new.tags, new.type, new.cjk, new.scope_key);
END;
`;

/** Current index schema version. Bump when TABLE_SCHEMA/FTS_SCHEMA change. */
const SCHEMA_VERSION = 2;

function userVersion(d: AnyDatabase): number {
  const row = d.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** v1 -> v2: add `cjk` column and rebuild the FTS table with it. */
function migrateToV2(d: AnyDatabase): void {
  const cols = d.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "cjk")) {
    d.exec("ALTER TABLE memories ADD COLUMN cjk TEXT NOT NULL DEFAULT ''");
  }
  // The query layer is fully derived from markdown (D1); wipe it so the next
  // syncScope() repopulates every row with the cjk column filled.
  // NOTE ordering matters: triggers are dropped BEFORE the wipe, and the FTS
  // table is rebuilt after. FTS5's 'delete' command corrupts
  // (SQLITE_CORRUPT_VTAB) when it targets a rowid that was never indexed, so
  // the wipe must not fire any FTS trigger while the index is out of sync
  // with the table.
  d.exec(`DROP TRIGGER IF EXISTS memories_ai;
          DROP TRIGGER IF EXISTS memories_ad;
          DROP TRIGGER IF EXISTS memories_au;`);
  d.exec("DELETE FROM memories");
  d.exec(`DROP TABLE IF EXISTS memories_fts;`);
  d.exec(FTS_SCHEMA);
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function db(): AnyDatabase {
  if (_db) return _db;
  const { indexDb } = paths();
  const Database = loadDatabase();
  const d = new Database(indexDb);
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA synchronous = NORMAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(TABLE_SCHEMA);
  d.exec(FTS_SCHEMA);
  if (userVersion(d) < SCHEMA_VERSION) migrateToV2(d);
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
