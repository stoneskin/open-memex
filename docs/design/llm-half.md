# §20 LLM half — semantic edges, missing-page proposals, compiled wiki

Status: **DRAFT for review** — not approved, not built.
Revised 2026-11-26 per thinktank review (standard tier, $0.12, judge picked grok-4.7, verdict REVISE; wiki pages deferred to v1.1 per the panel).
Date: 2026-11-26. Author: Muse.
Parent: V2-DESIGN §18 item (1) / §20. Companion specs: `docs/design/three-tier-zones.md`
(PR #85, merged 2026-11-26) · `docs/design/auto-capture.md` (PR #86, merged 2026-11-26).
Related: D61 propose-first flow · D77 reuse counters · D78 curate+submit (D93/D95) ·
D88 knowledge graph & compiled wiki · D91 deterministic half · D94 `wake` ritual ·
D96 embeddings gate · Karpathy's *LLM Wiki* (learning list #27).

## §1 Why

The deterministic half (D91) proved the graph layer works: structural edges
(supersedes / derived-from / body-mention / shared-tag), CLI queries, lint, and the
compiled outline injected at session start — all with zero model calls. What it
cannot do is the work that needs understanding:

- **Semantic edges.** Two memories can support or contradict each other without
  sharing a tag, a link, or a word. The deterministic half sees no edge there;
  a human reading both sees one immediately.
- **Missing pages.** A concept mentioned across five memories has no page of its
  own. Lint can count the mentions (deterministic); only understanding can say
  the concept deserves a page and draft what belongs on it.
- **Compiled wiki pages (v1.1, deferred).** The outline (§20.2) is a table of
  contents, not knowledge. Entity pages, concept pages, comparisons,
  overviews, syntheses — the compiled form Karpathy's pattern promises — do
  not exist yet. Per the thinktank review (2026-11-26, verdict REVISE), the
  wiki pages move to v1.1: the largest surface with the weakest verification.
  The design is retained in §6 as the v1.1 design, not v1 scope.

The LLM half is the third piece of §18 to close, after zones (6) and auto-capture
(7). It is also the first piece that needs a model call. open-memex has never made
one. That fact, not the feature list, is the design's load-bearing decision (§3).

## §2 Principles

1. **Derived, never a source of truth.** The graph and the wiki read raw memories
   and never modify them (D1, §20.2). If the LLM half is lost, wrong, or stale,
   it is rebuilt or corrected from raw. A wiki page that cannot name its source
   memories is not a page — it is a hallucination with formatting.
2. **Propose-first, always — through the right staging for each artifact.**
   Every LLM output enters as a draft and nothing is written before a human
   accept, but the staging differs by artifact: missing-page outlines (which
   become memories) go through the D61 flow (outbox → submit → promote);
   semantic-edge verdicts go through a dedicated verdict ingress with its
   own staging queue (§4); wiki pages go through the rebuild batch (§6).
   No LLM output ever writes a memory, an edge, or a wiki page directly, and
   no non-memory artifact ever enters the memory outbox — the outbox holds
   memory drafts only. The human (or the human's explicit batch accept) is
   the only writer.
3. **Inferred is marked, never asserted.** An LLM edge must be distinguishable
   from an extracted edge at every surface (receipt, query output, lint report).
   An inferred link is a suggestion, not a fact (§20.3).
4. **Off by default, confirmed at init.** §20.5 decided this in D88 and it
   stands: semantic extraction is off unless the user turns it on. Nothing
   leaves the machine without explicit action (Principle 4).
5. **No new model client in v1.** The agent already has a model. The plugin
   does not add one (§3).
6. **Measurement before mechanism.** Fixture + baseline first, for each piece
   (§7). No piece ships on an argument; each ships on a number.
7. **Verification is an admissibility check, not a truth check.** Every LLM
   output passes checks a program can run before a human ever sees it
   (§4, §6): endpoints exist, cited spans resolve verbatim, citations are
   present per the grammar. What a program cannot check — whether the
   relation is true, whether a claim is right — a human reviews. The
   verifier checks form; it never certifies truth, and no check result ever
   raises an edge's confidence to `high` (only a human accept does that).

## §3 Q1 — Where the model call lives (the load-bearing decision)

**Recommendation: the model call lives in the agent loop, not in the plugin.
v1 adds no model client, no provider config, no API key, no per-call cost.**

The plugin's job is to prepare deterministic inputs and to verify deterministic
outputs. The agent's job is the semantic step in between:

- The plugin computes *candidates* deterministically: unlinked memory pairs with
  high lexical overlap (§4), concepts mentioned N times with no page (§5),
  stale pages whose source memories changed (§6).
- The agent (which already has a model, a prompt, and the user's trust) judges
  each candidate through a tool/skill call and returns a structured verdict:
  edge type + confidence, page draft, or decline.
- The plugin runs the admissibility check on the verdict (§4), stages it as a draft,
  and the human confirms through the normal D61 flow.

**Why not a plugin-side client.** §20.5 (D88, 2026-10-31) says "once on, the
default backend is the API". That line was written before D91 split the graph
at the derivation boundary, and before the codebase's own evidence accumulated
against it:

- The repo has no LLM client, no provider abstraction, no key storage, no
  cost accounting, and no offline-degradation path for model calls. Adding one
  is a new subsystem, not a flag — auth, retries, rate limits, model choice,
  and the failure mode when the backend is unreachable.
- A plugin-side call sends memory content to a third party. Principle 4
  requires explicit action per send; a background semantic pass would need a
  consent surface the repo does not have.
- The auto-capture spec (§18 (7), merged the same day) already settled the
  pattern for the sibling feature: zero-LLM capture path, interpretation via
  the agent loop. The LLM half is the interpretation step auto-capture
  deliberately left out — it belongs in the same place.

**What this revisits.** D88's "default backend is the API" is *deferred*, not
deleted: a plugin-side backend (API default, local model via Ollama / LM Studio
config) remains the v2 option, gated on its own decision — the same way the
embeddings gate (D96) was decided separately from the retrieval work it served.
The spec records the deferral here so the D88 line is not silently contradicted:
§20.5's confirmation flow (init asks on/off) still applies, but "on" in v1
means "the agent loop may do semantic work", not "the plugin calls a model".

**Consequence.** The LLM half's v1 surface is: deterministic candidate
generation (plugin) + structured verdicts (agent) + deterministic
admissibility check (plugin) + per-artifact staging with human confirm
(§2.2). If the agent loop is unavailable (a host with
no model, a non-interactive run), the LLM half degrades to the deterministic
half — candidates are listed, nothing is judged. That degradation is the
feature, not a bug: it is what "off by default" means in practice.

## §4 Q2 — Semantic edges: what they are, how they are verified

### Types

The deterministic half ships three edge types (`supersedes`, `derived-from`,
`relates-to`). The LLM half adds two, and only two, in v1:

- **`supports`** — memory A gives a reason, evidence, or precedent for memory B.
- **`contradicts`** — memory A asserts the opposite of memory B (or of a
  conclusion B's page draws).

Semantic `relates-to` is deliberately *not* added: the deterministic half
already covers relates-to (body-mention, shared tag), and a semantic
relates-to would be the lowest-value, hardest-to-verify edge. If a pair is
related but neither supports nor contradicts, the correct edge is no edge.

### Provenance and confidence

- Every semantic edge carries provenance `INFERRED` and a confidence
  (`high | medium | low`) — the same vocabulary as §20.3, so no surface has
  to learn a new marking. Semantic edges are stored in `graph_edges`
  alongside structural edges, with a `semantic` flag distinguishing the
  source; queries and receipts render them with the INFERRED marking the
  deterministic half already uses.
- Confidence is capped by who accepted, not by what the verifier checked:
  a model-generated edge is `medium` at most, however cleanly it passes
  the admissibility check — the check verifies form (endpoints, spans),
  never truth. Only a human accept promotes an edge to `high`. The model's
  own confidence number, if it gives one, is recorded and ignored for the
  cap.

### Admissibility check (deterministic, before any human sees the edge)

A semantic edge is *admissible* only if all of these hold; otherwise it is
dropped before staging, and the drop is counted in the report:

1. Both endpoints are active memories in the project scope (retracted /
   archived endpoints are rejected, not warned).
2. The verdict cites a span in each endpoint (a quoted fragment, not a
   paraphrase) that the plugin can locate verbatim in the memory file.
3. The verdict states the relation in one sentence naming both sides
   ("A supports B because …" / "A contradicts B: A says X, B says Y").
4. A `contradicts` edge additionally names the resolution status: unresolved
   (default), or superseded-by (one side already superseded the other — in
   which case the edge is redundant and dropped, because the supersede chain
   already says it).

### Generation (deterministic candidates, agent verdicts)

Candidates are generated without a model, ranked by cheap signals, and
capped per run so the agent's judgment budget is bounded:

- Pairs sharing a `canonical_ref` or a rare tag that share no edge — these
  rank first. Lexical overlap is a poor signal for the edges that matter
  most: contradictions often share no wording ("Use X" vs "Never use X").
- Pairs with high lexical overlap (the existing `similarity()` used by lint's
  stale check, ≥ 0.8) that share no edge and are not in the same supersede
  chain — a secondary signal, kept because it still finds supports pairs
  cheaply.
- The cap is a config number (default 20 pairs per `graph semantic` run),
  recorded in the report; overflow pairs wait for the next run. The cap is
  the throttle that keeps the LLM half's cost (agent turns, human review)
  proportional to the corpus, not to its square.

### Verdict ingress (Q6 — resolved in this revision)

Verdicts enter through a dedicated plugin command, not through an open
prompt and not through `memory_propose`. The command accepts one structured
verdict (edge type + confidence + cited spans + one-sentence relation),
runs the admissibility check above, and stages passing verdicts in the
review queue; it is the only writer of semantic edges. `memory_propose`
does not accept edge verdicts — an agent that tries to propose an edge as
a memory is refused, so the verifier cannot be bypassed by convention.
The transport question the draft left open (MCP tool vs skill prompt vs
CLI round-trip) is now a build detail: whichever surface carries the
command, the command is the ingress, and the check runs before staging.

## §5 Q3 — Missing-page alerts: from lint finding to proposed memory

Lint (§20.4) already names the finding: "important concepts mentioned but
without their own page". The deterministic half reports it; the LLM half
turns it into a proposal. The pipeline has three stages, and only the middle
one needs understanding:

1. **Detect (deterministic, plugin).** A concept is a missing-page candidate
   when it is mentioned in ≥ 3 active memories (mentions counted by the same
   body-mention scan the deterministic half uses for edges) and has no wiki
   page and no memory of its own. The threshold (3) is a starting constant,
   calibrated from observation (§7), not a law. Candidates are listed by
   `graph lint` with the mention count and the citing memories.
2. **Draft (agent).** The agent reads the citing memories and drafts the
   proposal: a one-paragraph page outline (what the page would say, which
   memories it would cite) — not the page itself. Drafting the outline, not
   the page, keeps the proposal cheap to review and cheap to decline.
3. **Propose (D61 flow, human).** An accepted outline becomes a proposed
   memory (outbox draft → submit → promote), exactly as if the agent had
   proposed it in-session. This is the one place the D61 flow is the right
   staging: the outline *becomes a memory*, so the outbox is the correct
   home for it (contrast §2.2 — edge verdicts and wiki pages never enter
   the outbox). A declined outline is recorded as declined, so
   the same concept is not re-proposed on every lint run — the decline is
   remembered, per concept, until a new citing memory arrives.

A missing-page proposal never creates a wiki page by itself (§6, v1.1).
The page is written only after the underlying memories exist and a human
has approved the outline. The proposal is the on-ramp; the page is the
destination.

## §6 Q4 — Compiled wiki pages (v1.1 — deferred from v1): location, update, staleness, review

Per the thinktank review (2026-11-26, verdict REVISE), wiki pages move to
v1.1: the largest surface with the weakest verification, and the artifact
whose failure mode is worst (a wrong page reads as settled knowledge, where
a wrong edge reads as a suspicious link). This section is retained as the
v1.1 design — the rules below are decided, but they are not v1 scope, and
no wiki mechanism ships until the v1 pieces (semantic edges, missing-page
proposals) have passed their §7 fixtures in real use.

### Location and format

- Wiki pages are Markdown files under `<data root>/wiki/<scope_key>/`
  (beside `memories/`, not inside it — the wiki is derived, and derived
  material does not live in the source-of-truth directory). One page per
  entity / concept / comparison / overview, filename is the slug, frontmatter
  carries `sources:` (the ULIDs the page is compiled from) and
  `compiled_at:` (timestamp). A page without `sources:` is invalid and is
  refused by the admissibility check.
- Pages are **not** memories: never injected, never counted in D77
  `retrieved_count`, never visible to search. They are reachable through
  `graph outline` (the page list rides the outline's topic lines) and
  through an explicit `graph wiki` read, never ambiently.

### Update trigger

- **Explicit rebuild, not ingest-time.** §20.4 says ingest updates compiled
  pages on the write path. v1 does not do that: an ingest-time LLM pass
  would put a model call (and a human review) on every save. Instead, wiki
  updates run on an explicit command (`graph wiki rebuild`, and the
  `graph wiki` review screen): the plugin computes what changed since the
  last compile (new / superseded / edited source memories per page),
  the agent re-compiles the affected pages, the admissibility check runs
  on them (§6 below), and the human confirms the batch — the D78 batch-confirm shape,
  applied to pages.
- A page whose sources changed is marked stale in the outline (one word:
  `stale`) until rebuilt. Staleness is visible, never silent. Lifecycle:
  a stale page persists in the outline until it is rebuilt or explicitly
  pruned (`graph wiki prune`, v2 command); stale pages are never
  auto-deleted, and a stale page keeps its old content — stale means
  "may be out of date", never "removed".

### Admissibility check (deterministic, before the batch)

A compiled page is admissible only if all of these hold. This is an
admissibility check, not a truth check: it verifies that the page's form
is checkable (sources resolve, citations present, spans quoted), never
that its claims are true. "Factual claim" is defined operationally so the
check is programmable: **every non-structural line** — any line that is
not a heading, frontmatter, blank line, or list marker — **must carry at
least one `[ULID]` citation**. A line without one is dropped, not warned
into place; a page that loses more than half its lines to the drop fails
the batch outright instead of shipping gutted.

1. Every `sources:` ULID resolves to an active memory in the project scope.
2. Every factual claim on the page cites at least one source ULID inline
   (the citation format is `[id]`; a claim without a citation is dropped,
   not warned into place).
3. No claim contradicts a source memory (checked by re-reading the cited
   spans — a program can check "the page says X, the source says not-X"
   only when X is a quoted span; quoted-span contradictions are checked,
   paraphrase contradictions go to human review).
4. The page does not introduce a memory: it compiles, it does not originate.
   A sentence with no source is either a citation to add or a sentence to
   delete — never a sentence to keep on the model's authority.

### Review

Wiki pages are human-reviewed like proposed memories: the rebuild batch
shows the diff per page (added / removed / changed lines, with sources),
accept-all / decline-all / per-page edit. Nothing is written before the
decision (D78 batch-confirm precedent, D95). A declined page rebuild leaves
the old page in place and marks it stale; a declined page *creation* leaves
no page. Pages are rebuildable from raw at any time (`graph wiki rebuild
--from-scratch`), which is the recovery path when a page is wrong in a way
review missed.

## §7 Q5 — Measurement before mechanism

Each piece lands its fixture + baseline first, in a commit with no mechanism
change (repo rule, D91 precedent). The fixtures are small, checked in, and
run by `smoke-pure.ts`:

- **Semantic edges.** Fixture: 20 memory pairs, hand-labeled
  (supports / contradicts / neither, with the deciding spans quoted),
  including at least one no-shared-wording contradiction pair
  ("Use X" vs "Never use X") so the candidate generator is tested on the
  case lexical overlap misses. Baseline: the deterministic half's answer
  on the same pairs (no edge, by construction — it cannot see these).
  The tests split in two, because the no-client rule (§3) forbids CI from
  measuring model precision: **(a)** CI runs the fixture with canned /
  static verdicts and tests only the admissibility check's logic (endpoints,
  span resolution, drop rules); **(b)** model precision is an external
  observation — a human runs the fixture through the agent loop with the
  labels hidden from the judge and records precision / recall. The bar
  for (b): precision ≥ 0.8 on the pairs it calls supports/contradicts,
  recall ≥ 0.5 on the labeled supports/contradicts pairs (a judge that
  calls nothing vacuously passes precision and must not pass recall), and
  zero `contradicts` edges on the `neither` pairs (a false contradiction
  is worse than a missed support — it manufactures a conflict the human
  must resolve). The fixture is the anchor the verifier paper's lesson
  demands: a locked, human-labeled set the LLM output is judged against,
  not a downstream score that can look good while the verifier collapses
  (learning list #62, §5.2).
- **Missing pages.** Fixture: a corpus with 10 planted concepts (5 that
  deserve a page, 5 that do not — mentioned often but trivially). Bar:
  recall ≥ 0.8 on the deserving five, and at most 1 of the undeserving
  five proposed. The decline-memory rule (§5) is fixture-tested: a declined
  concept is not re-proposed until a new citing memory arrives.
- **Wiki pages (v1.1).** Fixture: 5 source memories + 1 hand-written reference
  page. Bar: the compiled page cites every source it draws on, introduces
  zero unsourced claims (admissibility check §6 rules 1–4 pass), and a rebuild from
  scratch reproduces the same sources list. Staleness bar: editing a source
  memory marks the page stale in the outline on the next `graph build`.

**Flip bars (separate decisions, not this spec).** A piece is enabled only
when **both** conditions hold: the user consented at init (§20.5) **and**
its flip bar is met — init consent alone does not enable anything, and a
met flip bar does not override a declined init answer. Semantic extraction
turns on by default only when: edge precision on the fixture ≥ 0.8
sustained over two consecutive fixture runs, zero false `contradicts` on
the `neither` set, and the human accept rate on proposed edges ≥ 0.9 over
a labeled observation window — defined as the first 100 proposed edges,
labeled by the user. Until then, every semantic edge, proposal, and page
goes through the batch. The init-time on/off question (§20.5) stays asked
either way.

## §8 Data model

### Graph edges (extension, same tables)

`graph_edges` gains two edge types (`supports`, `contradicts`) and one
column: `semantic` (0 = structural, 1 = LLM-judged). The column does not
exist today — `refreshGraph`'s INSERT lists only (scope_key, from_id,
to_id, edge_type, provenance, confidence, via) — so the column is a
schema change, and the rebuild rule must change with it: today
`refreshGraph` DELETEs the scope's whole edge set and re-inserts only
deterministic edges, which would wipe every semantic edge on the next
write-path refresh. The rule is: the rebuild snapshots the semantic=1
rows before the DELETE and re-inserts them after (dropping only those
whose endpoint is superseded or retracted — the supersede chain already
says what they said). Semantic edges are written only by the `graph
semantic` command path, never by the write-path refresh; the refresh
preserves them, it does not create them. A test pins this: a write-path
refresh after staging a semantic edge leaves the edge in place.

### Wiki pages (new directory, same durability)

`<data root>/wiki/<scope_key>/<slug>.md` — Markdown, frontmatter
`sources:` (ULID list) + `compiled_at:` (timestamp). Pages are derived and
rebuildable; they are never backed up separately from the memories they
compile (lose the wiki, rebuild it from raw). The wiki directory is excluded
from `open-memex export` unless `--all` (same rule as derived data).

### Staging (one queue per artifact, never the memory outbox for non-memories)

- **Missing-page outlines** use the existing D61 flow (outbox drafts →
  submit → promote). The outline becomes a memory, so the outbox is the
  correct home. No new review state, no new table.
- **Semantic-edge verdicts** are staged in a review queue (rows in
  `graph_meta` or a small staging table — build detail, not spec), written
  only by the verdict ingress (§4) after the admissibility check. They
  never enter the memory outbox: the outbox holds memory drafts, and an
  edge verdict staged there would be published as a memory by submit.
- **Wiki pages (v1.1)** are staged as page diffs in the rebuild batch
  (§6), never as outbox drafts.
- The decline-memory for missing-page concepts lives in `graph_meta` as
  a key (`declined-concept:<slug>` → last citing-memory count), so a
  decline survives restarts without a new table.

## §9 Rollout — observation first, one piece at a time

Zones §8 precedent, applied per piece — two slices, each gated on its §7
fixture:

**v1 — semantic edges + missing-page proposals.**

1. **Semantic edges first.** The smallest closed loop: `graph semantic`
   (candidates → agent verdicts → admissibility check → review queue). It
   exercises the whole shape (deterministic candidates, agent judgment,
   deterministic check, propose-first) with the smallest surface.
2. **Missing-page proposals second.** Built on the same shape; the only new
   mechanism is the mention-count detector and the decline-memory key.

**v1.1 — wiki pages.** The largest surface (page format, rebuild command,
review batch, staleness marking). It also has the most to lose from a
wrong first version — a bad page looks authoritative in a way a bad edge
does not. It ships only after the v1 pieces have passed their §7 fixtures
in real use; its design is §6, retained here, not re-decided later.

Each piece is off by default until its flip bar (§7) is met, and only if
the user consented at init (§20.5) — both conditions, always (§7). A piece
whose fixture regresses is disabled by config, not by deleting the
command — the command reports "disabled: fixture failing" and the
deterministic half keeps working underneath.

## §10 Acceptance criteria

- **A1 — No new model client.** The diff of v1 contains no provider
  dependency, no API key handling, no network call for semantic work.
  `graph semantic` with no agent loop available lists candidates and
  judges nothing.
- **A2 — Semantic edges verified.** CI runs the §7 fixture with canned
  verdicts and the admissibility check's logic passes (endpoints active,
  spans resolve, one-sentence relation, contradiction status named,
  drop rules applied). Separately, a human-run observation (labels hidden
  from the judge) records precision ≥ 0.8 on called edges, recall ≥ 0.5
  on labeled supports/contradicts pairs, and zero false `contradicts` on
  the `neither` pairs. Every staged edge passes the §4 admissibility
  rules.
- **A3 — Missing pages propose, never write.** A `graph lint` run on the
  fixture proposes the deserving concepts and at most 1 undeserving one;
  a declined concept is not re-proposed until a new citing memory arrives;
  no wiki page is created by the proposal path.
- **A4 — Wiki pages cite or drop (v1.1).** On the §7 fixture, the compiled
  page cites every source it draws on and introduces zero unsourced claims
  (admissibility check §6); rebuild-from-scratch reproduces the same
  sources list; editing a source marks the page stale in the outline.
- **A5 — Propose-first holds, per artifact.** No LLM output (edge,
  proposal, page) reaches the index, the graph, or the wiki directory
  before a human accept — each through its own staging (§8), never through
  the memory outbox except the missing-page outline, which becomes a
  memory. With the batch declined, the memory table, the D77 counters,
  the graph edge set, and the wiki directory are all unchanged.
- **A6 — Off by default.** Fresh install with semantic extraction declined
  at init: `graph semantic`, `graph wiki rebuild`, and the missing-page
  proposal path all report disabled; the deterministic half (edges, outline,
  lint, queries) works unchanged. A met flip bar never overrides a
  declined init answer (§7).
- **A7 — Rebuildable (v1.1).** Deleting the wiki directory and running
  `graph wiki rebuild --from-scratch` reproduces the same pages (same
  sources, same slugs) from raw memories.

## §11 Open questions

- **Q6 — The agent-loop contract (resolved in this revision).** The verdict
  format (edge type + confidence + cited spans + one-sentence relation)
  is specified here, and the ingress is now specified too (§4): a
  dedicated plugin command that runs the admissibility check before
  staging and is the only writer of semantic edges; `memory_propose`
  does not accept edge verdicts. Which surface carries the command (MCP
  tool vs skill prompt vs CLI round-trip) is a build detail — the
  command is the ingress either way.
- **Q7 — `related` frontmatter field.** §20.8 lists it as a v0.3 protocol
  decision. This spec keeps edges in the graph layer only and does not
  propose the field. If a v0.3 protocol revision wants it, the field's
  values are the graph's edge types with provenance — but that revision
  is out of scope here.
- **Q8 — Graph lane in recall receipts.** §20.8 also lists adding a `graph`
  lane to §7 receipts. This spec does not ship it: receipts change the
  retrieval contract, and the LLM half's edges should earn their place in
  receipts by passing the §7 fixture first. Revisit after semantic edges
  ship.
- **Q9 — Wiki page granularity (v1.1).** One page per entity/concept is
  the v1.1 rule. Whether comparisons and overviews deserve their own
  pages, or are sections inside concept pages, is a usage question —
  decide from the first real corpus, not from this spec.
- **Q10 — The plugin-side backend (v2).** If a plugin-side model client is
  ever built, it needs its own design: backend abstraction, key storage,
  cost accounting, offline degradation, and a consent surface per send.
  Nothing in v1 precludes it; nothing in v1 builds it.

## Sources

- `docs/design/knowledge-graph.md` (§20, D88 design; §20.3 edge types and
  provenance; §20.4 ingest/query/lint; §20.5 local-first & init confirmation;
  §20.6 phasing; §20.8 pending amendments).
- `docs/V2-DESIGN.md` §18 item (1) queue text and §20 status (2026-11-06);
  `docs/design/decisions.md` D88 (graph & compiled wiki), D91 (deterministic
  half), D61 (propose-first posture), D78 (batch-confirm), D96 (embeddings
  gate, opt-in only).
- Implementation (read 2026-11-26): `src/graph/extract.ts` (EdgeType today:
  `supersedes` | `derived-from` | `relates-to`; shared-tag caps
  `MAX_SHARED_TAG_EDGES_PER_NODE = 12`, `MAX_SHARED_TAG_NODES = 2000`),
  `src/graph/lint.ts` (LintKind: `orphan` | `dangling-edge` | `stale`),
  `src/graph/queries.ts` (neighbours/path), `src/graph/outline.ts`,
  `src/store/graph.ts` (`graph_edges`/`graph_meta`, `refreshGraphQuiet`),
  `src/config.ts` (`graphOutline`, `graphOutlineLines`,
  `crossLingualRerank`, `embeddingModel`), `src/tools/ops.ts`
  (`memory_propose` / `memory_submit` / `memory_promote`).
- Karpathy, *LLM Wiki* (learning list #27): three layers (raw / wiki /
  schema), three operations (ingest / query / lint); the compiled layer
  accumulates instead of re-deriving.
- Graphify on muse-thinktank (2026-10-31): curated graph, 1029 nodes,
  edges tagged EXTRACTED/INFERRED with confidence — the working
  implementation of the same pattern on codebases.
- "Who Verifies the Verifier?" (learning list #62, arXiv:2610.11464,
  §5.2): a self-evolved verifier can collapse while downstream scores
  look fine — the LLM half's outputs are therefore judged against a
  locked human-labeled fixture (§7), never against a downstream score.
- Thinktank review 2026-11-26 (standard tier, $0.12, judge picked
  grok-4.7, verdict REVISE): D61 outbox conflict, `refreshGraph` wipe of
  semantic edges, testing paradox (CI vs observation split), "factual
  claim" definition, model-edge confidence cap at medium, candidate
  bias toward shared wording, Q6 verdict ingress, init-gate conjunction,
  staleness lifecycle; wiki pages deferred to v1.1.
