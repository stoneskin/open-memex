# Three-Tier Memory Zones — Policy Spec (draft)

*Status: draft 2026-11-26, revised four times same day — twice per Stone's
corrections (Hot's two layers; the zones stay three), then per the thinktank
review 2026-11-26 (standard tier, $0.11, judge picked grok), then per
Stone's correction that the working set persists per project, not per task.
Awaiting Stone's review. Spec-first per V2-DESIGN §18 (6): the promotion/demotion
policy is decided here; the build follows. This spec changes no code and no
protocol field. When built, it gets a `D<n>` decision entry in
`docs/design/decisions.md` and the §18 (6) status line moves in the same PR.*

> Source: V2-DESIGN §18 "Three-tier memory zones" (Stone 2026-10-18, from
> Westenberg "I Deleted My Second Brain" + his own reflection). The hard part
> was already named there: **the promotion/demotion policy** — what moves
> between zones, when, by what rule. This document answers it.

## 1. Intent

The second brain should have zones like cache vs database — not "keep
everything" vs "delete everything".

- **Hot** — active zone, cache-like: small, curated, always in context.
  Hot is filled two ways (§3): some memories **reside** here permanently
  (stable across sessions and projects, e.g. habits and preferences), and the rest are **staged** per project (loaded for this project, swapped when the project changes). The staged ones
  still live in Warm; staging loads them into context, it does not move
  them — so this is still three residence tiers, not four.
- **Warm** — compost / incubation: not active but not cold; periodic review,
  rotted items deleted. This is "forget on purpose" as engineering.
- **Cold** — full archive: searchable, not resident.

A zone decides **where a memory lives in the agent's context budget**, never
whether it is true and never whether it is kept. Cold is not deleted. Hot is
not more true. Demotion never deletes; deletion stays a separate, explicit
human act.

## 2. Principles

1. **Residence, not truth.** Zone assignment is about context cost. A Cold
   memory is still retrievable by `memory_search` and still counts as
   knowledge; it simply never gets injected.
2. **Hot is earned, not default.** New memories start in Warm (incubation)
   and prove their way into Hot. The only exception is an explicit human pin.
3. **"Useful" ≠ "recently used" — and usefulness is relative to the
   current work.** A memory is not useful in the abstract; it is useful
   *for* something. Past-use counters (D77) are a prior — what this memory
   was good for before. Whether it belongs in Hot *now* is judged against
   the current work, the way RAG judges a passage against the query. The
   policy therefore takes the task as an input, not just the counters.
   (This is the point Stone named in §18: the cache-replacement problem
   for knowledge — now with the query attached.)
4. **Hot is filled two ways; the zones stay three.** The **resident** occupants are stable: habits, preferences, pinned items —
   things that are relevant whatever the project is. They do not rotate
   out. The **working-set** occupants are staged per project from
   the current work and persist while the project lasts: what one project
   needs, another does not. The distinction is residence vs staging: a
   staged memory keeps its home in Warm — the working set is
   not a fourth zone, it is how Hot gets filled for the current work. The
   resident layer is earned by sustained evidence (§5); the working set
   is staged by task relevance (§4), like RAG retrieval run before
   generation.
5. **Deterministic first.** v1 policy is rules over counters and retrieval
   scores a human can read and explain. LLM judgment is a later layer, not
   the v1 policy.
6. **No silent loss.** Nothing leaves Warm for deletion without a human
   (or a D78-style batch confirm). A rotted item is surfaced in a review
   queue; the queue proposes, the human disposes.
7. **Capture restraint is a separate gate.** Not everything deserves to enter
   even Cold storage. This spec governs movement between zones; admission
   stays with the capture rules (D67/D73) and the curator's admission bar.
8. **Zones are derived state, like the graph.** Zone membership is computed
   from counters + rules, stored in the index, rebuildable — not a new
   frontmatter field in v1. (One exception is under discussion: human pins,
   see open question Q5.) The working set is not even stored: it is
   re-staged every session from the task.
9. **Per scope, local first.** Zones are computed per scope; project Hot and
   personal Hot are separate sets. Personal never syncs (iron rule); team
   aggregation of `useful_count` is a server concern, out of scope for v1.

## 3. Zone definitions

| Zone (residence) | What it is | In context? | Searchable? |
|---|---|---|---|
| **Hot** | The working set's home: what the agent needs every turn. Bounded by a token budget, not a count. Contents: resident memories + the §20 compiled outline (which already covers part of Hot). | Always — this is the session-start injection set | Yes |
| **Warm** | The incubator and the compost heap. Every new memory lands here. Reviewed periodically; rotted items leave (to Cold, or to the delete queue). | On demand only (search / tool-triggered), except when staged into Hot for the current project | Yes |
| **Cold** | The archive. Everything ever kept, minus what a human deleted. Never injected, always searchable. | Never | Yes |

Hot's contents come from two sources. **Resident** memories live in Hot: habits, preferences, pinned items — small, earned by sustained
evidence, they do not rotate. **Staged** memories live in Warm
and are loaded into Hot for the current project, retrieved against the
current work before generation the way RAG stages passages before
answering. The working set belongs to the project, not the task: within
a project it persists across tasks and sessions and is refreshed
incrementally as the work changes — new relevant memories stage in, ones
that stop being relevant fade out by relevance and budget, not by a task
boundary. It swaps out only when the project changes. Staging is a load,
not a move, so the working set is not a fourth zone. Staging draws
from Warm only: a Cold memory never stages directly (§1, principle 1); it
must first return to Warm on proof (§5).

Hot's bound is a **token budget** (today's injection is 8 project + 5 personal
items at ≤240 chars each, ≈500 tokens worst case). Within one scope the
budget is shared by resident memories and the staged working set; project
and personal scopes have **separate budgets**, so one scope cannot starve
the other. When Hot exceeds its budget: (1) pins are never auto-evicted;
(2) unpinned resident items evict first, lowest-signal first — the working
set is what the current task needs *now*, and residents are re-earnable
from their counters; (3) the working set trims last, lowest
task-relevance first. Eviction demotes to Warm; it never deletes. (This
order follows the thinktank review 2026-11-26: the draft's original order
— working set first — would starve the current task. The dissenting view,
a safety valve letting high-relevance working-set items evict low-signal
residents, is recorded here and not adopted.)

## 4. Signals the policy may observe

| Signal | Source | What it says |
|---|---|---|
| `retrieved_count`, `useful_self` / `useful_team`, `reuse_rate` | D77 counters (`memory_usage`) | Evidence of use. `useful` is explicit only (tool, human approve, supersede) — exposure never counts as useful. This is the **prior**: what the memory was good for before. Counting rule: injection of a Hot member into context does **not** increment `retrieved_count` — only an explicit `memory_search` call, tool use, or human use counts as a retrieval. Without this rule the counters would certify themselves: injection would inflate retrieval counts and manufacture the very reuse it measures. |
| **Current-task relevance** | Retrieval against the current work (same BM25/FTS5 machinery as `memory_search`; the task is the query) | Whether the memory belongs in the working set *now*. This is the **query-time judgment**: usefulness is evaluated like a RAG passage against the query, not in the abstract. How the task is represented is open question Q7. |
| Zombies (`search-retrieved ≥ 5` and `useful == 0`) | D77-L3 reuse report | Candidates for demotion. Retrieval counted here is search-triggered only (see the counting rule above), so injection can neither inflate a zombie's count nor hide one. |
| Age (`created_at`, `updated_at`) | Frontmatter | Staleness input, never the sole trigger. |
| Lifecycle state | §3.3 (`active` / `superseded` / `deprecated` / `retracted` / `archived`) | `retracted` / `archived` are never in Hot or Warm. `deprecated` is Warm at most, and never staged into Hot (§5). |
| Graph edges, orphans, outline membership | §20 / D91 | A memory in the compiled outline, or with live neighbours, has structural signal. Orphans have none. |
| Curation decisions | D78 / `curation_feedback` | A memory merged away leaves Hot via the supersede chain. |
| Review state, type, tags, scope | §3 / §5 | Admission and routing context. |

Explicitly **not** a signal in v1: raw recency (see principle 3), LLM
judgment, and anything the policy cannot show its working for.

## 5. Promotion / demotion rules (v1, deterministic)

Numbers below are **initial values to be calibrated**, not constants. The
observation phase (§8) calibrates them from the histogram of
`useful`-event intervals: thresholds are set at the 80th percentile of
observed successful re-use, and re-checked before the injection flip. The
instrument is the D77 reuse report run against a real store: the policy is
right when the resulting Hot reads like "what I actually reach for" and
Warm reads like "stuff I might still need". Thresholds are tuned against
that reading, not asserted here.

- **Entry — everything lands in Warm.** A new memory (any scope, any
  capture path) enters Warm. Auto-captured items land in Warm too (zones
  govern where auto-capture lands, per §18).
- **Warm → Hot (resident) — on sustained evidence of use.** Promote when
  any of these holds: `useful_self ≥ 2` (personal scope), or
  `useful_self + useful_team ≥ 2` (project scope; `useful_team ≥ 2` alone
  also qualifies when self is absent), or `reuse_rate ≥ 0.5` with
  `retrieved_count ≥ 5`, or a human pinned it. A pin is immediate; the
  rest are evaluated on a periodic pass, not on every write. This is the
  layer where the counter-based promotion rule lives — it judges the
  memory's standing value across sessions. Outline membership is **not**
  a promotion trigger: it is a budget fact (§6), and it never blocks a
  demotion.
- **Pins are durable intent.** A pin is stored where it survives a rebuild
  (frontmatter or a dedicated store — build-time choice, Q5), so zone
  membership stays rebuildable derived state without losing human-defined
  Hot items.
- **Staging into the working set — on task relevance, per project (not a
  promotion).** Retrieval against the current work stages the top relevant
  memories into Hot, regardless of their counters — a memory useful for
  *this* task stages even if it has never been useful before. Staging
  draws from **Warm only** and explicitly excludes `retracted`, `archived`,
  and `deprecated` memories. Staging changes nothing about where the memory
  lives: it keeps its home in Warm. There is no promotion event and no
  demotion event: the working set belongs to the project, not the task —
  it persists across tasks and sessions within the project and is refreshed
  incrementally (new relevant memories stage in; ones that stop being
  relevant fade out by relevance and budget, not by a task boundary), and
  swaps out only when the project changes. A staged memory that gets marked
  useful during the session also accrues D77 evidence toward the resident
  layer. First-turn injection is the resident layer plus the project's
  carried-over working set, if one exists from an earlier session; the
  working set refreshes once a real query exists (the first user message).
  With only a project scope key and no query, staging is scope-relative,
  not task-relative — the spec does not claim otherwise (Q7).
- **Hot (resident) → Warm — on loss of standing.** Demote when a resident
  memory is superseded or deprecated (leaves Hot immediately), retracted
  (leaves all residence), or evicted for budget reasons or zombie status —
  a zombie is a memory with `search-retrieved ≥ 5` and `useful == 0`.
  There is **no silence clock** for residents in v1: a habit or preference
  that goes unmarked for months is stable, not stale, and absence of a
  `useful` mark is not evidence against it. (The draft's original 30-day
  silence clock was removed per the thinktank review 2026-11-26.)
- **Warm → Cold — on no use.** Demote when a Warm memory records no
  `useful` signal within the decay window (initial placeholder 180 days,
  calibrated by the observation phase per §8 — the 80th-percentile rule,
  not a constant). Retrieval without utility does **not** reset the clock:
  a memory searched every month but never useful still decays. A young
  memory nobody used yet stays Warm; the clock runs on usefulness, not
  on retrieval.
- **Cold → Warm — on proof.** Any `useful` mark on a Cold memory moves it
  to Warm immediately — the usual path is retrieval by search followed by
  a useful mark; explicit human recall does the same. This is the only
  way back from Cold, and the only way a Cold memory can later be staged
  (§1).
- **Warm → delete queue — human only.** Rotted items (contradicted by a
  newer capture, superseded and aged, or flagged by `audit` / graph lint as
  stale) are surfaced in a standing review queue — the same queue the
  knowledge-upkeep direction (§18) already wants. The queue proposes;
  a human (or a D78-style batch confirm) disposes. Nothing auto-deletes.
- **Eviction — Hot over budget.** When resident + working set exceed the
  token budget: (1) pins are never auto-evicted; (2) unpinned resident
  items evict first, lowest-signal first (lowest `useful`, then lowest
  `reuse_rate`, then oldest `updated_at`) — the working set is what the
  current task needs *now*, and residents are re-earnable from their
  counters; (3) the working set trims last, lowest task-relevance first.
  Eviction demotes to Warm; it never deletes.

## 6. Interaction with existing mechanisms

- **First-turn injection (§3, CONCEPTS.md).** Today the injection set is
  "most recently updated". Zones give it a better definition: resident
  layer + working set staged from the current work. The injection is
  exactly the RAG pattern — retrieval runs before generation, and Hot is
  the staged result. First-turn injection is the resident layer plus the
  project's carried-over working set, if any; the working set refreshes
  once a real query exists (Q7). Staging from the scope key alone is
  scope-relative, not task-relative. **v1 does not flip this switch** — see §8,
  observation first.
- **§20 compiled outline.** The outline is Hot's compiled form. An outline
  entry **replaces** the member bodies it covers for budget purposes — its
  tokens are counted once, not once per member plus once for the entry.
  Outline membership is a budget fact, not a promotion trigger (§5): it
  neither promotes a memory nor blocks its demotion.
- **D78 curation.** Curation moves memories along the lifecycle; zones
  follow the lifecycle (a merged-away memory leaves Hot via supersede).
  The batch-confirm screen is the model for the delete queue (§5).
- **D77 reuse report.** The instrument for observing zones: `sync-status`
  shows the zone distribution (counts per zone, per scope) alongside the
  reuse report. No new surface in v1 beyond that line. Note the asymmetry
  the report makes visible: counters measure the resident layer's past;
  they say nothing about the working set's staging quality (§10).
  Counting rule: injection never increments `retrieved_count` (§4) —
  without it, the counters would certify themselves.
- **Auto-capture (§18 #7).** Auto-captured items land in Warm; their
  promotion follows the same rules. No special-case lane.
- **Injection-cost discipline (§18).** Hot is the always-on cost; Warm and
  Cold are on-demand (tool/skill-triggered loading). The spec's token budget
  (§3) is the enforcement point — and the working set is why the budget
  must be shared by both layers within one scope, not per-layer: a session
  with a heavy task still has to fit. Project and personal scopes are
  budgeted separately (§3).
- **Lifecycle (§3.3).** Zones never override lifecycle: `retracted` /
  `archived` are out of all residence; `deprecated` caps at Warm.

## 7. Non-goals for v1

- No LLM judge for promotion / demotion. Deterministic rules only.
- No auto-delete. Forgetting is human-confirmed or batch-confirmed.
- No new frontmatter field and no protocol change (see Q5 for the one
  possible exception).
- No team / server semantics. Cross-user `useful_count` aggregation stays
  a server-side concern.
- No change to retrieval ranking. Zones govern residence (injection), not
  recall order — D79 owns ranking.

## 8. Rollout: observation first

v1 ships **observation-only**: the policy computes zones (resident layer)
and `sync-status` reports the distribution, and the working-set staging is
computed and logged but not injected — the first-turn injection rule does
not change ("most recently updated" stays). The injection flips to
resident + staged working set in a second step, only after the zone
assignment and the staging on a real store read right to the human. This is
the measurement-before-mechanism discipline: the zone assignment and the
staging are the measurement; the injection flip is the mechanism.

The observation phase also calibrates the numbers: it records histograms
of `useful`-event intervals, and the decay/promotion windows are set at
the 80th percentile of observed successful re-use — the 180-day placeholder
(§5) and the promotion thresholds are replaced by calibrated values before
the flip, not asserted. The flip itself requires a measurable bar:
recall@5 ≥ 0.7 on a labeled staging fixture (§10) and a human audit of
the resident layer confirming no junk was promoted.

## 9. Open questions (for Stone)

- **Q1 — Entry zone.** New memories land in Warm by default; Hot is
  earned. *Recommendation: yes. The only exception is an explicit pin.*
- **Q2 — Hot's bound.** Token budget (≈500 tokens, today's injection
  size), shared by resident layer and working set within one scope — with
  project and personal scopes budgeted separately — rather than a count.
  *Recommendation: budget. Cost is what Hot actually consumes.*
- **Q3 — Demotion clock.** The resident silence clock is removed (a quiet
  resident is stable, not stale — §5). What remains is the Warm → Cold
  decay window: no `useful` within the window → Cold, with
  retrieval-without-utility not resetting the clock.
  *Recommendation: initial placeholder 180 days; calibrate from the
  observation-phase histogram (80th percentile of successful re-use)
  before the injection flip — do not hard-code it.*
- **Q4 — Warm → Cold: rule or human?** The rule proposes; a human
  confirms via the review queue — or the rule applies directly?
  *Recommendation: rule proposes, human confirms in v1. "Forget on
  purpose" wants a human in the loop until the rule has earned trust.*
- **Q5 — Pins: frontmatter field or index-only?** A human pin is user
  intent, and intent usually deserves durability (frontmatter survives a
  rebuild; index-only does not). But it would be the first zone-related
  frontmatter field. *Recommendation: decide at build time between
  frontmatter and a dedicated store — but index-only does not satisfy the
  durability requirement (§5): a pin must survive a rebuild.*
- **Q6 — Injection flip timing.** Observation-only first (§8), flip later
  — or flip in the same build? *Recommendation: observation first. The
  cost of a wrong Hot is every session; the cost of waiting is one
  `sync-status` line.*
- **Q7 — What is "the current work" for staging?** The working set needs
  a task representation to retrieve against. Minimal v1 answer: the
  project scope key (already known at session start) — staging is
  per-project. Richer later: open files, the first user message, the
  working-state note. *Recommendation: start with the scope key only —
  and call it scope-relative staging, not task-relative. Task-relative
  staging needs a real query (the first user message, open files); the
  retrieval machinery already exists, so the upgrade path is adding query
  terms, not building a new system.*

## 10. Acceptance (Given / When / Then)

- **Assignment.** Given a seeded store with known D77 counters / When the
  zone policy runs / Then Hot / Warm / Cold match the expected table
  (pinned → Hot resident; `useful_self ≥ 2` personal / `useful_self +
  useful_team ≥ 2` project → Hot resident; no `useful` in 180 days →
  Cold; recently useful → Warm; a Cold memory never stages directly).
- **Staging is scope-relative in v1 (task-relative later).** Given a
  session on project A / When staging runs / Then the working set holds
  A's relevant memories and not B's. Given the same memory / When the
  session switches to project B / Then it leaves the working set — while a
  resident memory stays put across the switch. Given a task ends within
  project A / When the next task starts / Then the working set persists
  (refreshed, not wiped). Given no user query yet and no carried-over set /
  When the first turn injects / Then only the resident layer is injected.
  Given a Cold memory relevant to the task / When staging runs / Then it
  is NOT staged; it stages only after returning to Warm on a useful mark.
- **Staging quality is measurable like RAG.** Given a task with a labeled
  expected set (same shape as the `retrieval-eval` fixture) / When staging
  runs / Then recall@5 of the staged set is ≥ 0.7. Live miss signal:
  the agent calling `memory_search` after injection counts as a staging
  miss, and a run of misses is the trigger to retune staging — not to
  widen Hot.
- **Eviction.** Given Hot over its token budget / When eviction runs /
  Then pins are never evicted; unpinned resident items demote
  lowest-signal first; the working set trims last (lowest task-relevance);
  Hot fits the budget, and nothing is deleted.
- **Counting.** Given a resident memory injected every session / When the
  policy counts retrievals / Then `retrieved_count` does not move; only an
  explicit `memory_search` call, tool use, or human use increments it.
- **Re-promotion.** Given a Cold memory marked useful after a search /
  When the policy re-evaluates / Then it returns to Warm.
- **Supersede.** Given a resident Hot memory superseded by a new memory /
  When the supersede lands / Then the old memory leaves Hot.
- **Observation-only.** Given zones computed / When `sync-status` runs /
  Then the report shows the zone distribution, the observation phase
  reports the `useful`-interval histogram and the staging recall@5, and
  the first-turn injection is unchanged (still recency-ordered).
- **No silent loss.** Given a rotted Warm memory / When the policy runs /
  Then it appears in the review queue; no file is deleted or archived
  without a human (or batch) decision.

---

*Related: `docs/V2-DESIGN.md` §18 (6); `docs/design/knowledge-graph.md`
(§20, Hot's compiled form); `docs/CONCEPTS.md` §3 (injection);
`docs/CURATOR.md` (admission bar, pruning); AGENTS.md (D77 counters,
D78 curation, D91 graph).*
