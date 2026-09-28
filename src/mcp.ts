/**
 * open-memex generic MCP server (stdio transport).
 *
 * Exposes the same five memory tools as the opencode plugin
 * (memory_add / memory_search / memory_list / memory_supersede /
 * memory_forget) over the Model Context Protocol, so any MCP client —
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
  type ToolResult,
} from "./tools/ops.ts";

const SERVER_VERSION = "0.2.0-alpha";

/**
 * D26: session-start guidance delivered through the MCP handshake itself.
 * The init-written instruction files only exist if the user ran
 * `open-memex init --client`; the initialize `instructions` reach every MCP
 * client at connect time. Still advisory — no MCP consumer offers a hard
 * session-start hook — but it is the strongest signal available.
 */
const SERVER_INSTRUCTIONS = `You are connected to an open-memex local memory MCP server
(eleven memory_* tools: add, search, list, supersede, forget, status, submit,
propose, promote, resolve, pr_status).

- At the START of this session, call memory_status. If the project outbox has
  drafts waiting for review, summarize them (one line each) and ask the user
  which ones to sync into the repo. Sync NOTHING the user did not name.
- When the user says "sync memory" (or "同步记忆"), treat it as a request to run
  the sync flow: call memory_status, summarize the outbox drafts, and ask which
  ones to sync.
- When you finish a meaningful chunk of work, call memory_status again as a checkpoint.
- BE PROACTIVE: when the user shares something worth remembering across sessions
  (a decision, a preference, a project convention, a fix and its cause), call
  memory_add without being asked. Keep each memory to one self-contained statement.
- Before asking the user about past decisions, conventions, or preferences they
  may have told you before, call memory_search first.
- Memories default to this project's scope; use the personal scope for facts
  about the user that hold across all projects.
- personal scope memories NEVER leave this machine.`;

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

  const server = new McpServer(
    { name: "open-memex", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "memory_add",
    {
      description: TOOL_DESCRIPTIONS.memory_add,
      inputSchema: z.object(memoryAddArgs),
    },
    withSync((args) => toMcp(addMemory(getScope, cfg, args))),
  );

  server.registerTool(
    "memory_search",
    {
      description: TOOL_DESCRIPTIONS.memory_search,
      inputSchema: z.object(memorySearchArgs),
      annotations: { readOnlyHint: true },
    },
    withSync((args) => toMcp(searchMemories(getScope, args))),
  );

  server.registerTool(
    "memory_list",
    {
      description: TOOL_DESCRIPTIONS.memory_list,
      inputSchema: z.object(memoryListArgs),
      annotations: { readOnlyHint: true },
    },
    withSync((args) => toMcp(listMemories(getScope, args))),
  );

  server.registerTool(
    "memory_supersede",
    {
      description: TOOL_DESCRIPTIONS.memory_supersede,
      inputSchema: z.object(memorySupersedeArgs),
    },
    withSync((args) => toMcp(supersedeMemory(cfg, args))),
  );

  server.registerTool(
    "memory_forget",
    {
      description: TOOL_DESCRIPTIONS.memory_forget,
      inputSchema: z.object(memoryForgetArgs),
      annotations: { destructiveHint: true },
    },
    withSync((args) => toMcp(forgetMemory(args))),
  );

  server.registerTool(
    "memory_status",
    {
      description: TOOL_DESCRIPTIONS.memory_status,
      inputSchema: z.object(memoryStatusArgs),
      annotations: { readOnlyHint: true },
    },
    withSync((_args) => toMcp(statusMemories())),
  );

  server.registerTool(
    "memory_submit",
    {
      description: TOOL_DESCRIPTIONS.memory_submit,
      inputSchema: z.object(memorySubmitArgs),
    },
    withSync((args) => toMcp(submitMemoriesOp(args))),
  );

  server.registerTool(
    "memory_propose",
    {
      description: TOOL_DESCRIPTIONS.memory_propose,
      inputSchema: z.object(memoryProposeArgs),
    },
    withSync((args) => toMcp(proposeMemoriesOp(args))),
  );

  server.registerTool(
    "memory_promote",
    {
      description: TOOL_DESCRIPTIONS.memory_promote,
      inputSchema: z.object(memoryPromoteArgs),
    },
    withSync((args) => toMcp(promoteMemoryOp(args))),
  );

  server.registerTool(
    "memory_resolve",
    {
      description: TOOL_DESCRIPTIONS.memory_resolve,
      inputSchema: z.object(memoryResolveArgs),
    },
    withSync((args) => toMcp(resolveMemoryOp(args))),
  );

  server.registerTool(
    "memory_pr_status",
    {
      description: TOOL_DESCRIPTIONS.memory_pr_status,
      inputSchema: z.object(memoryPrStatusArgs),
      annotations: { readOnlyHint: true },
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
