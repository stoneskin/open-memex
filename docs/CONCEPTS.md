# Concepts — how open-memex works

[中文版](./CONCEPTS.zh-CN.md)

> This document explains open-memex's **mental model**: where your memories
> live, how they flow, and who can see them. It is not a how-to — for
> installation and commands, start with the [README](../README.md). Read this
> when you want to predict what open-memex will do before it does it.

## In one sentence

open-memex is a local-first memory layer: **Markdown is the source of truth;
SQLite is just a rebuildable index.** Lose the index and you rebuild it.
Lose the Markdown and it's really gone.

## 1. Two scopes: personal vs project

Every memory belongs to a scope, which decides **how far it may travel**:

| | personal | project |
|---|---|---|
| Holds | Facts about you: preferences, habits, cross-project info | Facts about the project: stack, conventions, decisions, gotchas |
| Lives | Only on your machine (see §2) | Local + eligible for team sharing (see §2, §5) |
| Rule | **Never leaves this machine** | Can be promoted to team knowledge |

On the opencode native plugin, keyword capture routes automatically:
"remember for me… / 记住我… / 我觉得… / 我喜欢…" (about me) → personal;
"我们决定… / 帮我们记住…" (about us) and everything else → project.
Everywhere else, the scope is whatever `memory_add` / `--scope` says.

## 2. Two homes: appdata vs the repo directory

| | appdata (the desk) | repo `.ai/open-memex/` (the shelf) |
|---|---|---|
| Location | Windows `%APPDATA%/open-memex`, macOS/Linux `~/.local/share/open-memex` | Project root, default `.ai/open-memex/` (configurable via `memoryDir`) |
| Holds | `memories/personal/` personal memories; project-scope **draft outbox**; `index.db` local index | Submitted project memories (`proposed` and up) |
| In git? | No | Yes — git is its courier |
| The index? | `index.db` is rebuildable, **never committed** | No index stored; rebuilt from Markdown on demand |

The private notebook (personal) never goes on the shelf. That's an iron rule, not a setting.

Project memories start life as **drafts in the appdata outbox** — git-invisible,
branch-independent. Only drafts you explicitly name move to the shelf, via
`open-memex submit` (§5). One stage, one home: after a successful submit the
outbox original is gone; before it, the repo knows nothing.

## 3. First-turn injection: which 8 project + 5 personal memories get chosen

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
- The instructions written by `init`: "before asking the user about something
  they may have told you before, call `memory_search` first — try a few keyword
  variants before giving up."

So: when the conversation touches past decisions, preferences, or conventions, the
model *should* search first — but nothing enforces it. This is an honest boundary of
the current design: on the opencode native plugin, first-turn injection is built in,
but later-turn recall still depends on the agent choosing to search. Over MCP there
is no hard session hook at all — guidance only.

## 5. How a memory becomes team knowledge

A personal observation becomes team knowledge by exactly one road —
**explicit promotion, never automatic sync**:

```
personal idea ──propose──▶ outbox draft ──submit──▶ proposed ──┬──promote──▶ approved ──promote──▶ published/shared
                                                              │                        │
                                                           --reject                 --reject
                                                              │                        │  (approval withdrawn
                                                              ▼                        │   before merge)
                                                           rejected ──resubmit──▶ proposed
```

Keep the four jobs straight — most confusion comes from mixing them up:

- **propose crosses the boundary** (personal → project outbox; the only step
  that copies across). It *copies* one or more personal memories into the
  outbox as review candidates, each with a new id and a `derived_from` pointer
  back. The personal original always stays. Solo? `--local-approve` lets you
  self-approve.
- **submit moves drafts into the repo** (outbox → `.ai/open-memex/`,
  `draft → proposed`). It makes a **local** commit **on your current branch** —
  it never creates a branch on its own, never pushes. All-or-nothing: same id
  with different content aborts for a human to decide.
- **promote only flips the status label** on a file already in
  `.ai/open-memex/` (`proposed → approved → published`, or `--reject` with a
  note — also allowed from `approved`, withdrawing approval before merge). It
  never moves files between directories. Every transition is appended to the
  memory's `review_history` (who / when / from → to / why), so the trail
  survives the PR.
- **git does the transport** (push, PR, merge).

Review itself needs no special UI. A memory PR contains **only memory files**,
reviewed and audited separately from code PRs; reviewers check "is this true?
is it safe to share? any secrets?" — things a code PR's CI never checks.
"Request changes" needs no command: while the PR is open, edit the file, commit,
push; the state stays `proposed` and the PR is the review mechanism.

Two helpers close the loop between GitHub and the local index:

- `open-memex pr-status [--apply]` maps the branch PR's state onto each
  in-repo memory (merged → `published`, approved → `approved`, changes
  requested → a suggestion only, never an auto-reject). Report by default;
  `--apply` performs the transitions locally.
- `open-memex resolve [id]` lists conflicted memory files, or field-level
  3-way-merges one. Semantic conflicts are **reported, never auto-resolved**.

**A rejection never deletes anything.** The file stays on your branch; what
happens next is the human's call:

1. **Accept**: close the PR and delete the branch — the file goes with it;
2. **Revise and resubmit**: edit, `promote --resubmit`, commit, push — review
   continues on the same PR;
3. **Keep as a record**: leave it visible with a `[rejected]` tag and your
   note, so the team can see what was considered and why not.

Finally: `list` / `search` show the review state (`[draft]` / `[proposed]` /
`[approved]` / `[published]` / `[rejected]`) next to project memories, and
retrieval ranks reviewed knowledge (`approved` / `published`) above unreviewed
outbox drafts — drafts stay findable, but never pose as vetted.

## 6. Sync: git is the courier, not the brain

- **Write**: `memory_add` (project scope) → writes the **appdata outbox** and
  updates the local index. **Never touches the repo, never auto-commits,
  never auto-pushes.**
- **Submit** (explicit, your call): `open-memex submit <id...>` → local commit
  into `.ai/open-memex/`; push/PR commands are printed for you (or done by your
  agent on your Yes).
- **Pull**: `open-memex pull` (always explicit, never automatic) → git fetch +
  fast-forward → scans `.ai/open-memex/*.md` → merges into the local `index.db`
  by file mtime. Retrieval always goes through SQLite, never walks git.
- **personal scope**: never syncs (§1 iron rule).
- **Projects without git**: keep working; project scope degrades to
  path-keyed local memories with a clear notice. Nothing breaks.

## 7. Security model

- **Memory is data, not instructions.** Memories come back into the agent's
  context as text to *use*, never as commands to obey — including memories
  that arrive via sync or were written by other people. There is no automated
  screening of shared memory; the real boundary is the human review in §5
  ("is this true? is it safe? any secrets?") plus this data/instruction
  separation. Read shared memories the way you'd read a wiki page a stranger
  edited.
- **Provenance travels with the file.** Each memory records its `source`,
  and review-track memories carry `proposed_by` / `approved_by` plus the
  append-only `review_history` — all inside the Markdown file itself, so the
  trail survives branches, PRs, and exports.
- **Secrets are stopped at write time.** `<private>…</private>` sections are
  stripped before saving; recognized API keys and tokens are masked in place
  (first 4 characters kept, so you can tell which key it was) and the write
  proceeds. Preview with `open-memex capture --dry-run`.
- **personal never enters git** (§1) — not by `submit`, not by `export`
  defaults, not ever.

---

*Design record: `docs/V2-DESIGN.md` (append-only decision log). Per-scope
details: `docs/SCOPES.md`. Reviewer convention: `docs/CURATOR.md`.*
