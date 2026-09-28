# OpenMemex User Guide

> This document describes open-memex's **mental model**: where your memories live,
> how they flow, and who can see them. The in-repo directory (§2, §6 write path)
> and the propose → promote → resolve workflow (§5) are implemented on the
> `V2-dev-p2b` branch; features marked **2B** are still to be built;
> everything else is 0.3.0 behavior.

## In one sentence

open-memex is a local-first memory layer: **Markdown is the source of truth;
SQLite is just a rebuildable index.** Lose the index and you rebuild it.
Lose the Markdown and it's really gone.

## 1. Two scopes: personal vs project

Every memory belongs to a scope, which decides **how far it may travel**:

| | personal | project |
|---|---|---|
| Holds | Facts about you: preferences, habits, cross-project info | Facts about the project: stack, conventions, decisions, gotchas |
| Lives | Only on your machine (see §2) | Local + eligible for team sharing (see §2, §6) |
| Rule | **Never leaves this machine** | Can be promoted to team knowledge |

Keywords route automatically (D18): "remember… / I think… / I like…" (I) → personal;
"we decided… / we think… / remember for us…" (we) → project.

## 2. Two homes: appdata vs the repo directory

| | appdata (the desk) | repo `.ai/open-memex/` (the shelf) |
|---|---|---|
| Location | Windows `%APPDATA%/open-memex`, Linux `~/.local/share/open-memex` | Project root, default `.ai/open-memex/` (D23, configurable via `memoryDir`) |
| Holds | `memories/personal/` personal memories; `index.db` local index | Project-scope Markdown, one memory per file |
| In git? | No | Yes — git is its courier |
| The index? | `index.db` is rebuildable, **never committed** | No index stored; rebuilt from Markdown on demand |

The private notebook (personal) never goes on the shelf. That's an iron rule, not a setting.

The repo directory is created on demand: the first project-scope write creates it.
Legacy project files left in appdata by 0.3.0 are moved in automatically on first
write/sync (only the current project's — never another's).

## 3. First-turn injection: how the 8 and 5 are chosen

Before the agent's first turn, open-memex injects an `[OPEN-MEMEX]` context block so it
doesn't need a search call just to get oriented. Defaults: **8 project + 5 personal**
memories (`maxProjectMemories` / `maxProfileItems`, tunable).

Selection has exactly one criterion: **most recently updated first**
(`ORDER BY updated_at DESC`), minus retracted/archived items, with superseded
versions resolved away. Not "the N most important" — "the N most recently touched".
What you just updated is most likely relevant to what you're doing now.

Token budget: each item is squeezed to one line (≤240 chars, ~60 tokens), so 8 items
cost ≈ 500 tokens worst case. Beyond that, diminishing returns — the long tail is what
`memory_search` is for; stuffing everything into the first turn buries the signal.

Raise it: `open-memex config set maxProjectMemories 12`

## 4. Later turns: when memory gets searched again

First-turn injection happens once. After that there is **no automatic re-search** —
MCP is request/response; the server cannot push. Whether `memory_search` gets called
is entirely the model's judgment, guided by two things:

- The injected block's footer: "Use the `memory_search` tool to look up more."
- The Copilot instructions written by `init`: "before asking the user about something
  they may have told you before, call `memory_search` first — try a few keyword
  variants before giving up."

So: when the conversation touches past decisions, preferences, or conventions, the
model *should* search first — but nothing enforces it. This is a known gap in the
current version; Phase 2C's native plugin hooks (e.g. Claude Code's
`UserPromptSubmit`) are meant to close it.

## 5. Promotion workflow: how a memory becomes team knowledge

A personal observation becomes team knowledge by exactly one road —
**explicit promotion, never automatic sync**:

```
personal idea ──propose──▶ proposed ──promote──▶ approved ──promote──▶ published/shared
                                │                                              │
                             rejected                              (PR review is
                                │                               the review mechanism)
                                ▼
                     curator promotes to org level later (Phase 4)
```

- `open-memex propose <id> --to project`: **copies** a personal memory into
  `.ai/open-memex/` as a review candidate (`review_state: proposed`, new id,
  `derived_from` pointing back at the personal original). **Copy, not move —
  the personal original stays.** It never creates a branch on its own — it
  prints the `git checkout -b` / `git add` / `gh pr create` commands for you
  to run. No surprise branches. Solo devs can use `--local-approve` to
  self-approve and skip the PR.
- A promotion PR contains **only memory files, no code**, reviewed and audited
  separately from code PRs. Reviewers check "is this true? is it safe to share?
  any secrets?" — things a code PR's CI never checks.
- `open-memex promote <id>`: advances the memory one step up the ladder
  (`proposed → approved → published`). `--reject --note "..."` rejects with a
  reason. After the PR merges, run `promote <id>` once more to mark it
  `published`. (Lifting project memories to org level is Phase 4.)
- `open-memex resolve [id]`: with no argument, lists conflicted memory files;
  with an id, attempts a **field-level 3-way merge** of the YAML frontmatter
  (`tags` union, `updated_at` takes latest, body merged when only one side
  changed). Semantic conflicts — both sides changed the same field or the
  body differently — are **reported, never auto-resolved**: the file is left
  untouched for a human to decide.
- `list` / `search` show a `[proposed]` / `[approved]` / `[published]` /
  `[rejected]` tag next to memories in review.

## 6. Sync: git is the courier, not the brain

- **Write**: `memory_add` (project scope) → writes `.ai/open-memex/<id>.md` in the
  repo working tree and updates the local index. **Never auto-commits, never
  auto-pushes.**
- **Pull** **2B**: `open-memex pull` (always explicit, never automatic) → git fetch +
  fast-forward → scans `.ai/open-memex/*.md` → merges into the local `index.db` by
  file mtime. Retrieval always goes through SQLite, never walks git.
- **personal scope**: never syncs (§1 iron rule).
- **Projects without git**: keep working; project scope degrades to local-only with
  a clear notice. Nothing breaks.

## 7. Security baseline

- Memory is **data** by default, never instructions — external content (pulled from
  sync, promoted by others) passes an admission check before it lands; the
  prompt-injection screen on shared files is heuristic, the real boundary is the
  data/instruction separation.
- Every memory carries provenance: `source` + `confidence` + `via` + author.
  Shared-scope writes go into an audit log.
- A pre-commit hook scans shared scopes for secrets and guards against history
  rewrites.
- `<private>…</private>` sections are stripped at write time; detected secret
  patterns are masked in place and the write proceeds.

---

*Companion design record: `docs/V2-DESIGN.md` (decisions D1–D24).*
