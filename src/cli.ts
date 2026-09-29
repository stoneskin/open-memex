#!/usr/bin/env node
// Run with:  node --experimental-strip-types src/cli.ts <command>
import { resolveProjectScope, resolveCwdScope, PERSONAL_SCOPE, type Scope } from "./scope.ts";
import { db, closeDb } from "./store/db.ts";
import { syncScope, upsertFromFile, deleteFromIndex } from "./store/sync.ts";
import { migrateScope, scopeHasFiles, type ConflictStrategy } from "./store/migrate.ts";
import { migrateV2 } from "./store/v2migrate.ts";
import { findDuplicates, supersede, setStatus } from "./store/lifecycle.ts";
import { proposeMemories, promoteMemory, listConflicts, resolveConflict, formatReviewHistory } from "./review.ts";
import { getSyncStatus, formatSyncStatus, submitMemories } from "./submit.ts";
import { getPrStatus, formatPrStatus, applyPrStatus } from "./github.ts";
import { search, list, hitStateLabel } from "./retrieve/search.ts";
import {
  writeMemoryFile,
  readMemoryFile,
  ulid,
  msToRfc3339,
  type Frontmatter,
} from "./store/markdown.ts";
import { loadConfig } from "./config.ts";
import { paths, projectRoot } from "./paths.ts";
import { redact } from "./redact.ts";
import { resolveMcpCommand } from "./init.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Per-command help, printed by `open-memex <command> --help`.
    AI assistants discover the CLI through --help, so every command needs one. */
const COMMAND_HELP: Record<string, string> = {
  where: `Show which project scope the current directory resolves to, and where its data lives.

Usage: open-memex where

Example:
  open-memex where`,

  list: `List memories in a scope, newest first.

Usage: open-memex list [--scope project|personal] [--type T] [--limit N]

Flags:
  --scope   project (default) or personal
  --type    filter by memory type
  --limit   max results

Examples:
  open-memex list
  open-memex list --scope personal --limit 20`,

  search: `Search memories by keyword (BM25 full-text), best matches first.

Usage: open-memex search "query" [--scope project|personal|both] [--type T] [--limit N]

Flags:
  --scope   project (default), personal, or both
  --type    filter by memory type
  --limit   max results

Example:
  open-memex search "deploy checklist" --scope both`,

  add: `Save a fact, preference, decision, or note to local memory.

Usage: open-memex add "content" [--scope project|personal] [--type T] [--tag t1,t2]

Flags:
  --scope   project (default) or personal (personal never leaves this machine)
  --type    memory type (default: fact)
  --tag     comma-separated tags

Example:
  open-memex add "We deploy on Fridays" --scope project --tag process`,

  supersede: `Replace a memory with a newer version. The old one is kept as history.

Usage: open-memex supersede <id> "new content" [--type T] [--tag t1,t2]

Example:
  open-memex supersede 01ABC "We deploy on Thursdays now"`,

  status: `Change a memory's lifecycle status.

Usage: open-memex status <id> active|deprecated|retracted|archived

Example:
  open-memex status 01ABC deprecated`,

  forget: `Delete a memory by id.

Usage: open-memex forget <id>

Example:
  open-memex forget 01ABC`,

  propose: `Copy personal memories into the project outbox as review drafts.
The personal originals stay put. Nothing enters git at this step.

Usage: open-memex propose <id...> --to project [--local-approve]

Flags:
  --to             project (required)
  --local-approve  mark the copies approved right away (solo-dev shortcut)

Example:
  open-memex propose 01ABC 01DEF --to project`,

  promote: `Advance a project memory one step up the review ladder
(proposed → approved → published), or reject it with a note.
Every transition is appended to the memory's review_history.
Rejected memories are never deleted — they can be revised and resubmitted.

Usage: open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]

Flags:
  --reject    move back to rejected (requires --note)
  --resubmit  move a rejected memory back to proposed
  --note      reason for the transition (recorded in review_history)
  --by        reviewer name (defaults to the git user)

Examples:
  open-memex promote 01ABC --note "verified against the runbook"
  open-memex promote 01ABC --reject --note "outdated after the migration"`,

  resolve: `List conflicted memories, or 3-way-merge one.

Usage: open-memex resolve [id-or-path]

With no argument, lists conflicts. With an id or file path, shows the
3-way merge (base / outbox / repo) so you can resolve it by hand.
Conflicts are never auto-resolved.

Examples:
  open-memex resolve
  open-memex resolve 01ABC`,

  "sync-status": `Show the project memory sync pipeline: when the index last synced
and what triggered it, drafts waiting in the outbox (appdata), memories in the
repo awaiting review or published, and repo files not yet committed.

Usage: open-memex sync-status

Example:
  open-memex sync-status`,

  pull: `Pull shared project memories from the git remote: fetch + fast-forward
only. Never auto-merges — a diverged branch fails with a clear message and is
left for you to resolve by hand. On success the local index re-syncs.

Usage: open-memex pull

Example:
  open-memex pull`,

  push: `Push the current branch (with its submitted memories) to the git
remote. Explicit only — open-memex never pushes on its own.

Usage: open-memex push

Example:
  open-memex push`,

  export: `Export memories to a portable .tar.gz bundle (markdown source of
truth + manifest.json) for moving to another machine or another app.
Excludes visibility:private memories by default; --all includes everything.

Usage: open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]

Flags:
  --scope   project (default), personal, or both
  --type    filter by memory type
  --tag     filter by tag
  --all, -a include private memories (full migration)
  -o        output file (default: ./open-memex-export-<timestamp>.tar.gz)

Examples:
  open-memex export -o backup.tar.gz
  open-memex export --scope both --all -o full-migration.tar.gz`,

  import: `Import a bundle created by \`open-memex export\`. Personal memories
go to the personal dir; project memories are re-keyed to the current project
and land in the outbox as drafts. Existing identical memories are skipped;
conflicting ids are reported, never overwritten.

Usage: open-memex import <bundle.tar.gz> [--dry-run]

Examples:
  open-memex import backup.tar.gz --dry-run
  open-memex import backup.tar.gz`,

  "distill-agents": `Propose an AGENTS.md snippet distilled from project
memories (decisions, constraints, lessons, gotchas, howtos). Prints markdown
to stdout, or writes it with -o. Review and merge by hand — open-memex never
rewrites your AGENTS.md on its own.

Usage: open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]

Examples:
  open-memex distill-agents
  open-memex distill-agents --type decision,gotcha -o agents-snippet.md`,

  submit: `Move outbox drafts into the repo for review: copies the drafts into
the repo memory dir as proposed (a local-approved copy keeps its approval),
commits locally on the CURRENT branch, and moves the outbox originals out.
Never creates a branch on its own — branch creation is your call.

Usage: open-memex submit <id...> [--branch <name>] [--base <branch>]

Flags:
  --branch  create this branch and submit onto it (only with your explicit
            approval for the full chain); default: stay on current branch
  --base    PR base override (default: the branch you're on)

Example:
  open-memex submit 01ABC 01DEF`,

  "pr-status": `Map the current branch's GitHub PR state back onto review_state:
merged → published, approval → approved (approved_by = the reviewer),
changes-requested → suggestion only (never auto-rejects).
Each memory in the PR is mapped independently; a human rejection is never
overwritten. Report-only by default.

Usage: open-memex pr-status [--apply]

Flags:
  --apply   write the transitions locally (still never pushes)

Examples:
  open-memex pr-status
  open-memex pr-status --apply`,

  reindex: `Rebuild the SQLite index from the markdown files.

Usage: open-memex reindex

Example:
  open-memex reindex`,

  scopes: `List the known scopes (personal + project).

Usage: open-memex scopes

Example:
  open-memex scopes`,

  migrate: `Move memories between scopes, or convert a legacy my-o-memory data dir.

Usage: open-memex migrate [--from <key>] [--to <key>] [--dry-run] [--on-conflict newer|overwrite|skip]
       open-memex migrate --to-v2 [--dry-run]

Flags:
  --from / --to   scope keys (default: current project → personal)
  --dry-run       preview without moving anything
  --on-conflict   newer (default), overwrite, or skip
  --to-v2         convert a legacy my-o-memory data dir to the v2 layout

Always preview with --dry-run first; nothing moves without confirmation.

Examples:
  open-memex migrate --dry-run
  open-memex migrate --from personal --to project --dry-run`,

  mcp: `Start the stdio MCP server (the same server editors connect to).

Usage: open-memex mcp [--print-config vscode|cursor|claude|opencode|visualstudio]

Flags:
  --print-config   print the MCP client config instead of starting the server

Examples:
  open-memex mcp
  open-memex mcp --print-config vscode`,

  init: `One-command project setup: writes the MCP config for your editor and the
agent memory instructions. Existing files are merged, never clobbered.

Usage: open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--force] [--yes]

Flags:
  --client        editor to configure (default: auto-detect)
  --instructions  personal (default, ~/.copilot/copilot-instructions.md) or project
  --force         overwrite existing config
  --yes           accept all defaults, never prompt

Examples:
  open-memex init
  open-memex init --client cursor --yes`,

  config: `Show config, or set a key.

Usage: open-memex config [set <key> <value>]

Examples:
  open-memex config
  open-memex config set sync.autoPull false`,

  capture: `Preview what the keyword-capture watcher would extract from text.

Usage: open-memex capture --dry-run "text"

Example:
  open-memex capture --dry-run "remember: we deploy on Fridays"`,

  doctor: `Environment health check: Node version, config source, scope resolution,
storage writability, then boots a real MCP server and runs initialize +
tools/list against it — all eleven tools must show up.

Usage: open-memex doctor

Example:
  open-memex doctor`,
};

function usage(exitCode = 1): never {
  console.log(`open-memex CLI

Usage:
  open-memex where
  open-memex list [--scope project|personal] [--type T] [--limit N]
  open-memex search "query" [--scope project|personal|both] [--type T] [--limit N]
  open-memex add "content" [--scope project|personal] [--type T] [--tag t1,t2]
  open-memex supersede <id> "new content" [--type T] [--tag t1,t2]
  open-memex status <id> active|deprecated|retracted|archived
  open-memex forget <id>
  open-memex propose <id...> --to project [--local-approve]
  open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]
  open-memex resolve [id-or-path]
  open-memex sync-status
  open-memex pull
  open-memex push
  open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]
  open-memex import <bundle.tar.gz> [--dry-run]
  open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]
  open-memex submit <id...> [--branch <name>] [--base <branch>]
  open-memex pr-status [--apply]
  open-memex reindex
  open-memex scopes
  open-memex migrate [--from <key>] [--to <key>]
                                          [--dry-run] [--on-conflict newer|overwrite|skip]
  open-memex migrate --to-v2 [--dry-run]
  open-memex mcp [--print-config vscode|cursor|claude|opencode|visualstudio]
  open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--force] [--yes]
  open-memex config [set <key> <value>]
  open-memex capture --dry-run "text"
  open-memex doctor

Every command has its own help with description and examples:
  open-memex <command> --help   (or -h)

One-command project setup: \`open-memex init\` (or \`npx open-memex@alpha init\`) writes
the MCP config for your editor (\`.vscode/mcp.json\`, \`.cursor/mcp.json\`,
\`opencode.jsonc\`, or Visual Studio's solution-level \`.mcp.json\`) — no copy-paste
needed. The Copilot memory instructions default to your user-level
\`~/.copilot/copilot-instructions.md\` (all projects, never checked into a repo);
\`--instructions project\` writes \`.github/copilot-instructions.md\` instead for
teams where everyone uses open-memex.
Existing files are merged, never clobbered; re-running is safe. On a terminal it
asks which editor to set up and a couple of settings (keyword capture, first-turn
injection); \`--yes\` accepts all defaults, and non-terminal runs never prompt.
\`open-memex config set <key> <value>\` changes those settings after install.

Once installed globally (\`npm i -g open-memex@alpha\`) the \`open-memex\` command is
available directly: \`open-memex mcp\` starts the stdio MCP server (same five
memory_* tools as the opencode plugin); \`open-memex mcp --print-config <client>\`
prints a copy-paste MCP client config snippet.

Scope defaults to \`project\` (derived from cwd's git remote or path).
\`user\` is accepted as a deprecated alias of \`personal\`.
\`scopes\` lists every project scope dir with its file count — use it to find
the \`--from\` key when migrating.
\`migrate\` moves memories between scope keys — useful when a repo gains a
git remote after memories were already stored under the cwd-based key.
\`migrate --to-v2\` converts v1 memory files to the v2 format (§19):
user→personal scope rename, epoch→RFC 3339 times, priority→importance,
type: instruction→role split. Always preview with --dry-run first.

Run \`open-memex <command> --help\` for details on a single command.`);
  process.exit(exitCode);
}

/**
 * Build a saveConfig patch for a (possibly dotted) config key, preserving
 * sibling keys already present in the nested object.
 */
function setConfigPath(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".");
  if (parts.length === 1) return { [key]: value };
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  const top = parts[0]!;
  const cur =
    cfg[top] && typeof cfg[top] === "object"
      ? { ...(cfg[top] as Record<string, unknown>) }
      : {};
  let node: Record<string, unknown> = cur;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    const nxt =
      node[seg] && typeof node[seg] === "object"
        ? { ...(node[seg] as Record<string, unknown>) }
        : {};
    node[seg] = nxt;
    node = nxt;
  }
  node[parts[parts.length - 1]!] = value;
  return { [top]: cur };
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

/** CLI `--scope` flag → Scope. `user` is a deprecated alias of `personal`. */
function resolveCliScope(flags: Record<string, string>, project: Scope): Scope {
  return flags.scope === "personal" || flags.scope === "user"
    ? PERSONAL_SCOPE
    : project;
}

/** Print a copy-paste MCP client config snippet. Requires a global install
 * (`npm i -g open-memex@alpha`) so the `open-memex` command is on PATH. */
function printMcpConfig(client: string): never {
  const c = client.toLowerCase();
  // D17: resolve the server command the same way `init` does.
  const mc = resolveMcpCommand();
  if (c === "vscode") {
    console.log(
      JSON.stringify(
        {
          servers: {
            "open-memex": {
              type: "stdio",
              command: mc.command,
              args: mc.args,
              cwd: "${workspaceFolder}",
            },
          },
        },
        null,
        2,
      ),
    );
  } else if (c === "cursor") {
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "open-memex": { command: mc.command, args: mc.args },
          },
        },
        null,
        2,
      ),
    );
  } else if (c === "claude") {
    console.log(`claude mcp add open-memex -- ${mc.command} ${mc.args.join(" ")}`);
  } else if (c === "opencode") {
    // D16: opencode as a plain MCP consumer (alternative to the native plugin).
    console.log(
      JSON.stringify(
        {
          mcp: {
            "open-memex": {
              type: "local",
              command: [mc.command, ...mc.args],
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    );
  } else if (c === "visualstudio" || c === "visual-studio") {
    // D20: Visual Studio (Windows-only) reads solution-level `.mcp.json`.
    console.log(
      JSON.stringify(
        {
          servers: {
            "open-memex": {
              type: "stdio",
              command: mc.command,
              args: mc.args,
            },
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`unknown client "${client}" (vscode|cursor|claude|opencode|visualstudio)`);
    process.exit(1);
  }
  if (!mc.durable) {
    console.error(
      `\n# note: no durable \`open-memex\` on PATH — snippet uses npx. \`npm i -g open-memex@alpha\` for faster startup.`,
    );
  }
  process.exit(0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);

  if (cmd === "--version" || cmd === "-v") {
    // package.json sits two levels above this file in both layouts
    // (src/cli.ts and dist/cli.js).
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    console.log(`open-memex ${pkg.version}`);
    return;
  }

  // Per-command help: `open-memex <command> --help`. Checked before loadConfig()
  // so it works even when the environment is broken.
  if (rest.includes("--help") || rest.includes("-h")) {
    const h = COMMAND_HELP[cmd];
    if (h) {
      console.log(`open-memex ${cmd}\n\n${h}`);
      return;
    }
    usage(0);
  }

  const cfg = loadConfig();
  const project = resolveProjectScope(process.cwd());

  // `migrate --to-v2` is a pure file operation (V2-DESIGN §19) — it runs
  // before the index is opened so it also works where the DB driver
  // isn't available.
  if (cmd === "migrate" && rest.includes("--to-v2")) {
    const flags = parseFlags(rest);
    const dryRun = flags["dry-run"] === "true";
    const stats = migrateV2({ dryRun });
    console.log(
      `${dryRun ? "DRY RUN: " : ""}scanned ${stats.scanned} files: ` +
        `${stats.converted} to convert, ${stats.skippedV2} already v2`,
    );
    for (const p of stats.plans) {
      console.log(`\n${p.fm.id}`);
      console.log(
        `  ${p.fromPath}${p.toPath !== p.fromPath ? `\n  → ${p.toPath}` : ""}`,
      );
      for (const c of p.changes) console.log(`  - ${c}`);
    }
    if (stats.legacyBackup) {
      console.log(
        `\nlegacy my-o-memory data dir merged; backup kept at:\n  ${stats.legacyBackup}`,
      );
    }
    if (!dryRun && stats.converted > 0) {
      console.log(
        `\nindex schema will rebuild automatically on next run; ` +
          `run \`open-memex reindex\` to verify.`,
      );
    }
    return;
  }

  // `init` is a pure file operation (§17 adoption path) — no DB needed.
  // Interactive when on a TTY (asks editor + settings); --yes skips prompts.
  if (cmd === "init") {
    const flags = parseFlags(rest);
    const { initProject } = await import("./init.ts");
    await initProject({
      client: flags["client"],
      force: flags["force"] === "true",
      yes: flags["yes"] === "true",
      instructions: flags["instructions"],
    });
    return;
  }

  // `doctor` runs environment health checks — no DB needed (it self-contains).
  if (cmd === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    const ok = await runDoctor();
    if (!ok) process.exitCode = 1;
    return;
  }

  // `config` prints the effective configuration (defaults + file). No DB needed.
  // `config set <key> <value>` persists a setting to the config file.
  if (cmd === "config") {
    if (rest[0] === "set") {
      const [, key, ...valueParts] = rest;
      const { SETTABLE_KEYS, saveConfig, configFilePath } = await import("./config.ts");
      const validate = key ? SETTABLE_KEYS[key] : undefined;
      if (!validate) {
        console.error(
          `unknown or unsettable key "${key ?? ""}". Settable keys: ${Object.keys(SETTABLE_KEYS).join(", ")}`,
        );
        process.exit(1);
      }
      const raw = valueParts.join(" ");
      if (!raw) {
        console.error(`usage: open-memex config set <key> <value>`);
        process.exit(1);
      }
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        /* keep as string */
      }
      try {
        const saved = validate(value);
        // Dotted keys (e.g. sync.autoPull) write into the nested config
        // object, preserving sibling keys already on disk.
        const file = saveConfig(setConfigPath(key!, saved));
        console.log(`set ${key} = ${JSON.stringify(saved)} (${file})`);
      } catch (err) {
        console.error(`invalid value for ${key}: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }
    const cfg = loadConfig();
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  // `capture --dry-run "text"` previews keyword capture without writing. No DB needed.
  if (cmd === "capture") {
    if (rest[0] !== "--dry-run") {
      console.error(`usage: open-memex capture --dry-run "text"`);
      process.exit(1);
    }
    const cfg = loadConfig();
    const { detectKeywords } = await import("./capture/keywords.ts");
    const text = rest.slice(1).join(" ");
    const hits = detectKeywords(text, cfg);
    if (hits.length === 0) {
      console.log("no keyword triggers — nothing would be captured.");
      return;
    }
    for (const h of hits) {
      const r = redact(h.content, cfg.redactPatterns);
      console.log(`- pattern:      ${h.pattern}`);
      console.log(`  scope:        ${h.personal ? "personal (forced by pattern)" : "current scope"}`);
      console.log(`  secret hit:   ${r.hadSecret ? `yes (${r.matchedPattern}) — will be masked` : "no"}`);
      console.log(
        `  body:         ${r.content.slice(0, 160)}${r.content.length > 160 ? "…" : ""}`,
      );
    }
    return;
  }

  // `mcp` starts the stdio MCP server (same tools as the opencode plugin).
  // Branched before db() — runMcpServer() does its own init, and stdout must
  // stay clean for the MCP protocol.
  if (cmd === "mcp") {
    const flags = parseFlags(rest);
    if (flags["print-config"]) {
      printMcpConfig(flags["print-config"] === "true" ? "vscode" : flags["print-config"]);
    }
    const { runMcpServer } = await import("./mcp.ts");
    await runMcpServer();
    return;
  }

  db();

  if (cmd === "where") {
    const p = paths();
    console.log(`root:      ${p.root}`);
    console.log(`memories:  ${p.memories}`);
    console.log(`index:     ${p.indexDb}`);
    console.log(`project:   ${project.key}`);
    console.log(`personal:  ${PERSONAL_SCOPE.key}`);
    return;
  }

  if (cmd === "reindex") {
    const a = syncScope(project.key, "cli");
    const b = syncScope(PERSONAL_SCOPE.key, "cli");
    console.log(
      `reindexed. project: +${a.added} ~${a.updated} -${a.removed} (scanned ${a.scanned}), personal: +${b.added} ~${b.updated} -${b.removed} (scanned ${b.scanned})`,
    );
    return;
  }

  if (cmd === "list") {
    const flags = parseFlags(rest);
    const s = resolveCliScope(flags, project);
    syncScope(s.key, "cli");
    const hits = list(s.key, {
      type: flags.type,
      limit: flags.limit ? Number(flags.limit) : undefined,
    });
    if (hits.length === 0) {
      console.log(`(no memories in ${s.key})`);
      return;
    }
    for (const h of hits) {
      const dep = h.status === "deprecated" ? " [deprecated]" : "";
      const rev = hitStateLabel(h);
      console.log(`[${h.type}]${dep}${rev} ${h.id}  ${h.snippet.replace(/\s+/g, " ").trim()}`);
    }
    return;
  }

  if (cmd === "search") {
    const query = rest[0];
    if (!query || query.startsWith("--")) usage();
    const flags = parseFlags(rest.slice(1));
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    const keys =
      flags.scope === "personal" || flags.scope === "user"
        ? [PERSONAL_SCOPE.key]
        : flags.scope === "project"
          ? [project.key]
          : [project.key, PERSONAL_SCOPE.key];
    const hits = search(query, {
      scopeKeys: keys,
      limit: flags.limit ? Number(flags.limit) : undefined,
      type: flags.type,
    });
    if (hits.length === 0) {
      console.log("(no matches)");
      return;
    }
    for (const h of hits) {
      const tag = h.scope_key === PERSONAL_SCOPE.key ? "personal" : "project";
      const dep = h.status === "deprecated" ? " [deprecated]" : "";
      const rev = hitStateLabel(h);
      console.log(`[${tag}/${h.type}]${dep}${rev} ${h.id}  ${h.snippet.replace(/\s+/g, " ").trim()}`);
    }
    return;
  }

  if (cmd === "add") {
    const content = rest[0];
    if (!content || content.startsWith("--")) usage();
    const flags = parseFlags(rest.slice(1));
    const s = resolveCliScope(flags, project);
    const { content: red, hadSecret, matchedPattern } = redact(content, cfg.redactPatterns);
    // Dedup on write (§3.4): identical content is idempotent; near-duplicates
    // warn but still save (use `supersede` when this replaces the old one).
    // Secrets are masked (first 4 chars kept) and the write proceeds.
    const dups = findDuplicates(s.key, red);
    if (dups.exact) {
      console.log(`already exists: id=${dups.exact.id} (identical content — not duplicated)`);
      return;
    }
    const now = Date.now();
    const rfc = msToRfc3339(now);
    const fm: Frontmatter = {
      id: ulid(),
      schema_version: 2,
      scope_key: s.key,
      scope: s.kind === "project" ? "project" : "personal",
      visibility: s.kind === "project" ? "internal" : "private",
      project_name: s.projectName,
      type: flags.type ?? "fact",
      role: "knowledge",
      importance: "normal",
      status: "active",
      tags: flags.tag
        ? flags.tag
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      source: "cli",
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
    const { filePath } = writeMemoryFile(fm, red);
    const mf = readMemoryFile(filePath);
    if (mf) upsertFromFile(mf);
    console.log(`saved ${fm.id} [${s.kind}] -> ${filePath}`);
    if (hadSecret) {
      console.log(
        `warning: content matched secret pattern (${matchedPattern}); saved with the secret masked (first 4 chars kept).`,
      );
    }
    for (const n of dups.near) {
      console.log(
        `warning: similar memory exists (score ${n.score.toFixed(2)}): id=${n.id}\n  ${n.snippet}\n  use \`open-memex supersede ${n.id} "new content"\` if this replaces it.`,
      );
    }
    return;
  }

  if (cmd === "supersede") {
    const id = rest[0];
    const content = rest[1];
    if (!id || !content || content.startsWith("--")) usage();
    const flags = parseFlags(rest.slice(2));
    const { content: red, hadSecret, matchedPattern } = redact(content, cfg.redactPatterns);
    try {
      const { oldMf, newMf } = supersede(id, {
        body: red,
        type: flags.type,
        tags: flags.tag
          ? flags.tag.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
        source: "cli",
      });
      upsertFromFile(oldMf);
      upsertFromFile(newMf);
      console.log(`superseded ${oldMf.fm.id} → ${newMf.fm.id}`);
      if (hadSecret) {
        console.log(
          `warning: content matched secret pattern (${matchedPattern}); saved with the secret masked (first 4 chars kept).`,
        );
      }
    } catch (e) {
      console.error(`supersede failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "status") {
    const id = rest[0];
    const st = rest[1];
    if (!id || !st) usage();
    try {
      const mf = setStatus(id, st as "active" | "deprecated" | "retracted" | "archived");
      upsertFromFile(mf);
      console.log(`status ${id} → ${mf.fm.status}`);
    } catch (e) {
      console.error(`status failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "forget") {
    const id = rest[0];
    if (!id) usage();
    const row = db().prepare(`SELECT file_path FROM memories WHERE id = ?`).get(id) as
      | { file_path: string }
      | undefined;
    if (!row) {
      console.error("not found");
      process.exit(1);
    }
    // Delete by indexed file_path — location-agnostic (appdata or in-repo, 2B/D24).
    if (row.file_path) {
      try {
        fs.unlinkSync(row.file_path);
      } catch {
        /* already gone */
      }
    }
    deleteFromIndex(id);
    console.log(`deleted ${id}`);
    return;
  }

/** Positional args with flags (and their values) skipped. */
function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) i++; // skip the flag's value
    } else {
      out.push(a);
    }
  }
  return out;
}

  if (cmd === "propose") {
    const flags = parseFlags(rest);
    const ids = positionalArgs(rest);
    if (ids.length === 0) usage();
    const to = flags.to ?? "project";
    if (to !== "project") {
      console.error(`propose --to "${to}" is not supported yet (org sharing is Phase 4).`);
      process.exit(2);
    }
    try {
      const batch = proposeMemories(ids, { localApprove: flags["local-approve"] === "true" });
      for (const { sourceId, result: r } of batch) {
        console.log(`proposed ${sourceId} → ${r.id}  [${r.reviewState}]`);
      }
      console.log(`Next: these are drafts in the outbox (appdata) — nothing is in git yet.`);
      console.log(`  open-memex sync-status`);
      console.log(`  open-memex submit ${batch.map(({ result: r }) => r.id).join(" ")}   # new branch, local commit; prints push + PR commands`);
    } catch (e) {
      console.error(`propose failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "promote") {
    const flags = parseFlags(rest);
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) usage();
    try {
      const r = promoteMemory(id, {
        reject: flags.reject === "true",
        resubmit: flags.resubmit === "true",
        note: flags.note,
        by: flags.by,
      });
      console.log(`promote ${r.id}: ${r.from} → ${r.to}`);
      if (r.to === "published") {
        console.log(`  merged to the shared branch? Teammates pick it up with an explicit pull.`);
      }
      if (r.to === "rejected") {
        console.log(`  not deleted — the file stays on your branch. Your call:`);
        console.log(`  accept: close the PR and delete the branch;`);
        console.log(`  revise: edit the file, then \`open-memex promote ${r.id} --resubmit\`;`);
        console.log(`  keep: leave it as a [rejected] record.`);
      }
      if (r.history.length > 0) {
        console.log(`  history (${r.history.length}):`);
        for (const h of formatReviewHistory(r.history)) console.log(h);
      }
    } catch (e) {
      console.error(`promote failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "resolve") {
    const target = rest.find((a) => !a.startsWith("--"));
    try {
      if (!target) {
        const conflicts = listConflicts();
        if (conflicts.length === 0) {
          console.log("(no conflicted memory files)");
        } else {
          for (const c of conflicts) console.log(`conflicted: ${c.id}  ${c.filePath}`);
          console.log(`\nRun \`open-memex resolve <id>\` to attempt a field-level 3-way merge.`);
        }
        return;
      }
      const outcome = resolveConflict(target);
      if (!outcome.ok) {
        console.error(`cannot auto-resolve ${path.basename(outcome.filePath)} — semantic conflicts need a human:`);
        for (const c of outcome.conflicts) {
          console.error(`  ${c.field}:`);
          console.error(`    base:   ${c.base}`);
          console.error(`    ours:   ${c.ours}`);
          console.error(`    theirs: ${c.theirs}`);
        }
        console.error(`Edit the file manually, then \`git add\` it. Nothing was written.`);
        process.exit(3);
      }
      console.log(`resolved ${path.basename(outcome.filePath)}`);
      if (outcome.autoMerged.length > 0)
        console.log(`  auto-merged: ${outcome.autoMerged.join(", ")}`);
      console.log(`  next: git add ${path.relative(process.cwd(), outcome.filePath)}`);
    } catch (e) {
      console.error(`resolve failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "sync-status") {
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    try {
      console.log(formatSyncStatus(getSyncStatus()));
    } catch (e) {
      console.error(`sync-status failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  // §9 / D12: explicit pull — fetch + fast-forward only, never auto-merge.
  if (cmd === "pull") {
    const { GitProvider } = await import("./providers/git.ts");
    const root = projectRoot();
    try {
      const r = new GitProvider().pull(root);
      const stats = syncScope(project.key, "pull");
      if (r.fastForwarded) {
        console.log(
          `pulled ${r.branch} from ${r.remote}: ${r.before.slice(0, 8)} → ${r.after.slice(0, 8)} (fast-forward)`,
        );
      } else {
        console.log(`already up to date: ${r.branch} @ ${r.after.slice(0, 8)}`);
      }
      console.log(
        `index: +${stats.added} ~${stats.updated} -${stats.removed} (scanned ${stats.scanned})`,
      );
    } catch (e) {
      console.error(`pull failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  // Explicit push — open-memex never pushes on its own (D36).
  if (cmd === "push") {
    const { GitProvider } = await import("./providers/git.ts");
    const root = projectRoot();
    try {
      const r = new GitProvider().push(root);
      syncScope(project.key, "push");
      console.log(`pushed ${r.branch} to ${r.remote} @ ${r.head.slice(0, 8)}`);
    } catch (e) {
      console.error(`push failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  // §9 / D40: portable export bundle (markdown + manifest).
  if (cmd === "export") {
    const { exportMemories } = await import("./export.ts");
    const flags = parseFlags(rest);
    const all = flags["all"] === "true" || flags["a"] === "true" || rest.includes("--all") || rest.includes("-a");
    const scopeFlag = flags["scope"] ?? "project";
    // parseFlags only handles `--` flags; `-o <file>` is picked up here.
    const oIdx = rest.findIndex((a) => a === "-o");
    const outFile = flags["o"] ?? flags["output"] ?? (oIdx >= 0 ? rest[oIdx + 1] : undefined);
    const scopeKeys =
      scopeFlag === "both"
        ? [project.key, PERSONAL_SCOPE.key]
        : scopeFlag === "personal"
          ? [PERSONAL_SCOPE.key]
          : [project.key];
    try {
      const r = exportMemories({
        scopeKeys,
        type: flags["type"],
        tag: flags["tag"],
        includePrivate: all,
        outFile,
      });
      console.log(`exported ${r.exported} memories → ${r.file}`);
      if (!r.includePrivate && r.skippedPrivate > 0) {
        console.log(`skipped ${r.skippedPrivate} private memories (use --all to include them)`);
      }
    } catch (e) {
      console.error(`export failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "import") {
    const { importBundle } = await import("./export.ts");
    const flags = parseFlags(rest);
    const bundle = positionalArgs(rest)[0];
    if (!bundle) {
      console.error(`usage: open-memex import <bundle.tar.gz> [--dry-run]`);
      process.exit(2);
    }
    const dryRun = flags["dry-run"] === "true";
    try {
      const r = importBundle(bundle, { projectScopeKey: project.key, dryRun });
      if (!dryRun) {
        syncScope(project.key, "cli");
        syncScope(PERSONAL_SCOPE.key, "cli");
      }
      console.log(
        `${dryRun ? "DRY RUN: " : ""}imported ${r.imported}, skipped ${r.skippedIdentical} identical`,
      );
      for (const c of r.skippedConflict) {
        console.log(`  conflict (kept existing): ${c.id} from ${c.file}`);
      }
    } catch (e) {
      console.error(`import failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  // Phase 3: distill project memories into a proposed AGENTS.md snippet.
  if (cmd === "distill-agents") {
    const { distillAgentsMarkdown } = await import("./distill-agents.ts");
    const flags = parseFlags(rest);
    const scopeFlag = flags["scope"] ?? "project";
    const scopeKeys =
      scopeFlag === "personal" ? [PERSONAL_SCOPE.key] : [project.key];
    const types = flags["type"]
      ? flags["type"].split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    const limit = flags["limit"] ? parseInt(flags["limit"], 10) : undefined;
    const oIdx = rest.findIndex((a) => a === "-o");
    const outFile = oIdx >= 0 ? rest[oIdx + 1] : undefined;
    try {
      const md = distillAgentsMarkdown({ scopeKeys, types, limit });
      if (!md) {
        console.log("no distillable memories found (decisions, constraints, lessons, gotchas, howtos)");
        return;
      }
      if (outFile) {
        fs.writeFileSync(outFile, md, "utf8");
        console.log(`wrote proposed AGENTS.md snippet → ${outFile} (review and merge by hand)`);
      } else {
        console.log(md);
      }
    } catch (e) {
      console.error(`distill-agents failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "pr-status") {
    const flags = parseFlags(rest);
    try {
      const st = getPrStatus();
      console.log(formatPrStatus(st));
      if (flags.apply === "true") {
        const applied = applyPrStatus(st);
        if (applied.length === 0) {
          console.log(`nothing to apply.`);
        } else {
          for (const a of applied) {
            console.log(`applied ${a.memoryId.slice(0, 8)}: ${a.from} → ${a.to} (by ${a.by})`);
          }
        }
      }
    } catch (e) {
      console.error(`pr-status failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "submit") {
    const flags = parseFlags(rest);
    const ids = positionalArgs(rest);
    if (ids.length === 0) usage();
    syncScope(project.key, "submit");
    try {
      const r = submitMemories(ids, { branch: flags.branch, base: flags.base });
      for (const s of r.submitted) {
        console.log(`submitted ${s.id} → ${path.relative(process.cwd(), s.filePath)}  [${s.reviewState}]`);
      }
      for (const id of r.skippedIdentical) {
        console.log(`already on branch: ${id} (identical content — outbox copy removed)`);
      }
      if (!r.committed) {
        console.log(`nothing new to commit — branch ${r.branch} already holds these memories.`);
      } else {
        console.log(`committed on ${r.branch}.`);
      }
      console.log(`Next (needs your approval — open-memex never pushes for you):`);
      console.log(`  ${r.pushCommand}`);
      console.log(`  ${r.prCommand}`);
    } catch (e) {
      console.error(`submit failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "scopes") {
    const { memories } = paths();
    if (!fs.existsSync(memories)) {
      console.log("(no memories dir yet)");
      return;
    }
    const entries: Array<{ key: string; files: number; marker: string }> = [];
    for (const name of fs.readdirSync(memories)) {
      const dir = `${memories}/${name}`;
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
      const marker =
        name === project.key ? " <- current project"
        : name === PERSONAL_SCOPE.key ? " <- personal"
        : "";
      entries.push({ key: name, files, marker });
    }
    entries.sort((a, b) => b.files - a.files);
    for (const e of entries) {
      console.log(`  ${e.files.toString().padStart(4)}  ${e.key}${e.marker}`);
    }
    return;
  }

  if (cmd === "migrate") {
    const flags = parseFlags(rest);
    const toKey = flags.to ?? project.key;

    let fromKey = flags.from;
    if (!fromKey) {
      // Auto-detect: the "legacy" scope is what the key WOULD be if we
      // ignored the git remote (pure cwd hash). Only offer it if it differs
      // from the current project scope AND has files on disk.
      const cwd = resolveCwdScope(process.cwd());
      if (cwd.key !== project.key && scopeHasFiles(cwd.key)) {
        fromKey = cwd.key;
        console.log(`(auto-detected legacy scope: ${fromKey})`);
      } else {
        console.error(
          `no --from given and no legacy cwd-based scope with files detected.\n` +
            `current project scope: ${project.key}\n` +
            `cwd-only scope:        ${cwd.key}`,
        );
        process.exit(2);
      }
    }

    if (fromKey === toKey) {
      console.error(`--from and --to are identical (${fromKey}); nothing to do.`);
      process.exit(2);
    }

    const dryRun = flags["dry-run"] === "true";
    const onConflict = flags["on-conflict"] as ConflictStrategy | undefined;
    if (onConflict && !["newer", "overwrite", "skip"].includes(onConflict)) {
      console.error(`invalid --on-conflict: ${onConflict}`);
      process.exit(2);
    }

    const stats = migrateScope(fromKey, toKey, {
      toProjectName: project.projectName,
      dryRun,
      onConflict,
      logger: (m) => console.log(m),
    });
    console.log(
      `${dryRun ? "DRY RUN: " : ""}moved ${stats.moved}, skipped ${stats.skipped}, conflicts ${stats.conflicts}`,
    );
    return;
  }

  usage();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
