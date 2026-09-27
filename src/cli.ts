#!/usr/bin/env node
// Run with:  node --experimental-strip-types src/cli.ts <command>
import { resolveProjectScope, resolveCwdScope, PERSONAL_SCOPE, type Scope } from "./scope.ts";
import { db, closeDb } from "./store/db.ts";
import { syncScope, upsertFromFile, deleteFromIndex } from "./store/sync.ts";
import { migrateScope, scopeHasFiles, type ConflictStrategy } from "./store/migrate.ts";
import { migrateV2 } from "./store/v2migrate.ts";
import { findDuplicates, supersede, setStatus } from "./store/lifecycle.ts";
import { search, list } from "./retrieve/search.ts";
import {
  writeMemoryFile,
  readMemoryFile,
  deleteMemoryFile,
  ulid,
  msToRfc3339,
  type Frontmatter,
} from "./store/markdown.ts";
import { loadConfig } from "./config.ts";
import { paths } from "./paths.ts";
import { redact } from "./redact.ts";
import { resolveMcpCommand } from "./init.ts";
import fs from "node:fs";

function usage(): never {
  console.log(`open-memex CLI

Usage:
  node --experimental-strip-types src/cli.ts where
  node --experimental-strip-types src/cli.ts list [--scope project|personal] [--type T] [--limit N]
  node --experimental-strip-types src/cli.ts search "query" [--scope project|personal|both] [--type T] [--limit N]
  node --experimental-strip-types src/cli.ts add "content" [--scope project|personal] [--type T] [--tag t1,t2]
  node --experimental-strip-types src/cli.ts supersede <id> "new content" [--type T] [--tag t1,t2]
  node --experimental-strip-types src/cli.ts status <id> active|deprecated|retracted|archived
  node --experimental-strip-types src/cli.ts forget <id>
  node --experimental-strip-types src/cli.ts reindex
  node --experimental-strip-types src/cli.ts scopes
  node --experimental-strip-types src/cli.ts migrate [--from <key>] [--to <key>]
                                          [--dry-run] [--on-conflict newer|overwrite|skip]
  node --experimental-strip-types src/cli.ts migrate --to-v2 [--dry-run]
  node --experimental-strip-types src/cli.ts mcp [--print-config vscode|cursor|claude|opencode|visualstudio]
  node --experimental-strip-types src/cli.ts init [--client vscode|cursor|opencode|visualstudio] [--force] [--yes]
  node --experimental-strip-types src/cli.ts config [set <key> <value>]
  node --experimental-strip-types src/cli.ts capture --dry-run "text"
  node --experimental-strip-types src/cli.ts doctor

One-command project setup: \`open-memex init\` (or \`npx open-memex@alpha init\`) writes
the MCP config for your editor (\`.vscode/mcp.json\`, \`.cursor/mcp.json\`,
\`opencode.jsonc\`, or Visual Studio's solution-level \`.mcp.json\`) plus
\`.github/copilot-instructions.md\` — no copy-paste needed.
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
type: instruction→role split. Always preview with --dry-run first.`);
  process.exit(1);
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
  if (!cmd) usage();

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
        const file = saveConfig({ [key!]: saved });
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
    const a = syncScope(project.key);
    const b = syncScope(PERSONAL_SCOPE.key);
    console.log(
      `reindexed. project: +${a.added} ~${a.updated} -${a.removed} (scanned ${a.scanned}), personal: +${b.added} ~${b.updated} -${b.removed} (scanned ${b.scanned})`,
    );
    return;
  }

  if (cmd === "list") {
    const flags = parseFlags(rest);
    const s = resolveCliScope(flags, project);
    syncScope(s.key);
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
      console.log(`[${h.type}]${dep} ${h.id}  ${h.snippet.replace(/\s+/g, " ").trim()}`);
    }
    return;
  }

  if (cmd === "search") {
    const query = rest[0];
    if (!query || query.startsWith("--")) usage();
    const flags = parseFlags(rest.slice(1));
    syncScope(project.key);
    syncScope(PERSONAL_SCOPE.key);
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
      console.log(`[${tag}/${h.type}]${dep} ${h.id}  ${h.snippet.replace(/\s+/g, " ").trim()}`);
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
    const row = db().prepare(`SELECT scope_key FROM memories WHERE id = ?`).get(id) as
      | { scope_key: string }
      | undefined;
    if (!row) {
      console.error("not found");
      process.exit(1);
    }
    deleteMemoryFile(row.scope_key, id);
    deleteFromIndex(id);
    console.log(`deleted ${id}`);
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
