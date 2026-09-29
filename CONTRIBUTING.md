# Contributing to open-memex

## Branch workflow

- `main` — the v2 line. Never commit directly; land work via pull request
  from a dev branch. Alpha versions (e.g. `0.5.0-alpha.x`) live on `main`;
  publish them with `npm publish --tag alpha` so the npm `latest` tag only
  moves on stable releases.
- `dev/<topic>` — feature/fix branches (e.g. `dev/init-ux`). Open as **draft**
  PRs against `main`; mark ready and merge after local testing passes.

(The `V2` integration branch was retired 2026-09-29 — it existed only to
isolate the breaking v1→v2 transition, which shipped with 0.3.0. If a future
breaking change ever needs isolation, create an integration branch then;
branches are cheap.)

## Before opening a PR

- `npm run typecheck` is clean
- `node --experimental-strip-types scripts/smoke-pure.ts` passes
- If you touched SQLite/FTS: `open-memex reindex` works against a scratch
  `MY_O_MEMORY_HOME`
- No secrets in fixtures (redaction tests are the exception)

## Design authority

Protocol decisions live in `docs/V2-DESIGN.md` (frozen v0.2, decision log
D1–D13). Changing architecture, scope semantics, lifecycle, or the protocol
surface (frontmatter schema, MCP tools, CLI contract) requires updating the
design doc first. `AGENTS.md` has the working notes for AI agents; this file
has the contributor workflow.
