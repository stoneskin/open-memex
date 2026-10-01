import { tool } from "@opencode-ai/plugin/tool";
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
