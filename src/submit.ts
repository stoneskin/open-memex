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
  atomicWriteTextSync,
  type ReviewState,
} from "./store/markdown.ts";
import { upsertFromFile, recordSync, readSyncState } from "./store/sync.ts";
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

/**
 * D53: cheap outbox draft count — one indexed query, no git I/O — for the
 * push-not-poll note appended to mutating tool results and to the MCP
 * session-start instructions. Same outbox definition as getSyncStatus
 * (file under the scope's outbox dir), without the expensive parts.
 */
export function outboxDraftCount(scopeKey: string): number {
  const outboxDir = memoriesDirPath(scopeKey);
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE scope_key = ? AND instr(file_path, ?) = 1`,
    )
    .get(scopeKey, outboxDir + path.sep) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function formatSyncStatus(st: SyncStatus, opts: { cap?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`project: ${st.projectName} (${st.scopeKey})`);
  // D31: when the index was last synced and what triggered it.
  const last = readSyncState(st.scopeKey);
  if (last) {
    lines.push(
      `last sync: ${last.lastSyncAt} (${last.lastSyncKind}) — +${last.added} ~${last.updated} -${last.removed} (scanned ${last.scanned})`,
    );
  } else {
    lines.push(`last sync: never`);
  }
  // Agent-facing renders cap each section so a big store can't flood a
  // tool result; the cap line points at the CLI, which shows everything.
  const CAP = opts.cap ?? 20;
  const more = (n: number) =>
    `  … and ${n} more (full list: open-memex sync-status)`;
  lines.push(`outbox (appdata, pending sync): ${st.outbox.length}`);
  for (const e of st.outbox.slice(0, CAP)) {
    lines.push(`  ${e.id}  [${e.reviewState}] ${e.title}`);
  }
  if (st.outbox.length > CAP) lines.push(more(st.outbox.length - CAP));
  const byState = new Map<string, number>();
  for (const e of st.inRepo) byState.set(e.reviewState, (byState.get(e.reviewState) ?? 0) + 1);
  const breakdown = [...byState.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "none";
  lines.push(`repo .ai/open-memex: ${st.inRepo.length} (${breakdown})`);
  for (const e of st.inRepo.slice(0, CAP)) {
    const u = e.gitState === "uncommitted" ? " (uncommitted)" : "";
    lines.push(`  ${e.id}  [${e.reviewState}]${u} ${e.title}`);
  }
  if (st.inRepo.length > CAP) lines.push(more(st.inRepo.length - CAP));
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
  /** Create this branch and submit onto it. If omitted, submit stays on the
      current branch — D36: no auto-created branches; branch creation is the
      human's call (or the agent's, only with explicit approval). */
  branch?: string;
  /** PR base override (default: the branch the submit ran on). */
  base?: string;
}

export interface SubmitResult {
  branch: string;
  base: string;
  /** true when --branch created a new branch for this submit */
  createdBranch: boolean;
  submitted: Array<{ id: string; filePath: string; reviewState: ReviewState }>;
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
  // submit needs a git repo — the memories land in .ai/open-memex/ and are
  // committed locally. Branch creation is never automatic (D36).
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
    // draft/rejected move to proposed; a local-approved copy keeps its approval.
    if (rs !== "draft" && rs !== "rejected" && rs !== "approved") {
      problems.push(`${id}: review_state is ${rs}, only draft/rejected/approved can be submitted`);
      continue;
    }
    validated.push({ id, srcPath, body: mf.body, reviewState: rs });
  }
  if (problems.length > 0) {
    fail(`submit aborted — nothing was written:\n  ${problems.join("\n  ")}`);
  }

  // 2. Resolve the target branch.
  //    D36: submit never creates a branch on its own — it works on the branch
  //    you're already on. Pass --branch <name> (explicitly) only when the user
  //    approved the full chain (branch + push + PR).
  const startBranch = git(root, ["branch", "--show-current"]) || git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch: string = startBranch;
  let createdBranch = false;
  if (opts.branch) {
    branch = opts.branch;
    let n = 0;
    let candidate = branch;
    while (true) {
      const exists = git(root, ["branch", "--list", candidate]);
      if (!exists) break;
      n++;
      candidate = `${branch}-${n}`;
    }
    branch = candidate;
    git(root, ["checkout", "-b", branch]);
    createdBranch = true;
  }
  const base = opts.base ?? startBranch;
  const author = currentAuthor();

  // 3. Copy drafts into the repo dir as proposed (same id — one memory, one id).
  //    Same id + different content on the branch = conflict → abort, human judges.
  const submitted: Array<{ id: string; filePath: string; reviewState: ReviewState }> = [];
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
    // draft/rejected → proposed; a local-approved copy arrives already
    // approved and keeps its approval (and its approved_by).
    const destState: ReviewState = v.reviewState === "approved" ? "approved" : "proposed";
    const fm = {
      ...parsed.fm,
      review_state: destState,
      updated_at: now,
      proposed_by: parsed.fm.proposed_by ?? author,
      // D29: the outbox → repo move is part of the audit trail.
      review_history: [
        ...(parsed.fm.review_history ?? []),
        {
          at: now,
          by: author,
          from: parsed.fm.review_state ?? "draft",
          to: destState,
          note: `submitted to branch ${branch}`,
        },
      ],
    };
    const text = serialize(fm, parsed.body);
    atomicWriteTextSync(destPath, text);
    written.push({ id: v.id, srcPath: v.srcPath, destPath, hash: contentHash(parsed.body) });
    submitted.push({ id: v.id, filePath: destPath, reviewState: destState });
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
    if (createdBranch) {
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
  // D31: the submit itself is a sync event — visible in sync-status.
  recordSync(scope.key, "submit", {
    added: submitted.length,
    updated: skippedIdentical.length,
    removed: 0,
    scanned: validated.length,
  });
  // D36: no auto-branch — the commit sits on the branch you were already on.
  // Next steps are printed, not run. For a separate memory PR, create a branch
  // first (the commit comes along), then push + open the PR.
  const branchCmd = `git checkout -b mem/sync-YYYYMMDD`;
  return {
    branch,
    base,
    submitted,
    skippedIdentical,
    committed,
    createdBranch,
    pushCommand: `git push -u origin ${branch}`,
    prCommand: createdBranch
      ? `gh pr create --base ${base} --title "mem: review ${validated.length} ${validated.length === 1 ? "memory" : "memories"}" --body "Submitted from the open-memex outbox: ${ids8}."`
      : `${branchCmd}  # if you want a separate memory PR (else push ${branch} directly)\n  git push -u origin <new-branch> && gh pr create --base ${base} --title "mem: review ${validated.length}" --body "Submitted from the open-memex outbox: ${ids8}."`,
  };
}
