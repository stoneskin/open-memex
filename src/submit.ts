/**
 * 2B/D26: submit — move outbox drafts into a git branch for review.
 *
 * The AI-driven sync loop:
 *   1. `open-memex sync-status` — what is waiting (outbox drafts, in-review, published)
 *   2. user picks memories to sync
 *   3. `open-memex submit <ids>` — new branch (default `mem/sync-*`), copy
 *      drafts into the repo dir as `proposed`, commit locally, move the
 *      outbox originals out (copy + verify + delete)
 *   4. push + open PR — done by the agent holding the user's approval, or by
 *      the human; the tool only prints the exact commands (D27)
 *
 * Git automation line (D27): the tool automates LOCAL git
 * only (branch, copy, commit). Nothing leaves the machine without the user's
 * explicit approval — push/PR are the agent's or the human's job.
 *
 * `submit` is idempotent: re-submitting an id whose file is already on the
 * branch with identical content just completes the outbox move. A same-id
 * file with DIFFERENT content is a conflict — abort, the human judges.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { inRepoMemoriesDir, memoriesDirPath, projectRoot } from "./paths.ts";
import { resolveProjectScope } from "./scope.ts";
import { contentHash } from "./store/lifecycle.ts";
import {
  msToRfc3339,
  parse as parseMemory,
  readMemoryFile,
  serialize,
  type ReviewState,
} from "./store/markdown.ts";
import { upsertFromFile } from "./store/sync.ts";
import { db } from "./store/db.ts";
import { currentAuthor } from "./review.ts";

function fail(msg: string): never {
  throw new Error(`[open-memex] ${msg}`);
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? "").trim().split("\n")[0];
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function snippetOf(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type OutboxLocation = "outbox" | "repo";
export type GitState = "uncommitted" | "committed" | "n/a";

export interface StatusEntry {
  id: string;
  title: string;
  reviewState: ReviewState;
  location: OutboxLocation;
  gitState: GitState;
}

export interface SyncStatus {
  scopeKey: string;
  projectName: string;
  outbox: StatusEntry[]; // appdata drafts waiting for submit
  inRepo: StatusEntry[]; // files in the repo dir (any review_state)
  uncommitted: StatusEntry[]; // repo files not yet committed (the untracked window)
}

/** Files under .ai/open-memex that git sees as new/modified/untracked. */
function uncommittedRepoFiles(root: string, repoDir: string): Set<string> {
  const out = new Set<string>();
  try {
    const porcelain = git(root, ["status", "--porcelain", "--", repoDir]);
    for (const line of porcelain.split("\n")) {
      const m = line.match(/^.{2}\s+(.*)$/);
      if (!m) continue;
      let p = m[1].trim();
      // handle renames: "R  old -> new"
      if (p.includes(" -> ")) p = p.split(" -> ")[1];
      // strip quotes git adds around unusual names
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      out.add(path.resolve(root, p));
    }
  } catch {
    /* not a git repo or git unavailable — no git state */
  }
  return out;
}

export function getSyncStatus(): SyncStatus {
  const root = projectRoot();
  const scope = resolveProjectScope(root);
  const cfg = loadConfig();
  const outboxDir = memoriesDirPath(scope.key);
  const repoDir = path.join(root, cfg.memoryDir);

  const rows = db()
    .prepare(
      `SELECT id, review_state, file_path, content FROM memories WHERE scope_key = ? ORDER BY updated_at DESC`,
    )
    .all(scope.key) as Array<{
    id: string;
    review_state: string;
    file_path: string;
    content: string;
  }>;

  const uncommitted = fs.existsSync(repoDir) ? uncommittedRepoFiles(root, repoDir) : new Set<string>();
  const outbox: StatusEntry[] = [];
  const inRepo: StatusEntry[] = [];
  const uncommittedList: StatusEntry[] = [];

  for (const r of rows) {
    const inOutbox = r.file_path.startsWith(outboxDir + path.sep);
    const entry: StatusEntry = {
      id: r.id,
      title: snippetOf(r.content ?? ""),
      reviewState: (r.review_state ?? "draft") as ReviewState,
      location: inOutbox ? "outbox" : "repo",
      gitState: "n/a",
    };
    if (inOutbox) {
      outbox.push(entry);
    } else {
      entry.gitState = uncommitted.has(path.resolve(r.file_path)) ? "uncommitted" : "committed";
      inRepo.push(entry);
      if (entry.gitState === "uncommitted") uncommittedList.push(entry);
    }
  }
  return {
    scopeKey: scope.key,
    projectName: scope.projectName,
    outbox,
    inRepo,
    uncommitted: uncommittedList,
  };
}

export function formatSyncStatus(st: SyncStatus): string {
  const lines: string[] = [];
  lines.push(`project: ${st.projectName} (${st.scopeKey})`);
  lines.push(`outbox (appdata, pending sync): ${st.outbox.length}`);
  for (const e of st.outbox) {
    lines.push(`  ${e.id}  [${e.reviewState}] ${e.title}`);
  }
  const byState = new Map<string, number>();
  for (const e of st.inRepo) byState.set(e.reviewState, (byState.get(e.reviewState) ?? 0) + 1);
  const breakdown = [...byState.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "none";
  lines.push(`repo .ai/open-memex: ${st.inRepo.length} (${breakdown})`);
  for (const e of st.inRepo) {
    const u = e.gitState === "uncommitted" ? " (uncommitted)" : "";
    lines.push(`  ${e.id}  [${e.reviewState}]${u} ${e.title}`);
  }
  if (st.uncommitted.length > 0) {
    lines.push(`note: ${st.uncommitted.length} repo file(s) not yet committed — they ride with the working tree until you commit.`);
  }
  if (st.outbox.length > 0) {
    lines.push(`next: open-memex submit ${st.outbox.map((e) => e.id).join(" ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export interface SubmitOptions {
  /** Submit onto this branch instead of creating mem/sync-*. Must be the current branch. */
  onto?: string;
  /** PR base override (default: the branch we branched from). */
  base?: string;
}

export interface SubmitResult {
  branch: string;
  base: string;
  submitted: Array<{ id: string; filePath: string }>;
  /** already on the branch with identical content — outbox move completed */
  skippedIdentical: string[];
  /** false when everything was already on the branch (nothing new to commit) */
  committed: boolean;
  pushCommand: string;
  prCommand: string;
}

interface Validated {
  id: string;
  srcPath: string;
  body: string;
  reviewState: ReviewState;
}

export function submitMemories(ids: string[], opts: SubmitOptions = {}): SubmitResult {
  if (ids.length === 0) fail("submit needs at least one memory id");
  const root = projectRoot();
  // submit needs a git repo — the whole point is branch + commit.
  git(root, ["rev-parse", "--git-dir"]);

  const scope = resolveProjectScope(root);
  const cfg = loadConfig();
  const outboxDir = memoriesDirPath(scope.key);
  const repoDir = inRepoMemoriesDir(root, cfg.memoryDir);

  // 1. Validate everything first (all-or-nothing — nothing is written yet).
  //    Read the outbox files directly from disk: the index resolves same-id
  //    collisions in favor of the repo copy, which would hide a genuine
  //    outbox-vs-branch conflict from us.
  const problems: string[] = [];
  const validated: Validated[] = [];
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      problems.push(`${id}: not a valid memory id`);
      continue;
    }
    const srcPath = path.join(outboxDir, `${id}.md`);
    if (!fs.existsSync(srcPath)) {
      problems.push(`${id}: not in the outbox (never staged, or already submitted? see sync-status)`);
      continue;
    }
    const mf = readMemoryFile(srcPath);
    if (!mf) {
      problems.push(`${id}: unreadable outbox file`);
      continue;
    }
    if (mf.fm.id !== id) {
      problems.push(`${id}: outbox file's frontmatter id is ${mf.fm.id} — not submitting a mislabeled file`);
      continue;
    }
    if (mf.fm.scope !== "project") {
      problems.push(`${id}: scope is ${mf.fm.scope}, only project memories can be submitted`);
      continue;
    }
    const rs = (mf.fm.review_state ?? "draft") as ReviewState;
    if (rs !== "draft" && rs !== "rejected") {
      problems.push(`${id}: review_state is ${rs}, only draft/rejected can be submitted`);
      continue;
    }
    validated.push({ id, srcPath, body: mf.body, reviewState: rs });
  }
  if (problems.length > 0) {
    fail(`submit aborted — nothing was written:\n  ${problems.join("\n  ")}`);
  }

  // 2. Resolve the target branch.
  const startBranch = git(root, ["branch", "--show-current"]) || git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch: string;
  if (opts.onto) {
    if (opts.onto !== startBranch) {
      fail(`--onto ${opts.onto} is not the current branch (${startBranch || "(detached)"}). submit only targets the branch you're on.`);
    }
    branch = opts.onto;
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    branch = `mem/sync-${stamp}`;
    let n = 0;
    while (true) {
      const exists = git(root, ["branch", "--list", branch]);
      if (!exists) break;
      n++;
      branch = `mem/sync-${stamp}-${n}`;
    }
    git(root, ["checkout", "-b", branch]);
  }
  const base = opts.base ?? startBranch;
  const author = currentAuthor();

  // 3. Copy drafts into the repo dir as proposed (same id — one memory, one id).
  //    Same id + different content on the branch = conflict → abort, human judges.
  const submitted: Array<{ id: string; filePath: string }> = [];
  const skippedIdentical: string[] = [];
  const now = msToRfc3339(Date.now());
  const written: Array<{ id: string; srcPath: string; destPath: string; hash: string }> = [];
  const conflicts: string[] = [];
  for (const v of validated) {
    const destPath = path.join(repoDir, `${v.id}.md`);
    const raw = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8") : null;
    if (raw !== null) {
      const existing = parseMemory(raw);
      const sameContent = existing !== null && contentHash(existing.body) === contentHash(v.body);
      if (sameContent) {
        skippedIdentical.push(v.id);
        written.push({ id: v.id, srcPath: v.srcPath, destPath, hash: contentHash(v.body) });
        continue;
      }
      conflicts.push(`${v.id}: already on branch ${branch} with different content — resolve it manually, then re-submit`);
      continue;
    }
    const parsed = parseMemory(fs.readFileSync(v.srcPath, "utf8"));
    if (!parsed) fail(`${v.id}: unreadable source file`);
    const fm = {
      ...parsed.fm,
      review_state: "proposed" as ReviewState,
      updated_at: now,
      proposed_by: parsed.fm.proposed_by ?? author,
    };
    const text = serialize(fm, parsed.body);
    fs.writeFileSync(destPath, text, "utf8");
    written.push({ id: v.id, srcPath: v.srcPath, destPath, hash: contentHash(parsed.body) });
    submitted.push({ id: v.id, filePath: destPath });
  }
  if (conflicts.length > 0) {
    // Roll back the copies we just made — nothing half-submitted.
    for (const w of written) {
      if (submitted.some((s) => s.id === w.id) && fs.existsSync(w.destPath)) {
        fs.unlinkSync(w.destPath);
      }
    }
    // If we created the branch and never committed, remove it too — an
    // aborted submit leaves no trace.
    if (!opts.onto) {
      try {
        git(root, ["checkout", "--quiet", startBranch]);
        git(root, ["branch", "--quiet", "-D", branch]);
      } catch {
        /* best effort — the error below is what matters */
      }
    }
    fail(`submit aborted — nothing was committed:\n  ${conflicts.join("\n  ")}`);
  }

  // 4. Commit locally (tool automates local git only — D27 line).
  //    Only our own files are committed: anything else the user staged stays
  //    staged and untouched.
  const destPaths = written.map((w) => w.destPath);
  const relPaths = destPaths.map((p: string) => path.relative(root, p));
  git(root, ["add", "--", ...destPaths]);
  const staged = git(root, ["diff", "--cached", "--name-only", "--", ...relPaths]);
  let committed = false;
  if (staged.trim()) {
    const short = submitted.map((s) => s.id.slice(0, 8)).join(" ");
    git(root, ["commit", "-m", `mem: submit ${submitted.length} ${submitted.length === 1 ? "memory" : "memories"} for review (${short})`, "--", ...relPaths]);
    committed = true;
  }

  // 5. Verify the committed copies, then move the outbox originals out
  //    (copy + verify + delete — never a bare rename across the move).
  for (const w of written) {
    const back = fs.readFileSync(w.destPath, "utf8");
    const bParsed = parseMemory(back);
    if (!bParsed || contentHash(bParsed.body) !== w.hash) {
      fail(`${w.id}: verification failed after commit — outbox copy kept at ${w.srcPath}`);
    }
    // Same id, new home: ON CONFLICT(id) rewrites the row to the repo path.
    upsertFromFile({
      fm: bParsed.fm,
      body: bParsed.body,
      filePath: w.destPath,
      mtimeMs: fs.statSync(w.destPath).mtimeMs,
    });
    fs.unlinkSync(w.srcPath);
  }

  const ids8 = validated.map((v) => v.id.slice(0, 8)).join(" ");
  return {
    branch,
    base,
    submitted,
    skippedIdentical,
    committed,
    pushCommand: `git push -u origin ${branch}`,
    prCommand: `gh pr create --base ${base} --title "mem: review ${validated.length} ${validated.length === 1 ? "memory" : "memories"}" --body "Submitted from the open-memex outbox: ${ids8}."`,
  };
}
