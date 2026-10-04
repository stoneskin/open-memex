import type { z } from "zod";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";
import type { Scope } from "../scope.ts";
import { PERSONAL_SCOPE } from "../scope.ts";
import type { MyOMemoryConfig } from "../config.ts";
import { syncScope } from "../store/sync.ts";
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
  withOutboxNote,
} from "./ops.ts";

// Local stand-in for the SDK's tool() helper — same signature, and the SDK
// function is a runtime identity (`return input`). Do NOT import it from
// @opencode-ai/plugin at runtime: that package is a devDependency, and when
// opencode loads this plugin by file:// URL from a global npm install
// nothing resolves the module — the import fails and opencode silently
// skips the whole plugin: no error, no tools (D58).
function tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}): { description: string; args: Args; execute: typeof input.execute } {
  return input;
}

export function makeTools(getScope: () => Scope, cfg: MyOMemoryConfig) {
  // D64: the plugin host syncs only at bootstrap, so without this the
  // index goes stale for the whole session — memories added through the
  // CLI or another client stay invisible to the agent, and same-content
  // duplicates accumulate. Mirror the MCP server: reconcile from disk
  // before every tool call. syncScope is mtime-based, so the steady-state
  // cost is one directory scan.
  const syncFirst = () => {
    try {
      syncScope(getScope().key, "request");
      syncScope(PERSONAL_SCOPE.key, "request");
    } catch (err) {
      // Deliberate asymmetry with the MCP adapter (which lets sync errors
      // propagate as tool errors): a failed sync must not take the plugin
      // tools down — the index may be stale for this call but the tool
      // still answers. Loud at debug, silent otherwise.
      if (cfg.logLevel === "debug") {
        console.error("[open-memex] pre-tool sync failed:", err);
      }
    }
  };

  const memory_add = tool({
    description: TOOL_DESCRIPTIONS.memory_add,
    args: memoryAddArgs,
    async execute(args) {
      syncFirst();
      return withOutboxNote(getScope().key, addMemory(getScope, cfg, args));
    },
  });

  const memory_search = tool({
    description: TOOL_DESCRIPTIONS.memory_search,
    args: memorySearchArgs,
    async execute(args) {
      syncFirst();
      return searchMemories(getScope, args);
    },
  });

  const memory_list = tool({
    description: TOOL_DESCRIPTIONS.memory_list,
    args: memoryListArgs,
    async execute(args) {
      syncFirst();
      return listMemories(getScope, args);
    },
  });

  const memory_supersede = tool({
    description: TOOL_DESCRIPTIONS.memory_supersede,
    args: memorySupersedeArgs,
    async execute(args) {
      syncFirst();
      return withOutboxNote(getScope().key, supersedeMemory(cfg, args));
    },
  });

  const memory_forget = tool({
    description: TOOL_DESCRIPTIONS.memory_forget,
    args: memoryForgetArgs,
    async execute(args) {
      syncFirst();
      return withOutboxNote(getScope().key, forgetMemory(args));
    },
  });

  return { memory_add, memory_search, memory_list, memory_forget, memory_supersede };
}
