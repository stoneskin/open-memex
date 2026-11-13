// D78 curate fixture - measurement first.
//
// Usage: node --experimental-strip-types scripts/curate-eval.ts
//
// Baseline (2026-11-13, 0.10.0-alpha.2, no curation): lint 9 findings
// (orphan 7, dangling 1, stale 1); deterministic candidates: exact-dup 1,
// empty 1, title 2; near-dup report (not auto) 1.
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
type: fact
role: knowledge
importance: normal
status: ${opts.status ?? "active"}
tags: [${(opts.tags ?? []).join(", ")}]
source: cli
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

  const re = run(["reindex"], project);
  if (re.code !== 0) throw new Error(`reindex failed: ${re.out}${re.err}`);
  return {
    project,
    scopeKey,
    outboxDir,
    repoDir,
    batchIds: [dupA, dupB, empty, title, nearA, nearB],
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
    const body = raw.slice(raw.indexOf("\n---\n") + 5);
    return { id: memId, body };
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
  for (let i = 0; i < batch.length; i++) {
    for (let j = i + 1; j < batch.length; j++) {
      const a = batch[i]!;
      const b = batch[j]!;
      if (contentHash(a.body) === contentHash(b.body)) continue;
      if (similarity(a.body, b.body) >= NEAR_DUP_THRESHOLD) nearPairs++;
    }
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
  };
}

interface Curated {
  autoApplied: number;
  merged: number;
  archived: number;
  normalized: number;
  receipts: string[];
  output: string;
}

function curated(s: Seed): Curated {
  const r = run(["submit", ...s.batchIds], s.project);
  const output = `${r.out}${r.err}`;
  const applied = Number((/curation auto-applied:\s*(\d+)/.exec(output) ?? [])[1] ?? 0);
  return {
    autoApplied: applied,
    merged: (output.match(/\bmerged\b/g) ?? []).length,
    archived: (output.match(/\barchived\b/g) ?? []).length,
    normalized: (output.match(/\bnormalized\b/g) ?? []).length,
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
    `title ${m.titlesToNormalize} | near-dup report ${m.nearPairs}`
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

const noSeed = seed("no-curate");
const no = noCurate(noSeed);
console.log(
  `--no-curate: ${no.disabled ? "curation skipped as requested" : "MISSING SKIP LINE"}; auto-applied ${no.autoApplied}`,
);

const undoIds = [id("DUPB"), id("TITLE"), id("EMPTY")];
const undoResults = undoIds.map((memId) => run(["curate", "undo", memId], curSeed.project));
console.log(`undo checks: ${undoResults.filter((r) => r.code === 0).length}/${undoResults.length} succeeded`);
console.log(`scratch: ${T}`);
