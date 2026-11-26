# Auto-capture design

Status: **DRAFT for review** — not approved, not built. Revised 2026-11-26 per thinktank review (standard tier, $0.13, verdict REVISE).
Date: 2026-11-26. Author: Muse.
Parent: V2-DESIGN §18 item (7). Companion spec: `docs/design/three-tier-zones.md`
(PR #85, merged 2026-11-26).
Related: D67 keyword capture · D73 hand-off note · D78 curate+submit (D93/D95) ·
D89 working state (D90) · D94 `wake` ritual · `distill-agents` CLI.

## §1 Why

Sessions produce durable knowledge — decisions, corrections, gotchas, repo changes —
that evaporates unless the user remembers to save it. Today open-memex only captures
what the user explicitly saves, plus D67 keyword hits from user text. Everything the
agent did, and everything the user decided mid-session, is lost when the process exits.

ai-memory solves this by capturing everything. open-memex will not: capture-everything
pollutes the index, and a polluted index taxes every future retrieval. Auto-capture
under the restraint philosophy means: **stage candidates deterministically, save
nothing without a human accept.**

This spec answers the five open questions from §18 (2026-10-19) before any code is
written. Question 1 was checked first, against primary sources, because the whole
design depends on it — and its answer changes question 5.

## §2 Principles

1. **Restraint.** Rather over-ask than over-save. A declined candidate costs one
   keypress in a batch review; a wrongly saved memory costs every future retrieval.
2. **Deterministic first, zero LLM in the capture path.** What happened is computed
   by rules. What it means is supplied by the agent already in the loop, or by the
   human at confirm time. No new model calls, no new auth, no new cost.
3. **Staging is durable on disk.** The plugin dies with the opencode process. Any
   candidate held only in memory is lost on quit — which is the most common way a
   session ends. Idle checkpoints write to SQLite synchronously.
4. **No auto-save in v1.** Observe first (zones §8 precedent): compute, stage,
   report. The flip to auto-save of the clearly-valuable class needs its own gate.
5. **Confirmation is batched, never per-item, never per-turn.**
6. **Zones govern where saved items land.** An accepted candidate enters Warm, like
   any new memory (zones §3). Hot is earned by D77 evidence, never granted at
   capture time.
7. **Every action undoable** (D78). Accept and decline are both reversible. A
   declined candidate leaves zero trace in the *memory index* and in the D77
   retrieval counters — but its staging row is retained for the undo window
   (§8), so 'zero trace' never means the row itself disappears.

## §3 Q1 — End-session trigger: what opencode actually exposes

Checked 2026-11-26 against primary sources: the official plugin docs
(opencode.ai/docs/build/plugins/server, crawled 2026-11-26 20:45 UTC) and the
installed SDK types (`@opencode-ai/plugin` 1.18.30, `@opencode-ai/sdk` 1.18.30 —
the versions this repo builds against).

### What does NOT exist

- **No SessionEnd hook, in either generation.** The V2 `SessionHooks` interface is a
  closed list: `prompt, context, compaction, generate, title, fork,
  experimental.model.resolve, model.request, http.request, http.response,
  experimental.ws.*, retry`. No `idle`, no `deleted`, no end-of-session hook.
- **No `experimental.idle` session hook** in the official surface. (A third-party
  plugin maps Claude's Stop onto the `session.idle` *bus event*, below — that is
  an event subscription, not a hook.)
- **No process-exit signal.** Nothing fires when the user quits the TUI, `opencode
  run` ends, or the server stops. `setup` may return a cleanup function that runs
  on plugin unload, but a killed process gets no cleanup, and unload has no session
  context and no model call — it can only flush what is already staged.

### What DOES exist

The session lifecycle is observable as **bus events**, reachable two ways:

| Signal | V1 plugin | V2 plugin | Payload | Semantics |
|---|---|---|---|---|
| `session.idle` | `event` hook | `ctx.event.subscribe` | `{ sessionID }` | Agent finished a turn; session is idle |
| `session.deleted` | `event` hook | `ctx.event.subscribe` | `{ sessionID, info }` | Session explicitly deleted |
| `session.error` | `event` hook | `ctx.event.subscribe` | `{ sessionID?, error? }` | Session errored |
| `session.created` / `updated` / `status` | `event` hook | `ctx.event.subscribe` | `{ sessionID, ... }` | Lifecycle bookkeeping |
| `session.compact(ed)` | `event` hook | `ctx.event.subscribe` | — | Compaction ran / is running |
| `compaction` hook | n/a (v1) | `ctx.session.hook("compaction")` | `{ messages }` | Runs for checkpoint summaries; can set `result` |
| `tool.execute.before/after` | v1 hooks | — (see note) | tool call + args | Tool-call observation |
| `message.updated` | `event` hook | `ctx.event.subscribe` | — | Transcript changes |

Notes:

- The V1 `event` hook (`Hooks.event`, installed types `index.d.ts:175`) receives every
  bus event; the V2 equivalent is `ctx.event.subscribe({ types })` (official docs).
  The event names above are verified in the installed SDK generated types, identical
  in the v1 and v2 unions.
- **Deletion is not exit.** SessionEnd fires on session *deletion*, not on process
  exit (third-party plugin docs, consistent with the event semantics). The common
  case — user quits — produces no `session.deleted`.
- V2 tool-call observation is the one gap: there is no v2 tool hook, and the v2 event
  union shows no `tool.execute.*` event type. The v2 fallback is deriving tool calls
  from `message.updated` (assistant messages carry tool parts). Exact v2 coverage is
  acceptance A1, confirmed by live probe, not assumed here.

### The trigger ladder (recommendation)

There is no single session-end moment, so v1 uses a ladder — each rung covers the
cases the rung above misses:

1. **`session.idle` — per-turn deterministic checkpoint (the workhorse).** On every
   idle event, append that turn's "what happened" to the staging table (§8). One
   SQLite write per turn, synchronous and durable; no LLM; no user-visible effect.
   This is what makes the design quit-proof for completed turns: by the time the
   user quits, everything from finished turns is already staged.

   Race window: a hard kill between a turn completing and the `session.idle` write
   committing loses that turn's candidates. The window is small (one synchronous
   write per turn), but it is real — the design is *not* quit-proof for the
   in-flight turn, and no rung below closes it. A3 tests the completed-turn case
   only.
2. **`session.deleted` + `session.error` — session-closed flag.** Mark the session
   closed, freeze its candidates for review. This fires only on explicit delete or
   error — a minority of endings — so it is a flag, not the trigger.
3. **Explicit command — immediate finalize.** A `/memex-capture` command (and the
   `open-memex capture-review` CLI) runs distillation + the batch review on demand,
   in-session. This is the ai-memory `finalize-session` fallback, adopted as a
   first-class trigger rather than a fallback.

Deferred to v2 (not in the v1 ladder): the `compaction` hook / `session.compact`
pre-compaction capture (a safety net for what the per-turn pass missed — dedupe by
evidence pointer, §11 Q7); the plugin-unload best-effort flush (writes staged rows,
nothing else; assumes it may never run); and the out-of-process PID watcher (the
seance pattern — a second process outside the plugin, contradicting local-first
simplicity; revisit only if the ladder proves lossy in practice).

### Consequence for Q5

Because there is no reliable moment *at* session end to ask the human anything, the
batch confirmation cannot happen at session end. It moves to **next session start**
(§7). The ladder's job is to make sure the candidates survive until then.

## §4 Q2 — Distillation: rules first

Two layers. Layer A is built; layer B is deliberately not built in the capture path.

### Layer A — "what happened", deterministic, zero LLM

Inputs, all already observable without new API:

- **User text** — `chat.message` / `prompt` hook. Already D67: keyword capture fires
  from user message parts. Auto-capture reuses the same text, not a second read.
- **Tool calls** — v1 `tool.execute.before/after` hooks (installed types, lines
  235/249). What ran, with what arguments, success or failure. V2: derived from
  `message.updated` (A1 probe).
- **Repo state** — the D89 working-state machinery already reads git status, branch,
  stash, and the changed file list. A turn's `git diff --stat` is the same read,
  scoped to the turn.
- **Decision sentences** — pattern rules over user + assistant text ("decided",
  "from now on", "don't", "always", "never", explicit corrections). Heuristic, so
  it is fixture-pinned: a labeled fixture of session excerpts, rules tuned until
  precision on the clearly-valuable class is high. A pattern that fires wrongly is
  a bug in the rule, fixed in the rule — never papered over with a model call.

Layer A output per turn: a short list of candidate records (text + evidence pointer:
turn number, tool call, diff hunk). Candidates are staged, never saved.

### Layer B — "what it means", not in the capture path

Interpretation is supplied where a model call is already being paid for, or by the
human:

- The agent in the loop can already restate a candidate in its own words when it
  surfaces one — that is interpretation, and it costs nothing extra.
- The human supplies the verdict at batch-confirm time (§7): save / discard / edit.
  Editing the text *is* the interpretation step for ambiguous candidates.

No new model calls, no provider config, no API keys, no per-turn cost. If a future
version wants LLM distillation, it goes through the agent loop (a tool the agent
calls), not through a plugin-side model client.

## §5 Q3 — Save-value triage: three classes

Pre-sort is deterministic rules only. No LLM judge in v1. The human's batch decision
is the actual triage; the classes only order the batch and set defaults.
Named 'classes', not 'tiers', to avoid collision with the zones spec's Hot/Warm/Cold tiers.

### Class 1 — clearly valuable → save-candidate (pre-checked in the batch UI)

- An explicit user decision or preference ("decided X", "from now on", "always/never").
- A correction of a prior memory or of the agent's stated fact.
- A repo-affecting change: commit, branch switch, config change, dependency change.
- An error + fix pair (the fix is the durable part; the error alone is not).
- A gotcha: something that cost time and will cost time again.

### Class 2 — clearly noise → drop (pre-checked as discard, staged only for audit)

- Transient exploration with no durable outcome (tried X, reverted, moved on).
- Repeated or already-answered questions.
- Tool-call chatter with no durable outcome.
- Sessions with no user decision and no repo change.

### Class 3 — ambiguous → ask (default bucket)

- Everything else. When in doubt, stage it and let the human decline. A declined
  candidate costs one keypress; a wrongly saved memory costs every future retrieval.
  The over-ask principle (§2.1) is implemented here: **the default bucket is ask,
  not save and not drop.**

Triage rules live in one place, are fixture-tested, and are versioned with the
spec. Thresholds (e.g. how many tool calls make a "session with no outcome") are
calibrated from the observation phase (§9), not hard-coded from intuition.

## §6 Q4 — Routing: four exits, simple v1 rules

| Candidate | Exit | Rule |
|---|---|---|
| Work done in this project | Project memory | Default: the session's scope. Project scope if the session worktree is a project scope, else personal |
| About the user's own workflow / preferences, not the project | Personal memory | Item mentions the user's habits, tools, or preferences with no project anchor |
| A durable rule, decision, or gotcha | AGENTS.md proposal | Candidate type is decision/gotcha/rule → propose via the existing `distill-agents` path (`--type decision,gotcha`), never write AGENTS.md directly |
| Class-2 noise, or human declines | Discard | Leaves zero trace in the memory index and D77 counters (staging row retained for the undo window, §8) |

Guardrails:

- Routing is applied **before staging**, not only in the batch. A candidate whose
  proposed route is personal is staged in the *personal* scope's `index.db`, never
  in a project scope's `index.db` — a personal item sitting in a project database
  file is a privacy failure even before anything is saved. The batch may still
  re-route per item, but the staging location follows the *proposed* route, and
  re-routing moves the row.
- Routing is a **suggestion in the batch**, not a decision. The human confirms or
  re-routes per item.
- Never auto-route personal → project. Project → personal only on explicit human
  choice. (A personal item leaking into a shared project index is a privacy failure,
  not a UX nit.)
- Saved items land in Warm (§2.6). Routing never promotes to Hot.

## §7 Q5 — Human interaction: one batch, at next session start

The §18 brief said "one batch confirmation at session end". Q1's answer moves it:
**the batch happens at the next session start**, carried by the `wake` ritual
(D94, documented session-start convention — the other bookend of this feature).

- **Next-start batch (default).** When a session starts, the wake note carries only
  a count and a pointer: "Last session staged N candidates — /memex-capture to
  review." Full candidate text, evidence pointers (turn #, tool call, diff hunk),
  and proposed routes live in the review UI (the command, or `open-memex
  capture-review`), not in the wake note — the note already carries the zones
  resident layer, and injecting full candidate text would bloat it and risk
  re-capture loops. One screen in the review UI, accept-all / decline-all / edit
  per item. Nothing is written before the decision (D78 batch-confirm precedent,
  D95).
- **Explicit command (immediate).** `/memex-capture` in-session, or `open-memex
  capture-review` from the CLI, runs the same batch immediately. For users who
  want to close the loop before quitting.
- **Never per-item popups, never per-turn asks.** An idle-time nudge was considered
  and rejected: idle fires after every turn, so asking at idle is per-turn asking
  with a different name. The batch waits for a start or a command.

If the user never returns (one-off session), staged candidates age out: the
retention window is **30 days** as a placeholder (calibrated from observation
data, §9); expired staging rows are dropped by `curate`-style cleanup, never
auto-saved.

## §8 Data model — the staging table

Candidates are **not memories** until a human accepts them: never injected, never
counted in D77 `retrieved_count` (zones §4 counting rule applies — staging is not
retrieval), never visible to search.

A `staging` table in the **routed** scope's `index.db` (§6: routing is applied
before staging, so a personal-route candidate is staged in the personal scope's
`index.db`, never in a project scope's), beside D77's `memory_usage` table
(same pattern, same file, same durability):

| Column | Meaning |
|---|---|
| `id` | Staging row id |
| `session_id` | Which session produced it |
| `scope` | Project or personal scope root |
| `turn_no` | Turn within the session (evidence pointer) |
| `source` | `user-text` / `tool-call` / `git-diff` / `decision-sentence` |
| `text` | Candidate text (Layer A output) |
| `evidence` | JSON, typed schema: `{ kind: 'turn' \| 'tool-call' \| 'diff-hunk', ref: string }` — turn number, tool call id, or diff hunk reference |
| `proposed_route` | Project / personal / AGENTS.md proposal / discard |
| `triage_class` | 1 / 2 / 3 (§5) |
| `status` | `pending` / `accepted` / `declined` |
| `created_at` | Timestamp |

Accept moves the row's text into the scope index as a Warm memory (normal save path,
normal D77 counters from then on) and marks the row `accepted`. Decline marks the
row `declined` and writes nothing to the memory index — the row itself stays in
the staging table for the undo window (§2.7: 'zero trace' means zero trace in the
memory index and the D77 counters, not that the row disappears). Both are undoable
through the existing `curate undo` machinery — accept is undone by removing the
saved memory, decline is undone by flipping the row back to `pending`.

## §9 Rollout — observation first

Zones §8 precedent, applied here:

- **v1 computes, stages, and reports only.** No auto-save of any class, including
  class 1. A `sync-status`-style report shows the staging distribution (candidates
  per session, class mix, accept/decline rates once humans start reviewing).
- **Flip bar for auto-saving class 1** (a separate decision, not this spec): human
  accept rate on class-1 candidates ≥ 0.9 over a labeled observation window, zero
  per-turn interruptions measured, and retrieval quality on the fixture not
  degraded by accepted items. Until then, every save goes through the batch.
- Retention window for unreviewed staging rows is 30 days as a placeholder (§7);
  the observation data calibrates it.

## §10 Acceptance criteria

- **A1 — Live probe.** A probe session on both adapters (v1 plugin, v2 adapter)
  records which events actually arrive: `session.idle`, `session.deleted`,
  `session.error`, `tool.execute.before/after` (v1), `message.updated` (v2 tool
  derivation). The trigger ladder (§3) is built only on signals the probe confirms.
  The probe log also confirms the `compaction` hook name (older plugin surfaces
  exposed `experimental.session.compacting` — do not assume the name from this
  draft) and whether a normal quit waits for pending event handlers before the
  process exits.
- **A2 — Zero-LLM capture path.** An idle checkpoint writes staging rows with no
  model call and no user-visible latency (one SQLite write per turn).
- **A3 — Quit-proof for completed turns.** Kill the opencode process mid-session;
  all staged rows from completed turns survive and appear in the next session's
  wake batch. The in-flight turn is out of scope (§3 race window).
- **A4 — Batch review works.** Next-start wake batch lists candidates with evidence
  + proposed routes; accept-all / decline-all / per-item edit all behave; nothing
  is written before the decision.
- **A5 — Nothing saved without a human accept.** With the batch declined, the
  memory table and the D77 retrieval counters are identical (no new memories, no
  counter movement). The `index.db` *file* is not byte-identical — staging writes
  happened — so the invariant is the memory table and the counters, not the file.
- **A6 — Undo works.** Accept-then-undo removes the memory; decline-then-undo
  flips the row back to `pending`.
- **A7 — No per-turn interruption.** A full session with auto-capture on produces
  zero prompts, zero popups, zero extra user turns.

## §11 Open questions

- **Q6 — Idle debounce.** `session.idle` fires per turn; the checkpoint is one
  SQLite write per turn, which needs no debounce. If a turn produces dozens of
  candidates, cap the per-turn staging write and note the cap in the report.
  (Calibration from observation, not a constant in this spec.)
- **Q7 — Compaction-hook capture scope.** **Deferred to v2 with the compaction rung
  (§3).** When it returns: the hook sees the full `messages` being summarized —
  staging from the compaction pass must dedupe against the per-turn checkpoints by
  evidence pointer, so it is a safety net, not a second pipeline.
- **Q8 — Concurrent sessions, one scope.** **v1 assumes one active session per
  scope** (the assumption is documented here, not enforced). Rows are keyed by
  `session_id`, so if two sessions do stage concurrently, the next-start batch shows
  each session's candidates separately. Cross-session dedupe is observation-phase
  work, not v1.
- **Q9 — The `wake` batch and the zones resident layer.** **Resolved: the wake note
  carries a count + command only (§7).** The wake note already carries the resident
  layer (zones §6). The candidates batch rides the same note as a count — "N
  candidates — /memex-capture to review" — with full text in the review UI. Token
  budget for the combined note is observation-phase work.

## Sources

- OpenCode official docs, Server plugin page (opencode.ai/docs/build/plugins/server,
  crawled 2026-11-26 20:45 UTC): `ctx.event.subscribe` (§ Events), `SessionHooks`
  closed list (§ Session reference), `setup` cleanup (§ setup).
- Installed SDK types, `@opencode-ai/plugin` 1.18.30 /
  `@opencode-ai/sdk` 1.18.30: `Hooks.event` (`plugin/dist/index.d.ts:175`),
  `tool.execute.before/after` (lines 235/249), bus-event unions incl.
  `session.idle` / `session.deleted` / `session.error` (v1 + v2 generated types,
  identical lists).
- Third-party plugin docs (secondary): opencode-claude-hooks — "SessionEnd: fired
  on session deletion, not on process exit"; seance opencode integration — wrapper
  tracks PID, fires session-end on exit; true-mem DeepWiki — `session.idle` →
  queue extraction, `session.deleted`/`session.error` → end-of-session maintenance.
- Repo: `src/index.ts` (v1 hooks in use), `src/opencode-v2.ts` (v1/v2 hook mapping,
  duck-typed `session.hook("prompt" | "context")`), `src/distill-agents.ts`,
  `src/cli.ts` (`distill-agents`, `capture-review` to be added), AGENTS.md (D67/D73/
  D78/D89/D94), V2-DESIGN §18 (7) brief.
