/**
 * LongMemEval-S retrieval bench (D77 external validation).
 *
 * Retrieval-stage only: for each question, every haystack session becomes
 * one memory (full turns, role-labeled), the corpus is isolated per
 * question, and we check whether a gold session lands in the top-k.
 * Metric: recall_any@k + MRR — the same protocol agentmemory publishes
 * (their BM25+vector: R@5 95.2%, R@10 98.6%, MRR 88.2%).
 *
 * This is NOT the official LongMemEval score (that needs answer
 * generation + a GPT-4o judge). Do not call the output a "LongMemEval
 * score" — it is retrieval recall on LongMemEval-S.
 *
 * The 30 abstention questions (*_abs) are excluded, per LongMemEval's own
 * retrieval-eval protocol (nothing in the history answers them).
 *
 * Runs every question twice: synonyms on (default) vs off — the ablation
 * for D79.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-longmemeval.ts \
 *     --data ~/workspace/bench-data/longmemeval_s_cleaned.json [--limit 20]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const dataPath = args[args.indexOf("--data") + 1] ?? "";
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx === -1 ? Infinity : Number(args[limitIdx + 1]);
const POOLED = args.includes("--pooled");
const variantIdx = args.indexOf("--variant");
const VARIANT = variantIdx === -1 ? "baseline" : args[variantIdx + 1];
if (!dataPath) {
  console.error("missing --data <longmemeval_s_cleaned.json>");
  process.exit(1);
}
if (!["baseline", "no-stopwords", "and", "no-prefix", "no-synonyms"].includes(VARIANT)) {
  console.error(`unknown --variant ${VARIANT}`);
  process.exit(1);
}

interface LMEItem {
  question_id: string;
  question_type: string;
  question: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  haystack_dates: string[];
}

const items: LMEItem[] = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const questions = items
  .filter((q) => !q.question_id.endsWith("_abs"))
  .slice(0, LIMIT);
console.log(`questions: ${questions.length} (abstention excluded)`);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lme-bench-"));
process.env.OPEN_MEMEX_HOME = HOME;

import { serialize, normalizeFrontmatter } from "../src/store/markdown.ts";
import { syncScope } from "../src/store/sync.ts";
import { search } from "../src/retrieve/search.ts";
import { memoriesDirPath } from "../src/paths.ts";
import { db } from "../src/store/db.ts";

const K = (() => {
  const li = args.indexOf("--search-limit");
  return li === -1 ? 10 : Number(args[li + 1]);
})();

const SEARCH_OPTS = {
  synonyms: VARIANT !== "no-synonyms",
  stopwords: VARIANT !== "no-stopwords",
  orJoin: VARIANT !== "and",
  prefix: VARIANT !== "no-prefix",
};

interface Agg {
  n: number;
  r1: number;
  r3: number;
  r5: number;
  r10: number;
  mrr: number;
}
const fresh = (): Agg => ({ n: 0, r1: 0, r3: 0, r5: 0, r10: 0, mrr: 0 });
const byType = new Map<string, Agg>();
const total = fresh();

function record(agg: Agg, rank: number) {
  agg.n++;
  if (rank === 0) agg.r1++;
  if (rank !== -1 && rank < 3) agg.r3++;
  if (rank !== -1 && rank < 5) agg.r5++;
  if (rank !== -1 && rank < 10) agg.r10++;
  if (rank !== -1) agg.mrr += 1 / (rank + 1);
}

function writeSession(
  dir: string,
  id: string,
  turns: Array<{ role: string; content: string }>,
  label: string,
) {
  const body =
    `[${label}]\n\n` + turns.map((t) => `${t.role}: ${t.content}`).join("\n\n");
  const fm = normalizeFrontmatter({
    id,
    scope: "personal",
    type: "fact",
    tags: ["longmemeval"],
    source: "longmemeval-s",
  });
  fs.writeFileSync(path.join(dir, `${id}.md`), serialize(fm, body), "utf8");
}

function wipeScope() {
  db()
    .prepare("DELETE FROM memories WHERE scope_key = 'personal'")
    .run();
  db()
    .prepare("DELETE FROM memories_fts WHERE rowid NOT IN (SELECT rowid FROM memories)")
    .run();
  const dir = memoriesDirPath("personal");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  return dir;
}

// question-local gold: session indices within this question's haystack
function goldIdxFor(q: LMEItem): Set<number> {
  const sidToIdx = new Map(q.haystack_session_ids.map((sid, i) => [sid, i]));
  return new Set(
    q.answer_session_ids
      .map((sid) => sidToIdx.get(sid))
      .filter((i): i is number => i !== undefined),
  );
}

let round2fires = 0;
let round2rescues = 0;

function rankOf(
  q: LMEItem,
  isGold: (id: string) => boolean,
): number {
  const stats = { ftsQuery: "", candidates: 0, hiddenSuperseded: 0, hiddenExcluded: 0, secondRound: false };
  const hits = search(q.question, {
    scopeKeys: ["personal"],
    limit: K,
    stats,
    ...SEARCH_OPTS,
  });
  if (stats.secondRound) {
    round2fires++;
    for (let r = 0; r < hits.length; r++) {
      if (isGold(hits[r].id)) {
        round2rescues++;
        break;
      }
    }
  }
  for (let r = 0; r < hits.length; r++) {
    if (isGold(hits[r].id)) return r;
  }
  return -1;
}

if (POOLED) {
  // One big corpus: every session of every question (~23.5k memories).
  const dir = wipeScope();
  let qi = 0;
  for (const q of questions) {
    q.haystack_sessions.forEach((turns, i) => {
      writeSession(dir, `q${qi}-s${i}`, turns, `question ${qi}, session ${i} — ${q.haystack_dates[i] ?? "unknown date"}`);
    });
    qi++;
  }
  syncScope("personal");
  console.log(`pooled corpus: ${(db().prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c} memories`);
}

let done = 0;
let qi = 0;
for (const q of questions) {
  const gold = goldIdxFor(q);
  let isGold: (id: string) => boolean;
  if (POOLED) {
    const myQi = qi;
    isGold = (id) => {
      const m = /^q(\d+)-s(\d+)$/.exec(id);
      return !!m && Number(m[1]) === myQi && gold.has(Number(m[2]));
    };
  } else {
    // Isolated corpus: wipe the personal scope and reseed per question.
    const dir = wipeScope();
    if (gold.size === 0) {
      qi++;
      continue;
    }
    q.haystack_sessions.forEach((turns, i) => {
      writeSession(dir, `sess-${i}`, turns, `session ${i} — ${q.haystack_dates[i] ?? "unknown date"}`);
    });
    syncScope("personal");
    isGold = (id) => {
      const m = /^sess-(\d+)$/.exec(id);
      return !!m && gold.has(Number(m[1]));
    };
  }
  if (gold.size === 0) {
    qi++;
    continue;
  }

  const r = rankOf(q, isGold);
  let t = byType.get(q.question_type);
  if (!t) {
    t = fresh();
    byType.set(q.question_type, t);
  }
  record(total, r);
  record(t, r);

  done++;
  qi++;
  if (done % 50 === 0) console.log(`  ... ${done}/${questions.length}`);
}

function pct(a: Agg, f: (x: Agg) => number): string {
  return ((f(a) / a.n) * 100).toFixed(1) + "%";
}
function show(name: string, a: Agg) {
  const cells = [`n=${a.n}`, `R@1 ${pct(a, (x) => x.r1)}`];
  if (K >= 3) cells.push(`R@3 ${pct(a, (x) => x.r3)}`);
  if (K >= 5) cells.push(`R@5 ${pct(a, (x) => x.r5)}`);
  if (K >= 10) cells.push(`R@10 ${pct(a, (x) => x.r10)}`);
  cells.push(`MRR@${K} ${(a.mrr / a.n).toFixed(3)}`);
  console.log(`  ${name.padEnd(28)} ${cells.join("  ")}`);
}

console.log(`\n==== LongMemEval-S retrieval (${POOLED ? "pooled 23k corpus" : "per-question isolated corpus"}) ====`);
console.log(`variant=${VARIANT} search-limit=${K}`);
console.log(`round2 fired on ${round2fires} queries, gold in round-2 results ${round2rescues}x`);
show("overall", total);
for (const [t, a] of [...byType.entries()].sort()) show(t, a);
