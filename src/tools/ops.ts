/**
 * Framework-agnostic memory operations.
 *
 * The same functions back both the opencode plugin tools
 * (`src/tools/memory.ts`) and the generic MCP server (`src/mcp.ts`).
 * They take plain validated args and return a plain { title, output }
 * result; each host adapts that to its own tool-result shape.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Scope } from "../scope.ts";
import type { MyOMemoryConfig } from "../config.ts";
import { PERSONAL_SCOPE } from "../scope.ts";
import { search, list, countList, hitStateLabel } from "../retrieve/search.ts";
import { formatInventoryLine, truncationNote } from "../retrieve/display.ts";
import {
  writeMemoryFile,
  readMemoryFile,
  ulid,
  msToRfc3339,
  MEMORY_TYPE_TAXONOMY,
  normalizeAliases,
  type Frontmatter,
} from "../store/markdown.ts";
import { upsertFromFile, deleteFromIndex } from "../store/sync.ts";
import { findDuplicates, supersede, setStatus } from "../store/lifecycle.ts";
import { db } from "../store/db.ts";
import { redact } from "../redact.ts";
import { getSyncStatus, formatSyncStatus, submitMemories, outboxDraftCount } from "../submit.ts";
import { getPrStatus, formatPrStatus, applyPrStatus } from "../github.ts";
import { paths } from "../paths.ts";
import {
  proposeMemories,
  promoteMemory,
  listConflicts,
  resolveConflict,
  formatReviewHistory,
} from "../review.ts";

export interface ToolResult {
  title: string;
  output: string;
}

/**
 * D53: push, don't poll. Append the project-outbox pending count to mutating
 * tool results so agents learn about drafts waiting for review without a
 * checkpoint poll. Silent when the outbox is empty. `reviewHint` names the
 * tool to call (MCP); transports without that tool leave it generic.
 */
export async function withOutboxNote(
  scopeKey: string,
  p: Promise<ToolResult>,
  reviewHint?: string,
): Promise<ToolResult> {
  const r = await p;
  const n = outboxDraftCount(scopeKey);
  if (n > 0) {
    const tail = reviewHint ? ` — ${reviewHint}` : " for review";
    r.output += `\n[open-memex: ${n} draft${n === 1 ? "" : "s"} waiting in the project outbox${tail}]`;
  }
  return r;
}

/** LLM-facing tool descriptions, shared by the opencode plugin and the MCP server. */
export const TOOL_DESCRIPTIONS = {
  memory_add:
    "Save a fact, preference, decision, or note to persistent local memory. Call this PROACTIVELY whenever the user shares something worth remembering across sessions — project conventions, tool choices, personal preferences, decisions made, error fixes and their causes. Worth saving: decisions and their reasons, preferences, conventions, gotchas, approaches tried and abandoned. Not worth saving: one-off task details or anything re-derivable from the code. Do not wait to be asked. For facts you infer yourself rather than the user stating, propose them first and save only on approval. Keep each memory to one self-contained statement; attach aliases when the parameter is available. Default scope is the current project; use the personal scope for facts about the user that apply across all projects.",
  memory_search:
    "Search persistent memory by keyword (BM25 full-text). Returns matching memories from the current project and/or personal scope. Call before asking the user about past decisions, conventions, or preferences they may have told you before. Search well: break the question into its concepts and try 2–3 phrasings per concept — synonyms, the user's other language, shorter keyword forms — and check the other scope too, before concluding nothing is stored.",
  memory_list:
    "List memories in a scope, newest first, as a numbered inventory. Each line keeps the raw fields — [type] id=… created=… source=… — say them back to the user in plain words (source=user → 'you told me this'; inference → 'I inferred this, check me'; keyword → 'caught from your own wording'), never read the raw id aloud unless they ask. When the user asks 'what do you remember about me?', use scope=both and present the inventory conversationally. The user may point at an entry by its number ('delete #3'): numbers are only valid for the listing you just produced — re-run memory_list, read the candidate back in full, and get a confirmation before calling memory_forget (deletion is permanent). include=all is the audit view (superseded versions, retracted, archived also shown).",
  memory_supersede:
    "Replace an existing memory with a newer version. The old memory is kept as history (status: superseded) and retrieval returns the new one. Use when a saved fact becomes outdated and should be replaced rather than duplicated.",
  memory_forget:
    "Delete a memory by id. Use when the user asks to forget something. Deletion is permanent: before deleting, restate the memory's content to the user and get a confirmation. With soft=true the memory is hidden instead (retracted: out of lists and search, file kept, one-way).",
  memory_status:
    "Show the project memory sync pipeline: drafts waiting in the outbox (appdata), memories in the repo awaiting review or published, and any repo files not yet committed. Call this at session start, when the server reports drafts waiting for review, or when the user says 'sync memory' (or '同步记忆'); then ask the user which drafts to sync. (MCP server and the `open-memex sync-status` CLI; the opencode native plugin does not expose this tool.)",
  memory_submit:
    "Move outbox drafts into the repo memory dir for review: copies the drafts in as proposed (or keeps a local approval), commits locally on the current branch, and moves the outbox originals out. Never creates a branch on its own — pass branch= only with the user's explicit approval for the full chain. Prints the push and PR commands — those need the user's explicit approval and are never run automatically. (MCP server and the `open-memex submit` CLI; the opencode native plugin does not expose this tool.)",
  memory_propose:
    "Copy personal memories into the project outbox as review drafts. The personal originals stay put. (MCP server and the `open-memex propose` CLI; the opencode native plugin does not expose this tool.)",
  memory_promote:
    "Advance a project memory one step up the review ladder (proposed → approved → published), or reject it with a note. Rejected memories are never deleted — they can be revised and resubmitted. (MCP server and the `open-memex promote` CLI; the opencode native plugin does not expose this tool.)",
  memory_resolve:
    "List git-conflicted memory files, or attempt a field-level 3-way merge of one. Semantic conflicts are reported, never auto-resolved. (MCP server and the `open-memex resolve` CLI; the opencode native plugin does not expose this tool.)",
  memory_pr_status:
    "Read the current branch's GitHub PR and map its review state onto each in-repo memory: merged PR → published, PR approval → approved (approved_by = reviewer), changes-requested → suggestion only. Report by default; apply=true performs the mapped transitions locally (no push). (MCP server and the `open-memex pr-status` CLI; the opencode native plugin does not expose this tool.)",
} as const;

/** Shared zod input shapes (raw shape, not z.object — hosts wrap as needed). */
export const scopeArg = z
  .enum(["project", "personal", "user"])
  .optional()
  .describe(
    "Memory scope. `project` = tied to this repo. `personal` = global across all your projects. `user` is a deprecated alias of `personal`. Default: project.",
  );

export const aliasesArg = z
  .array(z.string())
  .optional()
  .describe(
    "Optional: alternate phrasings of this fact — synonyms, another way a question might be worded, equivalents in the user's other language (e.g. 节假日 for 'public holidays'). They are indexed with the memory so differently-worded questions still match. Only used when the install has capture aliases enabled (init default). Send at most 4; extras and blanks are dropped silently, never an error.",
  );

export const memoryAddArgs = {
  content: z.string().min(1).describe("The fact to remember. One idea per memory."),
  type: z
    .enum(MEMORY_TYPE_TAXONOMY)
    .optional()
    .describe("Category of memory. Default: fact."),
  scope: scopeArg,
  tags: z.array(z.string()).optional().describe("Optional tags for filtering."),
  aliases: aliasesArg,
  source: z
    .string()
    .optional()
    .describe(
      "Where this memory came from. Default: tool. Pass 'inference' for agent-proposed captures (V2-DESIGN §3.5).",
    ),
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
  scope: z
    .enum(["project", "personal", "user", "both"])
    .optional()
    .describe(
      "Which scope(s) to list. `project` = tied to this repo. `personal` = global across all your projects. `both` lists each scope's newest. Default: project.",
    ),
  type: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include: z
    .enum(["active", "all"])
    .optional()
    .describe(
      "D68: `active` (default) shows what is currently remembered — newest version of each fact, retracted/archived hidden. `all` is the audit view: every stored row including superseded versions and hidden ones. The default CHANGED in D68: superseded versions no longer appear unless include=all.",
    ),
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
  aliases: aliasesArg,
};
export type MemorySupersedeArgs = z.infer<z.ZodObject<typeof memorySupersedeArgs>>;

export const memoryForgetArgs = {
  id: z.string().min(1),
  soft: z
    .boolean()
    .optional()
    .describe(
      "D68: hide instead of delete. The memory is retracted — excluded from lists and search — but its file stays. Retraction is one-way (D64): it does not come back; to restore the fact, save it again as a new memory. Offer `soft` when the user is unsure about deleting.",
    ),
};
export type MemoryForgetArgs = z.infer<z.ZodObject<typeof memoryForgetArgs>>;

export const memoryStatusArgs = {};
export type MemoryStatusArgs = z.infer<z.ZodObject<typeof memoryStatusArgs>>;

export const memorySubmitArgs = {
  ids: z.array(z.string().min(1)).min(1).describe("Outbox draft ids to submit."),
  branch: z
    .string()
    .optional()
    .describe(
      "Create this branch and submit onto it. If omitted, submit stays on the current branch — branches are never auto-created. Only pass this when the user explicitly approved the full chain (branch + push + PR).",
    ),
  base: z
    .string()
    .optional()
    .describe("PR base branch override. Default: the branch the submit ran on."),
};
export type MemorySubmitArgs = z.infer<z.ZodObject<typeof memorySubmitArgs>>;

export const memoryProposeArgs = {
  ids: z.array(z.string().min(1)).min(1).describe("Personal memory ids to copy into the project outbox."),
  localApprove: z
    .boolean()
    .optional()
    .describe("Single-developer shortcut: mark the copies approved immediately."),
};
export type MemoryProposeArgs = z.infer<z.ZodObject<typeof memoryProposeArgs>>;

export const memoryPromoteArgs = {
  id: z.string().min(1).describe("Project memory id."),
  reject: z.boolean().optional().describe("Reject instead of advancing."),
  resubmit: z.boolean().optional().describe("Move rejected back to proposed for another round."),
  note: z.string().optional().describe("Review note recorded on reject."),
  by: z.string().optional().describe("Reviewer name override."),
};
export type MemoryPromoteArgs = z.infer<z.ZodObject<typeof memoryPromoteArgs>>;

export const memoryResolveArgs = {
  target: z
    .string()
    .optional()
    .describe("Memory id or file path to resolve. Omit to list conflicts."),
};
export type MemoryResolveArgs = z.infer<z.ZodObject<typeof memoryResolveArgs>>;

export const memoryPrStatusArgs = {
  apply: z
    .boolean()
    .optional()
    .describe("Perform the mapped review transitions locally (no push). Default: report only."),
};
export type MemoryPrStatusArgs = z.infer<z.ZodObject<typeof memoryPrStatusArgs>>;

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
    aliases?: string[];
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
    ...(body.aliases && body.aliases.length > 0 ? { aliases: body.aliases } : {}),
    source: body.source,
    created_at: rfc,
    updated_at: rfc,
    supersedes: null,
    superseded_by: null,
    review_state: "draft",
    proposed_by: null,
    approved_by: null,
    derived_from: null,
    review_note: null,
    review_history: [],
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
    // D61: aliases are stored only when the install enables them (init
    // asks once, default on); normalize caps at 4 and drops junk silently.
    // Aliases pass through the same redaction as content (write-path
    // invariant) — an alias carrying a token gets masked, not stored raw.
    aliases: cfg.captureAliases
      ? normalizeAliases(
          (args.aliases ?? []).map((a) => redact(a, cfg.redactPatterns).content),
        )
      : [],
    source: args.source ?? "tool",
  });
  const { filePath } = writeMemoryFile(fm, redacted);
  const mf = readMemoryFile(filePath);
  if (mf) upsertFromFile(mf);
  let output = `Saved to ${s.kind} scope (${s.key}) as ${fm.type}. id=${fm.id}${secretNote}`;
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
      `- [${h.scope_key === PERSONAL_SCOPE.key ? "personal" : "project"}/${h.type}]${hitStateLabel(h)} id=${h.id}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`,
  );
  return { title: `memory: ${hits.length} result(s)`, output: lines.join("\n") };
}

export async function listMemories(
  getScope: () => Scope,
  args: MemoryListArgs,
): Promise<ToolResult> {
  // D68: the list is the user's inventory of what is remembered. Lines
  // are structured (number + id + created= + source= + state tags) and
  // every section reports its true total — a truncated list says so
  // instead of quietly looking complete (the D66 sync-status lesson).
  const include = args.include ?? "active";
  const render = (scopeKey: string) => {
    const hits = list(scopeKey, { type: args.type, limit: args.limit, include });
    const total = countList(scopeKey, { type: args.type, include });
    const lines = hits.map((h, i) => formatInventoryLine(i, h, PERSONAL_SCOPE.key));
    const note = truncationNote(hits.length, total);
    if (note) lines.push(note);
    return lines;
  };
  if (args.scope === "both") {
    // D64: "what do you remember about me" spans both stores; search
    // already defaults to both, list now matches. Each scope lists its
    // own newest (the limit applies per scope).
    const project = getScope();
    const sections: string[] = [];
    for (const s of [PERSONAL_SCOPE, project]) {
      const lines = render(s.key);
      const heading =
        s.key === PERSONAL_SCOPE.key
          ? "## About you (personal — stays on this machine, applies everywhere)"
          : `## This project (${s.projectName || s.key})`;
      sections.push(lines.length === 0 ? `${heading}\n(none yet)` : `${heading}\n${lines.join("\n")}`);
    }
    return { title: "memory: list (both scopes)", output: sections.join("\n\n") };
  }
  const s = resolveScope(
    getScope,
    args.scope === "project" || args.scope === "personal" || args.scope === "user"
      ? args.scope
      : undefined,
  );
  const lines = render(s.key);
  if (lines.length === 0) {
    return { title: "memory: empty", output: `No memories in scope ${s.key}.` };
  }
  const heading =
    s.key === PERSONAL_SCOPE.key
      ? "## About you (personal — stays on this machine, applies everywhere)"
      : `## This project (${s.projectName || s.key})`;
  return {
    title: `memory: ${countList(s.key, { type: args.type, include })} in ${s.key}`,
    output: `${heading}\n${lines.join("\n")}`,
  };
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
      // D61: explicit aliases replace the carried-over ones, only when
      // the install enables capture aliases. Same redaction as content.
      aliases:
        cfg.captureAliases && args.aliases !== undefined
          ? normalizeAliases(
              args.aliases.map((a) => redact(a, cfg.redactPatterns).content),
            )
          : undefined,
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
    .prepare(`SELECT file_path FROM memories WHERE id = ?`)
    .get(args.id) as { file_path: string } | undefined;
  if (!row) {
    return { title: "memory: not found", output: `No memory with id ${args.id}.` };
  }
  if (args.soft) {
    // D68: hide instead of delete. The status flip is the whole action —
    // retrieval and the inventory exclude retracted, the file stays put.
    // One-way (D64): no un-hide; restoring the fact means saving it again.
    try {
      const mf = setStatus(args.id, "retracted");
      upsertFromFile(mf);
      return {
        title: "memory: hidden",
        output: `Hidden ${args.id} (retracted). It no longer appears in lists or search, but the file is kept. This is one-way — to bring the fact back, save it again as a new memory.`,
      };
    } catch (e) {
      return { title: "memory: hide failed", output: (e as Error).message };
    }
  }
  // Delete by indexed file_path — location-agnostic (appdata or in-repo, 2B/D24).
  // Only ENOENT counts as "deleted": on any other unlink failure the file
  // is still the source of truth and would be re-indexed on next sync, so
  // report failure instead of lying (P0 review, 2026-10-03).
  if (row.file_path) {
    try {
      fs.unlinkSync(row.file_path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return {
          title: "memory: forget failed",
          output: `Could not delete ${row.file_path} (${code ?? "error"}) — the memory was NOT forgotten and is still in the index. Close anything holding the file and retry.`,
        };
      }
    }
  }
  deleteFromIndex(args.id);
  // D64: forgetting an in-repo memory deletes a file inside the user's
  // git working tree. Say so — the deletion should ride a commit, or the
  // file silently diverges from what teammates have.
  const inRepo =
    row.file_path.includes(`${path.sep}.ai${path.sep}`) &&
    !row.file_path.startsWith(paths().root);
  return {
    title: "memory: forgotten",
    output: inRepo
      ? `Deleted ${args.id}. Note: the file lived in the repo (.ai/open-memex/) — commit the deletion so the team sees it too.`
      : `Deleted ${args.id}.`,
  };
}

// ---------------------------------------------------------------------------
// 2B/D26: review workflow ops (also exposed over MCP so agents can drive the
// sync loop: status → ask user → submit → push/PR on approval).
// ---------------------------------------------------------------------------

export async function statusMemories(): Promise<ToolResult> {
  const st = getSyncStatus();
  const n =
    st.outbox.length +
    st.inRepo.filter((e) => e.reviewState === "proposed" || e.reviewState === "approved").length;
  return {
    title: `memory: sync status (${n} pending)`,
    output: formatSyncStatus(st),
  };
}

export async function submitMemoriesOp(args: MemorySubmitArgs): Promise<ToolResult> {
  const r = submitMemories(args.ids, { branch: args.branch, base: args.base });
  const lines: string[] = [];
  for (const s of r.submitted) lines.push(`submitted ${s.id} [${s.reviewState}]`);
  for (const id of r.skippedIdentical) lines.push(`already on branch: ${id} (outbox copy removed)`);
  lines.push(r.committed ? `committed on ${r.branch} (you are still on this branch).` : `nothing new to commit on ${r.branch}.`);
  lines.push(`Next — ask the user: "want me to create a branch + push + open the PR, or will you handle it yourself?"`);
  lines.push(`Never create branches, push, or open PRs without their explicit approval. If they handle it themselves, hand them these:`);
  lines.push(`  ${r.pushCommand}`);
  for (const l of r.prCommand.split("\n")) lines.push(`  ${l}`);
  return { title: `memory: submitted ${r.submitted.length}`, output: lines.join("\n") };
}

export async function proposeMemoriesOp(args: MemoryProposeArgs): Promise<ToolResult> {
  const batch = proposeMemories(args.ids, { localApprove: args.localApprove });
  const lines = batch.map(
    ({ sourceId, result: r }) => `proposed ${sourceId} → ${r.id} [${r.reviewState}] (outbox draft)`,
  );
  lines.push(`Next: open-memex sync-status, then submit the new ids to move them into a branch.`);
  return { title: `memory: proposed ${batch.length}`, output: lines.join("\n") };
}

export async function promoteMemoryOp(args: MemoryPromoteArgs): Promise<ToolResult> {
  const r = promoteMemory(args.id, {
    reject: args.reject,
    resubmit: args.resubmit,
    note: args.note,
    by: args.by,
  });
  const lines = [`promote ${r.id}: ${r.from} → ${r.to}`];
  if (r.to === "rejected") {
    lines.push(`not deleted — the file stays on the branch. Accept (close the PR), revise + resubmit, or keep as a [rejected] record.`);
  }
  if (r.history.length > 0) {
    lines.push(`history (${r.history.length}):`);
    lines.push(...formatReviewHistory(r.history));
  }
  return { title: `memory: ${r.id} → ${r.to}`, output: lines.join("\n") };
}

export async function resolveMemoryOp(args: MemoryResolveArgs): Promise<ToolResult> {
  if (!args.target) {
    const conflicts = listConflicts();
    if (conflicts.length === 0) {
      return { title: "memory: no conflicts", output: "(no conflicted memory files)" };
    }
    return {
      title: `memory: ${conflicts.length} conflicted`,
      output: conflicts.map((c) => `conflicted: ${c.id}  ${c.filePath}`).join("\n"),
    };
  }
  const outcome = resolveConflict(args.target);
  if (!outcome.ok) {
    const lines = [
      `cannot auto-resolve ${outcome.filePath} — semantic conflicts need a human:`,
      ...outcome.conflicts.flatMap((c) => [
        `  ${c.field}:`,
        `    base:   ${c.base}`,
        `    ours:   ${c.ours}`,
        `    theirs: ${c.theirs}`,
      ]),
      `Edit the file manually, then \`git add\` it. Nothing was written.`,
    ];
    return { title: "memory: resolve blocked", output: lines.join("\n") };
  }
  const lines = [`resolved ${outcome.filePath}`];
  if (outcome.autoMerged.length > 0) lines.push(`  auto-merged: ${outcome.autoMerged.join(", ")}`);
  return { title: "memory: resolved", output: lines.join("\n") };
}

export async function prStatusOp(args: MemoryPrStatusArgs): Promise<ToolResult> {
  const st = getPrStatus();
  const lines = [formatPrStatus(st)];
  if (args.apply) {
    const applied = applyPrStatus(st);
    if (applied.length === 0) {
      lines.push(`nothing to apply.`);
    } else {
      for (const a of applied) {
        lines.push(`applied ${a.memoryId.slice(0, 8)}: ${a.from} → ${a.to} (by ${a.by})`);
      }
    }
  }
  return { title: "memory: pr-status", output: lines.join("\n") };
}
