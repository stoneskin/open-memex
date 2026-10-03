import type { z } from "zod";
import type { ToolContext, ToolResult } from "@opencode-ai/plugin";
import type { Scope } from "../scope.ts";
import type { MyOMemoryConfig } from "../config.ts";
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
  const memory_add = tool({
    description: TOOL_DESCRIPTIONS.memory_add,
    args: memoryAddArgs,
    async execute(args) {
      return withOutboxNote(getScope().key, addMemory(getScope, cfg, args));
    },
  });

  const memory_search = tool({
    description: TOOL_DESCRIPTIONS.memory_search,
    args: memorySearchArgs,
    async execute(args) {
      return searchMemories(getScope, args);
    },
  });

  const memory_list = tool({
    description: TOOL_DESCRIPTIONS.memory_list,
    args: memoryListArgs,
    async execute(args) {
      return listMemories(getScope, args);
    },
  });

  const memory_supersede = tool({
    description: TOOL_DESCRIPTIONS.memory_supersede,
    args: memorySupersedeArgs,
    async execute(args) {
      return withOutboxNote(getScope().key, supersedeMemory(cfg, args));
    },
  });

  const memory_forget = tool({
    description: TOOL_DESCRIPTIONS.memory_forget,
    args: memoryForgetArgs,
    async execute(args) {
      return withOutboxNote(getScope().key, forgetMemory(args));
    },
  });

  return { memory_add, memory_search, memory_list, memory_forget, memory_supersede };
}
