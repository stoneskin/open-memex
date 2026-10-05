# open-memex

> Persistent memory for your AI coding agents — on your machine, in plain Markdown, shared by every tool you code with.

[![npm version](https://img.shields.io/npm/v/open-memex.svg)](https://www.npmjs.com/package/open-memex)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![open-memex MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/stoneskin/open-memex/badges/score.svg)](https://glama.ai/mcp/servers/stoneskin/open-memex)

[中文文档](./README.zh-CN.md)

Every AI coding session starts from zero: you re-explain the project, the agent
rediscovers the same gotchas, and yesterday's decisions vanish when the chat
ends. open-memex gives your agents a memory that survives the session. Say
"remember: we deploy on Fridays" once, and next week Copilot, Cursor, opencode,
or Claude Code already knows — because they all read and write the same local
memory on your machine.

- **Free and open source** (Apache-2.0). No account, no cloud, no telemetry —
  everything lives on your machine, in files you can open and edit.
- **Local-first**: memories are plain Markdown files (the source of truth) with
  a rebuildable SQLite keyword index. Nothing leaves your machine unless you
  explicitly share it.
- **One memory, every agent**: wire up several editors with one command; they
  share the same memory instead of keeping separate silos.

![Terminal demo: two memories saved on Monday, recalled by search in a fresh session on Friday](./docs/assets/open-memex-demo.svg)

New here? This README takes you from install to a working memory in about a
minute. The [concept guide](./docs/CONCEPTS.md) explains the mental model in
depth once you're up and running.

## Contents

- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Which editors, which features](#which-editors-which-features)
- [Installation](#installation)
- [Setting up your editor](#setting-up-your-editor)
- [What `init` changes on your machine](#what-init-changes-on-your-machine)
- [Capture: how memories get saved](#capture-how-memories-get-saved)
- [Tools the agent gets](#tools-the-agent-gets)
- [Memory types](#memory-types)
- [Team workflow: sharing memories through Git](#team-workflow-sharing-memories-through-git)
- [Retrieval: how memories come back](#retrieval-how-memories-come-back)
- [Security & data](#security--data)
- [Limitations](#limitations)
- [Upgrading](#upgrading)
- [Storage layout](#storage-layout)
- [Config](#config)
- [CLI reference](#cli-reference)
- [MCP server](#mcp-server)
- [Scopes, in detail](#scopes-in-detail)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Project status](#project-status)

## Quick start

You need **Node.js ≥ 22.14** (check with `node -v`). Then:

```sh
npm install -g open-memex
open-memex init
```

`init` detects the editors you have installed (VS Code, Cursor, opencode, and
Visual Studio when your project has a solution file) and connects each one to
open-memex. Restart your editor afterwards.

**See it work** (30 seconds):

```sh
open-memex add "This project deploys on Fridays"
```

Now open a new chat in your editor and ask your agent: *"When does this project
deploy?"* It already knows — no re-explaining. That round trip, capture once and
recall forever, is the whole product. Everything below is detail.

Optional but recommended — check everything is wired up:

```sh
open-memex doctor
```

## Core concepts

Three ideas explain almost everything open-memex does.

![open-memex architecture: your editors share one local memory — Markdown files as the source of truth, an SQLite FTS5 index for search, personal scope that never leaves the machine, and project scope shared through git PRs](docs/assets/open-memex-architecture-en.png)

**1. Two scopes: `project` and `personal`.**
Every memory belongs to one of two places:

- **project** — knowledge about one codebase (decisions, constraints, lessons).
  Scoped to the current repo automatically; you never set this up by hand.
- **personal** — knowledge about *you* (preferences, habits) that applies in
  every project. It lives only on this machine and can never be shared into a
  repo.

Facts about you ("I prefer concise diffs") go to `personal`; everything else
defaults to the current project.

**2. Capture → recall.**
Memories are saved as small Markdown files, one fact each. On the first turn of
every new session, open-memex hands your agent the most relevant ones
automatically, so it starts the session already knowing them. The agent can also
search the full memory on demand. You never have to "load" anything yourself.

**3. Your files, your rules.**
The Markdown files are the source of truth — open them, edit them, delete them,
grep them. The SQLite index next to them is just a search accelerator and
rebuilds from the files at any time (`open-memex reindex`). Team sharing, when
you want it, goes through the same review flow as code: nothing is shared
automatically (see [Team workflow](#team-workflow-sharing-memories-through-git)).

## Which editors, which features

open-memex talks to editors two ways: a native **opencode plugin**, and a
standard **MCP server** that any MCP-capable editor can use. (MCP — Model
Context Protocol — is the open standard editors use to give agents extra tools;
open-memex appears in your editor as a set of `memory_*` tools.) What you get
depends on which path an editor uses:

| Editor | Setup | Tools | Session-start recall | Keyword auto-capture |
|---|---|---|---|---|
| opencode (native plugin, recommended) | `open-memex init --client opencode --global` | 5 core tools | Built in — first turn of every session | Yes — `remember …`, `记住…` |
| VS Code (Copilot) | `open-memex init --client vscode` | All 11 via MCP | Via MCP guidance* | No — the agent saves when you ask |
| Cursor | `open-memex init --client cursor` | All 11 via MCP | Via MCP guidance* | No — the agent saves when you ask |
| Claude Code | `claude mcp add open-memex -- open-memex mcp` | All 11 via MCP | Via MCP guidance* | No — the agent saves when you ask |
| Visual Studio 2022 17.14+ / 2026 | `open-memex init --client visualstudio` | All 11 via MCP | Via MCP guidance* | No — the agent saves when you ask |
| Codex and other MCP clients | `open-memex mcp --print-config` | All 11 via MCP | Via MCP guidance* | No — the agent saves when you ask |

\* MCP has no hard session-start hook, so open-memex sends the agent guidance in
the MCP handshake (including how many drafts are waiting) and `init` writes the
fuller version into the editor's instruction files. In practice agents follow
it; the opencode plugin is the only path with true built-in first-turn
injection. The [Tools](#tools-the-agent-gets) section lists the 5 core tools
and the 6 extra workflow tools, so the "5 vs 11" split is explicit.

All editors on the same machine read and write the **same** memory — a
constraint captured in VS Code is respected in opencode; a lesson learned in
Cursor shows up in Claude Code. (Different machines do not sync automatically;
see the [FAQ](#faq).)

`init` also installs an **Agent Skill** (a short instruction file that teaches
skill-aware agents to use the CLI) for VS Code and Cursor, and for opencode in
per-project MCP mode. With the opencode native plugin wired, no skill is
installed there — the plugin already provides the memory tools, and a second
instruction set only made agents chatty.

## How it compares

| | open-memex | Instruction files (`CLAUDE.md`, `AGENTS.md`, …) | Cloud memory services | Chat history |
|---|---|---|---|---|
| Where it lives | Your machine + your repos | In the repo | Vendor servers | Gone when the chat ends |
| Who maintains it | Captured as you work; you review | You write and update by hand | The service | — |
| Works across AI tools | Yes — any MCP client (same machine) | One file per tool convention | Per-integration | No |
| Review before sharing | Yes — outbox + pull request | Yes — it's just files | Varies | No |
| Human-readable | Plain Markdown files | Yes | Dashboard / API | No |

Instruction files are great for a handful of standing rules — keep using them
(open-memex can even draft one from your memories; see `distill-agents` below).
open-memex covers the growing pile of decisions, lessons, and preferences that
no one remembers to write down.

## Installation

### Requirements

- **Node.js ≥ 22.14** (`open-memex doctor` verifies this for you). The floor is
  the SQLite driver's: `better-sqlite3` 13 is built against Node-API 10, which
  Node gained in 22.14.0 — older Node segfaults on the first database open.

### Install the CLI

```sh
npm install -g open-memex
```

That's the stable release. Installing the package may print a reminder to run
`open-memex init` — the editor wiring is a separate step (see
[Setting up your editor](#setting-up-your-editor)), so don't worry if you
don't see the reminder; just run `init` next.

Two alternatives:

- **No install — run via npx:** `npx -y open-memex <command>` runs any command
  without installing (e.g. `npx -y open-memex init --client vscode`). Slower to
  start, nothing to uninstall.
- **Alpha builds** (newest features, rougher edges, for testers):
  `npm install -g open-memex@alpha`. Check what's published with
  `npm view open-memex version` (stable) and `npm view open-memex@alpha version`
  (alpha).

If `open-memex` isn't found after installing, your PATH needs attention — see
[Troubleshooting](#troubleshooting).

### From source (for contributors)

```sh
git clone -b main https://github.com/stoneskin/open-memex.git
cd open-memex
npm install
node --experimental-strip-types src/cli.ts <command>
```

## Setting up your editor

Run `init` from your **project root** (the top folder of the repo you're working
in) so the project scope resolves to that repo:

```sh
open-memex init --yes
# …or without installing the package first:
npx -y open-memex init --yes
```

`--yes` accepts the recommended defaults for everything `init` asks about
(editors to wire, auto-capture, first-turn recall). Leave it off if you want to
answer each question. With no `--client`, `init` detects your installed editors
and wires them all — one init covers every project. Prefer a single editor?
Pass `--client`:

**VS Code** (Copilot):

```sh
open-memex init --client vscode
```

Writes the MCP server entry; reload the window afterwards and confirm the
`open-memex` server is started in Copilot Chat's MCP panel. By default this
writes a project-level `.vscode/mcp.json` (an interactive run asks which
level you want); add `--global` for VS Code's *user-level* config instead —
one setup that works in every project.

**Cursor:**

```sh
open-memex init --client cursor
```

Same shape as VS Code: project-level `.cursor/mcp.json` by default,
user-level MCP config with `--global`, plus Copilot-style instructions.

**opencode** (native plugin — recommended):

```sh
open-memex init --client opencode --global --yes
```

Merges the native plugin into your user-level `~/.config/opencode/opencode.json`
(or `opencode.jsonc` if that's the file you already have) — one-time, every
project picks it up, no per-project init. You get the 5 core tools, keyword
auto-capture, and first-turn context injection. (A config file with comments is
left untouched — `init` prints the line to add by hand.)

Both opencode generations are supported from the same install: `init` writes
the opencode 1 spelling (`"plugin"`) and the opencode 2 spelling (`"plugins"`)
— each host reads its own key. Opencode 1 needs version **1.18.29 or newer**
for this. `open-memex doctor` tells you if the wiring and the installed host
version don't match.

**opencode** (as a plain MCP consumer):

```sh
open-memex init --client opencode
```

Writes a project-level `opencode.jsonc` with the MCP server. Only needed if you
prefer plain MCP over the native plugin — you give up keyword capture and
built-in injection.

**Claude Code** (from your project root):

```sh
claude mcp add open-memex -- open-memex mcp
# …or print the config snippet: open-memex mcp --print-config claude
```

**Visual Studio** (from your solution directory):

```sh
open-memex init --client visualstudio
```

Writes solution-level `.mcp.json`. Requires Visual Studio 2022 17.14+ or Visual
Studio 2026 (Windows-only). Visual Studio also auto-discovers `.vscode/mcp.json`
and `.cursor/mcp.json`, so the VS Code setup above works too.

**Codex:** no `init` client yet — add the server manually via
`open-memex mcp --print-config` as a starting point (`[mcp_servers]` in
`config.toml`, or `codex mcp add`).

### One-time setup for all projects (VS Code / Cursor)

```sh
open-memex init --client vscode --global --yes
```

> **Two different "globals" — don't mix them up.**
> - `npm install -g open-memex` installs the *package* globally: it puts the
>   `open-memex` command on your PATH.
> - `init --global` writes the *editor config* at user level instead of the
>   project: init once, the wiring works in every project. It works the same
>   whether the package was installed globally or run via npx.

The `--global` form writes the server entry to the editor's *user-level* MCP
config (`%APPDATA%\Code\User\mcp.json` on Windows,
`~/Library/Application Support/Code/User/mcp.json` on macOS,
`~/.config/Code/User/mcp.json` on Linux; `~/.cursor/mcp.json` for Cursor)
instead of the project — init once, the server starts in every project.
A per-project `.vscode/mcp.json` still wins if a project defines its own.
If the user-level file has comments in it (editors accept JSONC), `init` leaves
the file untouched and prints the exact snippet to paste in by hand.

### `init` behavior notes

- Existing config files are **merged, never overwritten** — re-running `init`
  is safe. `--force` rewrites our entries.
- With no durable `open-memex` on `PATH` (e.g. one-shot npx), `init` writes an
  `npx -y open-memex mcp` server command into the config so the setup keeps
  working. `npm i -g open-memex` + `open-memex init --force` switches to the
  faster direct command later.
- On an interactive terminal, `init` shows the detected editors and asks you to
  confirm; scripts and CI never prompt and wire every detected editor.
- If you run bare `open-memex` on a machine where init never completed, it
  offers to run it for you (interactive terminals only).

### Remove the wiring

```sh
open-memex uninstall --yes
```

Reverses `init` — removes the MCP server entry, the opencode plugin line, the
Agent Skill, and the open-memex section of the editor instructions. With no
`--client` it cleans up every detected editor; `--global` limits the cleanup to
user-level wiring. Your memories are never touched.

## What `init` changes on your machine

Everything `init` writes, in one place:

- **Memory data** (created on first use, not by `init` itself):
  `%APPDATA%\open-memex\` on Windows, `~/.local/share/open-memex/` on
  macOS/Linux — your memory files and the search index. Nothing here is ever
  modified by `uninstall`.
- **Editor wiring** (removed by `open-memex uninstall`):
  - opencode: a `"plugin"` entry (opencode 1) and a `"plugins"` entry
    (opencode 2) merged into
    `~/.config/opencode/opencode.json` (or `.jsonc`). Stale `my-o-memory`
    entries from before the rename are removed at the same time.
  - VS Code / Cursor: an `open-memex` server entry in the user-level or
    project-level MCP config, plus an open-memex section in the Copilot
    instructions (user-level `~/.copilot/copilot-instructions.md` by default;
    `--instructions project` writes `.github/copilot-instructions.md` in the
    repo instead, for teams where everyone uses open-memex).
  - Visual Studio: `.mcp.json` next to your solution.
  - Agent Skill: a `skills/open-memex/` folder for VS Code
    (`~/.copilot/skills/`), Cursor (`~/.cursor/skills/`), or opencode in
    per-project MCP mode (`~/.config/opencode/skills/`).
- **Your repo**: nothing. Files only appear in a repo when you explicitly run
  `submit` (see Team workflow) — a local commit, never an automatic push.

Files with comments (JSONC) are never rewritten: `init` prints the exact
snippet to paste instead.

## Capture: how memories get saved

Three ways memories get in:

- **Keyword triggers** (opencode native plugin only): say `remember …`,
  `note that …`, `don't forget: …`, `TIL …`, `save this …` — or in Chinese
  `记住…` / `记一下…` / `记录一下…` / `别忘了：…` — and the sentence is captured
  without any tool call. Captures land in the current **project** by default;
  phrases that signal "this is about me" — `remember for me …`, `help me remember: …`,
  `记住我…`, `替我记…`, `帮我记…`, `我觉得…`, `我喜欢…` — go to **personal** instead, and
  team-context phrases (`我们决定…`, `帮我们记住…`) stay in project.
  Two rules keep the noise down (D67): a trigger must be a *statement to the
  store*, so the narration forms `记得…` / `remind me to…` / `别忘了带伞` /
  `don't forget the wifi password` never fire (add a separator — `别忘了：…`,
  `don't forget: …` — or `that` to make it an instruction); and a captured body
  under 3 characters is rejected as a fragment rather than saved — `capture
  --dry-run` says so instead of dropping it silently. A trigger also owns its
  own sentence: the plugin tells the agent what it just stored, and a
  `memory_add` that re-saves the same words within the next few minutes is
  refused with the stored id (D73) — one thing you said is one memory, not
  three copies of it.
- **The agent saves it**: in any editor, ask your agent to remember something
  (or it saves on its own when you state a fact worth keeping) — it calls
  `memory_add`. The routing above is a heuristic; you can always say "save this
  to my personal memory" or use the CLI with `--scope` to be explicit.
- **Checkpoint proposals**: when a task wraps up, the agent proposes 1–3 short
  candidate memories distilled from the session — decisions and their reasons,
  conventions, gotchas, approaches tried and abandoned — and saves only the
  ones you approve. Nothing is written silently: no draft is created behind
  your back.
- **The CLI**: `open-memex add "…"` with optional `--scope` / `--tag` / `--type`
  / `--aliases`.

**Aliases.** Each saved memory can carry up to 4 alternate phrasings
(synonyms, another language's equivalent) that are indexed with it, so a
question worded differently still finds the memory — "vacation days" finds the
holiday policy. `init` asks once whether to enable this (default on); turn it
off any time with `open-memex config set captureAliases false`.

**Redaction.** Wrap anything sensitive in `<private>…</private>` and it is
stripped before saving. Recognized secrets (API keys, tokens, high-entropy
credentials) are masked in place — the first 4 characters are kept so you can
tell *which* key it was, the rest is replaced — and the memory is still saved.
Preview exactly what a message would capture, safely, any time:

```sh
open-memex capture --dry-run "…"
```

If a secret slips through anyway, `open-memex forget <id>` deletes the memory.

## Tools the agent gets

The MCP server exposes eleven tools; the opencode native plugin exposes the
five core ones (marked ●). The other six are the team-review workflow tools —
they only matter once you share memories through Git.

| Tool | What it does |
|---|---|
| ● `memory_add`       | Save a fact, preference, decision, note |
| ● `memory_search`    | Keyword search (BM25) across project + personal memories |
| ● `memory_list`      | List memories in a scope (`project`, `personal`, or `both`) as a numbered inventory; `include=all` is the audit view |
| ● `memory_supersede` | Replace a memory with a newer version (keeps a supersede chain) |
| ● `memory_forget`    | Delete a memory by id (`soft=true` hides it instead — retracted, one-way) |
| `memory_status`      | Show the sync queue: outbox drafts, repo review states, uncommitted files |
| `memory_submit`      | Move named drafts into the repo memory dir (local branch + commit) |
| `memory_propose`     | Copy personal memories into the project scope as review candidates |
| `memory_promote`     | Advance `proposed → approved → published` (or reject / resubmit) |
| `memory_resolve`     | List conflicted memory files / 3-way-merge one of them |
| `memory_pr_status`   | Map the branch PR's GitHub state onto each memory's review state |

So an MCP-connected editor always has the full set; opencode's plugin covers
capture and recall, and anything workflow-shaped goes through the CLI or an
MCP-connected editor.

## Memory types

Every memory has a `type` (what it is) and `tags` (what it's about). Eleven
types are built in:

| Type | Captures |
|---|---|
| `fact` | A stable true statement about the project or world |
| `preference` | How someone likes things done |
| `decision` | A choice that was made — the why and the trade-off |
| `constraint` | A rule that must not be violated |
| `todo` | A commitment to do something later |
| `knowledge` | Durable domain or architecture knowledge |
| `howto` | A procedure that worked |
| `gotcha` | A trap to avoid |
| `lesson` | What an incident or mistake taught us |
| `observation` | Something noticed, not yet a conclusion |
| `reference` | A pointer to the authoritative doc (no copying) |

`--type` accepts any string, but sticking to the built-in set keeps session-start
labels, search, and `distill-agents` output predictable.

## Team workflow: sharing memories through Git

**Working solo? You can skip this section** — everything above is the whole
product for one person. Nothing below ever happens automatically.

Personal notes stay private. Project knowledge, when you choose to share it,
follows an explicit, reviewable pipeline shaped like code review:

```
capture → outbox (draft, local) → submit → repo (.ai/open-memex/) → PR review → published → recall
```

1. **Capture** — save decisions, gotchas, lessons as drafts during normal work.
2. **Review** — drafts wait in a local outbox (on your machine, invisible to
   git); `open-memex sync-status` — or just saying "sync memory" in chat —
   shows what's pending.
3. **Submit** — you name the memories; they move into `<repo>/.ai/open-memex/`
   with a local commit on your current branch. open-memex never pushes on its
   own; it prints the push + PR commands, and an agent holding your explicit
   yes can carry them out.
4. **PR review** — memories are plain Markdown; reviewers approve, request
   changes, or reject through the normal branch/PR process.
5. **Recall** — published memories are injected at session start and searchable
   on demand, for humans and agents alike.

Whoever tends the shared memory follows the [curator convention](./docs/CURATOR.md):
what to approve, what to send back, and the hygiene rules that keep shared
memory from rotting.

## Retrieval: how memories come back

On the first turn of every session, open-memex injects an `[OPEN-MEMEX]` block
into the agent's context with the most recent project memories (default: top 8)
and your personal preferences (default: top 5). It looks like this:

```text
[OPEN-MEMEX]

User profile / preferences:
- I prefer concise diffs

Project knowledge (my-repo):
- [decision] We deploy on Fridays; the release train leaves at 10:00

Use the `memory_search` tool to look up more. Use `memory_add` to save new facts.
Do not mention this block to the user unless asked.
```

It's a snapshot, not the whole memory — the agent can call `memory_search` any
time for the rest. Both top-N counts are configurable (see [Config](#config)).
For MCP clients this block is delivered as handshake guidance the agent follows;
the opencode plugin injects it directly on the first turn.

## Security & data

- **Local-first:** everything lives on your machine (`%APPDATA%\open-memex` on
  Windows, `~/.local/share/open-memex` on macOS/Linux) plus the repos you
  choose. Zero cloud calls, zero accounts, zero third-party APIs, zero
  telemetry.
- **Secrets stay out:** `<private>…</private>` spans are stripped; detected API
  keys/tokens are masked in place before saving. Preview with
  `open-memex capture --dry-run "…"`.
- **Personal never syncs:** the `personal` scope is this machine only —
  excluded from export by default and can never enter a repo.
- **Auditable sharing:** team memories move only by explicit `submit`, travel
  through branch/PR review, and every `promote` transition is appended to the
  memory's `review_history` (who / when / why).
- **You own the files:** Markdown is the source of truth — inspect, edit, or
  delete anything by hand; the SQLite index rebuilds from the files.

## Limitations

Honest edges, so nothing surprises you:

- **Keyword search, not semantic.** Retrieval is BM25 keyword matching: search
  finds the words you saved, not paraphrases. (Plain questions are fine —
  "how do we…" / "请问…" wording is filtered out before matching, so asking
  naturally doesn't dilute the results.) No embedding model is ever
  downloaded without your explicit opt-in.
- **One machine.** Editors on the same machine share memory; there is no
  cross-machine sync. `export` / `import` bundles (below) move memory between
  machines manually.
- **A snapshot, not everything.** Session-start recall is a top-N snapshot (8
  project + 5 personal by default); older memories are one `memory_search`
  away, but they are not all in context at once.
- **MCP guidance is advisory.** Outside opencode, proactive capture and recall
  depend on the agent following the handshake instructions — there is no hard
  session-start hook in MCP. The tools themselves always work when called.
- **Capture routing is a heuristic.** Personal-signal phrases (`remember for
  me …`, `我喜欢…`) go to personal; everything else defaults to the current
  project. When it guesses wrong, say the scope out loud or use `--scope` in
  the CLI.

## Upgrading

```sh
npm install -g open-memex@latest   # or @alpha
```

Your editor configs point at the installed `open-memex` command, so upgrades
need no re-wiring. After a major upgrade, run `open-memex init --force` once to
refresh the installed Agent Skill and instruction files with the latest wording.
If you installed from source or moved the package, `--force` also re-points the
opencode plugin path.

What changed in each version: see the [CHANGELOG](CHANGELOG.md).

## Storage layout

```
%APPDATA%\open-memex\               (Windows)
~/.local/share/open-memex/          (macOS/Linux; $XDG_DATA_HOME if set)
├── index.db                         # SQLite FTS5 index (rebuildable)
└── memories/
    ├── personal/
    │   └── <id>.md
    └── project__<name>__<hash12>/
        └── <id>.md
```

Each `.md` file is one memory: YAML frontmatter (`id, scope, type, tags,
created_at, schema_version`, …) followed by the content. You can edit them by
hand — the index re-syncs from the files, and Markdown is always the source of
truth (`open-memex reindex` rebuilds the index from scratch).

Once you `submit`, project memories also live as Markdown files under
`<repo>/.ai/open-memex/` (configurable via `memoryDir`), where they travel with
branches and PRs like any other file.

## Config

Settings live in `~/.config/opencode/open-memex.jsonc` — the `opencode` in the
path is historical; this one file is shared by every client. Override the config
path with `OPEN_MEMEX_CONFIG` and the storage root with `OPEN_MEMEX_HOME`
(the pre-rename `MY_O_MEMORY_CONFIG` / `MY_O_MEMORY_HOME` names are still
honored as fallbacks).

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

`open-memex config` prints the effective config (defaults + file). Change a
setting after install:

```sh
open-memex config set keywordCaptureEnabled false
open-memex config set maxProjectMemories 12
open-memex config set sync.autoPull true   # best-effort pull at MCP session start
```

Settable keys: `maxProjectMemories`, `maxProfileItems`, `injectOnFirstTurn`,
`keywordCaptureEnabled`, `captureAliases`, `logLevel`, `memoryDir`, and `sync.autoPull` (a dotted
key that writes into the nested `sync` object). Full design:
[docs/V2-DESIGN.md](./docs/V2-DESIGN.md).

## CLI reference

Setup & health:

```sh
open-memex init [--client vscode|cursor|opencode|visualstudio]
              [--instructions personal|project] [--global] [--force] [--yes]
open-memex uninstall [--client vscode|cursor|opencode|visualstudio] [--global] [--yes]
open-memex config                                  # print effective config
open-memex config set <key> <value>                # change a setting
open-memex doctor                                  # environment health check (incl. plugin entry)
open-memex audit                                   # memory health check (duplicates, stale, broken chains)
open-memex capture --dry-run "记住我喜欢简洁的回答"  # preview keyword capture
open-memex mcp --print-config vscode|cursor|claude|opencode|visualstudio
open-memex --help      # this reference
open-memex <command> --help  # help for one command
open-memex --version   # installed version
```

Memory operations:

```sh
open-memex add "This repo uses better-sqlite3" --type fact
open-memex search "auth flow"
open-memex search "auth flow" --explain   # show FTS expression, scores, lifecycle-hidden counts
open-memex list --scope project
open-memex list --scope both       # each scope's newest under its own header
open-memex list --include all      # audit view: superseded versions, retracted, archived
open-memex supersede <id> "Updated content"
open-memex status <id> deprecated
open-memex forget <id>
open-memex forget <id> --soft      # hide instead of delete (retracted; one-way)

open-memex inventory                        # everything remembered, as readable text
open-memex inventory --format json          # the same data, for agents
open-memex inventory --format html          # the same data as a local page (writes <data dir>/inventory.html)
# Personal + current project, outbox drafts in their own section, hidden
# history counted. Refuses to write a personal-bearing report inside a
# git working tree unless you pass --allow-personal.
# `list` numbers every entry in one listing and says how many it left out.
```

Team review workflow (two homes, one per stage):

Project drafts live in the **appdata outbox** (git-invisible, branch-independent);
only drafts you approve move into `<repo>/.ai/open-memex/`, where they follow
branches and PRs. Nothing moves without you naming it. In an AI chat with the
MCP server connected, just say **"sync memory"** (or "同步记忆") — the agent
runs the status check, summarizes the outbox drafts, and asks which ones to
sync. The server also tells the agent on its own: at session start the
handshake reports how many drafts are waiting, and every memory-changing tool
result carries the current count when it is non-zero.

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
# (agent full-chain path). Default PR base is the current branch (memory
# PRs stack onto your working branch); --base redirects it to main or
# wherever you review.

open-memex pr-status [--apply]
# read the branch's GitHub PR and map its state onto each in-repo memory:
# merged PR → published, PR approval → approved (approved_by = reviewer),
# changes-requested → suggestion only. Report by default; --apply performs
# the mapped transitions locally (no push).

open-memex pull
# pull shared memories from the git remote: fetch + fast-forward ONLY.
# A diverged branch fails with a clear message — open-memex never
# force-merges; resolve it by hand, then pull again. On success the
# local index re-syncs. Pulls are explicit by default; set
# `open-memex config set sync.autoPull true` for a best-effort pull
# at MCP session start (a failed pull never blocks the session).

open-memex push
# push the current branch (with its submitted memories) to the git remote.
# Explicit only — open-memex never pushes on its own.

open-memex export [--scope project|personal|both] [--type T] [--tag t] [--all] [-o <file>]
# bundle memories into a portable .tar.gz (markdown + manifest.json) for
# moving to another machine or another app. Excludes visibility:private
# memories by default; --all / -a includes everything (full migration).

open-memex import <bundle.tar.gz> [--dry-run]
# restore a bundle: personal memories go to the personal dir; project
# memories are re-keyed to the current project and land in the outbox as
# drafts. Identical ids are skipped; conflicting ids are reported,
# never overwritten.

open-memex distill-agents [--scope project|personal] [--type t1,t2] [--limit N] [-o <file>]
# propose an AGENTS.md snippet distilled from project memories
# (decisions, constraints, lessons, gotchas, howtos). Prints markdown;
# -o writes it to a file. You review and merge by hand — open-memex
# never rewrites your AGENTS.md on its own. The snippet ends with a
# "memory hygiene" section so agents reading AGENTS.md learn to propose
# distilled captures when a task ends.

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

Whoever tends the shared memory follows the curator convention —
`docs/CURATOR.md`: what to approve, what to send back, and the hygiene
rules that keep shared memory from rotting.

Maintenance:

```sh
open-memex where        # show storage + config paths
open-memex scopes       # list project scopes with memory counts
open-memex reindex      # rebuild the SQLite index from markdown
open-memex audit        # memory health: duplicate pairs, stale memories, broken chains
open-memex migrate --to-v2 [--dry-run]   # v1 data → v2 (renames user scope to personal)
```

The CLI runs under Node 22. From a source checkout it uses the built-in
experimental TypeScript loader (no build step); the published npm package ships
pre-compiled JS (`npm run build` at publish time). From a source checkout,
prefix every command with `node --experimental-strip-types src/cli.ts` (or
`npm run cli -- <command>` for simple cases — npm swallows unknown `--flag`
args, so prefer direct `node`).

## MCP server

The same memory tools over the Model Context Protocol, via a stdio server —
no host-specific plugin needed. Any MCP client can use open-memex.

```sh
open-memex mcp               # after a global install
npx -y open-memex mcp        # no install needed
```

The project scope is resolved from the process working directory, so configure
the server with cwd set to your project root (`init` handles this for you).

> **Note:** MCP is request/response — it gives the agent tools, not the
> opencode plugin's automatic keyword capture or first-turn injection.
> Proactive memory use depends on the agent's instructions: the server sends
> session-start guidance in the MCP handshake `instructions` (including the
> live outbox draft count at session start, plus the pending count appended to
> memory-changing tool results when non-zero), and `init` writes the fuller
> version into the editor's instruction files. Both are advisory — no MCP
> consumer offers a hard session-start hook.

## Scopes, in detail

- **project** — scoped to the current repo, keyed off the git origin URL hash
  (so clones of the same repo share a scope), or off the cwd path if there is
  no remote. Default for new memories.
- **personal** — global across all your projects, this machine only, never
  synced. Use for personal preferences. (v1 called this `user`;
  `migrate --to-v2` renames it.)

See [docs/SCOPES.md](./docs/SCOPES.md) for the full scope model: key derivation,
migration, visibility, reserved names. The [concept guide](./docs/CONCEPTS.md)
walks through the mental model end to end.

## Troubleshooting

**Every command dies with no output, or the process crashes (`exit 139`,
`0xC0000005`, "Segmentation fault").**
Your Node is older than **22.14** and the bundled SQLite driver cannot load on
it. `better-sqlite3` 13 is compiled against Node-API 10, which Node only gained
in 22.14.0; on anything older `require()` succeeds and then the first database
open segfaults the process with no diagnostic. open-memex now refuses to load
the driver and says so, but anything already crashing was almost certainly this.
Check with `node -v`, then either upgrade Node (`nvm install 22.14 && nvm use
22.14`, or any current 22.x/24.x) or pin the driver down with `npm install
better-sqlite3@^12.11.1`. `open-memex doctor` reports both the Node floor and a
live driver probe. Known upstream: WiseLibs/better-sqlite3#1514.

**`open-memex` is not recognized / command not found.**
A global `npm install -g` puts the `open-memex` launcher in npm's global bin
folder. If your terminal can't find it, that folder isn't on your `PATH`:

1. Find the folder: `npm config get prefix`
   - **Windows:** the launcher (`open-memex.cmd`) sits directly in that folder,
     e.g. `C:\Users\<you>\AppData\Roaming\npm`
   - **macOS / Linux:** it's in `<prefix>/bin`, e.g. `/usr/local/bin` or
     `~/.nvm/versions/node/v22.x.x/bin`
2. Add it to `PATH`:
   - **Windows:** Settings → System → About → Advanced system settings →
     Environment Variables → add the folder to the *User* `Path` → **restart
     the terminal**. Verify with `where open-memex`.
   - **macOS / Linux:** add `export PATH="$(npm prefix -g)/bin:$PATH"` to
     `~/.zshrc` (or `~/.bashrc`), restart the shell, verify with
     `command -v open-memex`.
3. No admin rights / don't want to touch `PATH`? Use the npx form —
   `npx -y open-memex <command>` resolves the package itself and needs no
   `PATH` changes.

**`EBUSY` / `EPERM` on `better_sqlite3.node` (Windows).**
On Windows a loaded DLL is locked: if the open-memex MCP server is running
(VS Code MCP panel, Cursor, etc.), `npm install -g open-memex` cannot replace
`better_sqlite3.node` and fails with `EBUSY` / `EPERM`. Stop the MCP server
first (or quit the editor), then re-run the install. If it still fails, delete
`node_modules/open-memex` and any `node_modules/.open-memex-*` temp folders
under your global npm root and install again.

**`init` says it left a config file untouched.**
Your editor config has comments (JSONC) or invalid JSON, and open-memex never
rewrites files it can't parse safely. `init` printed the exact snippet to add
by hand — paste it in, and you're done. The same applies to the opencode
config: if it has comments, add the `"plugin"` line manually.

**Something's off — run `open-memex doctor`.**
Checks the Node version, config source, scope resolution for the current
directory, and storage writability; verifies VS Code hasn't disabled MCP;
then boots a real MCP server and runs `initialize` + `tools/list` against
it — all eleven tools must show up. It also reports pre-rename `my-o-memory`
leftovers if any editor config still references the old package name.

## FAQ

**Do I need git?**
No. Capture and recall work in any folder — without a git repo the project
scope simply keys off the folder path. Git is only needed for the team
workflow (`submit` / PR review), which is optional.

**I use several editors. Do they really share one memory?**
Yes — on the same machine. Every wired editor reads and writes the same local
memory; see the [capability matrix](#which-editors-which-features) for what
each editor gets. A decision captured in VS Code is respected in opencode.

**I work on two computers (office + home). Does memory sync?**
Not automatically — memory is per-machine by design, and your personal scope
never leaves the machine it was created on. To move memory manually, use
`open-memex export` on one machine and `open-memex import` on the other.
Project memories shared through Git (Team workflow) travel with the repo, so
cloning the repo on the second machine brings the *published project* memories
along — your personal ones stay behind, on purpose.

**Is it really free? Do I need an account?**
Free and open source (Apache-2.0). No account, no sign-up, no telemetry, no
cloud calls. If it can't phone home, there's nothing to phone home to: the
only network open-memex ever touches is your own git remote, when you
explicitly push.

**I accidentally pasted a secret into a memory. What now?**
`open-memex search "<part of it>"` to find the memory, then
`open-memex forget <id>` to delete it. To prevent it next time, wrap sensitive
text in `<private>…</private>` (stripped before saving) — recognized API keys
and tokens are also masked automatically. Preview any message safely with
`open-memex capture --dry-run "…"`.

**Do I need to run `init` for every project?**
No. The data layer needs nothing — the project scope is derived automatically
from your cwd's git remote or path, so memories are namespaced per project
with zero setup. The editor wiring is one `open-memex init` per machine
(user-level wherever the editor supports it). Run it again only after
upgrading (`--force`) or if you switch editors.

**Does opencode need `init`?**
Two paths. Recommended: `open-memex init --client opencode --global` — it
merges the native open-memex plugin into `~/.config/opencode/opencode.json`
for you. One-time setup, applies to all projects, and additionally enables
keyword auto-capture and first-turn memory injection. Prefer to do it by hand?
Add `"plugin": ["file:///absolute/path/to/open-memex/src/index.ts"]` (the
installed package's path) to that file instead. As a plain MCP consumer:
`open-memex init --client opencode` writes a project-level `opencode.jsonc`
(no hooks). If your user-level config has comments, `init` leaves it
untouched and prints the manual step.

**VS Code — run `init` once, or per project?**
Once. Plain `open-memex init` auto-detects VS Code and writes the MCP server
entry to VS Code's user-level `mcp.json` (`%APPDATA%/Code/User/mcp.json` on
Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS,
`~/.config/Code/User/mcp.json` on Linux), so the server starts in every
project. A per-project `.vscode/mcp.json` still wins when present, and the
entry keeps `cwd=${workspaceFolder}` so project-scope resolution keeps
working per window. If your user-level `mcp.json` has comments (VS Code
accepts JSONC), `init` leaves it alone and prints the exact snippet to add by
hand. An empty file is treated as blank and written to directly.

**How do I remove the editor wiring?**
`open-memex uninstall` reverses `init`: it removes the MCP server entry, the
opencode plugin line, the Agent Skill directory, and the open-memex section of
the Copilot instructions. With no `--client` it cleans up every detected
editor; `--global` limits the cleanup to user-level wiring. Your memories are
never touched.

**I upgraded Node, or switched versions with nvm. Do I need to reinstall?**
The package itself doesn't care: its SQLite driver is a Node-API prebuild, so
it loads on any supported Node (≥ 22.14) with no recompiling, and your
memories live outside the install. But version managers (nvm and friends)
keep a separate global package folder per Node version, so after a switch
`open-memex` may simply be "not found". Run `npm install -g open-memex` once
under the new Node, then `open-memex doctor` to confirm the driver loads.

## Project status

open-memex is stable and in daily use; the current stable line is published on
npm as `latest`, with `alpha` builds for testers. Release history lives in
[GitHub Releases](https://github.com/stoneskin/open-memex/releases); design
decisions are recorded in the append-only log at
[docs/V2-DESIGN.md](./docs/V2-DESIGN.md).

On the horizon (no version promises): native agent plugins for more editors as
enhancements over the same MCP tools; local embeddings as an opt-in experiment
(no model is ever downloaded without asking); an org layer only if real
multi-repo sharing, ACL, or compliance needs demand it.

## License

[Apache-2.0](./LICENSE)
