## 20. Knowledge Graph & Compiled Wiki (v0.3 candidate)

> v0.3 candidate (D88). Does not change the frozen v0.2 protocol; the graph/wiki is a derived layer (see §20.2). Sources: Karpathy's *LLM Wiki* (three layers / three operations) and Graphify (a working implementation of the same pattern on codebases, measured on muse-thinktank 2026-10-31: curated graph, 1029 nodes, edges tagged EXTRACTED/INFERRED with confidence). Both point to the same pattern: compile knowledge once, instead of re-deriving it on every query.

### 20.1 Why add a graph (motivation)

Today open-memex is RAG-style retrieval: a query finds relevant fragments from memory and assembles an answer. Every query re-discovers knowledge from scratch — nothing accumulates. A question that synthesizes five memories forces the system to re-find and re-assemble them every time.

The alternative: between memories (raw) and terminal documents (docs / ADRs / AGENTS.md), add a layer of **compiled knowledge** — a knowledge graph plus a set of LLM-maintained wiki pages. When a new memory arrives, the system does not just store it for later retrieval; it reads it, extracts the key information, and merges it into the existing graph and wiki — updating entity and concept pages, flagging where new content contradicts old conclusions, strengthening or challenging emerging syntheses. Knowledge is **compiled once, then kept current**, not re-derived on every query.

This follows Design Principle 7 ("Memory is the entrance of knowledge, not its final form"): memory is the entrance, the graph/wiki is the compiled form, terminal documents are the final form. The §3 frontmatter currently has no `related` field (not in v0.2); this section supplies the graph edges — edges live in the graph layer first, and whether `related` enters the frontmatter is a v0.3 protocol decision.

### 20.2 Three layers (Karpathy's raw / wiki / schema)

| Layer | In open-memex | Owned by | Mutable? |
|---|---|---|---|
| **Raw** | The memory files themselves (Markdown, one memory per file) + the docs they point at via `canonical_ref` | User / team | **Immutable** — the graph and wiki only read raw, never modify it; when something is wrong, trace back to the memory and the doc |
| **Wiki (compiled)** | Knowledge compiled from memories: entity pages, concept pages, comparisons, overviews, syntheses (Markdown files; the queryable graph is the same knowledge in another shape) | Maintained by the LLM, reviewed by humans | Mutable — updated when new memories arrive; it is a **derived layer**, rebuildable from raw if lost (echoes D1: Markdown is the source of truth, indexes are rebuildable) |
| **Schema (discipline)** | Capture rules + promotion rules + this section's conventions (what to record, how, what enters the graph, who may change it) | Co-written by human + LLM | Evolves — revised with practice, lives in the protocol doc and AGENTS.md |

Key point: **the wiki layer is derived, not a second source of truth.** Truth always lives in raw (the memory files). If the wiki is lost, wrong, or stale, it can be rebuilt or corrected from raw. This matches D1 (Markdown is the source of truth) and §12 ("Memory stores summaries and points at docs via `canonical_ref` — never copies them"): the wiki stores compiled summaries and links, not copies of the originals.

### 20.3 Graph edges: typed edges with provenance

The §3 frontmatter currently has no `related` field (not in v0.2, see the note at the end of §3). This section introduces **typed edges with provenance** in the graph layer (edges are derived and rebuildable; they do not enter the frontmatter — whether `related` enters the frontmatter is a v0.3 protocol decision):

- **Edge types**: `relates-to`, `supports`, `contradicts`, `derived-from`, `supersedes` (already exists, see the supersede chain in §3.3).
- **Every edge carries provenance** (borrowing Graphify's practice): `EXTRACTED` (explicit in the source — e.g. memory A explicitly says "see memory B", or two memories share a `canonical_ref`) or `INFERRED` (system-inferred — e.g. similar content, shared tag/path), with a confidence (`confidence: high | medium | low`, reusing the confidence semantics already in §3).
- **Inferred edges are always marked**: in retrieval results they must be distinguishable (e.g. the recall receipt names the lane + edge type); an inferred link must never look like a fact that was in the source.

Why split EXTRACTED/INFERRED: this extends the trust model in §11 — a link with unclear provenance must not quietly become a "fact". An inferred edge is a suggestion, not an assertion.

### 20.4 Three operations (Karpathy's ingest / query / lint)

#### Ingest: the graph updates when a memory is written / approved

- Trigger: a memory is created, updated, or its promotion state becomes approved (§5). Core triggers an incremental graph update on the write path (new nodes/edges, updates to the affected compiled pages) — not a separate background job.
- One ingest can touch several compiled pages (one memory can update an entity page, a concept page, and an overview). That is normal — the wiki's value is "one ingest, merged in many places".
- Ingest never changes the memory itself (raw is immutable); it only updates the derived graph and wiki.

#### Query: graph traversal becomes a third retrieval lane

- §7 today has two lanes: BM25/FTS5 and vector (optional). This section adds a third: **graph traversal** (a node's neighbours, the shortest path between two concepts, a community).
- Recall receipts (§7) gain a `graph` lane: each hit reports its lane (BM25 / vector / graph / recency); a graph hit reports which edge it travelled (type + EXTRACTED/INFERRED).
- A good answer from a graph query can be filed back into the wiki as a new page (a good comparison or analysis should not vanish into chat history). That is the compounding step.

#### Lint: a health check, run automatically before promotion

Lint runs **automatically before promotion** (decided 2026-10-31) and checks the graph/wiki for:

- Contradictions between memories (two memories asserting opposite facts)
- Stale claims superseded by newer memories (should have entered the supersede chain but hasn't)
- Orphan memories (written but never linked, in no compiled page)
- Important concepts mentioned but without their own page (missing pages)
- Missing cross-references

**Lint only discovers and reports; it never auto-resolves** (echoes Principle 5: Core never silently resolves semantic conflicts; and §9's conflict handling). The results go to a human (the curator / promotion reviewer) to decide. This is the input the §5 promotion flow needs: a list of "which memories contradict, which are stale, which are orphaned".

### 20.5 Local-first & privacy (no change to the existing iron rules)

- **The graph is derived and stored locally**: compiled from local Markdown, stored locally (SQLite index + Markdown compiled pages), on the same machine as the memory files. Lost, it can be rebuilt.
- **Deterministic extraction needs no LLM**: structural edges (shared tag, shared path, shared `canonical_ref`, explicit links) are extracted by deterministic rules, on-machine, without an LLM (borrowing Graphify's tree-sitter idea: structure is extracted, not inferred).
- **Semantic extraction of docs is confirmed at init, on or off** (decided 2026-10-31): understanding document content semantically (not just structurally) needs an explicit LLM backend. Init asks the user whether to turn it on or off (echoes Principle 4: nothing leaves the machine without explicit user action) — off means no semantic extraction. Once on, the default backend is the API (most machines have no local model); to use a local model, change it in config (Ollama / LM Studio).
- **The personal scope never syncs** (D3): personal memories stay out of the graph's sync scope; the graph's sync follows the same scope/visibility rules as memory sync (§4), no separate scheme.
- **Iron rules unchanged**: a graph edge can never automatically become an instruction (iron rule 1's role gate still sits at the instruction-context entry); a personal memory's instruction never enters AGENTS.md (iron rule 2). The graph is a knowledge layer, not an authorization layer.

### 20.6 Scope & phasing (v0.3 candidate, not in v0.2)

- **This section is a v0.3 candidate; it does not change the frozen v0.2 text.** v0.2 (Phases 0–2) proceeds as planned; the graph is a **parallel, benchmark-gated experiment** (same treatment as embeddings in Phase 2), not on the critical path.
- **Smallest closed loop first**: one domain (e.g. one project) → graph compiled from memories → neighbours and paths queryable → lint reporting contradictions and orphans. Expand only after that loop works.
- **Scale ceiling**: Karpathy's index pattern suffices at ~100 sources and a few hundred pages; before open-memex's memory count reaches that scale, the graph's index is "read the compiled pages first, then drill into the originals" — no embedding RAG infrastructure needed. Beyond that, add search/vector (reusing the §7 embeddings interface).

### 20.7 What this section does not change

- **Data model unchanged**: one memory per file, Markdown is the source of truth, ULID is the filename (§3). The graph is a derived layer; it adds no memory field (edges live in the graph layer; whether `related` enters the frontmatter is a v0.3 protocol decision).
- **Iron rules unchanged** (§3.2): the instruction gate and the personal-scope guard apply as before.
- **Promotion flow unchanged** (§5): promotion stays explicit and human-reviewed; lint only supplies input to the reviewer, it does not decide for them.
- **Retrieval baseline unchanged** (§7): BM25/FTS5 + CJK remain the default; the graph is an added lane, not a replacement.

### 20.8 Small amendments to §3 / §7 / §12 (land with this section, pending approval)

- **§3**: a v0.3 protocol revision will consider whether to add a `related` field (typed, with provenance); until then, edges live only in the graph layer, not in the frontmatter.
- **§7 Recall receipts**: add a `graph` lane; a graph hit reports its edge type and provenance.
- **§12 table**: add a sub-row under "OpenMemex" — "Compiled wiki/graph: knowledge compiled from memories (derived, rebuildable), between memories and terminal documents".

