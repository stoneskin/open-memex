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
  memoryAddArgs,
  memorySearchArgs,
  memoryListArgs,
  memorySupersedeArgs,
  memoryForgetArgs,
  TOOL_DESCRIPTIONS,
  type ToolResult,
} from "./tools/ops.ts";

const SERVER_VERSION = "0.2.0-alpha";

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
  syncScope(scope.key);
  syncScope(PERSONAL_SCOPE.key);
  console.error(`[open-memex] MCP server up. scope=${scope.key}`);

  const server = new McpServer({ name: "open-memex", version: SERVER_VERSION });

  server.registerTool(
    "memory_add",
    {
      description: TOOL_DESCRIPTIONS.memory_add,
      inputSchema: z.object(memoryAddArgs),
    },
    (args) => toMcp(addMemory(getScope, cfg, args)),
  );

  server.registerTool(
    "memory_search",
    {
      description: TOOL_DESCRIPTIONS.memory_search,
      inputSchema: z.object(memorySearchArgs),
      annotations: { readOnlyHint: true },
    },
    (args) => toMcp(searchMemories(getScope, args)),
  );

  server.registerTool(
    "memory_list",
    {
      description: TOOL_DESCRIPTIONS.memory_list,
      inputSchema: z.object(memoryListArgs),
      annotations: { readOnlyHint: true },
    },
    (args) => toMcp(listMemories(getScope, args)),
  );

  server.registerTool(
    "memory_supersede",
    {
      description: TOOL_DESCRIPTIONS.memory_supersede,
      inputSchema: z.object(memorySupersedeArgs),
    },
    (args) => toMcp(supersedeMemory(cfg, args)),
  );

  server.registerTool(
    "memory_forget",
    {
      description: TOOL_DESCRIPTIONS.memory_forget,
      inputSchema: z.object(memoryForgetArgs),
      annotations: { destructiveHint: true },
    },
    (args) => toMcp(forgetMemory(args)),
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
