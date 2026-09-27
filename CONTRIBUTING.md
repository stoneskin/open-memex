# Contributing to open-memex

## Branch workflow

- `main` — stable. Mirrors the npm release line. Never commit directly;
  only merge from `V2` when a milestone is tested and ready to release.
- `V2` — integration branch for the v2 line. Phase work lands here via
  pull request. Merges to `main` only after the milestone is dogfooded
  (plugin tested in opencode, `migrate --to-v2 --dry-run` clean on real data).
- `V2-dev-p<n>` — phase dev branches (e.g. `V2-dev-p1`). Open as **draft**
  PRs against `V2`; mark ready and merge after local testing passes.

**Naming rule:** never create `V2/<anything>` — git cannot hold a branch
named `V2` and a branch named `V2/…` at the same time (ref file vs.
directory conflict). Use the flat `V2-dev-*` form instead.

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
