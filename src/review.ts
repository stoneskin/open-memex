/**
 * 2B/D26: propose → submit → promote → resolve workflow.
 *
 * - `propose <id> --to project`: copy a personal memory into the project
 *   outbox (appdata) as a draft. Never moves — the personal original stays
 *   put. Outbox drafts are git-invisible until submitted.
 * - `submit <ids>`: move outbox drafts into a git branch (new `mem/sync-*`
 *   by default), as `proposed`, commit locally, print push + PR commands.
 *   Push/PR need the user's explicit approval — the tool never pushes.
 * - `promote <id>`: advance a project memory one step up the review ladder
 *   (proposed → approved → published), or --reject it with a note.
 * - `resolve [id]`: assist with git merge conflicts inside the in-repo
 *   memory dir. Frontmatter gets a field-level 3-way merge; semantic
 *   conflicts are reported, never auto-resolved.
 *
 * Git automation line (D25 as revised by D26): local git only (submit's
 * branch + commit). Nothing leaves the machine without approval.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.ts";
import { inRepoMemoriesDirPath, projectRoot } from "./paths.ts";
import { resolveProjectScope } from "./scope.ts";
import {
  parse as parseMemory,
  serialize,
  ulid,
  writeMemoryFile,
  type Frontmatter,
  type ReviewState,
  type ReviewTransition,
} from "./store/markdown.ts";
import { findMemoryFile } from "./store/lifecycle.ts";
import { upsertFromFile } from "./store/sync.ts";

/** Best-effort author identity: git user.name, else the OS user. */
export function currentAuthor(): string {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (name) return name;
  } catch {
    /* git unavailable — fall through */
  }
  try {
    return os.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

function fail(msg: string): never {
  throw new Error(`[open-memex] ${msg}`);
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export interface ProposeResult {
  id: string;
  filePath: string;
  reviewState: ReviewState;
}

/**
 * Copy one personal memory into the project scope as a review candidate.
 * The source memory is untouched (copy, not move — D25).
 * Batch-friendly: validates nothing, copies one — use proposeMemories()
 * for the all-or-nothing multi-id path.
 */
export function proposeMemory(
  sourceId: string,
  opts: { localApprove?: boolean } = {},
): ProposeResult {
  const src = findMemoryFile(sourceId);
  if (!src) fail(`no memory found with id "${sourceId}".`);
  return copyPersonalToProject(sourceId, src.fm, src.body, opts);
}

function copyPersonalToProject(
  sourceId: string,
  srcFm: Frontmatter,
  srcBody: string,
  opts: { localApprove?: boolean } = {},
): ProposeResult {
  if (srcFm.scope === "project")
    fail(`memory "${sourceId}" is already in project scope — nothing to propose.`);
  if (srcFm.scope === "org")
    fail(`memory "${sourceId}" is already shared at org scope.`);
  if (srcFm.status === "retracted" || srcFm.status === "archived")
    fail(`memory "${sourceId}" is ${srcFm.status} — cannot propose it.`);

  const project = resolveProjectScope(projectRoot());
  const author = currentAuthor();
  const now = new Date().toISOString();
  // propose lands in the outbox as a draft (submit moves it to proposed);
  // --local-approve is the solo-dev shortcut straight to approved.
  const targetState: ReviewState = opts.localApprove ? "approved" : "draft";
  const fm: Frontmatter = {
    ...srcFm,
    id: ulid(),
    scope: "project",
    scope_key: project.key,
    project_name: project.projectName,
    created_at: now,
    updated_at: now,
    supersedes: null,
    superseded_by: null,
    review_state: targetState,
    proposed_by: author,
    approved_by: opts.localApprove ? author : null,
    derived_from: srcFm.id,
    review_history: [
      {
        at: now,
        by: author,
        from: "draft",
        to: targetState,
        note: opts.localApprove
          ? `proposed from personal memory ${srcFm.id} (local-approved)`
          : `proposed from personal memory ${srcFm.id}`,
      },
    ],
  };
  const { filePath } = writeMemoryFile(fm, srcBody);
  upsertFromFile({ fm, body: srcBody, filePath, mtimeMs: Date.now() });
  return { id: fm.id, filePath, reviewState: fm.review_state };
}

/**
 * Propose several personal memories at once — one branch, one PR.
 * All-or-nothing: every id is validated before anything is copied, so a bad
 * id never leaves a half-proposed batch behind.
 */
export function proposeMemories(
  sourceIds: string[],
  opts: { localApprove?: boolean } = {},
): { sourceId: string; result: ProposeResult }[] {
  if (sourceIds.length === 0) fail("propose needs at least one memory id.");
  const seen = new Set<string>();
  const sources = sourceIds.map((sourceId) => {
    if (seen.has(sourceId)) fail(`duplicate id "${sourceId}" — list each memory once.`);
    seen.add(sourceId);
    const src = findMemoryFile(sourceId);
    if (!src) fail(`no memory found with id "${sourceId}".`);
    if (src.fm.scope !== "personal")
      fail(`only personal memories can be proposed (memory "${sourceId}" is ${src.fm.scope}).`);
    if (src.fm.status === "retracted" || src.fm.status === "archived")
      fail(`memory "${sourceId}" is ${src.fm.status} — cannot propose it.`);
    return { sourceId, fm: src.fm, body: src.body };
  });
  return sources.map(({ sourceId, fm, body }) => ({
    sourceId,
    result: copyPersonalToProject(sourceId, fm, body, opts),
  }));
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

export interface PromoteResult {
  id: string;
  from: ReviewState;
  to: ReviewState;
  /** Full audit trail after this transition (D29). */
  history: ReviewTransition[];
}

const NEXT_STATE: Partial<Record<ReviewState, ReviewState>> = {
  proposed: "approved",
  approved: "published",
};

/**
 * Advance a project memory one step up the review ladder
 * (proposed → approved → published), reject it with --reject, or send a
 * rejected memory back for another round with --resubmit.
 *
 * A rejection never deletes anything: the file stays on the author's branch.
 * What happens next is the human's call — accept it (close the PR, delete the
 * branch), revise + --resubmit, or keep the rejected file as a record.
 */
export function promoteMemory(
  id: string,
  opts: { reject?: boolean; resubmit?: boolean; note?: string; by?: string } = {},
): PromoteResult {
  const mf = findMemoryFile(id);
  if (!mf) fail(`no memory found with id "${id}".`);
  if (mf.fm.scope !== "project")
    fail(`only project-scope memories go through review (memory "${id}" is ${mf.fm.scope}).`);

  const from = mf.fm.review_state ?? "draft";
  const by = opts.by?.trim() || currentAuthor();
  let to: ReviewState;
  if (opts.resubmit) {
    if (opts.reject) fail("choose one: --resubmit or --reject, not both.");
    if (from !== "rejected")
      fail(`only a "rejected" memory can be resubmitted (memory "${id}" is "${from}").`);
    to = "proposed";
  } else if (opts.reject) {
    if (from !== "proposed" && from !== "approved")
      fail(`cannot reject from "${from}" — only "proposed" or "approved" can be rejected.`);
    to = "rejected";
  } else {
    const next = NEXT_STATE[from];
    if (!next)
      fail(
        from === "draft"
          ? `memory "${id}" is still a draft — run "open-memex propose ${id} --to project" first.`
          : `memory "${id}" is "${from}" — a terminal state, nothing to promote.`,
      );
    to = next;
  }

  const fm: Frontmatter = {
    ...mf.fm,
    review_state: to,
    updated_at: new Date().toISOString(),
    // A rejection withdraws any earlier approval; a resubmission clears it too
    // (the memory must earn approval again).
    approved_by: to === "approved" ? by : to === "rejected" || to === "proposed" ? null : mf.fm.approved_by,
    review_note: opts.note?.trim() ? opts.note.trim() : mf.fm.review_note,
    // D29: every transition is appended to the audit trail — the note is
    // preserved here even when review_note later gets overwritten.
    review_history: [
      ...(mf.fm.review_history ?? []),
      {
        at: new Date().toISOString(),
        by,
        from,
        to,
        note: opts.note?.trim() ? opts.note.trim() : null,
      },
    ],
  };
  fs.writeFileSync(mf.filePath, serialize(fm, mf.body), "utf8");
  upsertFromFile({ fm, body: mf.body, filePath: mf.filePath, mtimeMs: Date.now() });
  return { id, from, to, history: fm.review_history };
}

/** Render a memory's audit trail as compact human-readable lines (D29). */
export function formatReviewHistory(history: ReviewTransition[]): string[] {
  return history.map(
    (t) =>
      `  ${t.at.slice(0, 10)} ${t.by}: ${t.from} → ${t.to}` +
      (t.note ? ` — ${t.note}` : ""),
  );
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export interface ConflictEntry {
  id: string;
  filePath: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function inRepoDir(): { root: string; dir: string } {
  const root = projectRoot();
  try {
    git(["rev-parse", "--git-dir"], root);
  } catch {
    fail("resolve needs a git repo — this directory is not one.");
  }
  return { root, dir: inRepoMemoriesDirPath(root, loadConfig().memoryDir) };
}

/** List in-repo memory files currently in an unmerged (conflicted) state. */
export function listConflicts(): ConflictEntry[] {
  const { root, dir } = inRepoDir();
  let out: string;
  try {
    out = git(["diff", "--name-only", "--diff-filter=U", "--", dir], root);
  } catch {
    fail("git is unavailable or the repo state cannot be read.");
  }
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && s.endsWith(".md"))
    .map((rel) => ({
      id: path.basename(rel, ".md"),
      filePath: path.join(root, rel),
    }));
}

export interface FieldConflict {
  field: string;
  base: string;
  ours: string;
  theirs: string;
}

export type ResolveOutcome =
  | { ok: true; filePath: string; autoMerged: string[] }
  | { ok: false; filePath: string; conflicts: FieldConflict[] };

function show(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
  return String(v);
}

/**
 * Attempt a field-level 3-way merge of a conflicted memory file.
 * Never auto-resolves semantic conflicts (same field changed differently
 * on both sides) — those are reported for the human to decide.
 */
export function resolveConflict(target: string): ResolveOutcome {
  const { root, dir } = inRepoDir();

  // Locate the file: by memory id, or as a direct path. Note findMemoryFile
  // returns null for a file with conflict markers (YAML won't parse), so
  // fall back to a direct <id>.md lookup inside the in-repo dir.
  let filePath: string | null = null;
  const byId = findMemoryFile(target);
  if (byId) {
    filePath = byId.filePath;
  } else {
    const base = path.basename(target).replace(/\.md$/, "");
    const candidates = [
      path.join(dir, `${base}.md`),
      path.isAbsolute(target) ? target : path.join(root, target),
      path.isAbsolute(target) ? `${target}.md` : path.join(root, `${target}.md`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        filePath = c;
        break;
      }
    }
  }
  if (!filePath) fail(`no memory or file found for "${target}".`);

  // Must actually be in conflict (stages 1/2/3 present).
  const stages = git(["ls-files", "-u", "--", filePath], root)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (stages.length === 0)
    fail(`"${path.basename(filePath)}" is not in a merge-conflict state.`);

  const blob = (stage: string): string => {
    // Git wants forward slashes even on Windows.
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    try {
      return git(["show", `:${stage}:${rel}`], root);
    } catch {
      fail(`cannot read git stage ${stage} for "${path.basename(filePath)}".`);
      throw new Error("unreachable");
    }
  };
  const base = parseMemory(blob("1"));
  const ours = parseMemory(blob("2"));
  const theirs = parseMemory(blob("3"));
  if (!base || !ours || !theirs)
    fail(`one of the conflict stages for "${path.basename(filePath)}" is not a valid memory file.`);

  const b = base.fm;
  const o = ours.fm;
  const t = theirs.fm;
  const conflicts: FieldConflict[] = [];
  const autoMerged: string[] = [];
  const merged: Record<string, unknown> = {};

  // Identity fields: both sides must agree, else this is not the same memory.
  for (const f of ["id", "scope_key", "scope", "project_name", "schema_version"] as const) {
    if (o[f] !== t[f]) {
      conflicts.push({ field: f, base: show(b[f]), ours: show(o[f]), theirs: show(t[f]) });
    } else {
      merged[f] = o[f];
    }
  }

  // Plain scalar fields: standard 3-way.
  const scalars = [
    "visibility",
    "type",
    "role",
    "importance",
    "status",
    "source",
    "created_at",
    "proposed_by",
    "approved_by",
    "derived_from",
    "review_note",
    "supersedes",
    "superseded_by",
  ] as const;
  for (const f of scalars) {
    const bv = b[f] as unknown;
    const ov = o[f] as unknown;
    const tv = t[f] as unknown;
    if (eq(ov, tv)) {
      merged[f] = ov;
    } else if (eq(bv, ov)) {
      merged[f] = tv;
      autoMerged.push(f);
    } else if (eq(bv, tv)) {
      merged[f] = ov;
      autoMerged.push(f);
    } else {
      conflicts.push({ field: f, base: show(bv), ours: show(ov), theirs: show(tv) });
    }
  }

  // review_state: 3-way, but never silently drop a rejection.
  {
    const bv = b.review_state;
    const ov = o.review_state;
    const tv = t.review_state;
    if (ov === tv) merged.review_state = ov;
    else if (bv === ov) merged.review_state = tv;
    else if (bv === tv) merged.review_state = ov;
    else if (ov === "rejected" || tv === "rejected")
      conflicts.push({ field: "review_state", base: bv, ours: ov, theirs: tv });
    else {
      // Both advanced along the ladder; keep the further one.
      const order: ReviewState[] = ["draft", "proposed", "approved", "published"];
      merged.review_state = order.indexOf(tv) > order.indexOf(ov) ? tv : ov;
    }
    if (!conflicts.some((c) => c.field === "review_state") && merged.review_state !== bv)
      autoMerged.push("review_state");
  }

  // tags: union when both sides changed.
  {
    const bs = new Set(b.tags ?? []);
    const os = new Set(o.tags ?? []);
    const ts = new Set(t.tags ?? []);
    if (eq([...os].sort(), [...ts].sort())) merged.tags = [...os];
    else {
      const union = [...new Set([...os, ...ts])].sort();
      merged.tags = union;
      if (!eq([...bs].sort(), union)) autoMerged.push("tags");
    }
  }

  // review_history (D29 audit trail): union by identity — a transition that
  // happened on either side is kept; identical entries collapse.
  {
    const key = (e: ReviewTransition) => `${e.at}|${e.by}|${e.from}|${e.to}`;
    const seen = new Set<string>();
    const union: ReviewTransition[] = [];
    const all = [...(b.review_history ?? []), ...(o.review_history ?? []), ...(t.review_history ?? [])];
    for (const e of all) {
      const k = key(e);
      if (!seen.has(k)) {
        seen.add(k);
        union.push(e);
      }
    }
    merged.review_history = union;
    if (union.length !== (b.review_history ?? []).length) autoMerged.push("review_history");
  }

  // updated_at: always moves forward — take the latest.
  {
    const latest = [b.updated_at, o.updated_at, t.updated_at].sort().at(-1)!;
    merged.updated_at = latest;
    if (latest !== b.updated_at) autoMerged.push("updated_at");
  }

  // body: 3-way text merge; divergent edits are a human decision.
  const bb = base.body.trimEnd();
  const ob = ours.body.trimEnd();
  const tb = theirs.body.trimEnd();
  let mergedBody: string;
  if (ob === tb) mergedBody = ob;
  else if (bb === ob) {
    mergedBody = tb;
    autoMerged.push("body");
  } else if (bb === tb) {
    mergedBody = ob;
    autoMerged.push("body");
  } else {
    conflicts.push({ field: "body", base: bb.slice(0, 120), ours: ob.slice(0, 120), theirs: tb.slice(0, 120) });
    mergedBody = bb; // unused when conflicts exist
  }

  if (conflicts.length > 0) return { ok: false, filePath, conflicts };

  const fm = merged as unknown as Frontmatter;
  fs.writeFileSync(filePath, serialize(fm, mergedBody), "utf8");
  upsertFromFile({ fm, body: mergedBody, filePath, mtimeMs: Date.now() });
  return { ok: true, filePath, autoMerged: [...new Set(autoMerged)] };
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
