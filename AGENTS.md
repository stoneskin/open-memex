# AGENTS.md

Local-first memory plugin for opencode. See `README.md` (English) and `README.zh-CN.md` (Chinese)
for user-facing docs; `docs/V2-DESIGN.md` §18 for the roadmap. This file lists only the non-obvious things an agent needs to work in this repo.

## Runtime model — read before touching anything

Three entry points execute the same TypeScript source. **Development is build-free**;
the published npm package ships pre-compiled JS (`npm run build` → `dist/`,
via `prepublishOnly` — Node refuses `--experimental-strip-types` for files under
`node_modules`, so a global install cannot run `src/` directly):

- **opencode host** loads `src/index.ts` under embedded **Bun**. SQLite here is `bun:sqlite` (built-in).
- **CLI** (`src/cli.ts`) and smoke tests run under **Node 22+** with `--experimental-strip-types`. SQLite here is `better-sqlite3` (native module).
- **MCP server** (`src/mcp.ts`, stdio) runs under **Node 22+** with `--experimental-strip-types`. It exposes the same ten memory tools to any MCP client (VS Code Copilot, Cursor, Claude Code). **stdout is the protocol channel — never log to stdout in `mcp.ts`; diagnostics go to stderr.**

`src/store/db.ts` picks the backend at runtime by sniffing `globalThis.Bun`. Both backends share the same surface (`new Database(path)`, `.exec`, `.prepare().run/all/get`, `.close`). Any DB code you write must stay on that common subset — do not import `better-sqlite3` or `bun:sqlite` directly outside `db.ts`.

Tool logic is host-agnostic and lives in `src/tools/ops.ts` (plain functions + shared zod arg shapes + `TOOL_DESCRIPTIONS`). `src/tools/memory.ts` (opencode) and `src/mcp.ts` are thin adapters — when adding or changing a tool, change `ops.ts` once and both hosts pick it up.

Consequences:
- Imports **must** use explicit `.ts` extensions (`allowImportingTsExtensions: true`, `moduleResolution: "Bundler"`).
- No transpile / bundle output. Do not add one; opencode loads the `.ts` file directly.
- Adding a native dep means it must work under both Bun's N-API compat and Node.

## Commands

```
npm install                                          # once
npm run typecheck                                    # tsc --noEmit — the only lint/type gate
npm run cli -- where | list | search "q" | add ... | forget <id> | reindex
npm run cli -- sync-status                                  # last sync time/kind + outbox drafts + repo review states + uncommitted files
npm run cli -- submit <id...> [--onto <branch>] [--base <branch>]  # drafts → .ai/open-memex/ (local branch+commit)
npm run cli -- propose <id...> --to project [--local-approve]  # copy personal → project outbox (batch OK)
npm run cli -- promote <id> [--reject] [--resubmit] [--note "..."]        # proposed → approved → published (audit trail appended)
npm run cli -- pr-status [--apply]                          # map branch PR's GitHub state onto review_state (report; apply = local only)
npm run cli -- resolve [id-or-path]                          # list / 3-way-merge conflicted memories
npm run mcp                                          # start the stdio MCP server
node --experimental-strip-types scripts\smoke-pure.ts   # runs pure-logic checks (no sqlite)
node --experimental-strip-types scripts\smoke-mcp.ts    # MCP handshake + tool round-trip (temp dirs, no real data)
```

After `npm i -g open-memex` (or `npm link` from source), the `open-memex` bin is on
PATH: `open-memex mcp` starts the MCP server, `open-memex mcp --print-config <client>`
prints a client config snippet (client: vscode|cursor|claude|opencode|visualstudio),
`open-memex init [--client vscode|cursor|opencode|visualstudio] [--instructions personal|project] [--force] [--yes]`
one-command project setup (editor MCP config + Copilot memory instructions;
instructions default to user-level ~/.copilot/copilot-instructions.md so the repo
stays clean for teammates without open-memex — D22; resolves the server command
at init time — npx fallback when no durable bin is on PATH, D17),
`open-memex config` prints the effective config, `open-memex capture --dry-run "text"`
previews keyword capture without writing, `open-memex doctor` runs health checks
(node version, config, scope resolution, storage writability, MCP handshake).
`open-memex init` asks editor + two settings on a TTY (`--yes` skips, scripts never
prompt); `open-memex config set <key> <value>` edits settings after install.
The published `open-memex` bin points at `dist/cli.js` (compiled at publish time).
From a source checkout, `npm run cli` / `npm run mcp` still run `src/` directly
with type-stripping — no build step needed for development.

There is **no `npm test`** and no CI. Verification loop is: `npm run typecheck` + `smoke-pure.ts` + (if touching sqlite) `npm run cli -- reindex` against a scratch `MY_O_MEMORY_HOME`.

To load the plugin in opencode locally, `~/.config/opencode/opencode.jsonc` must have:
```
"plugin": ["file:///c:/github/open-memex/src/index.ts"]
```
Restart opencode after any change — the plugin is not hot-reloaded.

## Data lives outside the repo

Storage root:
- Windows: `%APPDATA%\open-memex\`
- Linux/macOS: `$XDG_DATA_HOME/open-memex/` (fallback `~/.local/share/open-memex/`)
- Override with `MY_O_MEMORY_HOME` (use this for tests to avoid clobbering real data).

Layout: `memories/<scope_key>/<id>.md` (YAML frontmatter + body) + `index.db` (SQLite FTS5).

**Markdown files are the source of truth; `index.db` is rebuildable.** `syncScope()` (in `src/store/sync.ts`) reconciles the two by mtime on plugin load and before every CLI read. When adding new frontmatter fields, update `Frontmatter` in `src/store/markdown.ts`, the `memories` table in `src/store/db.ts`, and `upsertFromFile` in `src/store/sync.ts` together, and bump the reindex path.

## Scope keys

- `personal` scope key is literal `"personal"` (v1 called this `user`; renamed in v2, design §19).
- `project` scope key: `project__<sanitized-name>__<12-hex-sha256>`, seeded from normalized git origin URL, else lowercased cwd. See `src/scope.ts`. Same repo across machines → same key (intentional; enables future git-commit of memories).
- `org`, `team`, `public` are reserved — the schema rejects writes. See `docs/SCOPES.md`.
- The scope key **changes** when a repo gains/loses a git origin. `src/index.ts` logs a one-shot warning on load if it finds files under the legacy cwd-only key (`resolveCwdScope`). Use `cli scopes` to enumerate all scope dirs and `cli migrate --from <old>` to reconcile — see `src/store/migrate.ts`. No auto-migration; two unrelated repos at the same cwd would silently merge.
- Read-only callers must use `memoriesDirPath` (in `src/paths.ts`), never `memoriesDirFor`. The latter `mkdir -p`s the directory as a side effect and will pollute storage with empty scope dirs.

## Capture / write path invariants

Every write path (tool, keyword hook, CLI `add`) must:
1. Call `redact(content, cfg.redactPatterns)`. Built-in provider patterns live in `src/redact.ts` (always on); config `redactPatterns` is for user extras only.
2. If `hadSecret` → the matched secret is **masked in place** (first 4 characters kept, the rest replaced with `x`) and the write proceeds; never save the unmasked original. `<private>…</private>` spans are stripped to `[REDACTED]` instead (design D14).
3. Check `findDuplicates` (design §3.4): identical content is idempotent (return existing id); near-duplicates (similarity ≥ 0.8) warn but save — suggest `supersede` when the new content replaces the old.
4. `writeMemoryFile` first, then `readMemoryFile` + `upsertFromFile` to keep FTS in sync.

## Lifecycle invariants (design §3.3)

- Statuses: `active → superseded | deprecated | retracted | archived`. Retrieval excludes `retracted`/`archived`, ranks `active` above `deprecated`.
- Never hand-write `status: superseded` or half a chain. Use the `supersede` code path (`src/store/lifecycle.ts`): the old record keeps its file, flips to `superseded`, and both sides get `supersedes`/`superseded_by`. Only `active` memories can be superseded.
- Chain integrity is self-healing: on read, a missing counterpart is auto-completed with a warning; a dangling pointer warns but is never fabricated. Don't "fix" chains by editing frontmatter directly — let the read path do it.
- Frontmatter is `schema_version: 2`. The SQLite index schema is versioned separately and rebuilds automatically on version change — never hand-edit `index.db`.

Keyword capture fires from `chat.message` on the user's message parts (`UserMessage`). Patterns live in `src/capture/keywords.ts` / config `keywordPatterns`; regex group 1 is the memory body. Scope routing: personal patterns (`cfg.keywordPersonalPatterns`) force the personal scope — the rule is 我 → personal (记住我/替我记/我觉得/我喜欢/remember for me), 我们 → current scope (我们认为/我们决定/帮我们记住); personal patterns run first and claim their line so a generic trigger can't double-fire.

Context injection happens exactly once per session in `experimental.chat.system.transform`, guarded by an in-memory `Set<sessionID>` in `src/index.ts`. It is not persisted — restarting opencode re-injects on the next first turn.

## Design constraints — read the frozen design first

`docs/V2-DESIGN.md` is the frozen protocol v0.2 (zero open questions). Per its §12:
AGENTS.md answers "how should AI work here"; the design doc answers "why is it
built this way" (principles, iron rules, D1–D13 decision log). Before changing
architecture, scope semantics, lifecycle, or the protocol surface (frontmatter
schema, MCP tools, CLI contract), read the relevant design section — the decision
log records what was already considered and rejected.

Still hard: no cloud, no silent sync (explicit pull only), Markdown is the source
of truth, `personal` scope never leaves the machine. Embeddings are an *optional
capability* per the design — do not add them (or LLM-driven extraction, or a
knowledge graph) without updating the design doc first. `docs/V2-DESIGN.md` §18 tracks the
build roadmap; the design doc tracks the *why*.

## Branch workflow

`main` (stable, mirrors npm) ← `V2` (v2 integration) ← `V2-dev-p<n>`
(phase work; draft PRs into `V2`). Never create `V2/<anything>` — git can't
hold `V2` and `V2/…` simultaneously. Full rules: `CONTRIBUTING.md`.

## Style notes

- `strict: true`, `verbatimModuleSyntax: false`. Prefer `import type` for types anyway.
- Log prefix is `[open-memex]`. Gate verbose logs behind `cfg.logLevel === "debug"`.
- Windows is a first-class target (this workspace is Windows). Use `node:path` and never hardcode `/`.
- **Docs ship with code.** Every code change updates the docs it affects in the same commit:
  new/changed tools → `README.md` + `README.zh-CN.md` tool tables + MCP section (keep both
  languages in sync); behavior changes → both READMEs
  and the frozen `docs/V2-DESIGN.md` (append a `D<n>` decision entry, never rewrite history);
  new commands → README CLI sections + this file's Commands. A change without its docs
  is not done.
