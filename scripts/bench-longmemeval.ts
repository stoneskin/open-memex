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
if (!dataPath) {
  console.error("missing --data <longmemeval_s_cleaned.json>");
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

const K = 10;

interface Agg {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  mrr: number;
}
const fresh = (): Agg => ({ n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 });
const byType = new Map<string, { on: Agg; off: Agg }>();
const total = { on: fresh(), off: fresh() };

function record(agg: Agg, rank: number) {
  agg.n++;
  if (rank === 0) agg.r1++;
  if (rank !== -1 && rank < 5) agg.r5++;
  if (rank !== -1 && rank < 10) agg.r10++;
  if (rank !== -1) agg.mrr += 1 / (rank + 1);
}

let done = 0;
for (const q of questions) {
  // Isolated corpus: wipe the personal scope and reseed per question.
  db()
    .prepare("DELETE FROM memories WHERE scope_key = 'personal'")
    .run();
  db()
    .prepare("DELETE FROM memories_fts WHERE rowid NOT IN (SELECT rowid FROM memories)")
    .run();
  const dir = memoriesDirPath("personal");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));

  const sidToIdx = new Map(q.haystack_session_ids.map((sid, i) => [sid, i]));
  const goldIdx = new Set(
    q.answer_session_ids
      .map((sid) => sidToIdx.get(sid))
      .filter((i): i is number => i !== undefined),
  );
  if (goldIdx.size === 0) continue;

  q.haystack_sessions.forEach((turns, i) => {
    const body =
      `[session ${i} — ${q.haystack_dates[i] ?? "unknown date"}]\n\n` +
      turns.map((t) => `${t.role}: ${t.content}`).join("\n\n");
    const fm = normalizeFrontmatter({
      id: `sess-${i}`,
      scope: "personal",
      type: "fact",
      tags: ["longmemeval"],
      source: "longmemeval-s",
    });
    fs.writeFileSync(path.join(dir, `sess-${i}.md`), serialize(fm, body), "utf8");
  });
  syncScope("personal");

  const rankOf = (synonyms: boolean): number => {
    const hits = search(q.question, {
      scopeKeys: ["personal"],
      limit: K,
      synonyms,
    });
    for (let r = 0; r < hits.length; r++) {
      const m = /^sess-(\d+)$/.exec(hits[r].id);
      if (m && goldIdx.has(Number(m[1]))) return r;
    }
    return -1;
  };

  const rOn = rankOf(true);
  const rOff = rankOf(false);
  let t = byType.get(q.question_type);
  if (!t) {
    t = { on: fresh(), off: fresh() };
    byType.set(q.question_type, t);
  }
  record(total.on, rOn);
  record(total.off, rOff);
  record(t.on, rOn);
  record(t.off, rOff);

  done++;
  if (done % 50 === 0) console.log(`  ... ${done}/${questions.length}`);
}

function pct(a: Agg, f: (x: Agg) => number): string {
  return ((f(a) / a.n) * 100).toFixed(1) + "%";
}
function show(name: string, a: Agg) {
  console.log(
    `  ${name.padEnd(28)} n=${a.n}  R@1 ${pct(a, (x) => x.r1)}  R@5 ${pct(a, (x) => x.r5)}  R@10 ${pct(a, (x) => x.r10)}  MRR ${(a.mrr / a.n).toFixed(3)}`,
  );
}

console.log("\n==== LongMemEval-S retrieval (per-question isolated corpus) ====");
console.log("-- synonyms ON (D79):");
show("overall", total.on);
for (const [t, a] of [...byType.entries()].sort()) show(t, a.on);
console.log("-- synonyms OFF (ablation):");
show("overall", total.off);
for (const [t, a] of [...byType.entries()].sort()) show(t, a.off);
