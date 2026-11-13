#!/usr/bin/env node
// Run with:  node --experimental-strip-types src/cli.ts <command>
import { resolveProjectScope, resolveCwdScope, PERSONAL_SCOPE, type Scope } from "./scope.ts";
import { db, closeDb } from "./store/db.ts";
import { syncScope, upsertFromFile, deleteFromIndex } from "./store/sync.ts";
import { migrateScope, scopeHasFiles, type ConflictStrategy } from "./store/migrate.ts";
import { migrateV2 } from "./store/v2migrate.ts";
import { findDuplicates, supersede, setStatus } from "./store/lifecycle.ts";
import { proposeMemories, promoteMemory, listConflicts, resolveConflict, formatReviewHistory, currentAuthor } from "./review.ts";
import { getSyncStatus, formatSyncStatus, submitMemories } from "./submit.ts";
import { getPrStatus, formatPrStatus, applyPrStatus } from "./github.ts";
import { search, list, countList, hitStateLabel, type SearchStats } from "./retrieve/search.ts";
import { recordUseful, getUsage, reuseRate, usefulCount, usefulKindFor, deleteUsage, loadReuseReport } from "./store/usage.ts";
import { formatReuseReport } from "./reuse-report.ts";
import { DEFAULT_EXPANSIONS_WEIGHT } from "./retrieve/weights.ts";
import { formatInventoryLine, truncationNote } from "./retrieve/display.ts";
import {
  writeMemoryFile,
  readMemoryFile,
  ulid,
  msToRfc3339,
  normalizeAliases,
  type Frontmatter,
} from "./store/markdown.ts";
import { loadConfig, configSource } from "./config.ts";
import { paths, projectRoot, isInRepoMemoryFile } from "./paths.ts";
import { redact } from "./redact.ts";
import { readWorkingState, clearWorkingState, workingStatePath } from "./working-state.ts";
import { refreshGraph, refreshGraphQuiet, ensureGraph, loadGraphEdges, loadGraphNodes, loadAllMemoryIds } from "./store/graph.ts";
import { graphNeighbours, shortestPath } from "./graph/queries.ts";
import { lintGraph } from "./graph/lint.ts";
import { formatCurationAction } from "./curate.ts";
import { undoCuration } from "./store/curate.ts";
import { resolveMcpCommand } from "./init.ts";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * True when `target` sits inside a git working tree (D68 guard).
 *
 * D70: resolve the nearest EXISTING ancestor first. `git -C` on a
 * directory that does not exist throws, and the old code turned that
 * into "not in a worktree" — a fail-open guard on the one path where
 * personal memories would ride a commit.
 */
function isInsideWorkTree(target: string): boolean {
  try {
    let dir = path.dirname(path.resolve(target));
    while (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * D70: the one place that decides where a report may be written, for
 * every `inventory` format. Returns an error message to print, or null
 * when the path is safe. Kept single so the text/json/html paths cannot
 * drift apart (they already had two copies, D68).
 */
function inventoryWriteRefusal(
  target: string,
  includesPersonal: boolean,
  allowPersonal: boolean,
): string | null {
  // Personal content must not ride a commit (the design's hardest rule).
  if (includesPersonal && !allowPersonal && isInsideWorkTree(target)) {
    return (
      `inventory: ${target} is inside a git working tree and this report includes personal memories. ` +
      `Refusing to write it there. Pass --allow-personal if you really want that, or write outside the repo.`
    );
  }
  const parent = path.dirname(path.resolve(target));
  if (!fs.existsSync(parent)) {
    return `inventory: the directory ${parent} does not exist — create it first, or choose another --out path.`;
  }
  return null;
}

/** Per-command help, printed by `open-memex <command> --help`.
    AI assistants discover the CLI through --help, so every command needs one. */
const COMMAND_HELP: Record<string, string> = {
  where: `Show which project scope the current directory resolves to, and where its data lives.

Usage: open-memex where

Example:
  open-memex where`,

  list: `List memories in a scope, newest first, as a numbered inventory.

Usage: open-memex list [--scope project|personal|both] [--type T] [--limit N] [--include active|all]

Flags:
  --scope    project (default), personal, or both
  --type     filter by memory type
  --limit    max results (default 20, max 100)
  --include  active (default: what is currently remembered) or all (audit
             view: superseded versions, retracted and archived included)

A cut list says how many entries it left out. Numbers are unique within one
listing, so "the third one" names exactly one memory - but they are only
valid for the listing you just ran.

Examples:
  open-memex list
  open-memex list --scope personal --limit 20`,

  search: `Search memories by keyword (BM25 full-text), best matches first.

Usage: open-memex search "query" [--scope project|personal|both] [--type T] [--limit N] [--explain]

Flags:
  --scope    project (default), personal, or both
  --type     filter by memory type
  --limit    max results
  --explain  show the FTS expression, per-hit score, how many matches
             lifecycle hid (superseded / retracted / archived), and whether
             D79 feedback weighting moved any hit up

Example:
  open-memex search "deploy checklist" --scope both`,

  add: `Save a fact, preference, decision, or note to local memory.

Usage: open-memex add "content" [--scope project|personal] [--type T] [--tag t1,t2] [--aliases "a;b"] [--alias NICK --target REFERENT]

Flags:
  --scope    project (default) or personal (personal never leaves this machine)
  --type     memory type (default: fact)
  --tag      comma-separated tags
  --aliases  alternate phrasings of this fact (up to 4), indexed with the
             memory so differently-worded searches still match; separate
             with ; (commas also accepted — use ; when an alias itself
             contains one). Always on.
  --alias --target  D81: define user vocabulary once — e.g. --alias 香蕉计划
             --target 支付系统重构项目. Later queries mentioning either side
             trigger a second search round on the other side (both
             directions), scoped like the memory itself. Not gated by
             capture aliases.

Example:
  open-memex add "We deploy on Fridays" --scope project --tag process`,

  supersede: `Replace a memory with a newer version. The old one is kept as history.

Usage: open-memex supersede <id> "new content" [--type T] [--tag t1,t2] [--aliases "a;b"]

Without --aliases, the old memory's aliases carry over.

Example:
  open-memex supersede 01ABC "We deploy on Thursdays now"`,

  status: `Change a memory's lifecycle status.

Usage: open-memex status <id> active|deprecated|retracted|archived

Retraction is one-way: a retracted memory cannot be set back to active
(it was withdrawn on purpose). Save the content as a new memory instead.

Example:
  open-memex status 01ABC deprecated`,

  useful: `Mark a memory as useful (D77): record that it demonstrably paid
off. Useful is split automatically — useful_self for personal memories and
unpublished project drafts, useful_team for approved/published project
memories. Only explicit confirmation counts; passive retrieval (search/
list/injection) is counted separately as retrieved_count, never as useful.
A supersede or a human approval also records a useful signal on its own.

Usage: open-memex useful <id...>

Example:
  open-memex useful 01ABC`,

  forget: `Delete a memory by id. With --soft, hide it instead: the memory
is retracted (out of lists and search, file kept). Retraction is one-way —
save the content as a new memory to bring it back. If the memory lives in
the repo, either action is only local until you commit and push it.

Usage: open-memex forget <id> [--soft]

Example:
  open-memex forget 01ABC
  open-memex forget 01ABC --soft`,

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
repo awaiting review or published, and repo files not yet committed. The
D77 reuse report follows: per-scope retrieved/useful rates, most-reused
memories, and "zombies" (retrieved but never confirmed useful).

Usage: open-memex sync-status

Example:
  open-memex sync-status`,

  inventory: `Show everything remembered — personal + this project — in the
open: what each memory says, where it came from, and whether it has reached
the repo yet. Read-only; deleting stays a confirmed conversation with your
agent. Formats: text (default, diffable), json (for agents), html (a local
page for your browser; default writes <data dir>/inventory.html).

Usage: open-memex inventory [--format text|json|html] [--scope project|personal|both] [--out <path>] [--allow-personal]

Default scope: both. Without --out, text/json go to stdout. A report that
includes personal memories is refused inside a git working tree unless
--allow-personal is passed — personal content must not ride a commit.

Example:
  open-memex inventory --format json --out ~/inventory.json
  open-memex inventory --format html`,

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

Usage: open-memex submit <id...> [--branch <name>] [--base <branch>] [--no-curate]

D78: submit reports graph lint (report-only, never blocks) and auto-applies
only deterministic curation: exact duplicate merges, empty-body archives, and
first-line title whitespace normalization. Every change is listed with its
undo command. Near-duplicates stay report-only - a human decides.

Flags:
  --branch     create this branch and submit onto it (only with your explicit
               approval for the full chain); default: stay on current branch
  --base       PR base override (default: the branch you're on)
  --no-curate  skip the deterministic auto-apply tier; lint still reports

Example:
  open-memex submit 01ABC 01DEF
  open-memex submit 01ABC --no-curate`,

  curate: `Undo one deterministic curation action applied by submit.

Every action is recorded in the memory file's review_history, so undo works
across branches and machines. Only the most recent curation action on an id is
undoable: an undo appends its own receipt, so a second run refuses. Inspect the
file's review_history for the older trail.

Usage: open-memex curate undo <id>

Example:
  open-memex curate undo 01ABC`,

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
  --dry-run       preview without moving anything (--to-v2 previews the legacy
                  files in place, including per-file conversion plans)
  --on-conflict   newer (default), overwrite, or skip
  --to-v2         convert a legacy my-o-memory data dir to the v2 layout

Always preview with --dry-run first; nothing moves without confirmation.
On Windows, if another program holds the legacy folder open, the backup
rename fails with an actionable message instead of a stack trace — close
the program and re-run.

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
              [--instructions personal|project] [--global] [--force] [--yes]

Flags:
  --client        editor to configure (default: auto-detect all installed editors)
  --instructions  personal (default, ~/.copilot/copilot-instructions.md) or project
  --global        write the MCP server entry to the editor's user-level config
                  (VS Code / Cursor) — init once, works in every project.
                  For opencode, --global wires the native plugin at user level
                  (~/.config/opencode/opencode.json) — no per-project init needed.
  --force         overwrite existing config
  --yes           accept all defaults, never prompt

Examples:
  open-memex init
  open-memex init --client vscode --global --yes
  open-memex init --client cursor --yes`,

  uninstall: `Remove the editor wiring that \`init\` wrote: the MCP server entry,
the opencode native plugin line, and the Copilot instructions section.
Your memories are never touched.

Usage: open-memex uninstall [--client vscode|cursor|opencode|visualstudio]
              [--global] [--yes]

Flags:
  --client   editor to unwire (default: auto-detect all installed editors)
  --global   only the user-level config; without it, both project-level and
             user-level wiring are removed (init may have written either)
  --yes      accept all defaults, never prompt

Examples:
  open-memex uninstall
  open-memex uninstall --client vscode --yes`,

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
storage writability, VS Code MCP enablement (settings.json + system policy),
then boots a real MCP server and runs initialize + tools/list against it —
all thirteen tools must show up.

Usage: open-memex doctor

Example:
  open-memex doctor`,

  audit: `Memory health audit (read-only, reports never mutates): near-duplicate
pairs among active memories, stale actives untouched for 90+ days, broken
supersede chains, personal files found inside the repo memory dir, index/file
drift, and expired working-state notes (D89).

Usage: open-memex audit [--scope project|personal|both]

Flags:
  --scope   project (default), personal, or both

Example:
  open-memex audit --scope both`,

  graph: `Work with the compiled memory graph (§20, D88/D91) — a derived layer
of structural edges between memories, rebuilt from the Markdown source of
truth, never hand-edited.

Usage:
  open-memex graph build                 rebuild edges + the compiled outline for this project
  open-memex graph neighbours <id> [--depth N]   neighbours via BFS (default 1, max 6)
  open-memex graph path <idA> <idB> [--depth N]  shortest path (default 4, max 6)
  open-memex graph lint [--json]         health check: orphans, dangling refs, stale chains
  open-memex graph outline               print the compiled outline as it is injected

Every hop reports its edge type, provenance and confidence — EXTRACTED
means the link was explicit in the source (a supersede chain, a
derived-from copy, or the body mentioning the other memory's id);
INFERRED means the system noticed it (shared tags). Inferred links are
suggestions, never facts that were in the source.

Writes (add / supersede / forget / propose / promote) refresh the graph
automatically; graph build is the manual repair. Lint only reports.

Examples:
  open-memex graph build
  open-memex graph neighbours 01ABC --depth 2
  open-memex graph path 01ABC 01DEF
  open-memex graph lint`,

  wstate: `Show the project's session working-state note (D89, §3.6) — the
ephemeral scratch note the agent refreshes at wrap-up so an interrupted task
can resume. The file itself is plain Markdown and editable directly.

Usage: open-memex wstate [--clear]

Flags:
  --clear   delete the note (no tombstone — it is scratch, not knowledge)

Examples:
  open-memex wstate
  open-memex wstate --clear`,
};

function usage(exitCode = 1): never {
  console.log(`open-memex CLI

Usage:
  open-memex where
  open-memex list [--scope project|personal|both] [--type T] [--limit N] [--include active|all]
  open-memex search "query" [--scope project|personal|both] [--type T] [--limit N] [--explain]
  open-memex add "content" [--scope project|personal] [--type T] [--tag t1,t2]
  open-memex supersede <id> "new content" [--type T] [--tag t1,t2]
  open-memex status <id> active|deprecated|retracted|archived
  open-memex useful <id...>
  open-memex forget <id> [--soft]
  open-memex propose <id...> --to project [--local-approve]
  open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]
  open-memex resolve [id-or-path]
  open-memex sync-status
  open-memex inventory [--format text|json|html] [--scope project|personal|both] [--out <path>] [--allow-personal]
  open-memex pull
  open-memex push
  open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]
  open-memex import <bundle.tar.gz> [--dry-run]
  open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]
  open-memex submit <id...> [--branch <name>] [--base <branch>] [--no-curate]
  open-memex curate undo <id>
  open-memex pr-status [--apply]
  open-memex reindex
  open-memex audit [--scope project|personal|both]
  open-memex graph <build|neighbours <id>|path <a> <b>|lint|outline> [--depth N] [--json]
  open-memex wstate [--clear]
  open-memex scopes
  open-memex migrate [--from <key>] [--to <key>]
                                          [--dry-run] [--on-conflict newer|overwrite|skip]
  open-memex migrate --to-v2 [--dry-run]
  open-memex mcp [--print-config vscode|cursor|claude|opencode|visualstudio]
  open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--force] [--yes]
  open-memex uninstall [--client vscode|cursor|opencode|visualstudio]
              [--global] [--yes]
  open-memex config [set <key> <value>]
  open-memex capture --dry-run "text"
  open-memex doctor

Every command has its own help with description and examples:
  open-memex <command> --help   (or -h)

One-command project setup: \`open-memex init\` (or \`npx -y open-memex init\`) detects
your installed editors and wires them all — user-level where the editor supports it
(VS Code / Cursor MCP config, opencode native plugin), so one init covers every project;
Visual Studio is included when the project has a solution file (its \`.mcp.json\`
stays solution-level by design). \`--client\` picks a single editor instead, and a
single-editor opencode init writes the per-project plain-MCP \`opencode.jsonc\`.
The Copilot memory instructions default to your user-level
\`~/.copilot/copilot-instructions.md\` (all projects, never checked into a repo);
\`--instructions project\` writes \`.github/copilot-instructions.md\` instead for
teams where everyone uses open-memex.
Existing files are merged, never clobbered; re-running is safe. On a terminal it
confirms the detected editors and asks a couple of settings (keyword capture,
first-turn injection); \`--yes\` accepts all defaults, and non-terminal runs never prompt.
\`open-memex config set <key> <value>\` changes those settings after install.

Once installed globally (\`npm i -g open-memex\`) the \`open-memex\` command is
available directly: \`open-memex mcp\` starts the stdio MCP server (13 tools, a superset of
the opencode plugin's seven memory_* tools); \`open-memex mcp --print-config <client>\`
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

function parseFlags(argv: string[], booleans: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        // D44: accept --key=value as well as --key value (issue #7 — the
        // = form was silently misparsed before, dropping the flag).
        out[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      if (booleans.has(raw)) {
        out[raw] = "true";
        continue;
      }
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[raw] = val;
        i++;
      } else {
        out[raw] = "true";
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
 * (`npm i -g open-memex`) so the `open-memex` command is on PATH. */
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
      `\n# note: no durable \`open-memex\` on PATH — snippet uses npx. \`npm i -g open-memex\` for faster startup.`,
    );
  }
  process.exit(0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    // D50: fresh machine + interactive terminal → offer init instead of bare usage.
    // Non-interactive (CI/scripts/pipes) prints usage exactly as before.
    const { offerFirstRunInit } = await import("./first-run.ts");
    const outcome = await offerFirstRunInit(async () => {
      // Re-exec `open-memex init` as a child with inherited stdio instead of
      // calling initProject() in-process: the offer's readline already
      // consumed stdin's buffer, and a second readline on the same stream
      // would see EOF on burst input instead of the user's next answers.
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), "init"],
        { stdio: "inherit" },
      );
      if (r.error) throw r.error;
      if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
    });
    if (outcome !== "initialized") usage(0);
    return;
  }

  // F28: npm runs lifecycle scripts in the background and swallows their
  // stdout (unless --foreground-scripts), so the D50 postinstall pointer
  // never reaches the user. Every CLI entry point therefore carries a
  // one-line nudge on stderr until init has run or been declined — stderr
  // keeps the MCP stdio protocol (stdout) intact, and the .init.json marker
  // makes it once-ever. `init`/`uninstall` are excluded (already there /
  // nothing to wire). Placed before the --help/--version early returns:
  // `-v` is the first thing people run after installing.
  if (cmd !== "init" && cmd !== "uninstall") {
    const { isFirstRun } = await import("./first-run.ts");
    if (isFirstRun()) {
      console.error(
        "open-memex: first run? `open-memex init` wires it into your editors " +
          "(auto-detects VS Code, Cursor, opencode — and Visual Studio for solution projects).",
      );
    }
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);

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

  // §3.6 (D89): human convenience surface for the working-state note —
  // print it (with age/expiry) or delete it on request. The file itself is
  // always editable directly; audit reports expired notes either way.
  if (cmd === "wstate") {
    const flags = parseFlags(rest);
    if (flags["clear"] === "true") {
      const gone = clearWorkingState(project.key);
      console.log(
        gone
          ? `working-state note cleared (${project.key})`
          : "nothing to clear — the note is still on disk; delete it manually if it exists",
      );
      return;
    }
    const note = readWorkingState(project.key, cfg.workingStateTtlDays);
    if (!note) {
      console.log(`no working-state note for ${project.key} — the agent writes one at wrap-up (memory_workingstate); you can edit the file directly`);
      return;
    }
    if (!cfg.workingStateEnabled) {
      console.log("(working state is disabled in config — workingStateEnabled=false)");
    }
    console.log(
      note.expired
        ? `EXPIRED — ${note.ageDays} day(s) old, ttl ${note.ttlDays} (ignored at session start; ` +
          `audit keeps reporting it until the next wrap-up write or 'wstate --clear')`
        : `updated ${note.ageDays} day(s) ago — expires after ${note.ttlDays} day(s)`,
    );
    console.log();
    console.log(note.content || "(empty note)");
    console.log(`\nfile: ${workingStatePath(project.key)}`);
    return;
  }

  // `migrate --to-v2` is a pure file operation (V2-DESIGN §19) — it runs
  // before the index is opened so it also works where the DB driver
  // isn't available.
  if (cmd === "migrate" && rest.includes("--to-v2")) {
    const flags = parseFlags(rest);
    const dryRun = flags["dry-run"] === "true";
    let stats;
    try {
      stats = migrateV2({ dryRun });
    } catch (err) {
      // D44: actionable message, not a raw syscall stack (issue #7).
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
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
        dryRun
          ? `\nDRY RUN: legacy my-o-memory data dir found — it would be merged and backed up at:\n  ${stats.legacyBackup}`
          : `\nlegacy my-o-memory data dir merged; backup kept at:\n  ${stats.legacyBackup}`,
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
  // Interactive when on a TTY (confirms detected editors + settings); --yes skips prompts.
  if (cmd === "init") {
    const flags = parseFlags(rest);
    const { initProject } = await import("./init.ts");
    await initProject({
      client: flags["client"],
      force: flags["force"] === "true",
      yes: flags["yes"] === "true",
      instructions: flags["instructions"],
      global: flags["global"] === "true",
    });
    return;
  }

  // `uninstall` reverses `init` — removes the editor wiring; never touches data.
  // No DB needed (pure file operation, like init).
  if (cmd === "uninstall") {
    const flags = parseFlags(rest);
    const { uninstallProject } = await import("./init.ts");
    await uninstallProject({
      client: flags["client"],
      global: flags["global"] === "true",
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

  if (cmd === "audit") {
    const flags = parseFlags(rest);
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    const keys =
      flags.scope === "personal"
        ? [PERSONAL_SCOPE.key]
        : flags.scope === "both"
          ? [project.key, PERSONAL_SCOPE.key]
          : [project.key];
    const { runAudit, STALE_DAYS } = await import("./store/audit.ts");
    const r = runAudit(keys);
    console.log(`audit: ${r.totalMemories} memories (${keys.length === 2 ? "project+personal" : keys[0] === PERSONAL_SCOPE.key ? "personal" : "project"})`);
    console.log(`  near-duplicate active pairs: ${r.duplicatePairs.length}`);
    for (const p of r.duplicatePairs.slice(0, 10)) {
      console.log(`    ${p.a} ~ ${p.b} (similarity ${p.score.toFixed(2)}) — consider supersede`);
    }
    console.log(`  stale actives (>= ${STALE_DAYS} days untouched): ${r.stale.length}`);
    for (const s of r.stale.slice(0, 10)) {
      console.log(`    ${s.id} — ${s.ageDays} days`);
    }
    console.log(`  broken supersede chains: ${r.brokenChains.length}`);
    for (const b of r.brokenChains) {
      console.log(`    ${b.id} -> missing ${b.missingTarget}`);
    }
    console.log(`  personal files inside repo memory dir: ${r.personalInRepo.length}`);
    for (const f of r.personalInRepo) console.log(`    ${f}`);
    console.log(
      `  index drift: ${r.drift.filesNotIndexed} files not indexed, ${r.drift.rowsMissingFiles} rows missing files`,
    );
    // D89: expired working-state notes — reports only, never auto-deletes.
    console.log(`  expired working-state notes: ${r.workingStateExpired.length}`);
    for (const w of r.workingStateExpired) {
      console.log(`    ${w.filePath} — ${w.ageDays} days old (ttl ${w.ttlDays}); 'wstate --clear' or the next wrap-up write refreshes`);
    }
    return;
  }

  // D91: the graph surface (§20 deterministic half). Project scope only —
  // the graph covers the cwd's project scope like every other command;
  // no --scope flag exists because personal has no reader this iteration.
  if (cmd === "graph") {
    const sub = rest[0] ?? "";
    const flags = parseFlags(rest.slice(1));
    // --depth is opt-in per command: neighbours defaults to 1, path to 4,
    // and an explicit flag is clamped to [1, 6]. Absent = undefined so the
    // default reads cleanly where it is applied.
    const depth = (() => {
      if (flags.depth === undefined || flags.depth === "true") return undefined;
      const n = Number(flags.depth);
      if (!Number.isInteger(n) || n < 1 || n > 6) return undefined;
      return n;
    })();

    const syncThen = (fn: () => void) => {
      syncScope(project.key, "cli");
      fn();
    };

    if (sub === "build") {
      syncThen(() => {
        const s = refreshGraph(project.key, cfg);
        console.log(
          `graph built for ${s.scopeKey}: ${s.nodes} memories, ${s.edges} edges, ` +
            `${s.topics} topic(s), outline ${s.outlineLines} line(s)`,
        );
      });
      return;
    }

    if (sub === "neighbours") {
      const id = rest[1];
      if (!id) usage();
      syncThen(() => {
        ensureGraph(project.key, cfg);
        const nodes = loadGraphNodes(project.key);
        if (!nodes.some((n) => n.id === id)) {
          console.error(`neighbours: no memory with id ${id} in scope ${project.key} — graph findings never invent nodes.`);
          process.exit(1);
        }
        const hits = graphNeighbours(id, loadGraphEdges(project.key), nodes.map((n) => n.id), {
          maxDepth: depth ?? 1,
        });
        if (hits.length === 0) {
          const status = nodes.find((n) => n.id === id)!.status;
          console.log(
            status === "active"
              ? `no structural neighbours within depth ${depth ?? 1} — this memory is currently an orphan (see \`graph lint\`).`
              : `no structural neighbours within depth ${depth ?? 1} for this ${status} memory.`,
          );
          return;
        }
        for (const h of hits) {
          const n = nodes.find((x) => x.id === h.id)!;
          console.log(
            `- ${h.id} (depth ${h.depth}) ${h.via.type} ${h.via.provenance}/${h.via.confidence} (${h.via.via})` +
              ` [${n.status}] ${n.body.replace(/\s+/g, " ").trim().slice(0, 120)}`,
          );
        }
      });
      return;
    }

    if (sub === "path") {
      const a = rest[1];
      const b = rest[2];
      if (!a || !b) usage();
      syncThen(() => {
        ensureGraph(project.key, cfg);
        const nodes = loadGraphNodes(project.key);
        for (const id of [a, b]) {
          if (!nodes.some((n) => n.id === id)) {
            console.error(`path: no memory with id ${id} in scope ${project.key}.`);
            process.exit(1);
          }
        }
        const p = shortestPath(a, b, loadGraphEdges(project.key), nodes.map((n) => n.id), {
          maxDepth: depth ?? 4,
        });
        if (!p.found) {
          console.log(
            `no path found between ${a} and ${b} within depth ${depth ?? 4}. Weaker links (single shared tags) exist outside the built edge cap — \`graph neighbours\` per side may still connect them.`,
          );
          return;
        }
        console.log(`${a} [${nodes.find((n) => n.id === a)!.status}]`);
        for (const h of p.hops) {
          console.log(`  --(${h.type} ${h.provenance}/${h.confidence} via ${h.via})-->`);
          console.log(`${h.to} [${nodes.find((n) => n.id === h.to)!.status}]`);
        }
      });
      return;
    }
    if (sub === "lint") {
      syncThen(() => {
        ensureGraph(project.key, cfg);
        // Cross-scope ids (e.g. a propose copy's personal original) are not
        // findings — lint skips endpoints the store knows about.
        const f = lintGraph(loadGraphNodes(project.key), loadGraphEdges(project.key), loadAllMemoryIds());
        const counts = {
          orphan: 0,
          "dangling-edge": 0,
          stale: 0,
        };
        for (const x of f) counts[x.kind]++;
        if (flags.json === "true") {
          console.log(JSON.stringify({ findings: f, counts }, null, 2));
          return;
        }
        console.log(
          `graph lint (${project.key}): ${f.length} finding(s) — orphans ${counts.orphan}, dangling ${counts["dangling-edge"]}, stale ${counts.stale}. Reports only — a human decides; nothing is auto-resolved.`,
        );
        for (const x of f) {
          console.log(`  [${x.kind}] ${x.id}${x.other ? ` ↔ ${x.other}` : ""}: ${x.detail}`);
        }
        if (f.length > 0) {
          console.log(`feed these to the review flow when curating; D78's pre-submit lint consumes the same report later.`);
        }
      });
      return;
    }

    if (sub === "outline") {
      syncThen(() => {
        const g = ensureGraph(project.key, cfg);
        if (!g || !g.outline) {
          console.log("no compiled outline for this scope yet — `graph build` creates one.");
          return;
        }
        console.log(`outline built ${g.builtAt} (${g.nodes} memories / ${g.edges} edges):`);
        for (const line of g.outline.split("\n")) console.log(line);
      });
      return;
    }

    usage();
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
    const { scanKeywords, MIN_CAPTURE_CHARS, MAX_CAPTURE_CHARS } = await import(
      "./capture/keywords.ts"
    );
    const text = rest.slice(1).join(" ");
    const { hits, dropped } = scanKeywords(text, cfg);
    if (hits.length === 0) {
      console.log("no keyword triggers - nothing would be captured.");
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
    // D67: a trigger that matched but produced a fragment is reported, not
    // silently dropped - otherwise "记住：这个" just looks broken.
    for (const d of dropped) {
      console.log(
        d.reason === "too-short"
          ? `! matched but NOT captured: body "${d.content}" is ${d.content.length} chars (floor: ${MIN_CAPTURE_CHARS}). A trigger alone isn't a memory - write the fact: "记住：<fact>".`
          : `! matched but NOT captured: body is ${d.content.length} chars (ceiling: ${MAX_CAPTURE_CHARS}) - save it with memory_add instead.`,
      );
    }
    return;
  }

  // `mcp` starts the stdio MCP server (12 tools; the opencode plugin exposes 6).
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
    console.log(`config:    ${configSource() ?? "(built-in defaults)"}`);
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
    // D66: --scope both, on par with the memory_list tool — prints each
    // scope's newest under its own header.
    const scopes =
      flags.scope === "both" ? [PERSONAL_SCOPE, project] : [resolveCliScope(flags, project)];
    const include = flags.include === "all" ? "all" : "active";
    // D70: the CLI renders the SAME structured inventory the agent sees,
    // numbering runs across the whole listing, and a cut list says how
    // many entries it dropped — `open-memex list` is the surface a
    // sceptical user runs first, so it may not look complete when it isn't.
    let seq = 0;
    for (const s of scopes) {
      syncScope(s.key, "cli");
      const hits = list(s.key, {
        type: flags.type,
        limit: flags.limit ? Number(flags.limit) : undefined,
        include,
        record: true,
      });
      const total = countList(s.key, { type: flags.type, include });
      if (scopes.length > 1) {
        console.log(
          s.key === PERSONAL_SCOPE.key
            ? "## About you (personal — stays on this machine, applies everywhere)"
            : `## This project (${s.projectName || s.key})`,
        );
      }
      if (hits.length === 0) {
        console.log(
          scopes.length > 1
            ? "(nothing remembered in this scope yet)"
            : `(no memories in ${s.key})`,
        );
        continue;
      }
      for (const h of hits) {
        console.log(formatInventoryLine(seq++, h, PERSONAL_SCOPE.key));
      }
      const note = truncationNote(hits.length, total);
      if (note) console.log(note);
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
    const explain = flags.explain === "true";
    const stats: SearchStats | undefined = explain
      ? { ftsQuery: "", candidates: 0, hiddenSuperseded: 0, hiddenExcluded: 0, aliasExpansions: [] }
      : undefined;
    const hits = search(query, {
      scopeKeys: keys,
      limit: flags.limit ? Number(flags.limit) : undefined,
      type: flags.type,
      stats,
      record: true,
      feedback: cfg.feedbackWeighting,
    });
    if (explain && stats) {
      console.log(`fts: ${stats.ftsQuery || "(empty query)"}`);
      console.log(
        `candidates: ${stats.candidates}, hidden by lifecycle: ${stats.hiddenSuperseded} superseded, ${stats.hiddenExcluded} retracted/archived`,
      );
      if (stats.aliasExpansions.length > 0) {
        console.log(`alias rounds: ${stats.aliasExpansions.map((q) => `"${q}"`).join(" → ")}`);
      }
      // D79: say whether the reuse-signal nudge ran and exactly which hits it
      // moved. The score column below stays the raw BM25 value — feedback
      // reorders bands, it never edits the number.
      if (stats.feedback) {
        const fb = stats.feedback;
        console.log(
          `feedback weighting: ${
            fb.enabled
              ? `on (min retrieved=${fb.minRetrieved}, band=${fb.bandRatio})`
              : "off (default; enable with: open-memex config set feedbackWeighting true)"
          }`,
        );
        if (fb.enabled) {
          if (fb.promotions.length === 0) {
            console.log("  no hits moved by reuse signal");
          } else {
            for (const p of fb.promotions) {
              const rate = p.rate === null ? "n/a" : p.rate.toFixed(2);
              console.log(
                `  ↑ ${p.id} +${p.promoted} (reuse ${rate}, retrieved=${p.retrieved}, useful=${p.useful})`,
              );
            }
          }
        }
      }
      // D83: which indexed column each hit matched on. `expansion` means the
      // hit only surfaced through a D80 derived variant, so it ranks below an
      // equal body match by construction (BM25_WEIGHTS) — this is how a
      // surprising rank gets traced instead of guessed at.
      if (hits.length > 0) {
        const via = hits.reduce<Record<string, number>>((acc, h) => {
          acc[h.matchedVia] = (acc[h.matchedVia] ?? 0) + 1;
          return acc;
        }, {});
        console.log(
          `matched via: ${Object.entries(via).map(([k, n]) => `${k}=${n}`).join(", ")}` +
            `   (bm25 weights: content=1 tags=1 aliases=1 expansions=${DEFAULT_EXPANSIONS_WEIGHT} type=1 cjk=1)`,
        );
      }
    }
    if (hits.length === 0) {
      console.log("(no matches)");
      return;
    }
    for (const h of hits) {
      const tag = h.scope_key === PERSONAL_SCOPE.key ? "personal" : "project";
      const dep = h.status === "deprecated" ? " [deprecated]" : "";
      const rev = hitStateLabel(h);
      const sc = explain ? ` score=${h.score.toFixed(3)}` : "";
      console.log(`[${tag}/${h.type}]${dep}${rev}${sc} ${h.id}  ${h.snippet.replace(/\s+/g, " ").trim()}`);
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
      // D61: --aliases "phrase one; phrase two" (comma also accepted; use
      // ; when an alias itself contains a comma). A bare --aliases with no
      // value makes parseFlags yield "true" — treat that as absent. Stored
      // only when the install enables capture aliases, redacted like content.
      ...(typeof flags.aliases === "string" && flags.aliases !== "true" && cfg.captureAliases
        ? {
            aliases: normalizeAliases(
              flags.aliases
                .split(/[;,]/)
                .map((a) => redact(a.trim(), cfg.redactPatterns).content)
                .filter(Boolean),
            ),
          }
        : {}),
      // D81: --alias/--target define user vocabulary (not gated by capture
      // aliases — this is deliberate, like typing the words yourself).
      ...(typeof flags.alias === "string" && flags.alias !== "true" && flags.alias.trim()
        ? { alias: redact(flags.alias.trim(), cfg.redactPatterns).content }
        : {}),
      ...(typeof flags.target === "string" && flags.target !== "true" && flags.target.trim()
        ? { target: redact(flags.target.trim(), cfg.redactPatterns).content }
        : {}),
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
    // D91 ingest: refresh the project graph quietly (personal no-ops inside).
    refreshGraphQuiet(s.key, cfg);
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
        aliases:
          typeof flags.aliases === "string" && flags.aliases !== "true" && cfg.captureAliases
            ? normalizeAliases(
                flags.aliases
                  .split(/[;,]/)
                  .map((a) => redact(a.trim(), cfg.redactPatterns).content)
                  .filter(Boolean),
              )
            : undefined,
        source: "cli",
      });
      upsertFromFile(oldMf);
      upsertFromFile(newMf);
      refreshGraphQuiet(oldMf.fm.scope_key, cfg);
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
      refreshGraphQuiet(mf.fm.scope_key, cfg);
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
    // D68: --soft hides (retracts) instead of deleting — same action as
    // the memory_forget tool's soft flag. One-way (D64).
    if (rest.includes("--soft")) {
      const target = db().prepare(`SELECT file_path, scope_key FROM memories WHERE id = ?`).get(id) as
        | { file_path: string; scope_key: string }
        | undefined;
      try {
        const mf = setStatus(id, "retracted");
        upsertFromFile(mf);
        refreshGraphQuiet(mf.fm.scope_key, cfg);
        console.log(`hidden ${id} (retracted — out of lists and search; save it again as a new memory to bring it back)`);
        // D70: same honesty as the hard delete — a retraction of an in-repo
        // memory is a local working-tree edit until it is committed and pushed.
        if (target && isInRepoMemoryFile(target.file_path)) {
          console.log(
            `note: that memory lives in the repo (.ai/open-memex/) — the retraction is only local until you commit and push it; until then the team still sees it.`,
          );
        }
      } catch (e) {
        console.error(`hide failed: ${(e as Error).message}`);
        process.exit(1);
      }
      return;
    }
    const row = db().prepare(`SELECT file_path, scope_key FROM memories WHERE id = ?`).get(id) as
      | { file_path: string; scope_key: string }
      | undefined;
    if (!row) {
      console.error("not found");
      process.exit(1);
    }
    // Delete by indexed file_path — location-agnostic (appdata or in-repo, 2B/D24).
    // Only ENOENT = success; anything else means the file survives and
    // would be re-indexed — fail loudly (P0 review, 2026-10-03).
    if (row.file_path) {
      try {
        fs.unlinkSync(row.file_path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.error(`could not delete ${row.file_path} (${code ?? "error"}) — memory not forgotten`);
          process.exit(1);
        }
      }
    }
    deleteFromIndex(id);
    // D91 ingest: the node left the graph — refresh its scope quietly.
    refreshGraphQuiet(row.scope_key);
    // D77-L2: hard forget prunes the usage row with the memory (the tool
    // path does the same); branch-switch removals go through syncScope and
    // keep counters for that reason.
    deleteUsage(id);
    console.log(`deleted ${id}`);
    return;
  }

  if (cmd === "useful") {
    // D77-L2: the explicit confirmation route for humans. Auto-split like
    // the memory_useful tool; unknown ids fail that id without touching
    // the rest of the batch.
    const ids = rest;
    if (ids.length === 0) usage();
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    let notFound = 0;
    for (const id of ids) {
      const row = db()
        .prepare(`SELECT scope, review_state FROM memories WHERE id = ?`)
        .get(id) as { scope: string; review_state: string } | undefined;
      if (!row) {
        console.error(`not found: ${id}`);
        notFound++;
        continue;
      }
      const kind = usefulKindFor(row.scope, row.review_state);
      recordUseful(id, kind, "tool");
      const u = getUsage(id)!;
      const rate = reuseRate(u);
      const useful = usefulCount(u);
      console.log(
        `useful (${kind}) ${id} — retrieved: ${u.retrieved_count}, useful_self: ${u.useful_self}, useful_team: ${u.useful_team}, reuse_rate: ${rate === null ? "n/a" : rate.toFixed(2)} (useful ${useful}/${u.retrieved_count})`,
      );
    }
    if (notFound > 0) process.exit(1);
    return;
  }

/** Positional args with flags (and their values) skipped. */
function positionalArgs(argv: string[], booleans: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      if (raw.includes("=") || booleans.has(raw)) continue;
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

  if (cmd === "inventory") {
    // D68: refresh both scopes first so the report matches the markdown
    // on disk. Default scope: personal + this project.
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    const flags = parseFlags(rest);
    const format = flags.format ?? "text";
    if (format !== "text" && format !== "json" && format !== "html") {
      console.error(`inventory: unknown --format '${format}' (text|json|html)`);
      process.exit(2);
    }
    const scopeKeys =
      flags.scope === "personal"
        ? [PERSONAL_SCOPE.key]
        : flags.scope === "project"
          ? [project.key]
          : [PERSONAL_SCOPE.key, project.key];
    const outPath = flags["out"] ?? flags["output"];
    const includesPersonal = scopeKeys.includes(PERSONAL_SCOPE.key);
    const allowPersonal = flags["allow-personal"] === "true";
    try {
      const { loadInventory, renderInventoryText, renderInventoryJson } = await import("./inventory.ts");
      if (format === "html") {
        const { renderInventoryHtml, defaultHtmlOutPath } = await import("./inventory-html.ts");
        const target = outPath ?? defaultHtmlOutPath(paths().root);
        // D70: one guard for every format (this path had its own copy).
        const refusal = inventoryWriteRefusal(target, includesPersonal, allowPersonal);
        if (refusal) {
          console.error(refusal);
          process.exit(2);
        }
        // D70: only the audit surface needs the hidden rows themselves;
        // text/json report counts, so they must not pay to load them.
        const data = loadInventory(scopeKeys, { hidden: "entries" });
        fs.writeFileSync(target, renderInventoryHtml(data), "utf8");
        console.log(`inventory: ${data.total} memories → ${target}`);
        console.log(`open it in any browser; the report is read-only.`);
        return;
      }
      const data = loadInventory(scopeKeys);
      const rendered = format === "json" ? renderInventoryJson(data) : renderInventoryText(data);
      if (outPath) {
        // D68/3-C v2: the report contains personal content. Writing it into
        // a git working tree would ride the next commit off this machine —
        // refuse unless the user explicitly accepts that.
        const refusal = inventoryWriteRefusal(outPath, includesPersonal, allowPersonal);
        if (refusal) {
          console.error(refusal);
          process.exit(2);
        }
        fs.writeFileSync(outPath, rendered, "utf8");
        console.log(`inventory: ${data.total} memories → ${outPath}`);
      } else {
        process.stdout.write(rendered);
      }
    } catch (e) {
      console.error(`inventory failed: ${(e as Error).message}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "sync-status") {
    syncScope(project.key, "cli");
    syncScope(PERSONAL_SCOPE.key, "cli");
    try {
      console.log(formatSyncStatus(getSyncStatus(), { cap: Number.POSITIVE_INFINITY }));
      // D77-L3: same reuse block as the memory_status tool, uncapped (a
      // human asked; the CLI is where the full list lives).
      const reuse = loadReuseReport(
        [
          { scopeKey: project.key, label: "this project" },
          { scopeKey: PERSONAL_SCOPE.key, label: "personal" },
        ],
        { topLimit: Number.POSITIVE_INFINITY, zombieLimit: Number.POSITIVE_INFINITY },
      );
      console.log("");
      for (const line of formatReuseReport(reuse, { entryCap: Number.POSITIVE_INFINITY })) {
        console.log(line);
      }
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
      for (const rp of r.rejectedPaths) {
        console.log(`  rejected: ${rp} (path outside the bundle)`);
      }
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
    const booleans = new Set(["no-curate"]);
    const flags = parseFlags(rest, booleans);
    const ids = positionalArgs(rest, booleans);
    if (ids.length === 0) usage();
    syncScope(project.key, "submit");
    try {
      const r = submitMemories(ids, {
        branch: flags.branch,
        base: flags.base,
        noCurate: flags["no-curate"] === "true",
      });
      const c = r.curation;
      console.log(
        `curation: ${c.lintFindings.length} lint finding(s) - orphans ${c.lintCounts.orphan}, dangling ${c.lintCounts["dangling-edge"]}, stale ${c.lintCounts.stale}. Reports only - a human decides; nothing is auto-resolved.`,
      );
      for (const f of c.lintFindings.slice(0, 5)) {
        console.log(`  [${f.kind}] ${f.id}${f.other ? `  ${f.other}` : ""}: ${f.detail}`);
      }
      if (c.lintFindings.length > 5) {
        console.log(`  ... and ${c.lintFindings.length - 5} more (full list: open-memex graph lint)`);
      }
      if (c.disabled) {
        console.log("curation auto-apply skipped (--no-curate); no files were changed by curation.");
      } else if (c.applied.length === 0) {
        console.log("curation auto-applied: 0 (nothing deterministic to fix)");
      } else {
        console.log(`curation auto-applied: ${c.applied.length}`);
        for (const a of c.applied) console.log(`  ${formatCurationAction(a.action)}`);
      }
      for (const s of c.skipped) {
        console.log(`  curation skipped ${s.id}: ${s.reason}`);
      }
      for (const w of c.warnings) console.log(`  curation note: ${w}`);
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

  if (cmd === "curate") {
    const sub = rest[0];
    const id = rest[1];
    if (sub !== "undo" || !id) usage();
    syncScope(project.key, "cli");
    try {
      const r = undoCuration(id, { by: currentAuthor() });
      refreshGraphQuiet(project.key, cfg);
      console.log(`curation undone: ${r.kind} ${id}`);
      for (const p of r.filePaths) {
        console.log(`  ${path.relative(process.cwd(), p)}`);
      }
    } catch (e) {
      console.error(`curate undo failed: ${(e as Error).message}`);
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
    if (entries.length === 0) {
      console.log("(no scopes with memories yet — add one with `open-memex add`)");
      return;
    }
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
    // D57: lock contention past the busy timeout should read as a transient
    // condition, not a stack trace. The memory file is written before the
    // index update, so a locked-out write still lands on the next sync.
    const code = (err as { code?: string })?.code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      console.error(
        "open-memex: the memory store is busy (another open-memex process is writing). Wait a moment and retry — nothing was lost.",
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
