import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { resolveProjectScope, resolveCwdScope, PERSONAL_SCOPE, type Scope } from "./scope.ts";
import { db } from "./store/db.ts";
import { syncScope, upsertFromFile } from "./store/sync.ts";
import { scopeHasFiles } from "./store/migrate.ts";
import {
  writeMemoryFile,
  readMemoryFile,
  ulid,
  msToRfc3339,
  type Frontmatter,
} from "./store/markdown.ts";
import { buildContextBlock } from "./retrieve/inject.ts";
import { detectKeywords } from "./capture/keywords.ts";
import { findDuplicates } from "./store/lifecycle.ts";
import { redact } from "./redact.ts";
import { makeTools } from "./tools/memory.ts";

const plugin: Plugin = async ({ worktree, directory }) => {
  const cfg = loadConfig();
  const roots = worktree || directory || process.cwd();
  const scope: Scope = resolveProjectScope(roots);

  // Init DB and one-shot sync of markdown -> index on plugin load.
  try {
    db();
    syncScope(scope.key);
    syncScope(PERSONAL_SCOPE.key);
    if (cfg.logLevel === "debug") {
      console.log(`[open-memex] loaded. scope=${scope.key}`);
    }
    // If a git remote was added *after* memories were first captured, the
    // scope key changes (cwd-hash -> origin-hash). Detect the legacy dir on
    // disk and tell the user how to migrate. We do NOT auto-migrate: two
    // different repos at the same cwd would collide.
    const cwdScope = resolveCwdScope(roots);
    if (cwdScope.key !== scope.key && scopeHasFiles(cwdScope.key)) {
      console.warn(
        `[open-memex] found memories under legacy scope key "${cwdScope.key}". ` +
          `Current project scope is "${scope.key}". ` +
          `To move them: npm run cli -- migrate --from ${cwdScope.key}`,
      );
    }
  } catch (err) {
    console.error("[open-memex] init failed:", err);
  }

  const tools = makeTools(() => scope, cfg);
  const injectedSessions = new Set<string>();

  return {
    tool: tools,

    async "chat.message"(_input, output) {
      if (!cfg.keywordCaptureEnabled) return;
      const parts = (output.parts ?? []) as Array<{ type: string; text?: string }>;
      const text = parts
        .map((p) => (p?.type === "text" ? p.text ?? "" : ""))
        .filter(Boolean)
        .join("\n");
      if (!text) return;

      const hits = detectKeywords(text, cfg);
      for (const h of hits) {
        const { content, hadSecret, matchedPattern } = redact(h.content, cfg.redactPatterns);
        // Secrets are masked (first 4 chars kept) and the capture proceeds;
        // skip only when nothing usable remains.
        if (content.length === 0) continue;
        if (hadSecret && cfg.logLevel === "debug") {
          console.log(`[open-memex] keyword capture masked secret (${matchedPattern})`);
        }
        // Dedup (§3.4): skip exact duplicates captured before.
        if (findDuplicates(scope.key, content).exact) continue;
        const now = Date.now();
        const rfc = msToRfc3339(now);
        const fm: Frontmatter = {
          id: ulid(),
          schema_version: 2,
          scope_key: scope.key,
          scope: scope.kind === "project" ? "project" : "personal",
          visibility: scope.kind === "project" ? "internal" : "private",
          project_name: scope.projectName,
          type: "fact",
          role: "knowledge",
          importance: "normal",
          status: "active",
          tags: ["keyword"],
          source: "keyword",
          created_at: rfc,
          updated_at: rfc,
          supersedes: null,
          superseded_by: null,
        };
        try {
          const { filePath } = writeMemoryFile(fm, content);
          const mf = readMemoryFile(filePath);
          if (mf) upsertFromFile(mf);
          if (cfg.logLevel === "debug") {
            console.log(`[open-memex] captured keyword memory ${fm.id}`);
          }
        } catch (err) {
          console.error("[open-memex] keyword capture failed:", err);
        }
      }
    },

    async "experimental.chat.system.transform"(input, output) {
      if (!cfg.injectOnFirstTurn) return;
      const sid = input.sessionID ?? "";
      if (injectedSessions.has(sid)) return;
      injectedSessions.add(sid);
      try {
        const block = buildContextBlock(scope, cfg);
        if (block) output.system.push(block);
      } catch (err) {
        console.error("[open-memex] context injection failed:", err);
      }
    },
  };
};

export default plugin;
