# Writing for Memory — authoring checklist

> Status: Phase 5 candidate (not committed), recorded 2026-10-12.
> Adapted from mattpocock/skills `writing-for-agents`
> (https://github.com/mattpocock/skills).
> That document is a theory of writing for the agent-as-reader; this is the same
> theory applied to memory entries. Retrieval (FTS5/BM25, D81 alias expansion)
> decides *which* entries match — this checklist decides whether a matched entry
> *deserves* the context it costs.

## 1. Trigger branches — when this memory surfaces

A memory entry is a context pointer: its title/summary wording decides when it gets
retrieved, not just its body. A must-keep fact behind a weakly worded title is a
variance bug: sharpen the wording first.

- [ ] State what the entry is AND the branches that should trigger it (a branch is
      a distinct situation where this memory applies — different runs take
      different branches).
- [ ] Front-load the leading words: retrieval and reranking weight the front.
- [ ] One trigger per branch. Synonyms renaming a single branch are one branch
      written twice — collapse them.
- [ ] Say when it does **not** apply. A memory with no negative scope retrieves
      into situations it doesn't belong in.

## 2. Two budgets — what a retrieved memory costs

Every retrieved entry spends context budget on the agent's window, whether or not
it turns out to be useful that turn.

- [ ] Entries injected every session (high importance, always-relevant) earn the
      hardest pruning: each line must justify permanent context spend.
- [ ] Entries retrieved on demand cost only the retrieval plus their own lines —
      this is where detail belongs, not in the always-injected set.
- [ ] The human's curation attention is the other budget: capture is cheap,
      curation is the price of a trustworthy store. Spend it where judgement
      matters (D78: human-ON-the-loop).

## 3. Layered entries — tldr + body

Progressive disclosure applied to storage: split what every retrieval needs from
what only some retrievals need.

- [ ] Every entry carries a one-line tldr: the whole point, self-contained.
      Retrieval would return the tldr layer first; the body would load on
      demand. (Proposed storage design — Phase 5 candidate, not built yet.)
- [ ] Inline in the tldr what every branch needs; push branch-specific detail
      into the body.
- [ ] Never bury the action: if the entry exists to change behavior, the tldr
      says what to do, the body says why.

## 4. Capture criteria — is the entry self-contained?

A memory that needs its original session to be understood is a pointer to
nothing. Each entry must answer, on its own:

- [ ] What happened / what was decided (the fact, not the story).
- [ ] When it applies (trigger branches, §1).
- [ ] When it does NOT apply (negative scope, §1).
- [ ] Source: which session/decision it came from, dated. Undated lore rots;
      the reader can't tell stale from live.
- [ ] Role discipline (D2): records are records. An entry that reads as an
      instruction must carry `role: instruction` explicitly — never let a history
      entry impersonate a current rule.

## 5. Co-location — one entry, one meaning

- [ ] A memory's context, decision, and caveats live under one entry, not
      scattered across three. Reading one part should bring its neighbours.
- [ ] Distinct from duplication: repeating one meaning in two entries is a merge
      candidate; fragmenting one meaning across entries is the failure mode.
- [ ] Prefer editing the existing entry over appending a contradicting one.
      Contradictions without resolution are retrieval poison — resolve,
      supersede, or deprecate (`status: deprecated`); never hard-delete.

## 6. Curation bar — what earns a place in long-term memory

Capture-first means the inbox is generous; the long-term store is not. An entry
stays only if it clears both:

1. **Recorded from a real session.** What happened, what was decided, what went
   wrong — with a date and source. A hypothetical ("it would be nice to
   remember…") does not clear this bar.
2. **Retrieval earns its keep.** D77 counters (`retrieved_count`/`useful_count`,
   not yet built — near-term backlog) are the instrument: entries with sustained
   zero-reuse are prune/merge candidates. Attention, not sentiment, decides.

## 7. Glossary discipline — shared vocabulary as first-class memory

- [ ] Project glossaries (D81 alias vocabulary) are curated memory, not just
      query-time expansion machinery: terms, what they mean here, and what they
      are NOT.
- [ ] New entries should use the glossary's terms. A new term coined in an entry
      without a glossary home is an alias-expansion miss waiting to happen.
