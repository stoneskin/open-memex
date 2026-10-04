# Changelog

All notable changes to open-memex are recorded here. Entries are grouped by
the design decision (D<n>) that drove them, matching the
[GitHub Releases](https://github.com/stoneskin/open-memex/releases); the
rationale behind each decision lives in the decision log in
[docs/V2-DESIGN.md](docs/V2-DESIGN.md). Pre-release builds published under
the `@alpha` tag are development snapshots and are not listed individually.

## [Unreleased]

## Review follow-ups (D66)

Fixes from the follow-up review of the D63–D65 stack:

- Keyword patterns: `请帮我记住…` works (the D65 pattern had missed its `请` prefix), `帮我记录一下：…` / `替我记录一下：…` capture cleanly instead of saving mid-word garbage, `帮我记得…` no longer fires, and `help me remember: …` routes personal like `remember for me`.
- `open-memex sync-status` (the CLI) shows the full list again — the 20-per-section cap now applies only to agent tool results, whose "… and N more" line points at the CLI. `open-memex list --scope both` matches the `memory_list` tool.
- `open-memex status --help` documents that retraction is one-way.
- The full test suite is Windows-safe now (file:// probe imports, USERPROFILE-aware uninstall test) and refuses to run against a stale `dist/` build.

## Keyword capture gaps (D65)

The most natural phrasings were the ones that fell through:

- `帮我记住…` / `帮我记一下…` now capture (personal scope, same 我-rule as 替我记； `帮我们记住…` still routes project).
- A leading `请` no longer defeats capture: `请记住我…`, `请记住（个人）…`, and `请记住：…` all work.
- English `remember to …` no longer leaves a stray "to" at the front of the captured body.

Patterns are code defaults, so these apply automatically on upgrade — unless you hand-customized `keywordPatterns` / `keywordPersonalPatterns` in your config, in which case your lists win and you can port the additions by hand.

## P1 fixes: stale answers and stranded files (D64)

Second batch from the whole-project review — the index, the files, and the guidance can no longer quietly disagree:

- The opencode plugin now re-syncs the index before every tool call (previously only at startup): memories added via the CLI or another client are visible right away instead of after a restart.
- Superseding a published memory re-enters review as `proposed` instead of a stranded `draft` no command could advance; `promote` can move it forward again.
- All memory-file rewrites are atomic (tmp + rename), not just creates.
- A retracted memory can't be flipped back to `active` via status changes — save a new memory if the content is valid again.
- Proposed copies of personal memories are `visibility: internal` (was: `private`, which export silently excluded from team bundles).
- `uninstall` finds the real global opencode config (`.jsonc` included), and `doctor` checks all eleven MCP tools plus stranded v1 (`user`-scope) memories.
- `memory_status` output is capped per section; `memory_list` accepts `scope: both`; `forget` notes when the deleted file was in the repo; `where` prints the config path.

## Correctness fixes from the whole-project review (D63)

Six silent-wrong-answer bugs found by an external three-lens review, each fixed with a regression test:

- `init --client visualstudio` no longer wipes other servers from an existing `.mcp.json` (the parsed config was dropped instead of merged).
- `memory_forget` / `forget` tell the truth: when the memory file can't be deleted (locked, in use), they report failure and keep the index entry, instead of claiming success while the file — the source of truth — brings the memory back on next sync.
- Config parsing is string-aware: a redact pattern like `src/**/secrets` is no longer eaten as a block comment and silently disabled. `doctor` and the config loader now share one parser.
- `loadConfig` enforces the `memoryDir` invariant on hand-edited configs; an escaping value (`../../shared`) falls back to the default with a warning instead of writing project memories outside the repo.
- `migrate` re-scopes as well as re-keys: migrated files get the destination's `scope`/`visibility`, so personal→project migrations are submittable and project→personal memories stay private in exports. Conflict resolution compares parsed timestamps, not RFC-3339 strings.
- `import` rejects bundle entries whose paths escape the bundle (`../` or symlinks) instead of reading arbitrary local files into the store; rejected paths are printed.

## Environment variable names (D62)

- The override variables now answer to `OPEN_MEMEX_HOME` (storage root) and `OPEN_MEMEX_CONFIG` (config path). The pre-rename `MY_O_MEMORY_HOME` / `MY_O_MEMORY_CONFIG` names keep working as fallbacks — nothing to migrate, the data root itself does not move. `doctor` notes when the storage root came from the legacy variable.

## Proactive capture: checkpoint proposals and aliases (D61)

- At task checkpoints the agent now proposes instead of waiting to be asked: when a task wraps up, it offers 1–3 short candidate memories distilled from the session (decisions and their reasons, conventions, gotchas, approaches tried and abandoned) and saves only the ones you approve — approved inferences are marked `source: "inference"`. One memorability rubric and one search discipline (break the question into concepts, try several phrasings, check both scopes) are written into every guidance surface — the bundled skill, the AGENTS.md memory-hygiene footer, the MCP handshake, and the tool descriptions — so behavior is consistent across editors. Nothing is auto-drafted in the background; that posture waits on memory visibility.
- Memories can carry up to 4 **aliases** — alternate phrasings, synonyms, other-language equivalents — stored in the memory file and indexed with it, so a differently-worded question still matches ("vacation days" finds the holiday policy; "节假日" too). `init` asks once (default on); `open-memex config set captureAliases false` turns it off. Existing memory files are untouched — the index rebuilds itself on first use.

## One plugin, both opencode generations (D60)

- The native plugin now loads on **opencode 2** as well as opencode 1. `open-memex init --client opencode --global` writes both config spellings — the v1 `"plugin"` file entry and the v2 `"plugins"` directory entry — and each host reads its own. Previously an opencode 2 host silently skipped the plugin (a file entry is not a directory it can load), leaving no tools and no explanation.
- Tools register with code mode off (`options.codemode: false`): on opencode 2 an unflagged plugin tool is only reachable through a JS `execute` meta-tool, and models that call it by name get "Unknown tool" — with the opt-out, the five tools are ordinary function calls on both generations.
- On the opencode 1 side this raises the minimum host version to **1.18.29**: the dual entrypoint is a plain exported object, and older v1 hosts only invoke function exports.
- `open-memex doctor` extends the plugin patrol to both config keys: v2 entries are checked for a resolvable entry file and the same no-host-SDK-runtime-import rule, and when the installed opencode major version disagrees with what the config wires, doctor fails and names the fix.

## [0.6.2] - 2026-10-03

## Doctor patrols the plugin entry (D59)

- `open-memex doctor` gains an `opencode plugin` check: it reads the user-level opencode configs, attributes the open-memex plugin entry, and fails when the target file no longer exists (naming the `open-memex init --client opencode --global --force` re-point command) or when the plugin's import closure runtime-imports the host SDK. That second failure is exactly what silently killed the plugin in D58 — it now shows up in a check instead of surfacing as missing tools.

## Notes

- 0.6.1 contained D56–D58 but was published before this check landed; 0.6.2 is the recommended upgrade for everyone on the 0.6.x line.

## [0.6.1] - 2026-10-03

## Question-shaped search, host parity said out loud (D56)

- Search no longer feeds whole questions straight into full-text: query construction filters English/CJK function words, dedupes terms, and caps them — asking "how do we configure…" or "中文记忆怎么检索" now ranks the right memory first instead of matching everything
- The six MCP-only tools now say so in their own descriptions and name the CLI equivalent, so opencode plugin users see the asymmetry is by design instead of assuming breakage
- `init`'s closing lines state the privacy model in plain words: memories live only on this machine, personal ones never leave it, nothing is uploaded

## Search explainability and memory audit (D57)

- `open-memex search "deploy" --explain` shows the constructed FTS expression, per-hit scores, and how many matches lifecycle hid (superseded vs retracted/archived) — a miss is now diagnosable
- New `open-memex audit` (read-only; `doctor` checks the environment, this checks the memories): near-duplicate active pairs, memories untouched for 90+ days, broken supersede chains, personal files found inside the repo memory dir, index/file drift
- Concurrency posture measured and hardened: WAL everywhere, `busy_timeout` unified at 5s across backends (the opencode plugin's bun:sqlite defaulted to 0 — any overlapping write failed instantly), memory files written via tmp+rename, lock timeouts reported in one plain line, `doctor` reports the live locking settings

## Critical fix: opencode plugin silently dead on global installs (D58)

- After a global `npm i -g open-memex`, the opencode plugin was configured but silently inactive — no memory tools, no error, nothing in the log. Root cause: the plugin runtime-imported the host SDK (`@opencode-ai/plugin` is a devDependency; nothing resolves it from a global install, and opencode skips the plugin without a trace). The import is gone — the SDK helper is a runtime identity, now a local stand-in. **If your opencode shows no memory tools, update to 0.6.1.**

## [0.6.0] - 2026-10-02

## First-run onboarding (D50, D51, F28)

- `open-memex init` is now a guided first run: the postinstall note points at init, every CLI entry prints a one-line stderr nudge until init has run or been declined (stderr keeps the MCP stdio protocol intact), and init ends with a next-step hint (`open-memex add` + ask the agent what it remembers)
- Bare `open-memex` on a machine where init never completed offers to run it on a TTY; init/uninstall maintain a `.init.json` first-run marker so the offer is asked once

## Agent prompt clarity (D52)

- MCP tool descriptions rewritten for clarity

## Push-not-poll outbox (D53)

- New project memories land in a local outbox (invisible to git); `open-memex sync-status` shows drafts waiting and `open-memex submit` publishes them — the agent checks on demand instead of polling

## Agent Skills (D54, D55)

- New bundled `open-memex` skill (`skills/open-memex/SKILL.md`): teaches skill-aware agents the CLI (save/search/scope rules/outbox flow), preferring MCP tools when available; `init` installs it per editor, `uninstall` removes it
- opencode with the native plugin wired no longer gets the skill — the plugin already provides memory tools, and the duplicated guidance made the agent chatty

## Rename leftovers swept (F30)

- The my-o-memory → open-memex rename left editor configs loading the OLD plugin/server, silently splitting memories across two data dirs; `init`/`uninstall` now drop stale `my-o-memory` entries wherever they touch a config, and `doctor` reports leftovers via a read-only `legacy my-o-memory` check

## Fixes (F29)

- Copilot review fixes, package-lock.json repair, Visual Studio onboarding strings

## [0.5.1] - 2026-10-01

## Docs review (F1–F27)

- Full documentation pass: stale versions corrected (README now shows 0.5.0), roadmap extended with 0.5.0 (D45–D49), branch rules updated after the V2 branch retirement, MCP server tool count fixed to 11, USER-GUIDE cleaned of V2-dev leftovers

## `mcp --help` accuracy (F27)

- `--help` now states the MCP server exposes 11 tools (a superset of the opencode plugin's five `memory_*` tools); install hints point at the stable line instead of `@alpha`

## doctor: VS Code MCP-disabled check

- `open-memex doctor` now fails with a clear message when VS Code has MCP disabled — via `chat.mcp.enabled: false` in user/project `settings.json`, or a Windows registry policy (`HKLM/HKCU\SOFTWARE\Policies\Microsoft\VSCode`)

## [0.5.0] - 2026-09-30

## One config for every project (D45)

- `open-memex init --global`: writes editor wiring once at user level — one setup, every project covered
- `npm install -g open-memex` puts the command in your PATH; `init --global` wires your editors. README install chapter rewritten to keep the two straight

## Smarter init (D46 / D47)

- Bare `open-memex init` auto-detects installed editors and wires all of them — no more "which client?" for every project
- Non-strict-JSON configs (JSONC comments, trailing commas): init leaves the file untouched and prints a ready-to-paste snippet instead

## uninstall (D48)

- New `open-memex uninstall [--client ...] [--global] [--yes]`: removes wiring symmetrically with init, never touches memory data

## Empty-file fix (D49)

- Empty or whitespace-only config files are treated as blank, not corrupt — init writes into them directly (previously refused with "not valid JSON")

## Docs

- FAQ merged into the bilingual README (EN + zh-CN); install chapter rewritten; full `init` synopsis documented

## [0.4.1] - 2026-09-29

- Patch release on the 0.4.0 line (published to npm; no GitHub Release was created at the time).

## [0.4.0] - 2026-09-29

## Team sync via git

- Draft outbox (`appdata project/`) → `sync-status` → `submit` → `promote` / `resolve`: shared memory flows through git branches and PR review, just like code
- Fast-forward-only pulls, no auto-push — conflicts stop and ask, never overwrite
- `memory_status` checkpoints: after commits, work chunks, and memory actions

## Portable archives

- `export` / `import`: `.tar.gz` + `manifest.json`; `visibility: private` excluded by default, `--all` for full migration

## Capture loop closed (D42/D43)

- §3.5 checkpoint distillation taught in the MCP handshake instructions and `init`-written instruction files: the agent proposes 1–3 distilled captures at checkpoints, nothing saved without approval
- `distill-agents` output now ends with a "Memory hygiene" section, so opencode users reading AGENTS.md get the checkpoint habit too

## Also in this release

- 11 memory types (`fact` `preference` `decision` `constraint` `todo` `knowledge` `howto` `gotcha` `lesson` `observation` `reference`)
- README overhaul, fully bilingual (EN + zh-CN): why open-memex, 11 tools, architecture diagram, stable vs `@alpha` install channels
- MCP server: 11 tools, re-synced per request; CLI: 26 commands, each with full `--help`

Install: `npm install -g open-memex`

## [0.3.0] - 2026-09-27

- The v2 memory format and protocol ship: `personal` scope (renamed from `user`), RFC 3339 timestamps, type/role split. See `docs/V2-DESIGN.md`; `open-memex migrate --to-v2` converts v1 data. (Published to npm; no GitHub Release was created at the time.)

## [0.1.0] - 2026-09-26

- First public release under the open-memex name (renamed from my-o-memory): local-first memory for AI coding agents — Markdown files as the source of truth, SQLite FTS5 index, opencode plugin + MCP server + CLI.

[Unreleased]: https://github.com/stoneskin/open-memex/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/stoneskin/open-memex/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/stoneskin/open-memex/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/stoneskin/open-memex/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/stoneskin/open-memex/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/stoneskin/open-memex/compare/v0.4.0...v0.5.0
[0.4.1]: https://github.com/stoneskin/open-memex/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/stoneskin/open-memex/releases/tag/v0.4.0
[0.3.0]: https://github.com/stoneskin/open-memex/releases/tag/v0.3.0
[0.1.0]: https://github.com/stoneskin/open-memex/releases/tag/v0.1.0

