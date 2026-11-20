// D78 curate fixture - measurement first.
//
// Usage: node --experimental-strip-types scripts/curate-eval.ts
//
// Baseline (2026-11-13, 0.10.0-alpha.2, no curation): lint 9 findings
// (orphan 7, dangling 1, stale 1); deterministic candidates: exact-dup 1,
// empty 1, title 2; near-dup report (not auto) 1.
//
// D95 batch-confirm baseline (2026-11-19, 0.10.0, extended fixture, no batch
// logic): lint 14 (orphan 12, dangling 1, stale 1) - the five new outbox
// drafts are orphan nodes; deterministic candidates unchanged (exact-dup 1,
// empty 1, title 2); near-dup report 2 (the pair above + the semantic-merge
// pair); batch proposals: semantic-merge 1, split 1, type-inference 2,
// tag-inference 2. Nothing is applied for the batch tier - the run submits
// all 9 remaining members unchanged, which is the "declined batch changes
// nothing" baseline. Lint after submit: 11 (orphan 9, dangling 1, stale 1).
//
// Seeds two scratch projects with the same corpus, measures the deterministic
// curation candidates in the first, then runs `submit` in the second and reads
// the curation summary it prints. The baseline half contains no product logic;
// it uses the same contentHash/similarity the write path already uses, so the
// numbers are comparable before and after D78's auto-apply tier lands.
//
// Isolated: temp HOME + OPEN_MEMEX_HOME + temp git repo. Touches nothing real.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, similarity, NEAR_DUP_THRESHOLD } from "../src/store/lifecycle.ts";

// D95 batch-confirm threshold: 0.8 is the "worth a look" signal, 0.9 is
// "genuinely same content". Kept here for the baseline half; the product
// constant lives in src/curate.ts.
const SEMANTIC_MERGE_THRESHOLD = 0.9;

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO, "dist", "cli.js");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "om-curate-"));
const HOME = path.join(T, "home");
const DATA = path.join(T, "data");
fs.mkdirSync(HOME, { recursive: true });
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  OPEN_MEMEX_HOME: DATA,
};

function run(args: string[], cwd: string): { out: string; err: string; code: number } {
  try {
    return {
      out: execFileSync("node", [CLI, ...args], {
        cwd,
        env: ENV,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      err: "",
      code: 0,
    };
  } catch (e: any) {
    return { out: e.stdout ?? "", err: e.stderr ?? "", code: e.status ?? 1 };
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: ENV, stdio: "ignore" });
}

function mkproj(name: string): string {
  const p = path.join(T, name);
  fs.mkdirSync(p, { recursive: true });
  git(["init", "-q"], p);
  git(["config", "user.email", "test@example.com"], p);
  git(["config", "user.name", "Test"], p);
  fs.writeFileSync(path.join(p, "README.md"), "# curate eval\n");
  git(["add", "."], p);
  git(["commit", "-qm", "init"], p);
  return p;
}

// Crockford-safe, 26-char fixture ids so graph extraction sees real ULIDs.
function id(tag: string): string {
  const safe = tag.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
  return `01D78${safe.padEnd(21, "0")}`.slice(0, 26);
}

interface FixtureOptions {
  status?: string;
  tags?: string[];
  type?: string;
  source?: string;
  createdAt?: string;
  supersedes?: string | null;
  supersededBy?: string | null;
}

function fixture(
  dir: string,
  memId: string,
  body: string,
  scopeKey: string,
  opts: FixtureOptions = {},
): void {
  const now = opts.createdAt ?? "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${memId}.md`),
    `---
id: ${memId}
schema_version: 2
scope_key: ${scopeKey}
scope: project
visibility: internal
project_name: d78
type: ${opts.type ?? "fact"}
role: knowledge
importance: normal
status: ${opts.status ?? "active"}
tags: [${(opts.tags ?? []).join(", ")}]
source: ${opts.source ?? "cli"}
created_at: "${now}"
updated_at: "${now}"
supersedes: ${opts.supersedes ?? "null"}
superseded_by: ${opts.supersededBy ?? "null"}
review_state: draft
proposed_by: null
approved_by: null
derived_from: null
review_note: null
review_history: []
---

${body}
`,
    "utf8",
  );
}

function normalizeTitleLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function firstNonEmptyLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0) ?? "";
}

interface Seed {
  project: string;
  scopeKey: string;
  outboxDir: string;
  repoDir: string;
  batchIds: string[];
}

function seed(name: string): Seed {
  const project = mkproj(name);
  const where = run(["where"], project);
  const scopeKey = (/project:\s*(\S+)/.exec(where.out) ?? [])[1] ?? "";
  if (!scopeKey) throw new Error(`could not resolve scope key: ${where.out}${where.err}`);
  const outboxDir = path.join(DATA, "memories", scopeKey);
  const repoDir = path.join(project, ".ai", "open-memex");

  const orphan = id("ORPHAN");
  const dangling = id("DANGLING");
  const staleOld = id("STALEOLD");
  const staleNew = id("STALENEW");
  const staleMate = id("STALEMATE");
  fixture(repoDir, orphan, "zzq d78 orphan editor parser note with unique tag", scopeKey, {
    tags: ["orphanonly"],
  });
  fixture(
    repoDir,
    dangling,
    `zzq d78 dangling link see [[${id("MISSING")}]]`,
    scopeKey,
    { tags: ["dangletag"] },
  );
  fixture(repoDir, staleOld, "zzq d78 stale deploy checklist build sign upload", scopeKey, {
    status: "superseded",
    tags: ["staletag"],
  });
  fixture(repoDir, staleNew, "zzq d78 stale deploy checklist build sign upload now", scopeKey, {
    tags: ["staletag"],
  });
  fixture(repoDir, staleMate, "zzq d78 stale partner release notes", scopeKey, {
    tags: ["staletag"],
  });

  const dupA = id("DUPA");
  const dupB = id("DUPB");
  const empty = id("EMPTY");
  const title = id("TITLE");
  const nearA = id("NEARA");
  const nearB = id("NEARB");
  fixture(outboxDir, dupA, "zzq d78 exact duplicate remember the deploy window", scopeKey, {
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  fixture(outboxDir, dupB, "  zzq   d78 exact duplicate remember the deploy window  ", scopeKey, {
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  fixture(outboxDir, empty, "   \n\t\n", scopeKey);
  fixture(outboxDir, title, "  zzq   d78   title   needs   collapsing  \n\nsecond line", scopeKey);
  fixture(
    outboxDir,
    nearA,
    "zzq d78 near duplicate deployment window opens thursday morning",
    scopeKey,
  );
  fixture(
    outboxDir,
    nearB,
    "zzq d78 near duplicate deployment window opens friday morning",
    scopeKey,
  );

  // D95 batch-confirm corpus. Same shape as the deterministic half: every
  // case is a real outbox draft the human would submit together.
  //
  // - semantic-merge pair: same content, not byte-identical (similarity
  //   crosses 0.8, contentHash differs), so the deterministic tier leaves it
  //   alone and only the batch tier may merge it.
  // - split candidate: two unrelated paragraphs in one overlong memory.
  // - infer-type/tag, high confidence from a keyword capture (source:
  //   keyword): the hook never chose a type, so the auto tier may accept it.
  // - infer-type/tag, high confidence from a tool save (source: cli): the
  //   agent may have chosen `fact`, so the batch screen asks.
  const mergeA = id("MERGA");
  const mergeB = id("MERGB");
  const split = id("SPLIT");
  const inferAuto = id("INFERAUTO");
  const inferBatch = id("INFERBATCH");
  fixture(
    outboxDir,
    mergeA,
    "zzq d78 semantic merge candidate deployment window opens thursday morning at nine",
    scopeKey,
    { createdAt: "2026-01-01T00:00:10.000Z" },
  );
  fixture(
    outboxDir,
    mergeB,
    "zzq d78 semantic merge candidate deployment window opens Thursday morning at nine",
    scopeKey,
    { createdAt: "2026-01-01T00:00:11.000Z" },
  );
  fixture(
    outboxDir,
    split,
    "zzq d78 split candidate deployment runbook keep the release train on thursday morning after standup and record the rollback owner in the shared channel before the cut\n\nzzq d78 split candidate espresso grinder cleaning schedule backflush the group head every friday and descale the boiler monthly with the citric solution from the cabinet",
    scopeKey,
  );
  fixture(
    outboxDir,
    inferAuto,
    "TODO: rotate the deploy signing key before the release cut #release",
    scopeKey,
    { source: "keyword" },
  );
  fixture(
    outboxDir,
    inferBatch,
    "We decided the release cut moves to friday afternoon #release",
    scopeKey,
  );

  const re = run(["reindex"], project);
  if (re.code !== 0) throw new Error(`reindex failed: ${re.out}${re.err}`);
  return {
    project,
    scopeKey,
    outboxDir,
    repoDir,
    batchIds: [
      dupA,
      dupB,
      empty,
      title,
      nearA,
      nearB,
      mergeA,
      mergeB,
      split,
      inferAuto,
      inferBatch,
    ],
  };
}

interface Measure {
  lintTotal: number;
  orphan: number;
  dangling: number;
  stale: number;
  exactDuplicates: number;
  emptyBodies: number;
  titlesToNormalize: number;
  nearPairs: number;
  semanticMerges: number;
  splitCandidates: number;
  typeInferences: number;
  tagInferences: number;
}

/** Baseline-only copy of the split heuristic: two unrelated paragraphs in an
 *  overlong body. Kept in the fixture so the "before" number does not depend
 *  on product code that does not exist yet. */
function fixtureSplitCandidate(body: string): { first: string; second: string } | null {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length < 320) return null;
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const first = parts.slice(0, i + 1).join("\n\n");
    const second = parts.slice(i + 1).join("\n\n");
    if (first.length < 100 || second.length < 100) continue;
    const score = similarity(first, second);
    if (!best || score < best.score) best = { i, score };
  }
  if (!best || best.score >= 0.25) return null;
  return {
    first: parts.slice(0, best.i + 1).join("\n\n"),
    second: parts.slice(best.i + 1).join("\n\n"),
  };
}

const FIXTURE_TYPE_RULES: Array<[RegExp, string]> = [
  [/(^|\n)\s*(todo|TODO)\s*:/, "todo"],
  [/(^|\n)\s*(gotcha|beware|warning)\s*:/i, "gotcha"],
  [/(^|\n)\s*how\s+to\b/i, "howto"],
  [/\bwe\s+(?:have\s+)?decided\b/i, "decision"],
  [/(^|\n)\s*decision\s*:/i, "decision"],
  [/\bi\s+prefer\b/i, "preference"],
  [/(^|\n)\s*preference\s*:/i, "preference"],
];

function fixtureTypeInference(body: string): string | null {
  for (const [re, type] of FIXTURE_TYPE_RULES) if (re.test(body)) return type;
  return null;
}

function fixtureTagInference(body: string): string[] {
  const out: string[] = [];
  const re = /(^|\s)#([a-z0-9][a-z0-9_-]{1,23})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const tag = m[2]!.toLowerCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

interface LintCounts {
  total: number;
  orphan: number;
  dangling: number;
  stale: number;
}

function lint(s: Seed): LintCounts {
  const r = run(["graph", "lint", "--json"], s.project);
  try {
    const parsed = JSON.parse(r.out) as {
      findings: unknown[];
      counts: { orphan: number; "dangling-edge": number; stale: number };
    };
    return {
      total: parsed.findings.length,
      orphan: parsed.counts.orphan,
      dangling: parsed.counts["dangling-edge"],
      stale: parsed.counts.stale,
    };
  } catch {
    throw new Error(`graph lint --json did not parse: ${r.out}${r.err}`);
  }
}

function measure(s: Seed): Measure {
  const counts = lint(s);

  const batch = s.batchIds.map((memId) => {
    const raw = fs.readFileSync(path.join(s.outboxDir, `${memId}.md`), "utf8");
    const fence = raw.indexOf("\n---\n", 4);
    const fmRaw = raw.slice(4, fence);
    const body = raw.slice(fence + 5);
    const type = (/^type:\s*(\S+)/m.exec(fmRaw) ?? [])[1] ?? "fact";
    const source = (/^source:\s*(\S+)/m.exec(fmRaw) ?? [])[1] ?? "";
    const tagLine = (/^tags:\s*\[(.*)\]/m.exec(fmRaw) ?? [])[1] ?? "";
    const tags = tagLine
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return { id: memId, body, type, source, tags };
  });

  const groups = new Map<string, string[]>();
  for (const b of batch) {
    const key = contentHash(b.body);
    const list = groups.get(key) ?? [];
    list.push(b.id);
    groups.set(key, list);
  }
  let exactDuplicates = 0;
  for (const list of groups.values()) exactDuplicates += Math.max(0, list.length - 1);

  let emptyBodies = 0;
  let titlesToNormalize = 0;
  for (const b of batch) {
    if (b.body.trim().length === 0) {
      emptyBodies++;
      continue;
    }
    const line = firstNonEmptyLine(b.body);
    if (line !== normalizeTitleLine(line)) titlesToNormalize++;
  }

  let nearPairs = 0;
  let semanticMerges = 0;
  for (let i = 0; i < batch.length; i++) {
    for (let j = i + 1; j < batch.length; j++) {
      const a = batch[i]!;
      const b = batch[j]!;
      if (contentHash(a.body) === contentHash(b.body)) continue;
      const score = similarity(a.body, b.body);
      if (score < NEAR_DUP_THRESHOLD) continue;
      nearPairs++;
      // D95: a merge needs the near-dup signal to be genuinely same-content.
      // 0.8-0.9 stays report-only: one flipped word (thursday/friday) lands
      // there and merging it would drop a real difference.
      const ratio =
        Math.min(a.body.length, b.body.length) / Math.max(a.body.length, b.body.length);
      if (score >= SEMANTIC_MERGE_THRESHOLD && ratio >= 0.6) semanticMerges++;
    }
  }

  let splitCandidates = 0;
  let typeInferences = 0;
  let tagInferences = 0;
  for (const b of batch) {
    if (b.body.trim().length === 0) continue;
    if (fixtureSplitCandidate(b.body)) splitCandidates++;
    const inferredType = fixtureTypeInference(b.body);
    if (b.type === "fact" && inferredType && inferredType !== b.type) typeInferences++;
    const inferredTags = fixtureTagInference(b.body).filter((t) => !b.tags.includes(t));
    if (inferredTags.length > 0) tagInferences++;
  }

  return {
    lintTotal: counts.total,
    orphan: counts.orphan,
    dangling: counts.dangling,
    stale: counts.stale,
    exactDuplicates,
    emptyBodies,
    titlesToNormalize,
    nearPairs,
    semanticMerges,
    splitCandidates,
    typeInferences,
    tagInferences,
  };
}

interface Curated {
  autoApplied: number;
  merged: number;
  archived: number;
  normalized: number;
  submittedCount: number;
  prTitleCount: number | null;
  prBody: string;
  receipts: string[];
  output: string;
}

function curated(s: Seed): Curated {
  const r = run(["submit", ...s.batchIds], s.project);
  const output = `${r.out}${r.err}`;
  const applied = Number((/curation auto-applied:\s*(\d+)/.exec(output) ?? [])[1] ?? 0);
  const titleCount = /--title "mem: review (\d+) /.exec(output);
  return {
    autoApplied: applied,
    merged: (output.match(/\bmerged\b/g) ?? []).length,
    archived: (output.match(/\barchived\b/g) ?? []).length,
    normalized: (output.match(/\bnormalized\b/g) ?? []).length,
    submittedCount: (output.match(/^submitted /gm) ?? []).length,
    prTitleCount: titleCount ? Number(titleCount[1]) : null,
    prBody: (/--body "([^"]*)"/.exec(output) ?? [])[1] ?? "",
    receipts: output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(merged|archived|normalized) /.test(l)),
    output,
  };
}

function noCurate(s: Seed): { disabled: boolean; autoApplied: number; output: string } {
  const r = run(["submit", "--no-curate", ...s.batchIds], s.project);
  const output = `${r.out}${r.err}`;
  return {
    disabled: /curation auto-apply skipped \(--no-curate\)/.test(output),
    autoApplied: Number((/curation auto-applied:\s*(\d+)/.exec(output) ?? [])[1] ?? 0),
    output,
  };
}

function line(label: string, m: Measure): string {
  return (
    `${label}: lint ${m.lintTotal} (orphan ${m.orphan}, dangling ${m.dangling}, stale ${m.stale}) | ` +
    `deterministic candidates: exact-dup ${m.exactDuplicates}, empty ${m.emptyBodies}, ` +
    `title ${m.titlesToNormalize} | near-dup report ${m.nearPairs} | ` +
    `batch proposals: merge ${m.semanticMerges}, split ${m.splitCandidates}, ` +
    `type ${m.typeInferences}, tag ${m.tagInferences}`
  );
}

console.log("D78 curate eval (scratch stores, no real data)");
const baseSeed = seed("baseline");
const base = measure(baseSeed);
console.log(line("baseline", base));

const curSeed = seed("curated");
const before = measure(curSeed);
const after = curated(curSeed);
console.log(line("curated pre-submit", before));
const afterLint = lint(curSeed);
console.log(
  `curated lint after submit: ${afterLint.total} (orphan ${afterLint.orphan}, dangling ${afterLint.dangling}, stale ${afterLint.stale})`,
);
console.log(
  `curated auto-applied: ${after.autoApplied} (merged ${after.merged}, archived ${after.archived}, normalized ${after.normalized})`,
);
for (const r of after.receipts) console.log(`  ${r}`);
if (after.autoApplied === 0) {
  console.log("  (no curation summary yet - this is the pre-D78 baseline run)");
}
const bodyIds = (/IDs: ([^.]+)\./.exec(after.prBody) ?? [])[1]?.trim().split(/\s+/).filter(Boolean)
  .length ?? 0;
const prOk =
  after.submittedCount > 0 &&
  after.prTitleCount === after.submittedCount &&
  bodyIds === after.submittedCount &&
  /Lint before curation: 14 finding\(s\) \(orphans 12, dangling 1, stale 1; report only\)\. Auto-applied 3: merged 1, archived 1, normalized 1\.$/.test(
    after.prBody,
  );
console.log(
  `pr command: title ${after.prTitleCount ?? "missing"} (submitted ${after.submittedCount}), body ids ${bodyIds}, summary ${prOk ? "ok" : "MISSING"}`,
);
if (!prOk) throw new Error(`PR command does not match the submitted set:\n${after.output}`);

const noSeed = seed("no-curate");
const no = noCurate(noSeed);
console.log(
  `--no-curate: ${no.disabled ? "curation skipped as requested" : "MISSING SKIP LINE"}; auto-applied ${no.autoApplied}`,
);

const undoIds = [id("DUPB"), id("TITLE"), id("EMPTY")];
const undoResults = undoIds.map((memId) => run(["curate", "undo", memId], curSeed.project));
console.log(`undo checks: ${undoResults.filter((r) => r.code === 0).length}/${undoResults.length} succeeded`);
undoResults.forEach((r, i) => {
  if (r.code !== 0) console.log(`  undo ${undoIds[i]} failed: ${(r.err || r.out).trim()}`);
});
console.log(`scratch: ${T}`);
