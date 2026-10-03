import { loadConfig, type MyOMemoryConfig } from "./config.ts";
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

/**
 * Host-agnostic plugin core (D60). Both opencode host generations adapt to
 * this module: the v1 plugin (src/index.ts `server`) and the v2 plugin
 * (src/opencode-v2.ts `setup`). Host-specific glue — tool registration and
 * hook shapes — stays in the adapters; everything memory-shaped lives here.
 */
export const PLUGIN_ID = "open-memex";

export interface PluginState {
  cfg: MyOMemoryConfig;
  scope: Scope;
  /** Sessions that already received the one-time context injection. */
  injectedSessions: Set<string>;
}

/**
 * Resolve the project scope for a host working directory and bring the
 * index up to date. Never throws: a broken store must not keep the host
 * from starting — failures land in the host's log instead.
 */
export function bootstrapPlugin(root: string): PluginState {
  const cfg = loadConfig();
  const scope = resolveProjectScope(root);
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
    const cwdScope = resolveCwdScope(root);
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
  return { cfg, scope, injectedSessions: new Set<string>() };
}

/**
 * Keyword capture (§ capture): scan one user message for "remember …"
 * triggers and save each hit. Shared by the v1 `chat.message` hook and
 * the v2 session `prompt` hook — both hand us the message text.
 */
export function captureFromText(text: string, state: PluginState): void {
  const { cfg, scope } = state;
  if (!cfg.keywordCaptureEnabled || !text) return;
  const hits = detectKeywords(text, cfg);
  for (const h of hits) {
    const { content, hadSecret, matchedPattern } = redact(h.content, cfg.redactPatterns);
    // Secrets are masked (first 4 chars kept) and the capture proceeds;
    // skip only when nothing usable remains.
    if (content.length === 0) continue;
    if (hadSecret && cfg.logLevel === "debug") {
      console.log(`[open-memex] keyword capture masked secret (${matchedPattern})`);
    }
    // Personal patterns ("remember for me" / "记住（个人）") force the personal scope.
    const target = h.personal ? PERSONAL_SCOPE : scope;
    // Dedup (§3.4): skip exact duplicates captured before.
    if (findDuplicates(target.key, content).exact) continue;
    const now = Date.now();
    const rfc = msToRfc3339(now);
    const fm: Frontmatter = {
      id: ulid(),
      schema_version: 2,
      scope_key: target.key,
      scope: target.kind === "project" ? "project" : "personal",
      visibility: target.kind === "project" ? "internal" : "private",
      project_name: target.projectName,
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
      review_state: "draft",
      proposed_by: null,
      approved_by: null,
      derived_from: null,
      review_note: null,
      review_history: [],
    };
    try {
      const { filePath } = writeMemoryFile(fm, content);
      const mf = readMemoryFile(filePath);
      if (mf) upsertFromFile(mf);
      // Capture feedback: always visible (not debug-only) — the user said
      // "记住…", they should see that it landed. The opencode plugin API
      // offers no toast channel, so the plugin log is the feedback surface.
      const preview = content.length > 60 ? content.slice(0, 60) + "…" : content;
      console.log(`[open-memex] remembered → ${target.kind} scope: "${preview}"`);
    } catch (err) {
      console.error("[open-memex] keyword capture failed:", err);
    }
  }
}

/**
 * First-turn context injection: exactly once per session. The host adapter
 * supplies `push` (v1: output.system.push; v2: the session context hook's
 * system array). Returns true when a block was pushed.
 */
export function injectOnce(
  sessionID: string,
  state: PluginState,
  push: (block: string) => void,
): boolean {
  const { cfg, scope } = state;
  if (!cfg.injectOnFirstTurn) return false;
  if (state.injectedSessions.has(sessionID)) return false;
  state.injectedSessions.add(sessionID);
  try {
    const block = buildContextBlock(scope, cfg);
    if (block) {
      push(block);
      return true;
    }
  } catch (err) {
    console.error("[open-memex] context injection failed:", err);
  }
  return false;
}
