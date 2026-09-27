# Scopes

**Scope = ownership** (who owns the memory). It answers "whose memory is
this and where does it live", not "who may read it" — that's `visibility`,
a separate v2 field (see below).

## The three scopes

| Scope      | Owner            | Lives where                          | Synced?        |
|------------|------------------|--------------------------------------|----------------|
| `personal` | you              | this machine only (`memories/personal/`) | **never** |
| `project`  | repo collaborators | this machine, keyed by repo (`memories/project__<name>__<hash>/`) | via git, only if you opt in |
| `org`      | org members      | dedicated org memory repo (planned)  | via git (planned) |

**`personal` never leaves the machine.** No sync, no upload, no exceptions.
Put anything here that should never be shared: credentials-adjacent notes,
private preferences, personal instructions.

**`project`** is the default for new memories. It is keyed off the repo, so
the same project resolves to the same scope on every machine.

**`org`** is reserved for a future dedicated org memory repo. The schema
accepts it; the CLI does not create org scopes yet.

## How the project key is derived

`resolveProjectScope(cwd)` (`src/scope.ts`):

1. Read `git config --get remote.origin.url` in the cwd.
2. If a remote exists: normalize it (strip `.git`, `git@host:` → `https://host/`,
   lowercase) and take `sha256(normalized).slice(0, 12)` as the key suffix.
   The project name comes from the last URL path segment.
3. If no remote: fall back to the absolute cwd path (lowercased), hashed the
   same way. This is also how v1 "legacy" scopes are detected during
   migration when a repo gains a remote later.

Key format: `project__<sanitized-name>__<12-hex-chars>`, e.g.
`project__open-memex__9e2a8a546c21`. The 12-char hash keeps collisions
astronomically unlikely while staying readable in `ls`.

## CLI

```
open-memex add "content" --scope personal      # default is project
open-memex list --scope personal
open-memex search "query" --scope both         # project + personal
open-memex scopes                              # list all known scope dirs
open-memex migrate --from <old-key> --to <new-key> [--dry-run]
```

`--scope user` is accepted as a deprecated alias of `--scope personal`.

When a repo gains a git remote after memories were already stored under the
cwd-based key, `migrate --from <cwd-key> --to <remote-key>` moves them
(`scopes` shows you the exact keys). Nothing is automatic — you run it
explicitly, previewing with `--dry-run` first.

## v1 → v2 rename

v1's `user` scope is renamed to `personal` in v2 (design §19 — "user" was
ambiguous next to "org members are users too"). `open-memex migrate --to-v2`
moves `memories/user/` → `memories/personal/` and rewrites the frontmatter
(`scope: user` → `scope: personal`). A dated backup of the pre-migration
tree is kept. Reads remain backward compatible: a v1 file with `scope: user`
is interpreted as `personal`.

## Visibility (planned, not yet enforced)

v2 frontmatter carries a separate `visibility` field (`private` | `internal` |
`shared`). The intended rule: `visibility: private` inside a shared scope is
**physically isolated** — written to a local-only cache directory, never
under `.open-memex/` — rather than relying on `.gitignore`. This is not
implemented yet; today, treat `personal` as the only confidentiality
boundary and review anything you place under `.open-memex/` before pushing.

## Reserved names

`team` and `public` are reserved scope names: the schema rejects writes to
them. Rationale: `project` already expresses team sharing; a distinct `team`
scope needs a clear semantic difference (e.g. cross-repo) before it earns
existence.
