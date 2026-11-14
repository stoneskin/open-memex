/**
 * Token cost as spec (D94, OptMem small item 1): measure open-memex's
 * prompt/token overhead instead of asserting it.
 *
 * Two surfaces are measured separately, then summed:
 *   (a) the session-start injection block - `buildContextBlock`'s real output
 *       on a scratch fixture store (8 project memories + 5 personal +
 *       the compiled graph outline, i.e. the default-shape block every
 *       opencode session starts with);
 *   (b) all MCP tool descriptions - `TOOL_DESCRIPTIONS`' actual text, what
 *       an MCP client pays once per session at handshake.
 *
 * Method (also printed in the output): characters counted on the exact
 * strings, tokens estimated as characters / 4. That is the usual rough
 * ratio for English prose; it is an estimate, not a tokenizer count - no
 * tokenizer dependency is added on purpose (D94). The README quotes these
 * numbers as approximations ("约数"); re-run this script and update the
 * README whenever the fixture or the block shape changes - never hand-edit
 * the numbers.
 *
 * Usage: node --experimental-strip-types scripts/token-cost.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "token-cost-"));
process.env.OPEN_MEMEX_HOME = HOME;

import { buildContextBlock } from "../src/retrieve/inject.ts";
import { TOOL_DESCRIPTIONS } from "../src/tools/ops.ts";
import { DEFAULT_CONFIG, type MyOMemoryConfig } from "../src/config.ts";
import type { Scope } from "../src/scope.ts";
import {
  writeMemoryFile,
  ulid,
  msToRfc3339,
  type Frontmatter,
} from "../src/store/markdown.ts";
import { syncScope } from "../src/store/sync.ts";
import { PERSONAL_SCOPE } from "../src/scope.ts";

/** Same shape/size as a real default session: 8 project + 5 personal. */
const FIXTURE_SCOPE: Scope = {
  key: "project__token-cost-fixture__000000000000",
  kind: "project",
  projectName: "token-cost-fixture",
};

const now = msToRfc3339(Date.now());

function fmFor(scopeKey: string, kind: "project" | "personal", type: string, tags: string[]): Frontmatter {
  return {
    id: ulid(),
    schema_version: 2,
    scope_key: scopeKey,
    scope: kind,
    visibility: kind === "project" ? "internal" : "private",
    project_name: kind === "project" ? FIXTURE_SCOPE.projectName : "personal",
    type,
    role: "knowledge",
    importance: "normal",
    status: "active",
    tags,
    source: "token-cost fixture",
    created_at: now,
    updated_at: now,
    supersedes: null,
    superseded_by: null,
    review_state: kind === "project" ? "published" : "draft",
    proposed_by: null,
    approved_by: kind === "project" ? "fixture" : null,
    derived_from: null,
    review_note: null,
    review_history: [],
  };
}

const PROJECT_MEMORIES: Array<{ body: string; type: string; tags: string[] }> = [
  { body: "We deploy on Fridays; the release train leaves at 10:00 and the freeze window starts at 09:00.", type: "decision", tags: ["deploy", "release", "git"] },
  { body: "All PRs go dev/<topic> -> main; the V2 integration branch was retired 2026-09-29.", type: "decision", tags: ["git", "release", "typescript"] },
  { body: "Markdown files are the source of truth; index.db is a rebuildable search accelerator.", type: "constraint", tags: ["storage", "architecture", "typescript"] },
  { body: "Every memory-file write goes through atomicWriteTextSync - a torn read mid-rewrite parses as a deletion.", type: "constraint", tags: ["storage", "architecture", "reliability"] },
  { body: "Import paths must use explicit .ts extensions; moduleResolution is Bundler with allowImportingTsExtensions.", type: "howto", tags: ["build", "typescript", "architecture"] },
  { body: "Never import better-sqlite3 or bun:sqlite directly outside src/store/db.ts - the backend is chosen at runtime.", type: "gotcha", tags: ["architecture", "sqlite", "build"] },
  { body: "The Node floor is 22.14 (better-sqlite3 13 needs Node-API 10); never lower engines.node back to 22.6.", type: "constraint", tags: ["sqlite", "build", "windows"] },
  { body: "Windows is a first-class target: use node:path, never hardcode /, and keep temp files under the OS temp dir.", type: "gotcha", tags: ["windows", "typescript", "build"] },
];

const PERSONAL_MEMORIES: string[] = [
  "I prefer concise diffs over verbose explanations.",
  "My standup notes go into the team wiki, not chat.",
  "Public holidays are listed in the HR portal.",
  "I read Chinese faster than English - summarize in Chinese when both work.",
  "Do not schedule meetings before 10:00.",
];

// --- seed ---
const cfg: MyOMemoryConfig = DEFAULT_CONFIG;
for (const m of PROJECT_MEMORIES) {
  writeMemoryFile(fmFor(FIXTURE_SCOPE.key, "project", m.type, m.tags), m.body);
}
for (const body of PERSONAL_MEMORIES) {
  writeMemoryFile(fmFor(PERSONAL_SCOPE.key, "personal", "preference", []), body);
}
syncScope(FIXTURE_SCOPE.key);
syncScope(PERSONAL_SCOPE.key);

// --- measure ---
const block = buildContextBlock(FIXTURE_SCOPE, cfg);
if (!block) throw new Error("fixture produced an empty context block - fix the fixture");

const toolText = Object.values(TOOL_DESCRIPTIONS).join("\n");

// Method: chars on the exact strings; tokens estimated as chars / 4
// (rough English-prose ratio - deliberately no tokenizer dependency).
function estimate(label: string, text: string): { chars: number; tokens: number } {
  const chars = text.length;
  const tokens = Math.round(chars / 4);
  return { chars, tokens };
}

const a = estimate("injection block", block);
const b = estimate("tool descriptions", toolText);
const totalChars = a.chars + b.chars;
const totalTokens = a.tokens + b.tokens;

console.log("open-memex token cost (D94, OptMem small item 1)");
console.log(`method: exact string character counts; tokens = chars / 4 (rough estimate, no tokenizer)`);
console.log(`fixture: ${PROJECT_MEMORIES.length} project + ${PERSONAL_MEMORIES.length} personal memories + graph outline, default config`);
console.log("");
console.log(`(a) session-start injection block : ${a.chars} chars  ~ ${a.tokens} tokens  (once per session, not per turn)`);
console.log(`(b) MCP tool descriptions (13)    : ${b.chars} chars  ~ ${b.tokens} tokens  (once per session at handshake)`);
console.log(`total                             : ${totalChars} chars  ~ ${totalTokens} tokens`);
console.log("");
console.log("The block text measured:");
console.log("---");
console.log(block);
console.log("---");
// The scratch store's SQLite file is held open by the better-sqlite3
// connection until process exit, so rmSync fails with EPERM on Windows -
// leave the scratch dir to the OS temp cleaner instead of failing the run.
