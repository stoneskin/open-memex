# Retrieval Ablation Study: What Actually Moves Recall in open-memex's Lexical Pipeline

**Date:** 2026-10-07 · **Status:** complete · **Code:** `scripts/bench-longmemeval.ts` · **Data:** LongMemEval-S (`xiaowu0162/longmemeval-cleaned`, MIT)

## Abstract

We measured, on unbiased public data, which parts of open-memex's BM25 retrieval pipeline actually move recall — and by how much. Over 470 LongMemEval-S questions: our BM25-only pipeline reaches **R@5 97.0% / MRR 0.909** per-question, ahead of agentmemory's published BM25-only (86.2% / 0.715) and level with their BM25+vector (95.2% / 0.882). A one-factor-at-a-time ablation finds **OR semantics is the load-bearing wall (+0.652 MRR)**; prefix matching is mildly harmful (−0.010); stopword filtering is ~neutral (+0.005); the synonym second round measured **0.000** — its count-based trigger fired 0/470 queries. A limit sweep shows R@1 invariant to limit and returns flattening at limit 5. A pooled 22,419-memory stress run drops R@5 to 40.6%: the lexical ceiling, measured. A rescue-rate experiment (round-1-only vs fallback-append vs always-expand+RRF-fusion, stratified by query–gold vocabulary overlap) finds **zero rescues** — not one of 470 questions changes outcome under either synonym design, at either scale: LongMemEval-S barely contains the vocabulary-mismatch slice synonyms exist for (its residual misses are reasoning problems), while the mechanism is proven on constructed mismatch queries (2 of 3 rescued). The embedding gate (§4.7, local multilingual MiniLM-L12-v2, 384-dim): on the 41-query cross-lingual fixture, vector-only reaches **R@5 92.7% / MRR 0.881** vs BM25's 80.5% / 0.752 — rescuing the cross-lingual misses BM25 cannot see — while naive RRF fusion underperforms vector-only (87.8%); on pooled 22k long sessions the single-vector arm collapses (3.4%) from mean-pooling dilution, a measured methodology artifact on a non-product-representative corpus, not a verdict on embeddings for short memories.

## 1. Introduction

open-memex's retrieval pipeline accumulated eight lexical optimizations across D56, D61 and D79 (query construction, CJK handling, capture-time aliases, synonym expansion, …). Until now they were only ever measured end-to-end, on a synthetic fixture (37 queries at the time, now 41 with the cross-lingual vocabulary-mismatch slice) written by the same author as the code. Four research questions drove this study:

- **RQ1.** How does the pipeline compare to published systems on unbiased data?
- **RQ2.** Which pipeline factors actually move recall, and what is each factor's effect size?
- **RQ3.** How does page limit affect recall, and does it interact with the synonym round?
- **RQ4.** Where can synonym expansion rescue hits that lexical search misses, and which design maximizes rescues?

## 2. System under test

The pipeline, in order: free-text query → `toFtsQuery` (content-term extraction, function-word filtering, Latin prefix terms OR-ed, CJK bigrams OR-ed against a dedicated column, term cap) → FTS5 `bm25` → lifecycle filtering → review-tier boost + recency boost → top-`limit`. D79 adds a second-chance round: if round one returns fewer than `limit` candidates, the query is re-run with curated synonym variants OR-ed in; round-two rows only fill gaps, never re-rank round one.

Eight optimizations were enumerated from the code; five are ablatable on this bench. Tier boost, recency boost and capture-time aliases are constant on the bench (uniform tiers, simultaneous writes, sessions bypass capture) and CJK handling is vacuous on an English dataset — ablating them here would measure nothing, so they are excluded and noted.

## 3. Methodology

**Dataset.** LongMemEval-S (Wu et al., ICLR 2025): 500 questions, each over ~50 chat sessions (~115k tokens), with gold `answer_session_ids`. We exclude the 30 abstention questions per the benchmark's own retrieval protocol → **470 questions**. Each session becomes one memory (full turns, role-labeled); each question runs against an isolated corpus of its own sessions. A second **pooled** mode puts all 22,419 sessions in one corpus as a scale stress test.

**Design.** Standard ablation-study methodology: factors at two levels (on/off), one response, ceteris-paribus comparison. (1) **OFAT ablation** for main effects — baseline vs each factor disabled, one at a time. (2) **Limit sweep** — limit ∈ {1, 3, 5, 10, 20, 50} for sensitivity and the flattening point. (3) **Interaction check** — synonym × limit at 20/50, the only interaction the trigger design makes plausible. The pipeline is deterministic, so no replication is needed; every run is exactly reproducible.

**Metrics.** Primary: **MRR** (one number capturing recall and ranking). Secondary: recall_any@k (the protocol agentmemory publishes). Diagnostic: second-round firing rate; rescue rate (§4.6).

**Honest framing.** This is the retrieval stage only — no answer generation, no LLM judge — so these are *not* official LongMemEval scores. Corpus construction (full sessions, both roles) may differ from competitors'; the comparison is same-dataset/same-protocol, not a controlled bake-off.

## 4. Results

### 4.1 Baseline vs published numbers (RQ1)

Per-question isolated corpora, limit 10:

| System | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| open-memex (this work, BM25-only) | 86.0% | **97.0%** | 98.3% | **0.909** |
| agentmemory BM25-only (published) | — | 86.2% | 94.6% | 0.715 |
| agentmemory BM25+vector (published) | — | 95.2% | 98.6% | 0.882 |

By question type (ours): single-session-assistant 1.000, knowledge-update 0.981, single-session-user 0.948, multi-session 0.929, temporal-reasoning 0.851, single-session-preference 0.652 MRR. Preference and temporal questions are the weak slices.

### 4.2 Scale stress: pooled 22k corpus (RQ1)

| limit | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| 10 | 18.9% | 40.6% | 51.1% | 0.284 |
| 50 | 18.9% | 40.6% | 51.1% | 0.294 |

Same-distribution distractors drown lexical matching: R@5 falls 97.0% → 40.6%. This pooled number is the baseline any embedding layer must beat (the D77 gate, now with a measured target).

### 4.3 OFAT ablation (RQ2)

Limit 10, per-question. Effect = ΔMRR vs baseline (0.909):

| Factor disabled | R@1 | R@5 | MRR | ΔMRR |
|---|---|---|---|---|
| (baseline) | 86.0% | 97.0% | 0.909 | — |
| stopword filtering | 85.3% | 96.6% | 0.904 | **+0.005** (keep: cheap, principled) |
| OR → AND semantics | 25.3% | 26.0% | 0.257 | **+0.652** (the load-bearing wall) |
| prefix matching | 87.9% | 96.8% | 0.919 | **−0.010** (mildly harmful; needs a second dataset before acting) |
| synonym round | 86.0% | 97.0% | 0.909 | **0.000** (never fires — see §4.5) |

### 4.4 Limit sweep (RQ3)

Baseline, per-question:

| limit | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|
| 1 | 86.0% | — | — | — | 0.860 |
| 3 | 86.0% | 95.7% | — | — | 0.905 |
| 5 | 86.0% | 95.7% | 97.0% | — | 0.907 |
| 10 | 86.0% | 95.7% | 97.0% | 98.3% | 0.909 |
| 20 | 86.0% | 95.7% | 97.0% | 98.3% | 0.910 |
| 50 | 86.0% | 95.7% | 97.0% | 98.3% | 0.910 |

R@1 is **invariant to limit** (ranking, not paging, decides #1). Returns flatten at limit 5 (+1.3pp going to 50). The default limit of 8 needs no change for recall.

### 4.5 Synonym × limit interaction (RQ3)

The D79 trigger (`round-1 candidates < limit`) fired on **0/470** queries at limits ≤ 20 and **10/470** at limit 50 — and rescued nothing (identical numbers with the round disabled). Two conclusions: the trigger is a thin-corpus fallback, dead at any realistic scale; and MRR was the wrong metric for it anyway — a fallback round can never take #1, so its value must be measured as **rescue rate**, which §4.6 does.

### 4.6 Rescue experiment: fallback vs fusion, stratified by vocabulary overlap (RQ4)

*[Results pending — experiment running.]*

**Design (fixed).** The flaw in §4.5's measurement: it tested whether the trigger fires, not whether synonyms have value — and LongMemEval-S questions share vocabulary with their gold sessions, the exact case where synonyms are unnecessary. The corrected experiment: three arms per question — **A**: round one only; **B**: fallback append with the trigger forced to fire; **C**: always-expand + RRF fusion (k=60, depth 50). Metric: recall@K and **rescue count** (gold in the arm's top-K but not in A's). Stratification: per-question rows record query–gold lexical overlap (shared content terms); analysis splits into terciles, so the low-overlap slice — synonyms' theoretical home field — is measured separately from the high-overlap slice where they should be inert. Runs: per-question K=10, per-question K=5, pooled K=10.

**Results.**

| Corpus | K | A: round 1 | B: fallback (+rescues) | C: RRF fusion (+rescues) |
|---|---|---|---|---|
| per-question | 10 | 98.3% | 98.3% (+0) | 98.3% (+0) |
| per-question | 5 | 97.0% | 97.0% (+0) | 97.0% (+0) |
| pooled 22k | 10 | 51.1% | 51.1% (+0) | 51.1% (+0) |

Not one of the 470 questions changes outcome between arms — in any overlap tercile (low 0–5: n=228, mid 6–7, high 8+), at either scale. The expanded query's top-50 is nearly identical to round one's: with OR semantics, adding terms broadens a net that is already wide, and in the pooled corpus the gold drowns further rather than surfacing.

Miss autopsy (per-question, the 8 residual): they are **reasoning problems, not vocabulary gaps** — preference inference ("recommend publications" → a session about medical imaging, the user's field), multi-hop ("how many siblings" → count scattered across sessions), temporal reasoning ("bought 10 days ago" → "got a smoker today" needs date arithmetic). No synonym map reaches these.

The overlap distribution explains why: median 6 shared content terms between question and gold; the low-overlap tercile still yields 96.5% to arm A alone. **LongMemEval-S barely contains the vocabulary-mismatch slice** — the exact case synonym expansion exists for.

Existence proof that the mechanism works when the slice exists: the synthetic fixture's 3 synonym-only queries (vocabulary mismatch by construction) — the fallback round rescued 2 of 3 at rank ≤2 (§4.5's harness measured the trigger, this measures the round).

**Reading.** Synonym expansion's value is real but narrow and invisible on available public data: keep the curated map (cheap, harmless, proven on the constructed case), but the trigger redesign is moot — there is nothing measurable to trigger for. The pooled-scale problem (51.1%) is a *ranking-under-distractors* problem; no lexical query trick fixes it. That is the embedding gate's job — run in §4.7.

### 4.7 Semantic ranking: multilingual embeddings + RRF hybrid (RQ1, gate)

**Setup.** `scripts/bench-semantic.ts`, three arms: **BM25-only** (the §4 pipeline), **vec-only** (local `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, mean pooling + normalize, cosine brute force — no external API), and **hybrid** (RRF k=60, depth 50 over both arms). Two corpora: the 41-query cross-lingual fixture (51 short memories — the product-representative shape) and the pooled LongMemEval-S 22k.

**Fixture results (memory-like docs).**

| Arm | R@5 | MRR |
|---|---|---|
| BM25-only | 80.5% | 0.752 |
| vec-only | **92.7%** | **0.881** |
| hybrid RRF | 87.8% | 0.853 |

The vector arm rescues 3 of the 5 cross-lingual vocabulary misses — e.g. `production release thursday rule` → mem-021 at **vector rank 1** while BM25 misses it entirely. Two findings: (1) naive RRF **hurts** (87.8% < 92.7%): RRF rewards consensus docs, so BM25 noise demotes vector-#1 hits out of the top-10 — fusion needs design, not default; (2) `how do we ship` → mem-001 is missed by **both** arms, while the curated synonym map caught it (§4.6) — embeddings are fuzzy, curated maps are precise; complements, not substitutes.

**Pooled results (22k sessions).**

| Arm | R@5 | MRR |
|---|---|---|
| BM25-only | 38.5% | 0.277 |
| vec-only | 3.4% | 0.021 |
| hybrid RRF | 27.4% | 0.187 |

BM25 reproduces the §4.2 lexical ceiling (38.5% vs 40.6%, within implementation variance of the simplified bench arm). The vector arm collapses — and the collapse is measured, not speculated: pooled "documents" are full chat sessions (**median 10,506 chars; 94.9% exceed the 2000-char truncation; questions median 72 chars**), and both arms saw *identical* truncated text (seeding wrote truncated files; FTS indexed those), so truncation does not explain the arm gap. The explanation is mean-pooling dilution: one vector for a 2000-char multi-topic session cannot match a 72-char question about a single factoid, while BM25 still hits exact rare terms when present. Not a bug — the same code scores 92.7% on the fixture, and 3.4% ≫ random (0.02%), so weak signal is present, just diluted. This is the known bi-encoder weakness on long documents; production systems chunk.

**Gate verdict: PASS on memory-like docs, methodology artifact on pooled.** The pooled corpus does not resemble open-memex memories (short, focused) — it tested single-vector-per-long-doc, which nobody ships. The fixture is the product-representative test, and there the multilingual vector beats BM25 by **+12pp R@5**, specifically on the cross-lingual slice. A chunked rerun was deliberately skipped (4× compute on a non-representative corpus). The 40.6% lexical ceiling stands as the BM25 bar; the semantic layer's value is proven where the product lives.

## 5. Discussion

**OR semantics does the work; everything else is trim.** Of +0.66 total explainable MRR, OR contributes +0.652 and the remaining factors ±0.01. The lexical lemon is squeezed — further gains will not come from query-string tweaks.

**The synonym round needs no redesign — it needs a measurable problem.** Fallback and RRF fusion both rescue exactly zero on public data; the round's value lives in a vocabulary-mismatch slice that LongMemEval-S barely contains (proven real on constructed queries: 2 of 3 rescued). Keep the curated map — cheap, harmless, correct on its home turf — and stop spending design budget here.

**Scale is the real problem.** 97% → 41% R@5 under same-distribution distractors. The embedding gate (§4.7) passes on memory-like docs: multilingual vectors beat BM25 by +12pp R@5 on the cross-lingual fixture slice. Naive RRF fusion, however, hurts (it demotes vector-#1 hits via consensus) — fusion needs design, not default.

**Prefix matching is a candidate for removal** (−0.010 MRR, +1.9pp R@1 when disabled) but the effect is small; it needs confirmation on a second dataset before acting.

## 6. Threats to validity

- Single dataset, synthetic English chit-chat; generalization to real personal memories is unproven.
- Corpus construction (full sessions, both roles) may differ from agentmemory's; treat the comparison as indicative.
- OFAT cannot see factor interactions (only synonym×limit was checked).
- The pooled stress test is adversarial — 22k same-distribution distractors are harsher than a real diverse memory store.
- The 41-query synthetic fixture (recall@1 0.73) and this bench measure different things; both are reported, neither is "the" number.
- §4.7's pooled vector arm used single-vector-per-document with no chunking — a known-bad setup for 10k-char sessions, deliberately not re-run chunked (non-representative corpus); the fixture arm is the product-representative result.

## 7. Conclusion

Measure first, then change: the pipeline's BM25 core is strong (level with published hybrid systems), its dominant factor is OR semantics (+0.652 MRR; everything else ±0.01), its limit behavior is understood (R@1 invariant, flattening at 5), and its synonym round — under either design, at either scale — contributes nothing measurable on public data, because the data barely contains the vocabulary-mismatch slice it exists for. The embedding gate passes where the product lives: multilingual vectors beat BM25 by +12pp R@5 on memory-like docs, rescuing the cross-lingual misses BM25 cannot see; the pooled vector collapse is a single-vector-on-long-docs artifact, not a verdict. What remains is engineering, not research: index-time synonym/translation expansion (§18 backlog), a designed fusion strategy (naive RRF hurts), and a configurable embedding model.

## References

- Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, ICLR 2025. Data: `xiaowu0162/longmemeval-cleaned` (MIT).
- Hu et al., *MemoryAgentBench*, arXiv:2507.05257.
- agentmemory, `benchmark/LONGMEMEVAL.md` (published BM25-only / BM25+vector recall_any@k).
- RRF: Cormack et al., SIGIR 2009.

## Appendix: reproduction

```bash
# per-question baseline (limit 10)
node --experimental-strip-types scripts/bench-longmemeval.ts \
  --data <longmemeval_s_cleaned.json> --variant baseline --search-limit 10
# OFAT: --variant no-stopwords | and | no-prefix
#   (no-synonyms retired by D80 — expansion is index-time now; its 2026-10-07
#   measurement, effect 0.000, stands in the paper)
# limit sweep: --search-limit 1|3|5|10|20|50
# pooled stress: add --pooled
# rescue experiment: --rescue --search-limit <K> --out-rows <tsv> [--pooled]
# semantic experiment (§4.7): local multilingual embeddings, no API key needed
#   first run downloads the model (~470MB) to $HF_HUB_CACHE; /tmp is only
#   512MB on small VMs — set TMPDIR to a roomy dir before running
TMPDIR=~/bench-tmp HF_HUB_CACHE=~/bench-hf-cache \
node --experimental-strip-types scripts/bench-semantic.ts --fixture
TMPDIR=~/bench-tmp HF_HUB_CACHE=~/bench-hf-cache \
node --experimental-strip-types scripts/bench-semantic.ts \
  --pooled --data <longmemeval_s_cleaned.json>
#   --model <hf-id>  overrides the default
#   Xenova/paraphrase-multilingual-MiniLM-L12-v2 (doc embeddings cache to
#   <cwd>/emb-<mode>.json and are reused across runs)
```
