---
name: open-memex
description: Persistent local-first memory for the user and their projects. Use when the user shares facts, preferences, or decisions worth remembering across sessions, or when you need to recall past context before answering.
---

# open-memex — local memory

open-memex gives you persistent memory across sessions. Memories live in local
markdown files (SQLite FTS index); the `personal` scope never leaves this machine.

If `open-memex` MCP tools (`memory_add`, `memory_search`, …) are available in
this session, prefer them. Otherwise use the CLI below. If `open-memex` is not
on PATH, prefix commands with `npx -y open-memex@latest`.

## Save — be proactive

When the user shares something worth remembering — a fact, preference,
decision, convention, or error fix — save it without being asked:

```sh
open-memex add "standup is at 9:30"                        # current project scope
open-memex add "I prefer concise diffs" --scope personal   # applies everywhere
```

Keep each memory one self-contained statement. Scope routing: facts about the
user ("I"/"me") → `personal`; everything else → the current project.

Worth saving: decisions and their reasons, preferences, conventions, gotchas,
approaches tried and abandoned. Not worth saving: one-off task details or
anything re-derivable from the code.

Attach alternate phrasings when saving — synonyms, another way the question
might be worded, equivalents in the user's other language — so reworded
questions still find the memory:

```sh
open-memex add "Public holidays are listed in the HR portal" --aliases "holidays;time off;节假日"
```

(Aliases are stored only when the install has capture aliases enabled — the
init default.)

## At task checkpoints — propose, don't just save

For conclusions you infer yourself (the user never stated them): when you
finish a task the user would describe in one sentence, propose 1–3 short
memories capturing the useful conclusion (what was learned or decided, how an
issue was resolved, what to avoid, where the authoritative doc lives — not the
raw transcript). Save nothing the user did not approve; on approval, save it —
with the `memory_add` tool pass `source: "inference"` so the capture is marked
as agent-proposed. Don't interrupt mid-task, and don't re-propose something
the user already declined.

## Recall

```sh
open-memex search "deployment steps"   # keyword search across scopes
open-memex list                       # recent memories in the current project
```

Search before asking the user about past decisions or preferences they may
have told you before. Search well: break the question into its concepts and
try 2–3 phrasings per concept — synonyms, the user's other language, shorter
keyword forms — and check the other scope too, before concluding nothing is
stored.

## Seeing and removing what is remembered

When the user asks "what do you remember about me?" (or wants to check or
clean up), show them the inventory:

```sh
open-memex inventory              # everything remembered, read-only
```

In chat, present the memories conversationally — turn the fields into
plain words (who the words came from, when it was saved, project or
personal) instead of reading raw ids. If the user asks to remove one,
read the entry back in full and get a confirmation before deleting —
deletion is permanent, there is no undo. If they hesitate, offer hiding
instead (`--soft`): it leaves lists and search but the file survives.

```sh
open-memex forget <id>          # delete (permanent)
open-memex forget <id> --soft   # hide (retracted, one-way)
```

## Project outbox → repo (the sync flow)

New project memories land in a local outbox (not in git). Review and publish:

```sh
open-memex sync-status     # drafts waiting, repo review state, uncommitted files
open-memex submit <id>     # publish drafts to .ai/open-memex/ + local commit
```

If any command output reports drafts waiting in the project outbox, run
`open-memex sync-status` and ask the user which drafts to sync. The user may
also trigger this flow by saying "sync memory".

Run `open-memex <command> --help` for full usage of any command.
