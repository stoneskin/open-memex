# open-memex

Local-first persistent memory for AI coding agents: an [opencode](https://opencode.ai) plugin
plus a generic MCP server (VS Code Copilot, Cursor, Claude Code, …).

- **Markdown files** as the source of truth (human-editable, git-friendly)
- **SQLite FTS5** as a rebuildable index (BM25 keyword search, via `better-sqlite3`)
- **Zero cloud**, zero account, zero third-party API
- Loads directly under opencode's embedded Bun runtime; CLI and MCP server run under Node — no build step, no Bun install

## Install

**From npm:**

```
npm install -g open-memex         # latest stable (0.1.0)
npm install -g open-memex@alpha   # prerelease channel — 0.2.0-alpha today (v2 data model,
                                 # CJK retrieval, redaction hardening); 0.3.0-alpha next
                                 # (MCP server, bin/CLI, init)
```

Note: the published `alpha` (`0.2.0-alpha`) predates the MCP server — for the MCP server,
install from source for now (it will ride the `0.3.0-alpha` publish):

**From source** (latest dev, includes the MCP server):

```
git clone -b V2-dev-p2 https://github.com/stoneskin/open-memex.git
cd open-memex
npm install
```

Then wire it into your agent:

- **opencode** — add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///c:/github/open-memex/src/index.ts"]
}
```

Restart opencode.

- **VS Code / Cursor / Claude Code** — see [MCP server](#mcp-server-vs-code-cursor-claude-code-) below.

## Tools the plugin exposes to the agent

| Tool | What it does |
|---|---|
| `memory_add`     | Save a fact, preference, decision, note |
| `memory_search`  | Keyword search (BM25) across project + personal memories |
| `memory_list`    | List memories in a scope, newest first |
| `memory_supersede` | Replace a memory with a newer version (keeps a supersede chain) |
| `memory_forget`  | Delete a memory by id |

## Capture

- **Keyword triggers** in user messages: `remember ...`, `note that ...`, `TIL ...`, `save this: ...`, plus Chinese （记住/记一下/别忘了）. Scope routing: 我 → personal (记住我/替我记/我觉得/我喜欢), 我们 → project (我们认为/我们决定/帮我们记住)
- **Explicit tool calls** by the agent (via `memory_add`)
- **Redaction**: content inside `<private>...</private>` tags is stripped; detected secrets (API keys, tokens, high-entropy credentials) are masked in place — first 4 characters kept, the rest replaced with `x` — and the memory is saved

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
importance, status, tags, created_at, updated_at, schema_version`, ...) followed by the
memory content. You can edit them by hand — the plugin re-syncs on startup by comparing
file mtimes. Markdown is the source of truth; the SQLite index is derived and rebuildable
(`open-memex reindex`).

## Config

Optional file at `~/.config/opencode/open-memex.jsonc`. See `PLAN.md` for defaults.

## CLI

Runs under Node 22 with the built-in experimental TypeScript loader (no build step).

```
node --experimental-strip-types src/cli.ts where
node --experimental-strip-types src/cli.ts list --scope project
node --experimental-strip-types src/cli.ts search "auth flow"
node --experimental-strip-types src/cli.ts add "This repo uses better-sqlite3" --type project-config
node --experimental-strip-types src/cli.ts supersede <id> "Updated content"
node --experimental-strip-types src/cli.ts status <id> deprecated
node --experimental-strip-types src/cli.ts forget <id>
node --experimental-strip-types src/cli.ts reindex
node --experimental-strip-types src/cli.ts scopes
node --experimental-strip-types src/cli.ts migrate --from <old-scope-key> [--dry-run]
node --experimental-strip-types src/cli.ts migrate --to-v2 [--dry-run]
```

Or via the npm script: `npm run cli -- list --scope project`.
**Note:** flag arguments beyond the first must be passed via direct `node` invocation, not `npm run cli --`, because npm swallows unknown `--flag` args.

## MCP server (VS Code, Cursor, Claude Code, …)

The same five memory tools are exposed over the Model Context Protocol via a stdio server —
no host-specific plugin needed. Any MCP client can use open-memex.

Start it:

```
open-memex mcp                        # after `npm i -g open-memex@alpha`
npx open-memex@alpha mcp              # no install needed (once 0.3.0-alpha is published)
```

Don't know what to paste into your client? This prints a copy-paste config snippet:

```
open-memex mcp --print-config vscode|cursor|claude|opencode
```

The project scope is resolved from the process working directory, so configure the server
with cwd set to your project root (all three clients below do this for workspace servers).

### MCP config

**VS Code** — create `.vscode/mcp.json` in your project (workspace scope) or add to your
user `mcp.json` (or run `open-memex mcp --print-config vscode`):

```json
{
  "servers": {
    "open-memex": {
      "type": "stdio",
      "command": "open-memex",
      "args": ["mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

**Cursor** — Settings → MCP → Add new MCP server (or `open-memex mcp --print-config cursor`):

```json
{
  "mcpServers": {
    "open-memex": {
      "command": "open-memex",
      "args": ["mcp"]
    }
  }
}
```

**Claude Code** — run from your project root so the project scope resolves correctly
(or `open-memex mcp --print-config claude`):

```
claude mcp add open-memex -- open-memex mcp
```

> Source install? Replace `"command": "open-memex"` with `"command": "node"` and
> `"args": ["--experimental-strip-types", "/absolute/path/to/open-memex/src/mcp.ts"]`.

### VS Code setup

**One command** — from your project root:

```
npx open-memex@alpha init
# or, after a global install: open-memex init
```

> Requires the `0.3.0-alpha` publish (not on npm yet) — until then, run from a source
> checkout: `node --experimental-strip-types src/cli.ts init`.

This writes `.vscode/mcp.json` and `.github/copilot-instructions.md` for you — no
copy-paste. Existing files are merged, never clobbered, so re-running is safe.
No global install? `init` detects that and writes an `npx -y open-memex@alpha mcp`
server command instead, so the setup keeps working after a one-shot npx run
(slower startup; `npm i -g open-memex@alpha` and `open-memex init --force` to switch
to the direct command later).
Then reload your VS Code window and check the `open-memex` server is started in
Copilot Chat's tools / MCP panel.

**Manual setup**, if you prefer:

1. Add the server to `.vscode/mcp.json` as above (use the absolute path to your clone).
2. Open Copilot Chat, click the tools / MCP icon, and make sure the `open-memex` server
   is started and its `memory_*` tools are enabled.
3. Make Copilot consult memory proactively: create `.github/copilot-instructions.md`
   in your project root with something like:

```markdown
Before answering questions about past decisions, conventions, or things I told you
before, search open-memex memory (`memory_search`). When I tell you something worth
remembering (preferences, decisions, fixes), save it with `memory_add`.
```

**Note:** MCP is request/response — it gives the agent tools, not the opencode plugin's
automatic keyword capture or first-turn context injection. Proactive memory use depends
on the agent's instructions (step 3 above).

## Status

`0.2.0-alpha` (on npm now): v2 data model + migration, dedup + lifecycle (supersede/status),
redaction hardening, CJK bigram retrieval.

`0.3.0-alpha` (next, in development on `V2-dev-p2`): generic MCP server (`src/mcp.ts`),
`open-memex` bin/CLI, `init` one-command setup, Chinese keyword capture, `config` /
`capture --dry-run` CLI helpers.

See `PLAN.md` for the roadmap (local embeddings, auto-capture, compaction hook, etc).

## License

[Apache-2.0](./LICENSE)
