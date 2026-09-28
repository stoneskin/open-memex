# open-memex

[中文文档](./README.zh-CN.md)

Local-first persistent memory for AI coding agents: an [opencode](https://opencode.ai) plugin
plus a generic MCP server (VS Code Copilot, Cursor, Claude Code, Visual Studio, …).

- **Markdown files** as the source of truth (human-editable, git-friendly)
- **SQLite FTS5** as a rebuildable index (BM25 keyword search, via `better-sqlite3`)
- **Zero cloud**, zero account, zero third-party API
- Loads directly under opencode's embedded Bun runtime; CLI and MCP server run under Node — no build step in development (the published npm package ships pre-compiled JS), no Bun install

## Installation

### Requirements

- **Node.js ≥ 22.6** (`open-memex doctor` verifies this for you)

### Step 1 — Install the CLI

**npm (recommended):**

```sh
npm install -g open-memex
```

This installs the `0.3.0` stable release.

**No install — run via npx:**

```sh
npx -y open-memex <command>   # e.g. npx -y open-memex init --client vscode
```

**From source** (bleeding edge, `V2-dev-p2` branch):

```sh
git clone -b V2-dev-p2 https://github.com/stoneskin/open-memex.git
cd open-memex
npm install
node --experimental-strip-types src/cli.ts <command>
```

#### "`open-memex` is not recognized" — PATH setup

A global `npm install -g` puts the `open-memex` launcher in npm's global bin folder.
If your terminal can't find it, that folder isn't on your `PATH`:

1. Find the folder: `npm config get prefix`
   - **Windows:** the launcher (`open-memex.cmd`) sits directly in that folder, e.g.
     `C:\Users\<you>\AppData\Roaming\npm`
   - **macOS / Linux:** it's in `<prefix>/bin`, e.g. `/usr/local/bin` or
     `~/.nvm/versions/node/v22.x.x/bin`
2. Add it to `PATH`:
   - **Windows:** Settings → System → About → Advanced system settings →
     Environment Variables → add the folder to the *User* `Path` → **restart the
     terminal**. Verify with `where open-memex`.
   - **macOS / Linux:** add `export PATH="$(npm prefix -g)/bin:$PATH"` to
     `~/.zshrc` (or `~/.bashrc`), restart the shell, verify with
     `command -v open-memex`.
3. No admin rights / don't want to touch `PATH`? Use the npx form above — npx
   resolves the package itself and needs no `PATH` changes.

#### "`EBUSY` / `EPERM` on `better_sqlite3.node`" — Windows reinstall

On Windows a loaded DLL is locked: if the open-memex MCP server is running
(VS Code MCP panel, Cursor, etc.), `npm install -g open-memex` cannot
replace `better_sqlite3.node` and fails with `EBUSY` / `EPERM`. Stop the MCP
server first (or quit the editor), then re-run the install. If it still fails,
delete `node_modules/open-memex` and any `node_modules/.open-memex-*` temp
folders under your global npm root and install again.

### Step 2 — One-command setup for your editor

Run from your **project root** (so the project scope resolves to this repo):

**VS Code** (Copilot):

```sh
open-memex init --client vscode
# …or without a global install:
npx -y open-memex init --client vscode
```

Writes `.vscode/mcp.json` and user-level Copilot instructions, then reload the
window and confirm the `open-memex` server is started in Copilot Chat's MCP panel.

**Cursor:**

```sh
open-memex init --client cursor
```

Writes `.cursor/mcp.json` and user-level Copilot instructions.

**opencode** (as a plain MCP consumer):

```sh
open-memex init --client opencode
```

Writes project-level `opencode.jsonc` (`type: "local"`). Prefer the native plugin
instead? Add `"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]` to
`~/.config/opencode/opencode.jsonc` — you get keyword auto-capture and first-turn
context injection on top of the tools.

**Claude Code** (from your project root):

```sh
claude mcp add open-memex -- open-memex mcp
# …or print the config snippet: open-memex mcp --print-config claude
```

**Visual Studio** (from your solution directory):

```sh
open-memex init --client visualstudio
```

Writes solution-level `.mcp.json` and user-level Copilot instructions. Requires
Visual Studio 2022 17.14+ or Visual Studio 2026 (**Windows-only**). Visual Studio
also auto-discovers `.vscode/mcp.json` and `.cursor/mcp.json`, so the VS Code setup
above works too.

**Codex:** no `init` client yet — add the server manually via
`open-memex mcp --print-config` as a starting point (`[mcp_servers]` in
`config.toml`, or `codex mcp add`).

`init` notes:

- The Copilot memory instructions default to **user-level**
  (`~/.copilot/copilot-instructions.md`; `%USERPROFILE%\copilot-instructions.md`
  for Visual Studio) — they apply to all your projects and are never checked
  into a repo, so teammates without open-memex see nothing and nothing breaks
  for them. `--instructions project` writes `.github/copilot-instructions.md`
  instead, for teams where everyone uses open-memex.
- On a terminal it interactively asks which editor to set up, whether to enable
  keyword auto-capture, and whether to inject memories on the first turn.
  `--yes` accepts the defaults; scripts / non-TTY never prompt (editor defaults to
  VS Code).
- Existing config files are **merged, never clobbered** — re-running is safe.
  `--force` overwrites.
- With no durable `open-memex` on `PATH` (e.g. one-shot npx), `init` writes an
  `npx -y open-memex mcp` server command into the config so the setup keeps
  working. `npm i -g open-memex` + `open-memex init --force` switches to the
  faster direct command later.

### Step 3 — Verify it works

```sh
open-memex doctor
```

Checks: Node version, config source, scope resolution for the current directory,
storage writability, then boots a real MCP server and runs `initialize` +
`tools/list` against it — all eleven tools must show up.

## Tools the agent gets

| Tool | What it does |
|---|---|
| `memory_add`       | Save a fact, preference, decision, note |
| `memory_search`    | Keyword search (BM25) across project + personal memories |
| `memory_list`      | List memories in a scope, newest first |
| `memory_supersede` | Replace a memory with a newer version (keeps a supersede chain) |
| `memory_forget`    | Delete a memory by id |
| `memory_status`    | Show the sync queue: outbox drafts, repo review states, uncommitted files |
| `memory_submit`    | Move named drafts into the repo memory dir (local branch + commit) |
| `memory_propose`   | Copy personal memories into the project scope as review candidates |
| `memory_promote`   | Advance `proposed → approved → published` (or reject / resubmit) |
| `memory_resolve`   | List conflicted memory files / 3-way-merge one of them |
| `memory_pr_status` | Map the branch PR's GitHub state onto each memory's review state |

## Capture

- **Keyword triggers** in user messages (opencode native plugin): `remember …`,
  `note that …`, `don't forget …`, `TIL …`, `save this …`, plus Chinese
  `记住…` / `记一下` / `记录一下` / `别忘了…`.
  Scope routing: first-person singular goes **personal** (`remember for me`,
  `记住我…`, `替我记…`, `我觉得…`, `我喜欢…`); first-person plural goes to the
  current **project** scope (`我们认为…`, `我们决定…`, `帮我们记住…`).
- **Explicit tool calls** by the agent (via `memory_add`)
- **Redaction**: content inside `<private>…</private>` tags is stripped; detected
  secrets (API keys, tokens, high-entropy credentials) are masked in place — first
  4 characters kept, the rest replaced with `x` — and the memory is saved.
  Preview what a message would capture with `open-memex capture --dry-run "…"`.

## Scopes

- **project** — scoped to the current repo (keyed off the git origin URL hash, or the cwd if no remote). Default for new memories.
- **personal** — global across all your projects, this machine only, never synced. Use for personal preferences. (v1 called this `user`; `migrate --to-v2` renames it.)

See [docs/SCOPES.md](./docs/SCOPES.md) for the full scope model: key derivation, migration, visibility, reserved names.

## Retrieval

On the first turn of every session, `open-memex` injects a `[OPEN-MEMEX]` block into the system prompt containing top-N recent project memories + top-N personal preferences. The agent can also call `memory_search` on demand.

## Storage layout

```
%APPDATA%\open-memex\               (Windows)
$XDG_DATA_HOME/open-memex/          (Linux/macOS)
├── index.db                         # SQLite FTS5 index (rebuildable)
└── memories/
    ├── personal/
    │   └── <id>.md
    └── project__<name>__<hash12>/
        └── <id>.md
```

Each `.md` file has v2 YAML frontmatter (`id, scope, scope_key, visibility, role, type,
importance, status, tags, created_at, updated_at, schema_version`, …) followed by the
memory content. You can edit them by hand — the plugin re-syncs on startup by comparing
file mtimes. Markdown is the source of truth; the SQLite index is derived and rebuildable
(`open-memex reindex`).

## Config

Optional file at `~/.config/opencode/open-memex.jsonc` (override path with
`MY_O_MEMORY_CONFIG`; override storage root with `MY_O_MEMORY_HOME`).

Defaults:

```jsonc
{
  "maxProjectMemories": 8,    // top-N project memories injected on first turn
  "maxProfileItems": 5,       // top-N personal items injected on first turn
  "injectOnFirstTurn": true,  // [OPEN-MEMEX] system-prompt block
  "keywordCaptureEnabled": true,
  "logLevel": "info",          // info | debug
  "memoryDir": ".ai/open-memex" // in-repo project-memory dir, relative to repo root
}
```

Project-scope memories are stored as one Markdown file each under
`<repo>/<memoryDir>/` (default `.ai/open-memex/`) so they can be shared via git;
personal memories stay in local appdata and never leave the machine. Existing
project files from appdata are moved into the repo dir automatically on first
write/sync.

`open-memex config` prints the effective config (defaults + file).
Change a setting after install:

```sh
open-memex config set keywordCaptureEnabled false
open-memex config set maxProjectMemories 12
```

Settable keys: `maxProjectMemories`, `maxProfileItems`, `injectOnFirstTurn`,
`keywordCaptureEnabled`, `logLevel`, `memoryDir`. Full design: [docs/V2-DESIGN.md](./docs/V2-DESIGN.md).

## CLI reference

Setup & health:

```sh
open-memex init [--client vscode|cursor|opencode|visualstudio] [--force] [--yes]
open-memex config                                  # print effective config
open-memex config set <key> <value>                # change a setting
open-memex doctor                                  # environment health check
open-memex capture --dry-run "记住我喜欢简洁的回答"  # preview keyword capture
open-memex mcp --print-config vscode|cursor|claude|opencode|visualstudio
open-memex --help      # this reference
open-memex <command> --help  # help for one command
open-memex --version   # installed version
```

Memory operations:

```sh
open-memex add "This repo uses better-sqlite3" --type project-config
open-memex search "auth flow"
open-memex list --scope project
open-memex supersede <id> "Updated content"
open-memex status <id> deprecated
open-memex forget <id>
```

Team review workflow (Phase 2B — two homes, one per stage):

Project drafts live in the **appdata outbox** (git-invisible, branch-independent);
only user-approved drafts move into `<repo>/.ai/open-memex/`, where they follow
branches and PRs. Nothing moves without you naming it.

In an AI chat with the MCP server connected, just say **"sync memory"**
(or "同步记忆") — the agent runs the status check, summarizes the outbox drafts,
and asks which ones to sync. The agent also proposes this on its own at session
start and at work checkpoints.

```sh
open-memex sync-status
# show when the index was last synced (and what triggered it), the outbox
# (pending sync), the repo review states
# (draft / proposed / approved / published / rejected),
# and any uncommitted repo memory files.

open-memex submit <id...> [--branch <name>] [--base <branch>]
# move your named drafts into .ai/open-memex/ as "proposed":
# copies, flips review_state, local git commit ON THE CURRENT BRANCH.
# Never creates a branch on its own — branch creation is your call
# (or the agent's, only with your explicit approval for the full chain).
# All-or-nothing; conflicts (same id, different content) abort cleanly.
# Prints the push + gh pr commands; an agent holding your Yes carries
# through push/PR itself. --branch <name> creates the branch first
# (agent full-chain path). Default PR base is the current branch; --base
# redirects to main or your integration branch.

open-memex pr-status [--apply]
# read the branch's GitHub PR and map its state onto each in-repo memory:
# merged PR → published, PR approval → approved (approved_by = reviewer),
# changes-requested → suggestion only. Report by default; --apply performs
# the mapped transitions locally (no push).

open-memex propose <id...> --to project [--local-approve]
# propose one or several personal memories at once (one branch, one PR);
# each is copied with its own new id. All-or-nothing: a bad id aborts the
# whole batch, never a half-proposed one.
# copy a personal memory into the project scope as a review candidate
# (never moves — the personal original stays). Result lands in the outbox;
# run sync-status / submit when you're ready to put it in the repo.
open-memex promote <id> [--reject] [--resubmit] [--note "..."] [--by NAME]
# advance one step: proposed → approved → published (or reject with a note).
# Every transition is appended to the memory's review_history (who/when/why).
# A rejection never deletes the file — your call: accept it (close the PR,
# delete the branch), revise + --resubmit for another round, or keep it as
# a [rejected] record.
open-memex resolve [id-or-path]
# list conflicted memory files, or field-level 3-way merge one of them.
# Semantic conflicts are reported, never auto-resolved.
```

Maintenance:

```sh
open-memex where        # show storage + config paths
open-memex scopes       # list project scopes with memory counts
open-memex reindex      # rebuild the SQLite index from markdown
open-memex migrate --to-v2 [--dry-run]   # v1 data → v2
```

The CLI runs under Node 22. From a source checkout it uses the built-in experimental
TypeScript loader (no build step); the published npm package ships pre-compiled JS
(`npm run build` at publish time). From a source checkout, prefix every command with
`node --experimental-strip-types src/cli.ts` (or `npm run cli -- <command>` for
simple cases — npm swallows unknown `--flag` args, so prefer direct `node`).

## MCP server

The same eleven memory tools over the Model Context Protocol via a stdio server —
no host-specific plugin needed. Any MCP client can use open-memex.

```sh
open-memex mcp               # after a global install
npx -y open-memex mcp  # no install needed
```

The project scope is resolved from the process working directory, so configure the
server with cwd set to your project root (`init` handles this for you).

> **Note:** MCP is request/response — it gives the agent tools, not the opencode
> plugin's automatic keyword capture or first-turn context injection. Proactive
> memory use depends on the agent's instructions: the server sends session-start
> guidance (call `memory_status` at session start and at checkpoints) in the MCP
> handshake `instructions`, and `init` writes the fuller version into the
> editor's instruction files. Both are advisory — no MCP consumer offers a hard
> session-start hook.

## Roadmap

**`0.3.0` (this release):** generic MCP server, `open-memex` bin/CLI, one-command
`init` setup, Chinese keyword capture with personal/project routing, `config` /
`capture --dry-run` / `doctor` helpers, Visual Studio support.

**In progress — `0.4.0`:** team sync — shared memory via git: appdata draft
outbox → `sync-status` → `submit` (local branch+commit, push/PR on your Yes)
→ `promote` / `resolve` review workflow, in-repo `.ai/open-memex/` dir, 1–2
colleague pilot.

**Coming — `0.3.0` (stable):** org layer — org memory repo, curator convention,
distill-to-AGENTS.md assist.

**Future (signal-gated, no version committed):** native agent plugins (Claude Code /
Codex hooks as enhancement paths over the same MCP tools); local embeddings as a
benchmark-gated experiment (no embedding model is ever downloaded without explicit
opt-in); cloud `RemoteProvider` customization only if multi-repo sharing, ACL, or
compliance needs demand it.

Design details: [docs/V2-DESIGN.md](./docs/V2-DESIGN.md) (append-only decision log D1–D20).

## License

[Apache-2.0](./LICENSE)
