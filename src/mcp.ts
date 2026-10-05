/**
 * open-memex generic MCP server (stdio transport).
 *
 * Exposes the memory tools as the opencode plugin
 * (memory_add / memory_search / memory_list / memory_supersede /
 * memory_forget, plus memory_status / memory_submit / memory_propose /
 * memory_promote / memory_resolve / memory_pr_status) over the Model Context Protocol, so any MCP client —
 * VS Code Copilot Chat, Cursor, Claude Code, etc. — can use open-memex
 * without a host-specific plugin.
 *
 * Run:  node --experimental-strip-types src/mcp.ts
 *        (or: npm run mcp)
 *
 * The project scope is resolved from the process working directory, so
 * launch the server with cwd set to the project root (VS Code, Cursor and
 * Claude Code all do this for workspace-configured MCP servers).
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never log to stdout here;
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { resolveProjectScope, PERSONAL_SCOPE, type Scope } from "./scope.ts";
import { db } from "./store/db.ts";
import { syncScope } from "./store/sync.ts";
import {
  addMemory,
  searchMemories,
  listMemories,
  supersedeMemory,
  forgetMemory,
  statusMemories,
  submitMemoriesOp,
  proposeMemoriesOp,
  promoteMemoryOp,
  resolveMemoryOp,
  prStatusOp,
  memoryAddArgs,
  memorySearchArgs,
  memoryListArgs,
  memorySupersedeArgs,
  memoryForgetArgs,
  memoryStatusArgs,
  memorySubmitArgs,
  memoryProposeArgs,
  memoryPromoteArgs,
  memoryResolveArgs,
  memoryPrStatusArgs,
  TOOL_DESCRIPTIONS,
  withOutboxNote,
  type ToolResult,
} from "./tools/ops.ts";
import { outboxDraftCount } from "./submit.ts";

// Server version tracks package.json — never hardcode it here again.
// package.json sits two levels above this file in both layouts
// (src/mcp.ts and dist/mcp.js), same convention as cli.ts --version.
const SERVER_VERSION: string = (() => {
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

/**
 * D26: session-start guidance delivered through the MCP handshake itself.
 * The init-written instruction files only exist if the user ran
 * `open-memex init --client`; the initialize `instructions` reach every MCP
 * client at connect time. Still advisory — no MCP consumer offers a hard
 * session-start hook — but it is the strongest signal available.
 */
const SERVER_INSTRUCTIONS = `You are connected to an open-memex local memory MCP server.
Its tools are memory_add, memory_search, memory_list, memory_supersede,
memory_forget, memory_status, memory_submit, memory_propose, memory_promote,
memory_resolve, memory_pr_status — always call them by these full names.

- The server tells you when project outbox drafts are waiting for review —
  in tool results, and in these session-start instructions. When it does,
  summarize them (one line each) and ask the user which ones to sync into the
  repo; sync NOTHING the user did not name. If you already asked about these
  drafts this session, don't ask again. When the server reports none waiting,
  do nothing.
- When the user says "sync memory" (or "同步记忆"), call memory_status,
  summarize the outbox drafts (one line each), and ask which ones to sync.
  ALWAYS use the memory_status tool for this — never browse the memory data
  directory directly.
- After memory_submit, ask ONE follow-up: "want me to create a branch + push +
  open the PR, or will you handle it yourself?" NEVER create branches, push, or
  open PRs without the user's explicit approval. A "yes, you do it" covers the
  whole chain — do NOT re-ask at each step.
- BE PROACTIVE about facts the user states directly: when the user shares a
  decision, preference, project convention, or fix-and-cause worth remembering
  across sessions, call memory_add without being asked. Keep each memory to one
  self-contained statement, and add a brief "(noted in memory)" so the user
  sees it worked.
- For conclusions YOU infer (the user never stated them): when you finish a
  task the user would describe in one sentence, consider distilling the
  session — if there is something worth keeping,
  propose 1–3 short memories capturing the useful conclusion (what was learned
  or decided, how an issue was resolved, what to avoid, where the authoritative
  doc lives — not the raw transcript), each with its proposed scope. Save
  NOTHING the user did not approve; on approval call memory_add with source
  "inference" at the approved scope. If the knowledge already lives in project
  docs, save it as type "reference" pointing at the doc instead of copying it.
  Long-form notes are fine ONLY when the user explicitly asks to save one.
- Before asking the user about past decisions, conventions, or preferences they
  may have told you before, call memory_search first — search well: break the
  question into its concepts and try 2–3 phrasings per concept (synonyms, the
  user's other language, shorter keyword forms), and check the other scope too,
  before concluding nothing is stored.
- When the user asks what you remember (about them, or in this project),
  call memory_list with scope=both and present it conversationally — turn
  the structured fields into plain words (source=user → "you told me
  this"; source=inference → "I inferred this, check me"), and don't read
  raw ids aloud. If they ask to remove or hide an entry, re-run
  memory_list first (numbers from an older listing may have shifted),
  read the candidate back in full, and get a confirmation before calling
  memory_forget: deletion is permanent. If they hesitate, offer soft=true
  (hide it instead — still one-way, but the file survives).
- Memories default to this project's scope; use the personal scope for facts
  about the user that hold across all projects. When a saved fact becomes
  outdated, call memory_supersede (find the old memory's id with memory_search
  first) instead of adding a duplicate.
`;

/** Adapt a framework-agnostic op result to an MCP tool response. */
function toMcp(p: Promise<ToolResult>) {
  return p.then(
    (r) => ({ content: [{ type: "text" as const, text: r.output }] }),
    (e: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: `open-memex error: ${(e as Error)?.message ?? String(e)}`,
        },
      ],
      isError: true as const,
    }),
  );
}

export async function runMcpServer() {
  const cfg = loadConfig();
  const scope: Scope = resolveProjectScope(process.cwd());
  const getScope = () => scope;

  // Init DB and one-shot sync of markdown -> index, mirroring the plugin.
  db();
  syncScope(scope.key, "session");
  syncScope(PERSONAL_SCOPE.key, "session");
  console.error(`[open-memex] MCP server up. scope=${scope.key}`);

  // D12: pulls are explicit by default — session start never touches the
  // network. With sync.autoPull, one best-effort pull; a failure never
  // blocks the session, it just logs and continues.
  if (cfg.sync?.autoPull) {
    try {
      const { GitProvider } = await import("./providers/git.ts");
      const r = new GitProvider().pull(process.cwd());
      syncScope(scope.key, "pull");
      console.error(
        `[open-memex] auto-pull: ${r.branch} ${r.fastForwarded ? "fast-forwarded" : "already up to date"}`,
      );
    } catch (e) {
      console.error(`[open-memex] auto-pull skipped: ${(e as Error).message}`);
    }
  }

  // D26: re-sync on every request, not just at startup. The in-repo dir
  // follows the current git branch, so a branch switch mid-session would
  // otherwise leave the index pointing at files that no longer exist.
  const withSync = <A extends object, R>(fn: (args: A) => R) => {
    return (args: A): R => {
      syncScope(scope.key, "request");
      syncScope(PERSONAL_SCOPE.key, "request");
      return fn(args);
    };
  };

  // D53: session-start outbox state, pushed. The stdio server starts fresh per
  // session, so construction-time state ≈ session-start state.
  const n = outboxDraftCount(scope.key);
  // D61: the alias guidance rides the handshake only when the install
  // enables capture aliases — otherwise agents would attach aliases the
  // server then drops.
  const aliasGuidance = cfg.captureAliases
    ? "\n- When you save a memory, attach 2–4 aliases via memory_add's aliases parameter: alternate phrasings, synonyms, equivalents in the user's other language. They are indexed with the memory so a differently-worded question still finds it."
    : "";
  const instructions =
    (n > 0
      ? `${SERVER_INSTRUCTIONS}\n\nSession start: the project outbox has ${n} draft${n === 1 ? "" : "s"} waiting for review — call memory_status to see them.`
      : SERVER_INSTRUCTIONS) + aliasGuidance;

  const server = new McpServer(
    { name: "open-memex", version: SERVER_VERSION },
    { instructions },
  );

  server.registerTool(
    "memory_add",
    {
      description: TOOL_DESCRIPTIONS.memory_add,
      inputSchema: z.object(memoryAddArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(withOutboxNote(getScope().key, addMemory(getScope, cfg, args), "call memory_status to review"))),
  );

  server.registerTool(
    "memory_search",
    {
      description: TOOL_DESCRIPTIONS.memory_search,
      inputSchema: z.object(memorySearchArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withSync((args) => toMcp(searchMemories(getScope, args))),
  );

  server.registerTool(
    "memory_list",
    {
      description: TOOL_DESCRIPTIONS.memory_list,
      inputSchema: z.object(memoryListArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withSync((args) => toMcp(listMemories(getScope, args))),
  );

  server.registerTool(
    "memory_supersede",
    {
      description: TOOL_DESCRIPTIONS.memory_supersede,
      inputSchema: z.object(memorySupersedeArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(withOutboxNote(getScope().key, supersedeMemory(cfg, args), "call memory_status to review"))),
  );

  server.registerTool(
    "memory_forget",
    {
      description: TOOL_DESCRIPTIONS.memory_forget,
      inputSchema: z.object(memoryForgetArgs),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withSync((args) => toMcp(withOutboxNote(getScope().key, forgetMemory(args), "call memory_status to review"))),
  );

  server.registerTool(
    "memory_status",
    {
      description: TOOL_DESCRIPTIONS.memory_status,
      inputSchema: z.object(memoryStatusArgs),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    withSync((_args) => toMcp(statusMemories())),
  );

  server.registerTool(
    "memory_submit",
    {
      description: TOOL_DESCRIPTIONS.memory_submit,
      inputSchema: z.object(memorySubmitArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(withOutboxNote(getScope().key, submitMemoriesOp(args), "call memory_status to review"))),
  );

  server.registerTool(
    "memory_propose",
    {
      description: TOOL_DESCRIPTIONS.memory_propose,
      inputSchema: z.object(memoryProposeArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(withOutboxNote(getScope().key, proposeMemoriesOp(args), "call memory_status to review"))),
  );

  server.registerTool(
    "memory_promote",
    {
      description: TOOL_DESCRIPTIONS.memory_promote,
      inputSchema: z.object(memoryPromoteArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(promoteMemoryOp(args))),
  );

  server.registerTool(
    "memory_resolve",
    {
      description: TOOL_DESCRIPTIONS.memory_resolve,
      inputSchema: z.object(memoryResolveArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(resolveMemoryOp(args))),
  );

  server.registerTool(
    "memory_pr_status",
    {
      description: TOOL_DESCRIPTIONS.memory_pr_status,
      inputSchema: z.object(memoryPrStatusArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    withSync((args) => toMcp(prStatusOp(args))),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Standalone entry: `node --experimental-strip-types src/mcp.ts`.
// The CLI (`open-memex mcp`) imports runMcpServer() instead.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((err) => {
    console.error("[open-memex] MCP server failed:", err);
    process.exit(1);
  });
}
