import type { Plugin } from "@opencode-ai/plugin";
import {
  PLUGIN_ID,
  bootstrapPlugin,
  captureFromText,
  injectOnce,
} from "./plugin-core.ts";
import { pickScopeRoot } from "./scope.ts";
import { makeTools } from "./tools/memory.ts";
import { v2Plugin } from "./opencode-v2.ts";

/**
 * One entrypoint, both opencode generations (D60):
 * - OpenCode 2 structurally decodes the default export as `{ id, setup }`
 *   and ignores `server` (see src/opencode-v2.ts).
 * - OpenCode 1 (≥1.18.29) reads `server` off the same default export and
 *   ignores `setup` — the function below is the v1 plugin exactly as it
 *   behaved before dual support.
 * Neither host runtime-imports an SDK package from this file: v1's SDK is
 * type-only (D58), and v2's decode is structural.
 */
const server: Plugin = async ({ worktree, directory }) => {
  // v1's `worktree` is the filesystem root for non-git folders — never seed a
  // scope on it (D71). `pickScopeRoot` falls back to the opened `directory`.
  const state = bootstrapPlugin(pickScopeRoot(worktree, directory));
  const tools = makeTools(() => state.scope, state.cfg);

  return {
    tool: tools,

    async "chat.message"(_input, output) {
      const parts = (output.parts ?? []) as Array<{ type: string; text?: string }>;
      const text = parts
        .map((p) => (p?.type === "text" ? p.text ?? "" : ""))
        .filter(Boolean)
        .join("\n");
      captureFromText(text, state);
    },

    async "experimental.chat.system.transform"(input, output) {
      injectOnce(input.sessionID ?? "", state, (block) => {
        output.system.push(block);
      });
    },
  };
};

export default { id: PLUGIN_ID, setup: v2Plugin.setup, server };
