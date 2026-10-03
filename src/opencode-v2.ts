import { z } from "zod";
import {
  PLUGIN_ID,
  bootstrapPlugin,
  captureFromText,
  injectOnce,
  type PluginState,
} from "./plugin-core.ts";
import { makeTools } from "./tools/memory.ts";

/**
 * OpenCode 2 adapter (D60). The v2 host structurally decodes the plugin's
 * default export as `{ id, setup }` — `Plugin.define` is an identity
 * wrapper, so a plain object with no runtime import of `@opencode/plugin`
 * loads identically. Importing the SDK at runtime would repeat the D58
 * failure (devDependency, unresolvable from a global install, silent
 * skip); the context is duck-typed here from the 2.0.x surface instead.
 *
 * v1/v2 hook mapping used below:
 *   tool map                          → ctx.tool.transform (JSON Schema in,
 *                                       { content } out)
 *   chat.message (keyword capture)    → ctx.session.hook("prompt") — fires
 *                                       once per submitted prompt
 *   experimental.chat.system.transform → ctx.session.hook("context") — runs
 *                                       before each model request; the
 *                                       system array is mutable
 *
 * Tool registration must opt out of code mode (`options.codemode: false`,
 * verified on 2.0.1): by default the host exposes plugin tools only
 * through an `execute` meta-tool that runs model-written JS, and a model
 * that calls the tool by name instead gets "Unknown tool" — flaky,
 * model-dependent behavior. With the opt-out the five tools are plain
 * function calls, same as on v1 and MCP.
 */

interface V2ToolInfo {
  name: string;
  description: string;
  input: unknown;
  options?: { codemode?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: string }>;
}

interface V2Registration {
  dispose?: () => Promise<void>;
}

export interface V2PluginContext {
  app?: { version?: string };
  location?: { directory?: string; project?: { directory?: string } };
  tool: {
    transform: (cb: (editor: { add: (tool: V2ToolInfo) => void }) => void) => Promise<unknown>;
  };
  session: {
    hook: (
      name: "prompt" | "context",
      cb: (event: never) => void | Promise<void>,
    ) => Promise<V2Registration>;
  };
}

interface V2PromptEvent {
  sessionID: string;
  prompt?: { text?: string };
}

interface V2ContextEvent {
  sessionID: string;
  system: unknown[];
}

/** Register the five memory tools on a v2 host. */
async function registerTools(ctx: V2PluginContext, state: PluginState): Promise<void> {
  const tools = makeTools(() => state.scope, state.cfg);
  await ctx.tool.transform((editor) => {
    for (const [name, t] of Object.entries(tools)) {
      editor.add({
        name,
        description: t.description,
        input: z.toJSONSchema(z.object(t.args)),
        options: { codemode: false },
        execute: async (input) => {
          const r = await t.execute(input as never, undefined as never);
          const content =
            typeof r === "string" ? r : ((r as { output?: string }).output ?? JSON.stringify(r));
          return { content };
        },
      });
    }
  });
}

export const v2Plugin = {
  id: PLUGIN_ID,
  async setup(ctx: V2PluginContext) {
    const root = ctx.location?.directory ?? ctx.location?.project?.directory ?? process.cwd();
    const state = bootstrapPlugin(root);
    const registrations: V2Registration[] = [];

    await registerTools(ctx, state);

    registrations.push(
      await ctx.session.hook("prompt", (ev: V2PromptEvent) => {
        captureFromText(ev.prompt?.text ?? "", state);
      }),
    );
    registrations.push(
      await ctx.session.hook("context", (ev: V2ContextEvent) => {
        injectOnce(ev.sessionID ?? "", state, (block) => {
          ev.system.push({ type: "text", text: block });
        });
      }),
    );

    return () => {
      for (const r of registrations) void r.dispose?.();
    };
  },
};
