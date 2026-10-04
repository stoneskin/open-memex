/**
 * Export / import: portable memory archives (§9, D40).
 *
 * `export` bundles selected memories (markdown source of truth + manifest)
 * into a single .tar.gz for moving to another machine or another app.
 * `import` restores a bundle: personal memories go to the personal dir,
 * project memories are re-keyed to the current project and land in the
 * outbox as drafts (submit moves them into the repo).
 *
 * D40: export excludes `visibility: private` by default; `--all` / `-a`
 * includes everything — the full-migration escape hatch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { db } from "./store/db.ts";
import {
  readMemoryFile,
  writeMemoryFile,
  normalizeFrontmatter,
} from "./store/markdown.ts";
import { upsertFromFile } from "./store/sync.ts";
import { contentHash } from "./store/lifecycle.ts";

const EXPORT_FORMAT = "open-memex-export/1";

function fail(msg: string): never {
  throw new Error(`[open-memex] ${msg}`);
}

function checkTar(): void {
  try {
    execFileSync("tar", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("the `tar` command is required for export/import but was not found on PATH");
  }
}

export interface ExportOptions {
  /** scope keys to include (resolved by the caller) */
  scopeKeys: string[];
  type?: string;
  tag?: string;
  /** D40: include visibility:private memories */
  includePrivate?: boolean;
  outFile?: string;
}

export interface ExportResult {
  file: string;
  exported: number;
  skippedPrivate: number;
  includePrivate: boolean;
}

interface ExportRow {
  id: string;
  scope_key: string;
  scope: string;
  visibility: string;
  type: string;
  file_path: string;
}

export function exportMemories(opts: ExportOptions): ExportResult {
  checkTar();
  const includePrivate = opts.includePrivate ?? false;

  let sql = `SELECT id, scope_key, scope, visibility, type, file_path FROM memories WHERE scope_key IN (${opts.scopeKeys.map(() => "?").join(",")})`;
  const params: unknown[] = [...opts.scopeKeys];
  if (!includePrivate) sql += ` AND visibility != 'private'`;
  if (opts.type) {
    sql += ` AND type = ?`;
    params.push(opts.type);
  }
  if (opts.tag) {
    sql += ` AND (',' || tags || ',' LIKE ?)`;
    params.push(`%,${opts.tag},%`);
  }
  sql += ` ORDER BY updated_at DESC`;
  const rows = db().prepare(sql).all(...(params as any[])) as ExportRow[];

  const skippedPrivate = includePrivate
    ? 0
    : (db().prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE scope_key IN (${opts.scopeKeys.map(() => "?").join(",")}) AND visibility = 'private'`,
      ).get(...(opts.scopeKeys as any[])) as { n: number }).n;

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "open-memex-export-"));
  try {
    const memDir = path.join(stage, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    const manifestEntries: Array<{ id: string; scope: string; file: string }> = [];
    let exported = 0;
    for (const r of rows) {
      const mf = readMemoryFile(r.file_path);
      if (!mf) continue; // stale index row — skip, don't fail the export
      const rel = path.join(r.scope, `${r.id}.md`);
      const dest = path.join(memDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(r.file_path, dest);
      manifestEntries.push({ id: r.id, scope: r.scope, file: path.join("memories", rel) });
      exported++;
    }
    const manifest = {
      format: EXPORT_FORMAT,
      exported_at: new Date().toISOString(),
      open_memex_version: readPackageVersion(),
      include_private: includePrivate,
      filters: {
        scope_keys: opts.scopeKeys,
        type: opts.type ?? null,
        tag: opts.tag ?? null,
      },
      memories: manifestEntries,
    };
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const outFile = opts.outFile ?? path.resolve(`open-memex-export-${stamp}.tar.gz`);
    execFileSync("tar", ["-czf", outFile, "-C", stage, "manifest.json", "memories"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { file: outFile, exported, skippedPrivate, includePrivate };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function readPackageVersion(): string {
  try {
    const here = new URL(import.meta.url);
    const pkg = path.join(path.dirname(here.pathname), "..", "package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** current project scope key — project memories are re-keyed to it */
  projectScopeKey: string;
  dryRun?: boolean;
}

export interface ImportResult {
  imported: number;
  skippedIdentical: number;
  skippedConflict: { id: string; file: string }[];
  /** Manifest entries refused for pointing outside the bundle. */
  rejectedPaths: string[];
}

export function importBundle(bundlePath: string, opts: ImportOptions): ImportResult {
  checkTar();
  if (!fs.existsSync(bundlePath)) fail(`bundle not found: ${bundlePath}`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "open-memex-import-"));
  try {
    execFileSync("tar", ["-xzf", path.resolve(bundlePath), "-C", stage], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const manifestPath = path.join(stage, "manifest.json");
    if (!fs.existsSync(manifestPath)) fail("not an open-memex export bundle (manifest.json missing)");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      format: string;
      memories: Array<{ id: string; scope: string; file: string }>;
    };
    if (manifest.format !== EXPORT_FORMAT) {
      fail(`unsupported bundle format: ${manifest.format} (expected ${EXPORT_FORMAT})`);
    }

    const result: ImportResult = { imported: 0, skippedIdentical: 0, skippedConflict: [], rejectedPaths: [] };
    const existingStmt = db().prepare(`SELECT content_hash FROM memories WHERE id = ?`);
    // The manifest comes from whoever sent the bundle: entry.file must
    // stay inside the staging dir (P0 review, 2026-10-03 — "../" entries
    // otherwise read arbitrary .md files into the store). realpath also
    // catches symlinks planted by the tarball.
    const stageRoot = fs.realpathSync(stage);
    for (const entry of manifest.memories ?? []) {
      const joined = path.resolve(path.join(stage, entry.file));
      const src = fs.existsSync(joined) ? fs.realpathSync(joined) : joined;
      if (!src.startsWith(stageRoot + path.sep)) {
        result.rejectedPaths.push(entry.file);
        continue;
      }
      const mf = readMemoryFile(src);
      if (!mf) continue;
      const fm = normalizeFrontmatter({ ...mf.fm } as unknown as Record<string, unknown>);
      // Re-key to this machine: personal stays personal; project memories
      // adopt the current project's scope key (keys embed a path hash).
      if (fm.scope === "project") fm.scope_key = opts.projectScopeKey;
      else if (fm.scope === "personal") fm.scope_key = "personal";

      const existing = existingStmt.get(fm.id) as { content_hash: string } | undefined;
      if (existing) {
        if (existing.content_hash === contentHash(mf.body)) result.skippedIdentical++;
        else result.skippedConflict.push({ id: fm.id, file: entry.file });
        continue;
      }
      if (opts.dryRun) {
        result.imported++;
        continue;
      }
      const { filePath } = writeMemoryFile(fm, mf.body);
      const written = readMemoryFile(filePath);
      if (written) upsertFromFile(written);
      result.imported++;
    }
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
