/**
 * Framework-agnostic memory operations.
 *
 * The same functions back both the opencode plugin tools
 * (`src/tools/memory.ts`) and the generic MCP server (`src/mcp.ts`).
 * They take plain validated args and return a plain { title, output }
 * result; each host adapts that to its own tool-result shape.
 */
import { z } from "zod";
import type { Scope } from "../scope.ts";
import type { MyOMemoryConfig } from "../config.ts";
import { PERSONAL_SCOPE } from "../scope.ts";
import { search, list } from "../retrieve/search.ts";
import {
  writeMemoryFile,
  deleteMemoryFile,
  readMemoryFile,
  ulid,
  msToRfc3339,
  MEMORY_TYPE_TAXONOMY,
  type Frontmatter,
} from "../store/markdown.ts";
import { upsertFromFile, deleteFromIndex } from "../store/sync.ts";
import { findDuplicates, supersede } from "../store/lifecycle.ts";
import { db } from "../store/db.ts";
import { redact } from "../redact.ts";

export interface ToolResult {
  title: string;
  output: string;
}

/** LLM-facing tool descriptions, shared by the opencode plugin and the MCP server. */
export const TOOL_DESCRIPTIONS = {
  memory_add:
    "Save a fact, preference, decision, or note to persistent local memory. Call this PROACTIVELY whenever the user shares something worth remembering across sessions — project conventions, tool choices, personal preferences, decisions made, error fixes and their causes. Do not wait to be asked. Keep each memory to one self-contained statement. Default scope is the current project; use the personal scope for facts about the user that apply across all projects.",
  memory_search:
    "Search persistent memory by keyword (BM25 full-text). Returns matching memories from the current project and/or personal scope. Call before asking the user about past decisions, conventions, or preferences they may have told you before — try a few keyword variants, including the user's own language, when the first search comes up empty.",
  memory_list:
    "List memories in a scope, newest first. Useful for browsing what is remembered, or verifying that a save landed.",
  memory_supersede:
    "Replace an existing memory with a newer version. The old memory is kept as history (status: superseded) and retrieval returns the new one. Use when a saved fact becomes outdated and should be replaced rather than duplicated.",
  memory_forget: "Delete a memory by id. Use when the user asks to forget something.",
} as const;

/** Shared zod input shapes (raw shape, not z.object — hosts wrap as needed). */
export const scopeArg = z
  .enum(["project", "personal", "user"])
  .optional()
  .describe(
    "Memory scope. `project` = tied to this repo. `personal` = global across all your projects. `user` is a deprecated alias of `personal`. Default: project.",
  );

export const memoryAddArgs = {
  content: z.string().min(1).describe("The fact to remember. One idea per memory."),
  type: z
    .enum(MEMORY_TYPE_TAXONOMY)
    .optional()
    .describe("Category of memory. Default: note."),
  scope: scopeArg,
  tags: z.array(z.string()).optional().describe("Optional tags for filtering."),
};
export type MemoryAddArgs = z.infer<z.ZodObject<typeof memoryAddArgs>>;

export const memorySearchArgs = {
  query: z
    .string()
    .min(1)
    .describe("Free-text query. File paths, error strings, identifiers work well."),
  scope: z
    .enum(["project", "personal", "user", "both"])
    .optional()
    .describe("Which scope(s) to search. Default: both."),
  type: z.string().optional().describe("Restrict to memories of this type."),
  limit: z.number().int().min(1).max(50).optional(),
};
export type MemorySearchArgs = z.infer<z.ZodObject<typeof memorySearchArgs>>;

export const memoryListArgs = {
  scope: scopeArg,
  type: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
export type MemoryListArgs = z.infer<z.ZodObject<typeof memoryListArgs>>;

export const memorySupersedeArgs = {
  id: z.string().min(1).describe("ID of the memory being replaced."),
  content: z.string().min(1).describe("The new, corrected content."),
  type: z
    .enum(MEMORY_TYPE_TAXONOMY)
    .optional()
    .describe("Category of the new memory. Defaults to the old memory's type."),
  tags: z.array(z.string()).optional().describe("Optional tags for the new memory."),
};
export type MemorySupersedeArgs = z.infer<z.ZodObject<typeof memorySupersedeArgs>>;

export const memoryForgetArgs = {
  id: z.string().min(1),
};
export type MemoryForgetArgs = z.infer<z.ZodObject<typeof memoryForgetArgs>>;

function resolveScope(
  getScope: () => Scope,
  kind?: "project" | "personal" | "user",
): Scope {
  return kind === "personal" || kind === "user" ? PERSONAL_SCOPE : getScope();
}

function buildFrontmatter(
  s: Scope,
  body: {
    type: Frontmatter["type"];
    tags: string[];
    source: Frontmatter["source"];
  },
): Frontmatter {
  const rfc = msToRfc3339(Date.now());
  return {
    id: ulid(),
    schema_version: 2,
    scope_key: s.key,
    scope: s.kind === "project" ? "project" : "personal",
    visibility: s.kind === "project" ? "internal" : "private",
    project_name: s.projectName,
    type: body.type,
    role: "knowledge",
    importance: "normal",
    status: "active",
    tags: body.tags,
    source: body.source,
    created_at: rfc,
    updated_at: rfc,
    supersedes: null,
    superseded_by: null,
  };
}

export async function addMemory(
  getScope: () => Scope,
  cfg: MyOMemoryConfig,
  args: MemoryAddArgs,
): Promise<ToolResult> {
  const { content: redacted, hadSecret, matchedPattern } = redact(
    args.content,
    cfg.redactPatterns,
  );
  const secretNote = hadSecret
    ? `\nNote: content matched a secret pattern (${matchedPattern}); it was saved with the secret masked (first 4 chars kept, rest replaced with x).`
    : "";
  const s = resolveScope(getScope, args.scope);
  // Dedup on write (§3.4): identical content is idempotent; near-duplicates
  // are reported so the caller can supersede instead of duplicating.
  const dups = findDuplicates(s.key, redacted);
  if (dups.exact) {
    return {
      title: "memory: already exists",
      output: `Identical memory already exists: id=${dups.exact.id}. Not duplicated.`,
    };
  }
  const fm = buildFrontmatter(s, {
    type: args.type ?? "fact",
    tags: args.tags ?? [],
    source: "tool",
  });
  const { filePath } = writeMemoryFile(fm, redacted);
  const mf = readMemoryFile(filePath);
  if (mf) upsertFromFile(mf);
  let output = `Saved to ${s.key} as ${fm.type}. id=${fm.id}${secretNote}`;
  for (const n of dups.near) {
    output += `\nNote: similar memory exists (score ${n.score.toFixed(2)}): id=${n.id} — ${n.snippet}. Use memory_supersede if this replaces it.`;
  }
  return { title: `memory: saved ${fm.id}`, output };
}

export async function searchMemories(
  getScope: () => Scope,
  args: MemorySearchArgs,
): Promise<ToolResult> {
  const project = getScope();
  const scopeKeys =
    args.scope === "personal" || args.scope === "user"
      ? [PERSONAL_SCOPE.key]
      : args.scope === "project"
        ? [project.key]
        : [project.key, PERSONAL_SCOPE.key];
  const hits = search(args.query, {
    scopeKeys,
    limit: args.limit,
    type: args.type,
  });
  if (hits.length === 0) {
    return {
      title: "memory: 0 results",
      output: `No memories matched "${args.query}".`,
    };
  }
  const lines = hits.map(
    (h) =>
      `- [${h.scope_key === PERSONAL_SCOPE.key ? "personal" : "project"}/${h.type}] id=${h.id}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return { title: `memory: ${hits.length} result(s)`, output: lines.join("\n") };
}

export async function listMemories(
  getScope: () => Scope,
  args: MemoryListArgs,
): Promise<ToolResult> {
  const s = resolveScope(getScope, args.scope);
  const hits = list(s.key, { type: args.type, limit: args.limit });
  if (hits.length === 0) {
    return { title: "memory: empty", output: `No memories in scope ${s.key}.` };
  }
  const lines = hits.map(
    (h) => `- [${h.type}] id=${h.id} — ${h.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return { title: `memory: ${hits.length} in ${s.key}`, output: lines.join("\n") };
}

export async function supersedeMemory(
  cfg: MyOMemoryConfig,
  args: MemorySupersedeArgs,
): Promise<ToolResult> {
  const { content: redacted, hadSecret, matchedPattern } = redact(
    args.content,
    cfg.redactPatterns,
  );
  const secretNote = hadSecret ? ` (secret masked: ${matchedPattern})` : "";
  try {
    const { oldMf, newMf } = supersede(args.id, {
      body: redacted,
      type: args.type,
      tags: args.tags,
      source: "tool",
    });
    upsertFromFile(oldMf);
    upsertFromFile(newMf);
    return {
      title: `memory: superseded ${oldMf.fm.id}`,
      output: `Replaced ${oldMf.fm.id} with ${newMf.fm.id} (old kept as history).${secretNote}`,
    };
  } catch (e) {
    return {
      title: "memory: supersede failed",
      output: (e as Error).message,
    };
  }
}

export async function forgetMemory(args: MemoryForgetArgs): Promise<ToolResult> {
  const row = db()
    .prepare(`SELECT scope_key FROM memories WHERE id = ?`)
    .get(args.id) as { scope_key: string } | undefined;
  if (!row) {
    return { title: "memory: not found", output: `No memory with id ${args.id}.` };
  }
  deleteMemoryFile(row.scope_key, args.id);
  deleteFromIndex(args.id);
  return { title: "memory: forgotten", output: `Deleted ${args.id}.` };
}
