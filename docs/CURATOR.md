# Curator Convention

The **curator** is the human who tends a project's shared memory. It is a
documented convention, not a permission system — anyone on the team can act
as curator; the tool records *who* did *what* (the audit trail), it doesn't
decide who is *allowed* to.

## What the curator does

1. **Triage proposals.** `open-memex propose` puts memories up for review.
   The curator reads them, then `open-memex promote <id>` to approve or
   `open-memex promote <id> --reject` to send back, with `--note` saying why.
2. **Resolve conflicts.** `open-memex resolve` lists file-level and semantic
   conflicts. The curator merges or picks a winner — Core never silently
   resolves a semantic conflict; both sides stay `active` until a human
   decides.
3. **Keep the garden.** Deprecate what's stale (`open-memex status <id>
   deprecated`), supersede what's been replaced, forget what's noise.
   Shared memory rots without pruning.
4. **Watch the pipeline.** `open-memex sync-status` shows the outbox, review
   states, and uncommitted files; `open-memex pr-status --apply` maps the
   GitHub PR state back onto `review_state`.

## Admission bar

Approve a memory when it is:

- **True** — you believe it, or it cites something verifiable.
- **Durable** — it will still matter in a month. Chat logs are not memories.
- **Scoped right** — project knowledge in project scope; personal stuff stays
  personal (personal memories are never the curator's business).
- **Well-typed** — `type` says what it IS (`decision`, `gotcha`, `lesson`…),
  `tags` say what it's ABOUT.

Send back (don't silently fix) when it's vague, duplicated, or belongs in
`docs/` as formal documentation instead — memory is the fast-changing long
tail, `docs/` is the slow-changing core.

## What the curator does NOT do

- **Never rewrite someone else's memory in place.** Propose a superseding
  memory instead — the chain (`supersedes` / `superseded_by`) is the audit
  trail.
- **Never approve their own proposals silently in team mode.** That's what
  `--local-approve` is for — solo projects only.
- **Never pull rank with the tool.** If the team disagrees with a call, the
  disagreement itself is worth a memory.

## Cadence

There is no required cadence. A workable default: triage proposals at the
end of each work chunk (the same checkpoint where §3.5 distillation runs),
and do a pruning pass when `sync-status` starts feeling noisy.

## Solo mode

No team, no curator needed. `open-memex propose --local-approve` records
`approved_by: self` and skips the PR. You are the curator, the proposer,
and the gardener — the same hygiene rules apply, just faster.
