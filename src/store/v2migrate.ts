import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";
import {
  parseRawFrontmatter,
  normalizeFrontmatter,
  isTaxonomyType,
  serialize,
  atomicWriteTextSync,
  type Frontmatter,
} from "./markdown.ts";

/**
 * v1 → v2 file migration (V2-DESIGN §19). Explicit only — run via
 * `open-memex migrate --to-v2`. Converts frontmatter in place:
 *
 *   - scope rename: v1 `user` → v2 `personal` (scope, scope_key, and the
 *     storage dir `memories/user/` → `memories/personal/`)
 *   - times: epoch ms → RFC 3339
 *   - `priority: N` → `importance: low|normal|high`
 *   - `type: instruction` → `type: knowledge` + `role: instruction`
 *   - unknown v1 types → `knowledge` (v2 taxonomy, §3.1)
 *   - adds `schema_version: 2`, `visibility`, `role`, `status`
 *
 * Legacy `my-o-memory` data roots (§19/D13: `.my-o-memory/` →
 * `.open-memex/`, `~/.my-o-memory/` → `~/.open-memex/`) are merged into the
 * current root; the old dir is kept as a dated backup.
 */

const V2_MARKER = /^schema_version:\s*2(\s|$)/m;

export function isV2File(raw: string): boolean {
  return V2_MARKER.test(raw);
}

export interface ConversionPlan {
  fm: Frontmatter;
  body: string;
  fromPath: string;
  toPath: string;
  changes: string[];
}

/**
 * Plan the v1 → v2 conversion of one file. Returns null when the file is
 * already v2 (nothing to do). Pure — no disk writes.
 */
export function planConversion(
  filePath: string,
  memoriesRoot: string,
): ConversionPlan | null {
  const raw = fs.readFileSync(filePath, "utf8");
  if (isV2File(raw)) return null;
  const parsed = parseRawFrontmatter(raw);
  if (!parsed) return null;
  const { rawFm, body } = parsed;

  const fm = normalizeFrontmatter(rawFm);
  const changes: string[] = [];

  // scope rename
  if (rawFm.scope_kind === "user" || rawFm.scope_key === "user") {
    changes.push("scope user → personal");
  } else if (!rawFm.scope) {
    changes.push(`scope → ${fm.scope} (default)`);
  }

  // storage dir move follows scope_key
  const toPath = path.join(memoriesRoot, fm.scope_key, path.basename(filePath));
  if (toPath !== filePath) {
    changes.push(
      `file moved: ${path.basename(path.dirname(filePath))}/ → ${fm.scope_key}/`,
    );
  }

  // visibility default
  if (!rawFm.visibility) {
    changes.push(`visibility → ${fm.visibility} (default)`);
  }

  // type taxonomy
  const rawType = rawFm.type;
  if (rawType === "instruction") {
    changes.push("type instruction → knowledge, role → instruction (D11)");
  } else if (typeof rawType === "string" && rawType && !isTaxonomyType(rawType)) {
    changes.push(`type "${rawType}" → knowledge (not in v2 taxonomy)`);
    fm.type = "knowledge";
  } else if (!rawType) {
    changes.push(`type → ${fm.type} (default)`);
  }

  // priority → importance
  if (typeof rawFm.priority === "number") {
    changes.push(`priority ${rawFm.priority} → importance ${fm.importance}`);
  } else if (!rawFm.importance) {
    changes.push(`importance → ${fm.importance} (default)`);
  }

  // times
  if (typeof rawFm.created_at === "number") {
    changes.push("created_at/updated_at: epoch ms → RFC 3339");
  }

  // status default
  if (!rawFm.status) {
    changes.push(`status → ${fm.status} (default)`);
  }

  changes.push("schema_version → 2");
  return { fm, body, fromPath: filePath, toPath, changes };
}

export interface MigrateV2Result {
  scanned: number;
  converted: number;
  skippedV2: number;
  plans: ConversionPlan[];
  legacyBackup: string | null;
}

/**
 * Locate a legacy `my-o-memory` data root next to the current root.
 * Pure lookup — no disk writes.
 */
export function findLegacyDataRoot(): string | null {
  const { root } = paths();
  const legacy = path.join(path.dirname(root), "my-o-memory");
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return null;
  return legacy;
}

/** Dated backup path for a legacy data root. Pure — no disk writes. */
export function legacyBackupPath(legacy: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${legacy}.backup-${stamp}`;
}

/**
 * Merge a legacy `my-o-memory` data root into the current `open-memex` root.
 * The old dir is renamed to a dated backup — never deleted.
 * Failures throw an actionable Error (no raw syscall dump): on Windows the
 * backup rename typically fails with EPERM when another program holds the
 * folder open.
 */
function mergeLegacyDataRoot(legacy: string, backup: string): void {
  const { memories } = paths();
  const fail = (where: string, err: unknown): never => {
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new Error(
      `could not ${where} (${legacy})` +
        (code ? ` [${code}]` : "") +
        `. Another program may be holding the folder open (e.g. a running MCP server, editor, or antivirus). ` +
        `Your memories are safe — nothing was deleted. Close the program and re-run ` +
        `\`open-memex migrate --to-v2\`, or rename the folder to ${backup} yourself and re-run.`,
    );
  };
  const legacyMem = path.join(legacy, "memories");
  if (fs.existsSync(legacyMem)) {
    fs.mkdirSync(memories, { recursive: true });
    for (const entry of fs.readdirSync(legacyMem)) {
      const src = path.join(legacyMem, entry);
      const dst = path.join(memories, entry);
      try {
        if (!fs.existsSync(dst)) {
          fs.renameSync(src, dst);
        } else {
          // merge file-by-file, never overwrite
          for (const name of fs.readdirSync(src)) {
            const s = path.join(src, name);
            const d = path.join(dst, name);
            if (!fs.existsSync(d)) fs.renameSync(s, d);
          }
        }
      } catch (err) {
        fail(`move memories from the legacy data dir`, err);
      }
    }
  }
  try {
    fs.renameSync(legacy, backup);
  } catch (err) {
    fail(`back up the legacy data dir`, err);
  }
}

/** Plan v1 → v2 conversion for every `.md` file under `dir`. Read-only. */
function planDir(
  dir: string,
  memoriesRoot: string,
  result: MigrateV2Result,
): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    for (const name of fs.readdirSync(sub)) {
      if (!name.endsWith(".md")) continue;
      const filePath = path.join(sub, name);
      result.scanned++;
      const plan = planConversion(filePath, memoriesRoot);
      if (!plan) {
        result.skippedV2++;
        continue;
      }
      result.converted++;
      result.plans.push(plan);
    }
  }
}

/** Apply conversion plans to disk (real run only — never in dry-run). */
function applyPlans(result: MigrateV2Result): void {
  for (const plan of result.plans) {
    fs.mkdirSync(path.dirname(plan.toPath), { recursive: true });
    atomicWriteTextSync(plan.toPath, serialize(plan.fm, plan.body));
    if (plan.toPath !== plan.fromPath) fs.unlinkSync(plan.fromPath);
  }
}

export function migrateV2(opts: { dryRun: boolean }): MigrateV2Result {
  const { memories: memoriesRoot } = paths();
  const result: MigrateV2Result = {
    scanned: 0,
    converted: 0,
    skippedV2: 0,
    plans: [],
    legacyBackup: null,
  };

  const legacy = findLegacyDataRoot();
  if (legacy) {
    result.legacyBackup = legacyBackupPath(legacy);
    if (opts.dryRun) {
      // D44: dry-run previews the legacy files in place — nothing is moved,
      // so the preview actually shows what would convert (issue #7).
      planDir(path.join(legacy, "memories"), memoriesRoot, result);
    } else {
      mergeLegacyDataRoot(legacy, result.legacyBackup);
    }
  }

  planDir(memoriesRoot, memoriesRoot, result);
  if (!opts.dryRun) applyPlans(result);
  return result;
}
