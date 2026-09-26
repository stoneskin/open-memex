import { tool } from "@opencode-ai/plugin/tool";
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
import { db } from "../store/db.ts";
import { redact } from "../redact.ts";

const z = tool.schema;

/** v2 content-kind taxonomy (V2-DESIGN §3.1). */
const MEMORY_TYPES = MEMORY_TYPE_TAXONOMY;

export function makeTools(getScope: () => Scope, cfg: MyOMemoryConfig) {
  const scopeArg = z
    .enum(["project", "personal", "user"])
    .optional()
    .describe(
      "Memory scope. `project` = tied to this repo. `personal` = global across all your projects. `user` is a deprecated alias of `personal`. Default: project.",
    );

  function resolveScope(kind?: "project" | "personal" | "user"): Scope {
    return kind === "personal" || kind === "user" ? PERSONAL_SCOPE : getScope();
  }

  const memory_add = tool({
    description:
      "Save a fact, preference, decision, or note to persistent local memory. Call this whenever the user tells you something you should remember in future sessions (project conventions, tool choices, personal preferences, error fixes). Keep each memory to one self-contained statement.",
    args: {
      content: z.string().min(1).describe("The fact to remember. One idea per memory."),
      type: z
        .enum(MEMORY_TYPES)
        .optional()
        .describe("Category of memory. Default: note."),
      scope: scopeArg,
      tags: z.array(z.string()).optional().describe("Optional tags for filtering."),
    },
    async execute(args) {
      const { content: redacted, hadSecret, matchedPattern } = redact(
        args.content,
        cfg.redactPatterns,
      );
      if (hadSecret) {
        return {
          title: "memory: rejected (secret detected)",
          output: `Refused to save: content matched a secret pattern (${matchedPattern}). Wrap the sensitive part in <private>...</private> tags or paraphrase, then try again.`,
        };
      }
      const s = resolveScope(args.scope);
      const rfc = msToRfc3339(Date.now());
      const fm: Frontmatter = {
        id: ulid(),
        schema_version: 2,
        scope_key: s.key,
        scope: s.kind === "project" ? "project" : "personal",
        visibility: s.kind === "project" ? "internal" : "private",
        project_name: s.projectName,
        type: args.type ?? "fact",
        role: "knowledge",
        importance: "normal",
        status: "active",
        tags: args.tags ?? [],
        source: "tool",
        created_at: rfc,
        updated_at: rfc,
      };
      const { filePath } = writeMemoryFile(fm, redacted);
      const mf = readMemoryFile(filePath);
      if (mf) upsertFromFile(mf);
      return {
        title: `memory: saved ${fm.id}`,
        output: `Saved to ${s.key} as ${fm.type}. id=${fm.id}`,
      };
    },
  });

  const memory_search = tool({
    description:
      "Search persistent memory by keyword (BM25 full-text). Returns matching memories from the current project and/or personal scope. Use before asking the user something they may have told you before.",
    args: {
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
    },
    async execute(args) {
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
      return {
        title: `memory: ${hits.length} result(s)`,
        output: lines.join("\n"),
      };
    },
  });

  const memory_list = tool({
    description: "List memories in a scope, newest first. Useful for browsing.",
    args: {
      scope: scopeArg,
      type: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async execute(args) {
      const s = resolveScope(args.scope);
      const hits = list(s.key, { type: args.type, limit: args.limit });
      if (hits.length === 0) {
        return { title: "memory: empty", output: `No memories in scope ${s.key}.` };
      }
      const lines = hits.map(
        (h) => `- [${h.type}] id=${h.id} — ${h.snippet.replace(/\s+/g, " ").trim()}`,
      );
      return {
        title: `memory: ${hits.length} in ${s.key}`,
        output: lines.join("\n"),
      };
    },
  });

  const memory_forget = tool({
    description: "Delete a memory by id. Use when the user asks to forget something.",
    args: {
      id: z.string().min(1),
    },
    async execute(args) {
      const row = db()
        .prepare(`SELECT scope_key FROM memories WHERE id = ?`)
        .get(args.id) as { scope_key: string } | undefined;
      if (!row) {
        return { title: "memory: not found", output: `No memory with id ${args.id}.` };
      }
      deleteMemoryFile(row.scope_key, args.id);
      deleteFromIndex(args.id);
      return { title: "memory: forgotten", output: `Deleted ${args.id}.` };
    },
  });

  return { memory_add, memory_search, memory_list, memory_forget };
}
