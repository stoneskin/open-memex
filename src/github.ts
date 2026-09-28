/**
 * 2B/D32: GitHub PR ↔ review_state mapping.
 *
 * Memories ride into review inside a branch + PR (dedicated memory PR or
 * together with code). The PR's lifecycle on GitHub is the team's review
 * signal; this module reads it back and maps it onto each memory's own
 * review_state:
 *
 *   PR merged                        → proposed/approved → published
 *   PR reviewDecision == APPROVED     → proposed → approved (approved_by = reviewer login)
 *   PR reviewDecision == CHANGES_REQUESTED → suggestion only, printed for the human
 *
 * Per-memory independence: every memory on the branch keeps its own state.
 * A locally `rejected` memory is never flipped by a PR approval, and a
 * changes-requested review never auto-rejects — the human runs `promote`.
 *
 * Report by default; `--apply` performs the mapped transitions locally
 * (file rewrite + index, never a push — inside the D27 local-git line).
 * Needs the GitHub CLI (`gh`) authenticated on the user's machine.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.ts";
import { projectRoot } from "./paths.ts";
import { parse as parseMemory, type ReviewState } from "./store/markdown.ts";
import { iterInRepoMemoryFiles } from "./store/markdown.ts";
import { promoteMemory, currentAuthor } from "./review.ts";

function fail(msg: string): never {
  throw new Error(`[open-memex] ${msg}`);
}

function sh(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? "").trim().split("\n")[0];
    fail(`${cmd} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

export interface PrInfo {
  number: number;
  url: string;
  state: "open" | "closed"; // GitHub PR state
  merged: boolean;
  mergedAt: string | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  approvedBy: string[];
  changesRequestedBy: string[];
  base: string;
  head: string;
  title: string;
}

interface GhPrJson {
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
  isMerged?: boolean;
  reviewDecision?: string | null;
  baseRefName: string;
  headRefName: string;
  title: string;
  reviews?: Array<{ author: { login: string }; state: string; submittedAt: string }>;
}

/** Read the PR for a branch (default: current branch) via the GitHub CLI. */
export function getPrInfo(branch?: string): PrInfo | null {
  const root = projectRoot();
  // `gh` must exist and be authenticated on the user's machine.
  try {
    execFileSync("gh", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    fail("the GitHub CLI (`gh`) is not installed — install it and run `gh auth login` first.");
  }
  const ref = branch ?? sh("git", ["branch", "--show-current"], root);
  if (!ref) fail("not on a branch — check out the memory branch first.");
  let raw: string;
  try {
    raw = sh("gh", ["pr", "view", ref, "--json",
      "number,url,state,mergedAt,reviewDecision,baseRefName,headRefName,title,reviews"], root);
  } catch {
    return null; // no PR for this branch yet
  }
  let j: GhPrJson;
  try {
    j = JSON.parse(raw) as GhPrJson;
  } catch {
    fail(`could not parse \`gh pr view\` output for branch ${ref}.`);
  }
  const approvedBy: string[] = [];
  const changesRequestedBy: string[] = [];
  // Latest review per author wins.
  const latest = new Map<string, { state: string; at: string }>();
  for (const r of j.reviews ?? []) {
    const login = r.author?.login;
    if (!login) continue;
    const prev = latest.get(login);
    if (!prev || r.submittedAt >= prev.at) latest.set(login, { state: r.state, at: r.submittedAt });
  }
  for (const [login, r] of latest) {
    if (r.state === "APPROVED") approvedBy.push(login);
    else if (r.state === "CHANGES_REQUESTED") changesRequestedBy.push(login);
  }
  return {
    number: j.number,
    url: j.url,
    state: j.state === "OPEN" ? "open" : "closed",
    merged: !!j.mergedAt,
    mergedAt: j.mergedAt,
    reviewDecision: (j.reviewDecision as PrInfo["reviewDecision"]) ?? null,
    approvedBy,
    changesRequestedBy,
    base: j.baseRefName,
    head: j.headRefName,
    title: j.title,
  };
}

export interface MemoryPrMapping {
  memoryId: string;
  from: ReviewState;
  /** Null = no automatic transition; see reason. */
  suggestedTo: ReviewState | null;
  reason: string;
  approvedBy: string | null;
}

export interface PrStatus {
  branch: string;
  pr: PrInfo | null;
  mappings: MemoryPrMapping[];
}

/** Map the branch PR's state onto each in-repo memory's review_state. */
export function getPrStatus(branch?: string): PrStatus {
  const root = projectRoot();
  const cfg = loadConfig();
  const current = branch ?? sh("git", ["branch", "--show-current"], root);
  const pr = getPrInfo(current);

  const mappings: MemoryPrMapping[] = [];
  for (const fp of iterInRepoMemoryFiles(root, cfg.memoryDir)) {
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = parseMemory(raw);
    if (!parsed) continue;
    const from = parsed.fm.review_state ?? "draft";
    const id = parsed.fm.id;
    if (!pr) {
      mappings.push({ memoryId: id, from, suggestedTo: null, reason: `no PR for branch ${current} yet`, approvedBy: null });
      continue;
    }
    if (from === "published") {
      mappings.push({ memoryId: id, from, suggestedTo: null, reason: "already published", approvedBy: null });
      continue;
    }
    if (from === "rejected") {
      mappings.push({ memoryId: id, from, suggestedTo: null, reason: `stays rejected — a PR ${pr.merged ? "merge" : "approval"} never overrides a human rejection`, approvedBy: null });
      continue;
    }
    if (pr.merged) {
      if (from === "proposed" || from === "approved") {
        mappings.push({ memoryId: id, from, suggestedTo: "published", reason: `PR #${pr.number} merged`, approvedBy: null });
      } else {
        mappings.push({ memoryId: id, from, suggestedTo: null, reason: `PR #${pr.number} merged, but memory is "${from}"`, approvedBy: null });
      }
      continue;
    }
    if (pr.reviewDecision === "APPROVED" && from === "proposed") {
      const by = pr.approvedBy[0] ?? null;
      mappings.push({
        memoryId: id, from, suggestedTo: "approved",
        reason: `PR #${pr.number} approved${by ? ` by @${by}` : ""}`, approvedBy: by,
      });
      continue;
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      const by = pr.changesRequestedBy[0] ?? null;
      mappings.push({
        memoryId: id, from, suggestedTo: null,
        reason: `PR #${pr.number} has changes requested${by ? ` by @${by}` : ""} — run \`open-memex promote ${id} --reject --note "..."\` yourself if you agree`,
        approvedBy: null,
      });
      continue;
    }
    mappings.push({
      memoryId: id, from, suggestedTo: null,
      reason: pr.state === "open" ? `PR #${pr.number} still awaiting review` : `PR #${pr.number} is closed without merge`,
      approvedBy: null,
    });
  }
  return { branch: current, pr, mappings };
}

export interface PrApplyResult {
  memoryId: string;
  from: ReviewState;
  to: ReviewState;
  by: string;
}

/** Apply the mapped transitions locally (no push — D27). Advances step by
 *  step through the ladder, so a merged PR moves proposed → approved →
 *  published with each step in the audit trail. */
export function applyPrStatus(st: PrStatus): PrApplyResult[] {
  const out: PrApplyResult[] = [];
  const actor = currentAuthor();
  const order: ReviewState[] = ["draft", "proposed", "approved", "published"];
  for (const m of st.mappings) {
    if (!m.suggestedTo || order.indexOf(m.from) >= order.indexOf(m.suggestedTo)) continue;
    const by = m.approvedBy ?? actor;
    const note = m.suggestedTo === "published" && st.pr
      ? `PR #${st.pr.number} merged`
      : m.reason;
    let cur = m.from;
    while (order.indexOf(cur) < order.indexOf(m.suggestedTo)) {
      const r = promoteMemory(m.memoryId, { by, note });
      cur = r.to;
      out.push({ memoryId: m.memoryId, from: r.from, to: r.to, by });
    }
  }
  return out;
}

export function formatPrStatus(st: PrStatus): string {
  const lines: string[] = [];
  lines.push(`branch: ${st.branch}`);
  if (!st.pr) {
    lines.push(`PR: none yet — push the branch and open one, then re-run.`);
  } else {
    const p = st.pr;
    lines.push(`PR #${p.number}: ${p.title}`);
    lines.push(`  ${p.url}`);
    lines.push(`  state: ${p.merged ? `merged${p.mergedAt ? ` at ${p.mergedAt}` : ""}` : p.state}` +
      (p.reviewDecision ? `, reviews: ${p.reviewDecision}` : ""));
    if (p.approvedBy.length > 0) lines.push(`  approved by: ${p.approvedBy.map((l) => "@" + l).join(", ")}`);
    if (p.changesRequestedBy.length > 0) lines.push(`  changes requested by: ${p.changesRequestedBy.map((l) => "@" + l).join(", ")}`);
  }
  if (st.mappings.length === 0) {
    lines.push(`no in-repo memories on this branch.`);
  } else {
    lines.push(`memories (${st.mappings.length}):`);
    for (const m of st.mappings) {
      const arrow = m.suggestedTo ? ` → [${m.suggestedTo}]` : "";
      lines.push(`  ${m.memoryId.slice(0, 8)}  [${m.from}]${arrow}  ${m.reason}`);
    }
    if (st.mappings.some((m) => m.suggestedTo)) {
      lines.push(`run with --apply to perform the mapped transitions locally (no push).`);
    }
  }
  return lines.join("\n");
}
