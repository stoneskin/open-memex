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

## Recall

```sh
open-memex search "deployment steps"   # keyword search across scopes
open-memex list                       # recent memories in the current project
```

Search before asking the user about past decisions or preferences they may
have told you before.

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
