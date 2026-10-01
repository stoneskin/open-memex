# OpenMemex User Guide

> This document describes open-memex's **mental model**: where your memories live,
> how they flow, and who can see them. The in-repo directory (§2, §6 write path)
> and the propose → promote → resolve workflow (§5) shipped in 0.4.0
> (Phase 2B); everything described here is current as of 0.5.0.

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
| Holds | `memories/personal/` personal memories; project-scope **draft outbox**; `index.db` local index | Submitted project memories (`proposed` and up) |
| In git? | No | Yes — git is its courier |
| The index? | `index.db` is rebuildable, **never committed** | No index stored; rebuilt from Markdown on demand |

The private notebook (personal) never goes on the shelf. That's an iron rule, not a setting.

Project memories start life as **drafts in the appdata outbox** — git-invisible,
branch-independent. Only drafts you explicitly name move to the shelf, via
`open-memex submit` (§5). One stage, one home: after a successful submit the
outbox original is gone; before it, the repo knows nothing.

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
personal idea ──propose──▶ outbox draft ──submit──▶ proposed ──┬──promote──▶ approved ──promote──▶ published/shared
                                                              │                        │
                                                           --reject                 --reject
                                                              │                        │  (approval withdrawn
                                                              ▼                        │   before merge)
                                                           rejected ──resubmit──▶ proposed
```

- `open-memex propose <id...> --to project`: **copies** one or more personal
  memories into the **appdata outbox** as review candidates (`review_state:
  draft`, each with its own new id, `derived_from` pointing back at the
  personal original). **Copy, not move — the personal original stays.**
  All-or-nothing: a bad id aborts the whole batch. Nothing touches the repo
  yet — the outbox is git-invisible and branch-independent.
  Solo devs can use `--local-approve` to self-approve.
- `open-memex sync-status`: shows **when the index was last synced** (and
  what triggered it — session start, a request, a CLI run, a submit), the
  outbox (pending sync), the repo review states
  (`draft / proposed / approved / published / rejected`), and any uncommitted
  repo memory files. Your agent calls this at session start, at meaningful
  checkpoints, after you commit, and after memory actions — then asks which
  drafts (if any) you want synced. You can also just say "sync memory".
- `open-memex submit <id...>`: moves **your named drafts** into
  `<repo>/.ai/open-memex/` as `proposed`. It copies the files, flips
  `review_state`, and makes a **local** git commit **on your current branch** —
  it never creates a branch on its own (branch creation is your call, or your
  agent's with your explicit approval via `--branch <name>`).
  All-or-nothing, idempotent, crash-safe. It prints the `git push` +
  `gh pr create` commands; if your agent already has your Yes for this sync,
  it carries through push and PR itself. The PR base defaults to the current
  branch; `--base` redirects to `main` or your integration branch.
  Same id with different content on the branch **aborts** — a human decides,
  never auto-overwrite.
  - Keep the four jobs straight: **propose crosses the boundary**
    (personal → project outbox, the only step that copies across);
    **submit moves drafts into the repo** (outbox → `.ai/open-memex/`,
    `draft → proposed`); **promote only flips the status label** on a file
    already in `.ai/open-memex/` (`proposed → approved → published`) — it
    never moves files between directories; **git does the transport**
    (push, PR, merge).
- A standalone memory PR contains **only memory files, no code**, reviewed and
  audited separately from code PRs. Reviewers check "is this true? is it safe
  to share? any secrets?" — things a code PR's CI never checks. You create the
  branch yourself when you want one (or your agent does, with your approval).
- "Request changes" needs no command: while the PR is open, the author edits
  the same file (directly, or by asking their agent in chat), commits, and
  pushes. The state stays `proposed`; the PR is the review mechanism.
- `open-memex promote <id>`: advances the memory one step up the ladder
  (`proposed → approved → published`). `--reject --note "..."` rejects with a
  reason (also allowed from `approved`, before merge — withdrawing approval).
  Every transition is appended to the memory's `review_history` — who moved it,
  when, from what to what, and why — so the review trail survives long after
  the PR is closed.
  After the PR merges, run `promote <id>` once more to mark it `published`
  — or let `pr-status --apply` do it for you (below).
  (Lifting project memories to org level is Phase 4.)
- **A rejection never deletes anything.** The file stays on your branch; what
  happens next is the human's call:
  1. **Accept**: close the PR and delete the branch — the file goes with it
     (the local index cleans itself up on the next sync);
  2. **Revise and resubmit**: edit the file, run
     `open-memex promote <id> --resubmit`, commit, push — review continues on
     the same PR;
  3. **Keep as a record**: leave it; it stays visible with a `[rejected]` tag
     and your note, so the team can see what was considered and why not.
- `open-memex pr-status [--apply]`: reads the current branch's GitHub PR
  and maps its state onto each in-repo memory's review state — merged PR →
  `published`, PR approval → `approved` (`approved_by` = the reviewer), review
  "request changes" → a suggestion for you to act on (never auto-rejects).
  Each memory keeps its own state: a human `rejected` is never overridden by
  a PR signal. Report by default; `--apply` performs the mapped transitions
  locally (no push). This is how a team review on GitHub closes the loop back
  into the memory index without new review UI.
- `open-memex resolve [id]`: with no argument, lists conflicted memory files;
  with an id, attempts a **field-level 3-way merge** of the YAML frontmatter
  (`tags` union, `updated_at` takes latest, body merged when only one side
  changed). Semantic conflicts — both sides changed the same field or the
  body differently — are **reported, never auto-resolved**: the file is left
  untouched for a human to decide.
- `list` / `search` show a `[draft]` / `[proposed]` / `[approved]` /
  `[published]` / `[rejected]` tag next to project memories in review, and
  retrieval ranks reviewed knowledge (`approved` / `published`) above
  unreviewed outbox drafts — drafts stay findable but never pose as vetted.

## 6. Sync: git is the courier, not the brain

- **Write**: `memory_add` (project scope) → writes the **appdata outbox** and
  updates the local index. **Never touches the repo, never auto-commits,
  never auto-pushes.**
- **Submit** (explicit, your call): `open-memex submit <id...>` → local branch
  + local commit into `.ai/open-memex/`; push/PR are printed for you (or done
  by your agent on your Yes).
- **Pull**: `open-memex pull` (always explicit, never automatic) → git fetch +
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

*Companion design record: `docs/V2-DESIGN.md` (decisions D1–D49).*
