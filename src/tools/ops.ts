/**
 * Framework-agnostic memory operations.
 *
 * The same functions back both the opencode plugin tools
 * (`src/tools/memory.ts`) and the generic MCP server (`src/mcp.ts`).
 * They take plain validated args and return a plain { title, output }
 * result; each host adapts that to its own tool-result shape.
 */
import fs from "node:fs";
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
import { findDuplicates, findTurnEcho, supersede, setStatus } from "../store/lifecycle.ts";
import { TURN_ECHO_WINDOW_MS } from "../capture/handoff.ts";
import {
  getUsage,
  recordUseful,
  reuseRate,
  usefulKindFor,
  usefulCount,
  deleteUsage,
  loadReuseReport,
} from "../store/usage.ts";
import { formatReuseReport } from "../reuse-report.ts";
import { formatCurationAction } from "../curate.ts";
import { db } from "../store/db.ts";
import { redact } from "../redact.ts";
import { getSyncStatus, formatSyncStatus, submitMemories, outboxDraftCount } from "../submit.ts";
import { getPrStatus, formatPrStatus, applyPrStatus } from "../github.ts";
import { isInRepoMemoryFile } from "../paths.ts";
import { refreshGraphQuiet } from "../store/graph.ts";
import {
  writeWorkingState,
  readWorkingState,
  clearWorkingState,
} from "../working-state.ts";
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
    "Save a fact, preference, decision, or note to persistent local memory. Call this PROACTIVELY whenever the user shares something worth remembering across sessions — project conventions, tool choices, personal preferences, decisions made, error fixes and their causes. Worth saving: decisions and their reasons, preferences, conventions, gotchas, approaches tried and abandoned. Not worth saving: one-off task details or anything re-derivable from the code. Do not wait to be asked. For facts you infer yourself rather than the user stating, propose them first and save only on approval. Keep each memory to one self-contained statement; attach aliases when the parameter is available. If a note tells you the user's own wording was already stored verbatim this turn, that statement is already saved: do not retry it in a rewording — save only what that text does not contain, or use memory_supersede on the given id. Default scope is the current project; use the personal scope for facts about the user that apply across all projects. Returns the new memory's id; an identical fact already stored returns that id instead of duplicating.",
  memory_search:
    "Search persistent memory by keyword (BM25 full-text). Returns matching memories from the current project and/or personal scope. Call before asking the user about past decisions, conventions, or preferences they may have told you before. Search well: break the question into its concepts and try 2–3 phrasings per concept — synonyms, the user's other language, shorter keyword forms — and check the other scope too, before concluding nothing is stored. Results are ranked by BM25 within review tiers — reviewed (approved/published) project memories come first. `limit` caps how many come back (default 8) and `type` restricts to one memory type.",
  memory_list:
    "List memories in a scope, newest first, as a numbered inventory. Each line keeps the raw fields — [type] id=… created=… source=… — say them back to the user in plain words (source=user → 'you told me this'; inference → 'I inferred this, check me'; keyword → 'caught from your own wording'), never read the raw id aloud unless they ask. When the user asks 'what do you remember about me?', use scope=both and present the inventory conversationally. The user may point at an entry by its number ('delete #3'): numbers are only valid for the listing you just produced — re-run memory_list, read the candidate back in full, and get a confirmation before calling memory_forget (deletion is permanent). include=all is the audit view (superseded versions, retracted, archived also shown). `type` filters to one memory type; `limit` caps how many entries come back.",
  memory_supersede:
    "Replace an existing memory with a newer version. The old memory is kept as history (status: superseded) and retrieval returns the new one. Use when a saved fact becomes outdated and should be replaced rather than duplicated. Only active memories can be superseded; the new memory inherits type, tags, and aliases unless you pass replacements. An unknown id is reported back as a failure; nothing is written.",
  memory_forget:
    "Delete a memory by id. Use when the user asks to forget something. To replace an outdated fact with a corrected one instead of deleting it, use memory_supersede. Deletion is permanent: before deleting, restate the memory's content to the user and get a confirmation. With soft=true the memory is hidden instead (retracted: out of lists and search, file kept, one-way).",
  memory_status:
    "Show the project memory sync pipeline: drafts waiting in the outbox (appdata), memories in the repo awaiting review or published, and any repo files not yet committed — plus the D77 reuse report: per-scope retrieved/useful rates, the most-reused memories, and \"zombies\" (retrieved but never confirmed useful). Call this at session start, when the server reports drafts waiting for review, when the user says 'sync memory' (or '同步记忆'), or when they ask what memory is pulling its weight. Then ask the user which drafts to sync. For the memories themselves use memory_list; for PR review state use memory_pr_status. (MCP server and the `open-memex sync-status` CLI; the opencode native plugin does not expose this tool.)",
  memory_submit:
    "Move outbox drafts into the repo memory dir for review. Before copying, reports graph lint (never blocking) and auto-applies only deterministic curation: exact-duplicate merges, empty-body archives, and first-line title normalization. Near-duplicates are reported, never merged. Every applied action appears in the output with its undo command; pass noCurate=true to skip the auto-apply tier while keeping the lint report. Then copies the drafts in as proposed (or keeps a local approval), commits locally on the current branch, and moves the outbox originals out. Never creates a branch on its own — pass branch= only with the user's explicit approval for the full chain. Prints the push and PR commands — those need the user's explicit approval and are never run automatically. (MCP server and the `open-memex submit` CLI; the opencode native plugin does not expose this tool.) Unknown ids or a failed local commit abort the submit with the reason; nothing is published automatically.",
  memory_propose:
    "Copy personal memories into the project outbox as review drafts. The personal originals stay put. Use this when personal knowledge should enter a project's review flow; memory_submit then moves the drafts into the repo, and memory_promote advances drafts already there. (MCP server and the `open-memex propose` CLI; the opencode native plugin does not expose this tool.)",
  memory_promote:
    "Advance a project memory one step up the review ladder (proposed → approved → published), or reject it with a note. Rejected memories are never deleted — they can be revised and resubmitted. One step per call; an unknown id or a memory already published errors. Pass `by` to record the reviewer when it should differ from the default (e.g. approving on the strength of someone else's review). For brand-new outbox drafts, memory_submit is the entry point. (MCP server and the `open-memex promote` CLI; the opencode native plugin does not expose this tool.)",
  memory_resolve:
    "List git-conflicted memory files, or attempt a field-level 3-way merge of one. Semantic conflicts are reported, never auto-resolved. Run it when a git pull or merge leaves memory files conflicted; the merged file is written in place (undo with git if the merge is wrong). For PR review state rather than file conflicts, use memory_pr_status. (MCP server and the `open-memex resolve` CLI; the opencode native plugin does not expose this tool.)",
  memory_pr_status:
    "Read the current branch's GitHub PR and map its review state onto each in-repo memory: merged PR → published, PR approval → approved (approved_by = reviewer), changes-requested → suggestion only. Report by default — that mode changes nothing; apply=true writes the mapped transitions to the local files (still no push). (MCP server and the `open-memex pr-status` CLI; the opencode native plugin does not expose this tool.)",
  memory_workingstate:
    "Read, write, or clear the one ephemeral per-project working-state note (§3.6, D89): where an interrupted task stands, so a fresh session can resume. Scratch state, NOT durable knowledge — it never enters memory retrieval or a review ladder; any conclusion here that should outlive the task goes through the normal memory_add/checkpoint-proposal path instead. WRITE it (action=write, content required) when the user signals the session or task is wrapping up — body rubric: task summary (one paragraph), open files, last commands, where the work stands, next step; short by design, a scratch note, not a transcript. READ it when resuming work or when the user asks what they were doing. CLEAR it on the user's request only. The note lives outside memories/, the user can edit the plain file directly, and it expires after ttl_days (default 7) — expired notes are ignored and `audit` reports them.",
  memory_useful:
    "Mark an existing memory as useful (D77): record that it demonstrably paid off. Call it ONLY on an explicit signal — the user confirmed it helped ('that was the one', 'saved me again'), or your completed/accepted work clearly relied on that memory and the user saw the result. NEVER call it because a memory appeared in memory_search results, a memory_list inventory, or the session-start block: passive exposure never refreshes usefulness. Exposure is counted automatically under retrieved_count; the useful buckets increment only through this tool, a human approval at review, or a supersede. Useful is split automatically: useful_self for personal memories and unpublished project drafts (the author's own utility), useful_team for approved/published project memories (team knowledge reused) — pass kind only to override. Returns the cumulative counts and reuse_rate (useful / retrieved). The counters live in the local SQLite index, not in the Markdown source of truth, and never leave this machine.",
} as const;

/** Shared zod input shapes (raw shape, not z.object — hosts wrap as needed). */
export const scopeArg = z
  .enum(["project", "personal"])
  .optional()
  .describe(
    "Memory scope. `project` = tied to this repo. `personal` = global across all your projects. Default: project.",
  );

export const aliasesArg = z
  .array(z.string())
  .optional()
  .describe(
    "Optional: alternate phrasings of this fact — synonyms, another way a question might be worded, equivalents in the user's other language (e.g. 节假日 for 'public holidays'). They are indexed with the memory so differently-worded questions still match. Always on. Send at most 4; extras and blanks are dropped silently, never an error.",
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
  alias: z
    .string()
    .optional()
    .describe(
      "D81: nickname this memory defines (e.g. 香蕉计划). Pairs with `target`: the alias memory expands queries in its scope at search time, both directions, no reindex. Explicit vocabulary — always stored, not gated by capture aliases.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "D81: what `alias` refers to (e.g. 支付系统重构项目). Only meaningful with `alias`.",
    ),
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
    .enum(["project", "personal", "both"])
    .optional()
    .describe("Which scope(s) to search. Default: both."),
  type: z
    .enum(MEMORY_TYPE_TAXONOMY)
    .optional()
    .describe(
      "Restrict to memories of this type. Closed taxonomy — a misspelled type is rejected, never silently empty.",
    ),
  limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 8)."),
};
export type MemorySearchArgs = z.infer<z.ZodObject<typeof memorySearchArgs>>;

export const memoryListArgs = {
  scope: z
    .enum(["project", "personal", "both"])
    .optional()
    .describe(
      "Which scope(s) to list. `project` = tied to this repo. `personal` = global across all your projects. `both` lists each scope's newest. Default: project.",
    ),
  type: z
    .enum(MEMORY_TYPE_TAXONOMY)
    .optional()
    .describe(
      "Only list memories of this type. Closed taxonomy — a misspelled type is rejected, never silently empty.",
    ),
  limit: z.number().int().min(1).max(100).optional().describe("Max entries to list, newest first (default 20)."),
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
  alias: z
    .string()
    .optional()
    .describe(
      "D81: nickname the new memory defines (e.g. 香蕉计划). Omitted = inherit the old memory's alias.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "D81: what `alias` refers to (e.g. 支付系统重构项目). Omitted = inherit.",
    ),
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
  noCurate: z
    .boolean()
    .optional()
    .describe("Skip the deterministic pre-submit auto-apply tier; the graph lint report still runs. Default false."),
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

export const memoryWorkingStateArgs = {
  action: z
    .enum(["read", "write", "clear"])
    .default("read")
    .describe(
      "read = show the current note (empty when none); write = create or refresh it; clear = delete it.",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "Note body, Markdown, short by design (required for write). Rubric: task summary (one paragraph), open files, last commands, where the work stands, next step. A scratch note, not a transcript.",
    ),
};
export type MemoryWorkingStateArgs = z.infer<z.ZodObject<typeof memoryWorkingStateArgs>>;

export const memoryUsefulArgs = {
  id: z
    .string()
    .min(1)
    .describe("ID of the memory being confirmed useful (memory_search / memory_list return ids)."),
  kind: z
    .enum(["self", "team"])
    .optional()
    .describe(
      "Which useful counter. Default: auto — personal memories and unpublished project drafts count useful_self; approved/published project memories count useful_team. Pass only to override the auto split.",
    ),
};
export type MemoryUsefulArgs = z.infer<z.ZodObject<typeof memoryUsefulArgs>>;

function resolveScope(
  getScope: () => Scope,
  kind?: "project" | "personal",
): Scope {
  return kind === "personal" ? PERSONAL_SCOPE : getScope();
}

function buildFrontmatter(
  s: Scope,
  body: {
    type: Frontmatter["type"];
    tags: string[];
    aliases?: string[];
    alias?: string;
    target?: string;
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
    // D81: explicit alias vocabulary — single trimmed strings, dropped
    // when empty. Not gated by captureAliases (that gates agent-invented
    // phrasings; this is deliberate vocabulary).
    ...(body.alias?.trim() ? { alias: body.alias.trim() } : {}),
    ...(body.target?.trim() ? { target: body.target.trim() } : {}),
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
  // D73: one user statement, one memory. The keyword hook stores the user's
  // sentence verbatim with no agent in the loop; a paraphrase of that same
  // sentence is refused instead of written beside it. The stored id comes back
  // so the caller can supersede it or save only the genuinely new part.
  const echo = findTurnEcho(s.key, redacted, TURN_ECHO_WINDOW_MS);
  if (echo.length > 0) {
    const top = echo[0];
    const others = echo
      .slice(1)
      .map((e) => `id=${e.id} (${e.source}, overlap ${e.score.toFixed(2)})`)
      .join(", ");
    return {
      title: "memory: already captured verbatim",
      output:
        `Not saved — the user's own words were already stored moments ago (source: ${top.source}, overlap ${top.score.toFixed(2)}): ` +
        `id=${top.id} — ${top.snippet}` +
        (others ? `\nAlso matching: ${others}` : "") +
        `\nDo not retry with a rewording: that only adds a second copy of one statement. ` +
        `Save a separate memory only for information that stored text does not contain, or call memory_supersede on that id if this replaces it.`,
    };
  }
  const fm = buildFrontmatter(s, {
    type: args.type ?? "fact",
    tags: args.tags ?? [],
    // D61: aliases are always stored (Stone 2026-10-07: init no longer asks;
    // default on). Normalize caps at 4 and drops junk silently.
    // Aliases pass through the same redaction as content (write-path
    // invariant) — an alias carrying a token gets masked, not stored raw.
    aliases: cfg.captureAliases
      ? normalizeAliases(
          (args.aliases ?? []).map((a) => redact(a, cfg.redactPatterns).content),
        )
      : [],
    // D81: explicit alias vocabulary — same redaction as content, never
    // gated by captureAliases.
    alias: args.alias?.trim()
      ? redact(args.alias.trim(), cfg.redactPatterns).content
      : undefined,
    target: args.target?.trim()
      ? redact(args.target.trim(), cfg.redactPatterns).content
      : undefined,
    source: args.source ?? "tool",
  });
  const { filePath } = writeMemoryFile(fm, redacted);
  const mf = readMemoryFile(filePath);
  if (mf) upsertFromFile(mf);
  // D91 ingest: the project graph (edges + compiled outline) refreshes on
  // the write path — quiet, never fails the save.
  refreshGraphQuiet(s.key, cfg);
  let output = `Saved to ${s.kind} scope (${s.key}) as ${fm.type}. id=${fm.id}${secretNote}`;
  for (const n of dups.near) {
    output += `\nNote: similar memory exists (score ${n.score.toFixed(2)}): id=${n.id} — ${n.snippet}. Use memory_supersede if this replaces it.`;
  }
  return { title: `memory: saved ${fm.id}`, output };
}

export async function searchMemories(
  getScope: () => Scope,
  cfg: MyOMemoryConfig,
  args: MemorySearchArgs,
): Promise<ToolResult> {
  const project = getScope();
  const scopeKeys =
    args.scope === "personal"
      ? [PERSONAL_SCOPE.key]
      : args.scope === "project"
        ? [project.key]
        : [project.key, PERSONAL_SCOPE.key];
  // D77-L2: every surface that hands hits to a caller counts as exposure.
  const hits = search(args.query, {
    scopeKeys,
    limit: args.limit,
    type: args.type,
    record: true,
    feedback: cfg.feedbackWeighting,
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
  // D70: numbering runs across every section of THIS listing, so "delete
  // #3" names exactly one memory. A per-section counter emitted two "#1"s.
  let seq = 0;
  const render = (scopeKey: string) => {
    const hits = list(scopeKey, { type: args.type, limit: args.limit, include, record: true });
    const total = countList(scopeKey, { type: args.type, include });
    const lines = hits.map((h) => formatInventoryLine(seq++, h, PERSONAL_SCOPE.key));
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
    args.scope === "project" || args.scope === "personal"
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
      // D81: explicit alias vocabulary — omitted inherits the old memory's
      // pair; same redaction as content; never gated by captureAliases.
      alias:
        args.alias !== undefined
          ? redact(args.alias, cfg.redactPatterns).content || undefined
          : undefined,
      target:
        args.target !== undefined
          ? redact(args.target, cfg.redactPatterns).content || undefined
          : undefined,
      source: "tool",
    });
    upsertFromFile(oldMf);
    upsertFromFile(newMf);
    // D91 ingest: the chain has changed — refresh the owning scope quietly.
    refreshGraphQuiet(oldMf.fm.scope_key, cfg);
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
    .prepare(`SELECT file_path, scope_key FROM memories WHERE id = ?`)
    .get(args.id) as { file_path: string; scope_key: string } | undefined;
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
      refreshGraphQuiet(row.scope_key);
      return {
        title: "memory: hidden",
        output:
          `Hidden ${args.id} (retracted). It no longer appears in lists or search, but the file is kept. This is one-way — to bring the fact back, save it again as a new memory.` +
          // D70: a retraction of an in-repo memory is a local working-tree
          // edit like the delete — without a commit (and a push) the memory
          // stands on every teammate's clone, so "hidden" would be a lie.
          (isInRepoMemoryFile(row.file_path)
            ? ` Note: this memory lives in the repo (.ai/open-memex/), so the retraction is only local until you commit and push it — until then the team still sees it.`
            : ""),
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
  // D77-L2: the memory is gone for good — its telemetry has no subject left.
  // Only the hard path prunes the usage row; status flips and index removal
  // (branch switches remove in-repo files transiently) keep it.
  deleteUsage(args.id);
  // D91 ingest: a node left the graph — refresh its scope quietly.
  refreshGraphQuiet(row.scope_key);
  // D64: forgetting an in-repo memory deletes a file inside the user's
  // git working tree. Say so — the deletion should ride a commit, or the
  // file silently diverges from what teammates have.
  const inRepo = isInRepoMemoryFile(row.file_path);
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

/**
 * D77-L2: the explicit confirmation route to the useful counters. The
 * restraint rules live in the tool description and the MCP handshake —
 * an unguarded call path here would create the self-reinforcing retrieval
 * loop D77 warns about, so nothing silently routes exposure into useful.
 * Classification proxy (no identity system): personal scope / unreviewed
 * project draft → useful_self; approved/published project memory → useful_team.
 */
export async function markMemoryUseful(
  args: MemoryUsefulArgs,
): Promise<ToolResult> {
  const row = db()
    .prepare(`SELECT scope, review_state FROM memories WHERE id = ?`)
    .get(args.id) as { scope: string; review_state: string } | undefined;
  if (!row) {
    return {
      title: "memory: useful not found",
      output: `No memory with id ${args.id} in the index — memory_search or memory_list returns current ids.`,
    };
  }
  const kind = args.kind ?? usefulKindFor(row.scope, row.review_state);
  recordUseful(args.id, kind, "tool");
  const u = getUsage(args.id)!;
  const rate = reuseRate(u);
  const useful = usefulCount(u);
  return {
    title: `memory: useful (${kind}) ${args.id}`,
    output:
      `Marked useful (${kind}). retrieved: ${u.retrieved_count}, useful_self: ${u.useful_self}, useful_team: ${u.useful_team}, reuse_rate: ${rate === null ? "n/a (never retrieved)" : rate.toFixed(2)}.` +
      `\nA supersede or a human approval also counts — no need to duplicate those with an explicit call.`,
  };
}

export async function statusMemories(): Promise<ToolResult> {
  const st = getSyncStatus();
  const n =
    st.outbox.length +
    st.inRepo.filter((e) => e.reviewState === "proposed" || e.reviewState === "approved").length;
  // D77-L3: the reuse report rides the status surface (the D77 text calls
  // memory_status out by name). Personal + this project, capped for an agent
  // result; the CLI prints the same block uncapped.
  const reuse = loadReuseReport([
    { scopeKey: st.scopeKey, label: "this project" },
    { scopeKey: PERSONAL_SCOPE.key, label: "personal" },
  ]);
  return {
    title: `memory: sync status (${n} pending)`,
    output: [formatSyncStatus(st), "", ...formatReuseReport(reuse)].join("\n"),
  };
}

export async function submitMemoriesOp(args: MemorySubmitArgs): Promise<ToolResult> {
  const r = submitMemories(args.ids, { branch: args.branch, base: args.base, noCurate: args.noCurate });
  const lines: string[] = [];
  const c = r.curation;
  lines.push(
    `curation lint: ${c.lintFindings.length} finding(s) - orphans ${c.lintCounts.orphan}, dangling ${c.lintCounts["dangling-edge"]}, stale ${c.lintCounts.stale} (report only)`,
  );
  if (c.disabled) {
    lines.push("curation auto-apply skipped (noCurate=true)");
  } else if (c.applied.length === 0) {
    lines.push("curation auto-applied: 0");
  } else {
    lines.push(`curation auto-applied: ${c.applied.length}`);
    for (const a of c.applied) lines.push(`  ${formatCurationAction(a.action)}`);
  }
  for (const s of c.skipped) lines.push(`curation skipped ${s.id}: ${s.reason}`);
  for (const w of c.warnings) lines.push(`curation note: ${w}`);
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

/**
 * §3.6 (D89): the one ephemeral per-project working-state note. Scratch
 * state, not knowledge — it never enters the review ladder or the
 * retrieval index; durable conclusions still go through memory_add (agent
 * proposes, user approves). The tool description and the session-start
 * block must keep saying the same thing on this.
 */
export async function workingStateMemory(
  getScope: () => Scope,
  cfg: MyOMemoryConfig,
  args: MemoryWorkingStateArgs,
): Promise<ToolResult> {
  if (!cfg.workingStateEnabled) {
    return {
      title: "memory: working-state",
      output:
        "The working-state note is disabled (config workingStateEnabled=false). Enable it in the config file, or record durable facts with memory_add instead.",
    };
  }
  const scope = getScope();
  if (args.action === "clear") {
    const gone = clearWorkingState(scope.key);
    return {
      title: "memory: working-state",
      output: gone
        ? `Working-state note for ${scope.projectName} deleted.`
        : "Failed to delete the working-state note — it may still be on disk.",
    };
  }
  if (args.action === "write") {
    const content = (args.content ?? "").trim();
    if (!content) {
      return {
        title: "memory: working-state",
        output:
          "Refusing an empty working-state note: pass content (task summary, open files, last commands, where the work stands, next step).",
      };
    }
    const r = writeWorkingState(scope.key, content, cfg.workingStateTtlDays, cfg.redactPatterns);
    const secretNote = r.hadSecret
      ? `\n[open-memex: a secret was masked in place (${r.matchedPattern}) before saving]`
      : "";
    return {
      title: "memory: working-state",
      output:
        `Working-state note written to ${r.filePath}. Surfaces at session start; expires after ${cfg.workingStateTtlDays} day${cfg.workingStateTtlDays === 1 ? "" : "s"} or at the next write.${secretNote}`,
    };
  }
  const note = readWorkingState(scope.key, cfg.workingStateTtlDays);
  if (!note) {
    return {
      title: "memory: working-state",
      output: `No working-state note for ${scope.projectName}. Write one at wrap-up (action=write) so an interrupted task can resume.`,
    };
  }
  const status = note.expired
    ? `EXPIRED (${note.ageDays} day${note.ageDays === 1 ? "" : "s"} old, ttl ${note.ttlDays}) — stale until a write refreshes it`
    : `updated ${note.ageDays} day${note.ageDays === 1 ? "" : "s"} ago, ttl ${note.ttlDays} day${note.ttlDays === 1 ? "" : "s"}`;
  return {
    title: "memory: working-state",
    output: `[${status}]\n\n${note.content}`,
  };
}
