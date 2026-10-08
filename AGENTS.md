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
- **MCP server** (`src/mcp.ts`, stdio) runs under **Node 22+** with `--experimental-strip-types`. It exposes the same eleven memory tools to any MCP client (VS Code Copilot, Cursor, Claude Code). **stdout is the protocol channel — never log to stdout in `mcp.ts`; diagnostics go to stderr.**

`src/store/db.ts` picks the backend at runtime by sniffing `globalThis.Bun`. Both backends share the same surface (`new Database(path)`, `.exec`, `.prepare().run/all/get`, `.close`). Any DB code you write must stay on that common subset — do not import `better-sqlite3` or `bun:sqlite` directly outside `db.ts`. The Node driver is pinned to the `better-sqlite3` 13 N-API line (D72): the pre-13 `node::ObjectWrap` build aborts intermittently on Node 24.19+ when a prepared statement is finalized by GC.

D74 — the Node floor is **22.14**, not 22.6. `better-sqlite3` 13 is compiled against Node-API 10, which Node gained in 22.14.0; below that floor `require()` succeeds and `new Database()` segfaults the process with no diagnostic (measured: Node 22.12.0 dies with `0xC0000005` on win32-x64, Node 22.23.3 / 24.20.0 are fine; upstream WiseLibs/better-sqlite3#1514). The gate lives in `src/runtime-floor.ts` (pure, unit-tested) and is enforced in `loadDatabase` (`src/store/db.ts`) so every entry point fails with an actionable message instead of a silent crash; `doctor` reports the floor plus a live driver probe run in a child process (a segfault cannot be caught in-process, so the probe must be spawned, and it must resolve the driver from this package's directory, not the caller's cwd). `engines.node` is `>=22.14.0`. Never lower it back to the `--experimental-strip-types` floor of 22.6 — that number is a different constraint and predates the driver bump.

Tool logic is host-agnostic and lives in `src/tools/ops.ts` (plain functions + shared zod arg shapes + `TOOL_DESCRIPTIONS`). `src/tools/memory.ts` (opencode) and `src/mcp.ts` are thin adapters — when adding or changing a tool, change `ops.ts` once and both hosts pick it up.

**Plugin code must not runtime-import a host SDK package** (D58, extended by D60): `@opencode-ai/plugin` (v1) and `@opencode/plugin` (v2) are devDependencies, and neither host resolves them for plugins loaded from a global npm install — the import fails and the host silently skips the plugin (no error, no tools). Type-only imports are fine. `src/tools/memory.ts` carries a local stand-in for the v1 SDK's `tool()` (a runtime identity), and `src/opencode-v2.ts` duck-types the v2 context, for exactly this reason. The plugin entry is a dual export (`{ id, setup, server }`, D60): v1 ≥1.18.29 calls `server`, opencode 2 calls `setup`; both adapt `src/plugin-core.ts`.

Consequences:
- Imports **must** use explicit `.ts` extensions (`allowImportingTsExtensions: true`, `moduleResolution: "Bundler"`).
- No transpile / bundle output. Do not add one; opencode loads the `.ts` file directly.
- Adding a native dep means it must work under both Bun's N-API compat and Node.

## Commands

```
npm install                                          # once
npm run typecheck                                    # tsc --noEmit — the only lint/type gate
npm run cli -- where | list | search "q" | add ... | forget <id> | reindex
npm run cli -- <command> --help                          # per-command help (AI assistants discover flags this way)
npm run cli -- sync-status                                  # last sync time/kind + outbox drafts + repo review states + uncommitted files
npm run cli -- inventory [--format text|json|html] [--scope both]  # what is remembered, in the open (D68); personal-bearing output refused inside a git worktree without --allow-personal
npm run cli -- audit [--scope project|personal|both]            # memory health: near-dup pairs, stale actives, broken chains, personal-in-repo (read-only)
npm run cli -- pull                                          # fetch + fast-forward only (explicit; diverged = clean failure, never force-merge)
npm run cli -- push                                          # push current branch to remote (explicit only; open-memex never auto-pushes)
npm run cli -- export [--scope project|personal|both] [--all] [-o <file>]  # portable .tar.gz bundle (markdown + manifest); private excluded unless --all
npm run cli -- import <bundle.tar.gz> [--dry-run]               # restore: personal → personal dir, project → outbox re-keyed; conflicts reported, never overwritten
npm run cli -- distill-agents [--type t1,t2] [-o <file>]         # propose an AGENTS.md snippet from project memories (assist only; you merge by hand)
npm run cli -- submit <id...> [--branch <name>] [--base <branch>]  # drafts → .ai/open-memex/ (current branch + local commit; never auto-branches)
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
`open-memex init [--client vscode|cursor|opencode|visualstudio] [--instructions personal|project] [--global] [--force] [--yes]`
one-command project setup (editor MCP config + Copilot memory instructions;
no --client → auto-detects installed editors and wires them all, user-level
where supported — init once, every editor, every project (D46);
instructions default to user-level ~/.copilot/copilot-instructions.md so the repo
stays clean for teammates without open-memex — D22; `--global` writes the MCP
server entry to the editor's user-level config instead (VS Code / Cursor; D45)
or the opencode native plugin entry into ~/.config/opencode/opencode.json (D46);
resolves the server command
at init time — npx fallback when no durable bin is on PATH, D17),
`open-memex config` prints the effective config, `open-memex capture --dry-run "text"`
previews keyword capture without writing, `open-memex doctor` runs health checks
(node version, config, scope resolution, storage writability, SQLite locking,
opencode plugin entries for both host generations (target exists + no
host-SDK runtime imports, D59/D60),
VS Code MCP enablement, MCP handshake).
`open-memex init` with no --client auto-detects and wires every installed editor
(`--yes` skips, scripts never prompt); `open-memex config set <key> <value>` edits settings after install.
`npm install -g` prints a pointer to `open-memex init` via a postinstall script
(print-only — postinstall must never prompt, it runs in CI/Docker; D50).
Note: npm swallows lifecycle-script stdout (background run unless
`--foreground-scripts`), so the postinstall pointer is best-effort only —
every CLI entry point also prints a one-line stderr nudge until init has run
or been declined (F28; stderr keeps the MCP stdio protocol intact).
Bare `open-memex` on a machine where init never completed offers to run it on a
TTY (usage as before when non-interactive); init/uninstall maintain a
`.init.json` first-run marker at the data root so the offer is asked once (D50);
init ends with a one-line next-step hint (`open-memex add` + ask the agent to
recall it) so a first-time user sees what "it works" looks like (D51).
init also installs the bundled `open-memex` Agent Skill (skills/open-memex/SKILL.md,
teaches skill-aware agents the CLI: save/search/scope rules/outbox flow) into each
wired editor's user-level skills dir — ~/.copilot/skills/ (VS Code),
~/.cursor/skills/ (Cursor), ~/.config/opencode/skills/ (opencode, per-project MCP
mode only — with the native plugin the skill is skipped and any previously installed
one is removed, D55); Visual Studio
has no skills concept and is skipped. Copy, not symlink (Windows needs no
Developer Mode); existing skill kept unless --force (D54).
`open-memex uninstall [--client vscode|cursor|opencode|visualstudio] [--global] [--yes]`
reverses init — removes the MCP server entry / opencode plugin line / Copilot
instructions section / Agent Skill directory; memory data never touched (D48); no --client → auto-detect
with an interactive confirm, explicit --client never prompts; `--yes` only skips
that confirm; `--global` limits cleanup to user-level. Empty/whitespace-only
config files parse as `{}` and are safely populated (D49); non-JSON (JSONC)
files are left untouched with a printed manual snippet (D47). init/uninstall also sweep
pre-rename `my-o-memory` plugin entries and MCP server keys wherever they touch a
config, and `open-memex doctor` reports any remaining pre-rename leftovers (F30).
The published `open-memex` bin points at `dist/cli.js` (compiled at publish time).
From a source checkout, `npm run cli` / `npm run mcp` still run `src/` directly
with type-stripping — no build step needed for development.

There is **no `npm test`** and no CI. Verification loop is: `npm run typecheck` + `smoke-pure.ts` + (if touching sqlite) `npm run cli -- reindex` against a scratch `OPEN_MEMEX_HOME`.

To load the plugin in opencode locally, `~/.config/opencode/opencode.jsonc` must have:
```
"plugin": ["file:///c:/github/open-memex/src/index.ts"]
```
Restart opencode after any change — the plugin is not hot-reloaded.

## Data lives outside the repo

Storage root:
- Windows: `%APPDATA%\open-memex\`
- Linux/macOS: `$XDG_DATA_HOME/open-memex/` (fallback `~/.local/share/open-memex/`)
- Override with `OPEN_MEMEX_HOME` (use this for tests to avoid clobbering real data). The pre-rename `MY_O_MEMORY_HOME` is still honored as a fallback (D62).

Layout: `memories/<scope_key>/<id>.md` (YAML frontmatter + body) + `index.db` (SQLite FTS5).

**Markdown files are the source of truth; `index.db` is rebuildable.** `syncScope()` (in `src/store/sync.ts`) reconciles the two by mtime on plugin load and before every CLI read. When adding new frontmatter fields, update `Frontmatter` in `src/store/markdown.ts`, the `memories` table in `src/store/db.ts`, and `upsertFromFile` in `src/store/sync.ts` together, and bump the reindex path.

## Scope keys

- `personal` scope key is literal `"personal"` (v1 called this `user`; renamed in v2, design §19).
- `project` scope key: `project__<sanitized-name>__<12-hex-sha256>`, seeded from normalized git origin URL, else lowercased cwd. See `src/scope.ts`. Same repo across machines → same key (intentional; enables future git-commit of memories).
- The root a host adapter seeds on matters: OpenCode v1 reports the **filesystem root** as `worktree` for non-git folders, so the v1 adapter goes through `pickScopeRoot` (src/scope.ts) — `worktree` only when it is a real directory below the filesystem root, else the opened `directory` (D71). Seeding on a filesystem root merges every non-git folder on a drive into one `project__workspace__…` bucket.
- `org`, `team`, `public` are reserved — the schema rejects writes. See `docs/SCOPES.md`.
- The scope key **changes** when a repo gains/loses a git origin. `src/index.ts` logs a one-shot warning on load if it finds files under the legacy cwd-only key (`resolveCwdScope`). Use `cli scopes` to enumerate all scope dirs and `cli migrate --from <old>` to reconcile — see `src/store/migrate.ts`. No auto-migration; two unrelated repos at the same cwd would silently merge.
- Read-only callers must use `memoriesDirPath` (in `src/paths.ts`), never `memoriesDirFor`. The latter `mkdir -p`s the directory as a side effect and will pollute storage with empty scope dirs.

## Capture / write path invariants

Every write path (tool, keyword hook, CLI `add`) must:
1. Call `redact(content, cfg.redactPatterns)`. Built-in provider patterns live in `src/redact.ts` (always on); config `redactPatterns` is for user extras only.
2. If `hadSecret` → the matched secret is **masked in place** (first 4 characters kept, the rest replaced with `x`) and the write proceeds; never save the unmasked original. `<private>…</private>` spans are stripped to `[REDACTED]` instead (design D14).
3. Check `findDuplicates` (design §3.4): identical content is idempotent (return existing id); near-duplicates (similarity ≥ 0.8) warn but save — suggest `supersede` when the new content replaces the old.
4. `writeMemoryFile` first, then `readMemoryFile` + `upsertFromFile` to keep FTS in sync.
5. Deletion reports honestly (D63): only ENOENT counts as "deleted"; any other unlink failure keeps the index row and returns failure — the file is the source of truth and would otherwise resurrect the memory on next sync.

Capture-time aliases (D61): `memory_add`/`supersede` may carry up to 4
`aliases` (alternate phrasings) into frontmatter; they index in their own FTS
column. Always on since 2026-10-07 (Stone: init no longer asks) —
`cfg.captureAliases` still gates them for backward compatibility with
installs that set it manually, but new installs never see the question. Always pass them through
`normalizeAliases`; the keyword-capture path (no agent in the loop) never
invents aliases. Checkpoint-proposal guidance (propose, never auto-draft) is
copy, not mechanism: keep the rubric wording in sync across the skill, the
AGENTS.md hygiene footer, the MCP handshake, and the tool descriptions.

## Lifecycle invariants (design §3.3)

- Statuses: `active → superseded | deprecated | retracted | archived`. Retrieval excludes `retracted`/`archived`, ranks `active` above `deprecated`.
- Never hand-write `status: superseded` or half a chain. Use the `supersede` code path (`src/store/lifecycle.ts`): the old record keeps its file, flips to `superseded`, and both sides get `supersedes`/`superseded_by`. Only `active` memories can be superseded.
- Superseding a memory that had entered review (proposed/approved/published/rejected) starts the replacement at `review_state: proposed` so `promote` can advance it (D64). Never reset it to `draft` — a draft in the repo dir is stranded (submit only moves outbox files).
- `setStatus` refuses `retracted → active` (D64): retracted content must not silently return to recall. Save a new memory instead.
- **Visibility surfaces share one contract (D70).** `memory_list`, `cli list` and `inventory` render the same `formatInventoryLine`; numbering is a running counter across every section of one listing (never per scope), and a cut list discloses how many entries it dropped. Any *correction* that touches an in-repo memory (`memory_forget`, `soft=true`, `forget --soft`) must say the change is local until committed and pushed — use `isInRepoMemoryFile` (`src/paths.ts`). Report output paths go through `inventoryWriteRefusal` (`src/cli.ts`), which fails closed on an unresolvable directory.
- **Every memory-file write goes through `atomicWriteTextSync`** (markdown.ts; tmp + rename). The create path, supersede flips, review transitions, submit landings, migrate/v2migrate rewrites — no direct `fs.writeFileSync` on a memory file. A torn read mid-rewrite parses as a deletion and drops the memory from the index.
- Chain integrity is self-healing: on read, a missing counterpart is auto-completed with a warning; a dangling pointer warns but is never fabricated. Don't "fix" chains by editing frontmatter directly — let the read path do it.
- Frontmatter is `schema_version: 2`. The SQLite index schema is versioned separately and rebuilds automatically on version change — never hand-edit `index.db`.

Keyword capture fires from `chat.message` on the user's message parts (`UserMessage`). Patterns live in `src/capture/keywords.ts` / config `keywordPatterns`; regex group 1 is the memory body. Scope routing: personal patterns (`cfg.keywordPersonalPatterns`) force the personal scope — the rule is 我 → personal (记住我/替我记/帮我记/我觉得/我喜欢/remember for me/help me remember), 我们 → current scope (我们认为/我们决定/帮我们记住); personal patterns run first and claim their line so a generic trigger can't double-fire (a rejected personal match keeps the claim — see D67).

D73 — one user statement, one memory. The hook and the agent are two writers for one turn, and only the hook knows the sentence is stored. Both hooks therefore take the session id (`chat.message` on v1, `prompt` on v2), `captureFromText` records each capture in `PluginState.captures`, and the system/context hook pushes the hand-off note (`captureHandoff` → `formatHandoffBlock`, `src/capture/handoff.ts`) once per capture. `memory_add` additionally refuses a write overlapping a `source: keyword`/`user` memory created in the same scope within `TURN_ECHO_WINDOW_MS` (`findTurnEcho`, threshold `TURN_ECHO_THRESHOLD` = 0.28) and returns the stored id plus the supersede route. Keep the note, the refusal text, `TOOL_DESCRIPTIONS.memory_add`, the skill, and this paragraph saying the same thing — an agent that reads only one of them still has to behave. Never lower `TURN_ECHO_THRESHOLD` to catch more: the measured reason it is high is that an agent's gloss (0.211) and a genuinely new fact from the same sentence (0.214) are lexically indistinguishable.

D67 rules for any new pattern: a trigger must be a **statement to the store**, not narration — 记得… / `remind me to…` are deliberately out, and the ambiguous forms require an explicit marker (`别忘了：…`, `don't forget: …`, `don't forget that …`). The 帮/替/我们 family takes the full verb phrase (`记` + optional `住|录`, never followed by a verb continuation) + optional `一下`; the separator boundary applies to the **bare** verb only, so `帮我记一下这个配置` captures while `帮我记得带伞` cannot produce mid-word garbage. Bodies under `MIN_CAPTURE_CHARS` (3) are rejected as fragments — never lower the floor silently; `scanKeywords` returns the drop so `capture --dry-run` and the debug log can report it.

Context injection happens exactly once per session in `experimental.chat.system.transform`, guarded by an in-memory `Set<sessionID>` in `src/index.ts`. It is not persisted — restarting opencode re-injects on the next first turn.

## Design constraints — read the frozen design first

`docs/V2-DESIGN.md` is the frozen protocol v0.2 (decisions settled through D74; open questions tracked at the end of the doc). Per its §12:
AGENTS.md answers "how should AI work here"; the design doc answers "why is it
built this way" (principles, iron rules, the append-only decision log, currently D1–D74). Before changing
architecture, scope semantics, lifecycle, or the protocol surface (frontmatter
schema, MCP tools, CLI contract), read the relevant design section — the decision
log records what was already considered and rejected.

Still hard: no cloud, no silent sync (explicit pull only), Markdown is the source
of truth, `personal` scope never leaves the machine. Embeddings are an *optional
capability* per the design — do not add them (or LLM-driven extraction, or a
knowledge graph) without updating the design doc first. `docs/V2-DESIGN.md` §18 tracks the
build roadmap; the design doc tracks the *why*.

## Branch workflow

`dev/<topic>` → PR → `main` (alpha versions published with
`npm publish --tag alpha`, npm `latest` moves only on stable releases).
The `V2` integration branch was retired 2026-09-29 — its job (isolating the
breaking v1→v2 transition) shipped with 0.3.0. Full rules: `CONTRIBUTING.md`.

## Style notes

- `strict: true`, `verbatimModuleSyntax: false`. Prefer `import type` for types anyway.
- Log prefix is `[open-memex]`. Gate verbose logs behind `cfg.logLevel === "debug"`.
- Windows is a first-class target (this workspace is Windows). Use `node:path` and never hardcode `/`.
- **Docs ship with code.** Every code change updates the docs it affects in the same commit:
  new/changed tools → `README.md` + `README.zh-CN.md` tool tables + MCP section (keep both
  languages in sync); behavior changes → both READMEs
  and the frozen `docs/V2-DESIGN.md` (append a `D<n>` decision entry, never rewrite history);
  new commands → README CLI sections + this file's Commands. A change without its docs
  is not done. Anything deferred as "later" goes into the near-term backlog in
  `docs/V2-DESIGN.md` §18 the same day — unwritten later means never.
- **Measurement before mechanism.** A retrieval change lands its fixture +
  baseline number in a commit with no retrieval change at all, so the delta is
  unambiguous. `scripts/retrieval-eval.ts` is the gate: no retrieval PR merges
  without before/after recall@k + MRR on the checked-in fixture.
- **Version bumps ship with features.** `package.json` + `package-lock.json` carry the
  in-development version. A new alpha line starts with a minor bump after the
  previous minor shipped (`0.3.0` → `0.4.0-alpha.1`); while that minor is still
  unreleased, further features AND fixes on the same line only bump the alpha
  suffix (`0.8.0-alpha.2` → `-alpha.3`) — never jump to the next minor before
  the current one is released.
  The bump goes in the same commit as the feature, never as an afterthought.
  The version number serves the publish: no publish, no mandatory bump. But once a
  version has been pushed to the remote (shared), later changes must bump — two
  different code states must never share one version number.
