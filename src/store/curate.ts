/**
 * D78: the write half of deterministic curation.
 *
 * Pure planning lives in src/curate.ts. This module applies a plan to the
 * outbox files through the existing lifecycle primitives (atomic writes,
 * supersede-chain fields, append-only review_history) and keeps the index in
 * step. Every action is reversible:
 *
 * - merge-duplicate  -> open-memex curate undo <duplicate id>
 * - normalize-title  -> open-memex curate undo <id>
 * - archive-empty    -> open-memex status <id> active
 */

import {
  findMemoryFile,
  rewriteMemoryFile,
  setStatus,
} from "./lifecycle.ts";
import {
  firstNonEmptyLineIndex,
  normalizeTitle,
  type CurationAction,
  type CurationPlan,
  type CurationSkip,
} from "../curate.ts";
import { msToRfc3339, type MemoryFile } from "./markdown.ts";
import { upsertFromFile } from "./sync.ts";

export interface AppliedCuration {
  action: CurationAction;
  filePaths: string[];
}

export interface CurationApplyResult {
  applied: AppliedCuration[];
  skipped: CurationSkip[];
}

function pushNote(mf: MemoryFile, note: string, by: string): void {
  const now = msToRfc3339(Date.now());
  const state = mf.fm.review_state ?? "draft";
  mf.fm.review_history = [
    ...(mf.fm.review_history ?? []),
    { at: now, by, from: state, to: state, note },
  ];
  mf.fm.updated_at = now;
}

function reindex(mf: MemoryFile): void {
  const fresh = findMemoryFile(mf.fm.id);
  if (fresh) upsertFromFile(fresh);
  else upsertFromFile(mf);
}

function applyOne(action: CurationAction, by: string): string[] {
  if (action.kind === "archive-empty") {
    const mf = findMemoryFile(action.id);
    if (!mf) throw new Error(`no memory with id ${action.id}`);
    if (mf.fm.status !== "active") throw new Error(`${action.id} is not active`);
    const updated = setStatus(action.id, "archived");
    pushNote(updated, "curation: archived empty body", by);
    rewriteMemoryFile(updated);
    reindex(updated);
    return [updated.filePath];
  }

  if (action.kind === "normalize-title") {
    const mf = findMemoryFile(action.id);
    if (!mf) throw new Error(`no memory with id ${action.id}`);
    if (mf.fm.status !== "active") throw new Error(`${action.id} is not active`);
    const n = normalizeTitle(mf.body);
    if (!n) throw new Error(`${action.id} title is already normalized`);
    mf.body = n.body;
    pushNote(
      mf,
      `curation: normalized title ${JSON.stringify([n.before, n.after])}`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    return [mf.filePath];
  }

  return applyMerge(action, by);
}

function applyMerge(action: CurationAction, by: string): string[] {
  const canonical = findMemoryFile(action.canonicalId!);
  const dup = findMemoryFile(action.id);
  if (!canonical) throw new Error(`canonical ${action.canonicalId} not found`);
  if (!dup) throw new Error(`duplicate ${action.id} not found`);
  if (canonical.fm.status !== "active") {
    throw new Error(`canonical ${canonical.fm.id} is not active`);
  }
  if (dup.fm.status !== "active") throw new Error(`${dup.fm.id} is not active`);
  if (dup.fm.supersedes || dup.fm.superseded_by) {
    throw new Error(`${dup.fm.id} is already in a supersede chain`);
  }

  // Append the duplicate at the OLDEST end of the canonical's chain. The
  // chain is a single pointer (supersedes points back), so this is the only
  // place a second identical body can sit without dropping history.
  let tail = canonical;
  const seen = new Set<string>([tail.fm.id]);
  while (tail.fm.supersedes) {
    const next = findMemoryFile(tail.fm.supersedes);
    if (!next) throw new Error(`${tail.fm.id} supersedes missing ${tail.fm.supersedes}`);
    if (seen.has(next.fm.id)) throw new Error(`supersede cycle at ${next.fm.id}`);
    seen.add(next.fm.id);
    tail = next;
  }
  if (tail.fm.id !== canonical.fm.id && tail.fm.status !== "superseded") {
    throw new Error(`${tail.fm.id} is the chain tail but is ${tail.fm.status}`);
  }

  const now = msToRfc3339(Date.now());
  tail.fm.supersedes = dup.fm.id;
  tail.fm.updated_at = now;
  pushNote(
    tail,
    `curation: merged exact duplicate ${dup.fm.id} (undo: open-memex curate undo ${dup.fm.id})`,
    by,
  );

  dup.fm.status = "superseded";
  dup.fm.superseded_by = tail.fm.id;
  dup.fm.supersedes = null;
  dup.fm.updated_at = now;
  pushNote(
    dup,
    `curation: merged exact duplicate into ${canonical.fm.id} (undo: open-memex curate undo ${dup.fm.id})`,
    by,
  );

  rewriteMemoryFile(dup);
  rewriteMemoryFile(tail);
  reindex(dup);
  reindex(tail);
  return [dup.filePath, tail.filePath];
}

/**
 * Apply every planned action. One action failing is reported and skipped, not
 * fatal: a curation hiccup must never block the submit the human asked for.
 */
export function applyCurationPlan(
  plan: CurationPlan,
  opts: { by: string },
): CurationApplyResult {
  const applied: AppliedCuration[] = [];
  const skipped = [...plan.skipped];
  for (const action of plan.actions) {
    try {
      applied.push({ action, filePaths: applyOne(action, opts.by) });
    } catch (e) {
      skipped.push({
        id: action.id,
        reason: `auto-apply failed: ${(e as Error).message}`,
      });
    }
  }
  return { applied, skipped };
}

function latestCurationNote(mf: MemoryFile): string | null {
  for (let i = (mf.fm.review_history ?? []).length - 1; i >= 0; i--) {
    const note = mf.fm.review_history[i]!.note ?? "";
    if (note.startsWith("curation:")) return note;
  }
  return null;
}

export interface UndoCurationResult {
  id: string;
  kind: "merge-duplicate" | "normalize-title" | "archive-empty";
  filePaths: string[];
}

/**
 * Undo the LATEST curation action on `id`. The marker lives in review_history
 * (the file is the source of truth), so this works across machines/branches.
 */
export function undoCuration(id: string, opts: { by: string }): UndoCurationResult {
  const mf = findMemoryFile(id);
  if (!mf) throw new Error(`no memory with id ${id}`);
  const note = latestCurationNote(mf);
  if (!note) throw new Error(`${id} has no curation action to undo`);

  if (note.startsWith("curation: merged exact duplicate into ")) {
    if (!mf.fm.superseded_by) {
      throw new Error(`${id} has no superseded_by pointer to undo`);
    }
    const pred = findMemoryFile(mf.fm.superseded_by);
    if (!pred) throw new Error(`predecessor ${mf.fm.superseded_by} not found`);
    const successor = mf.fm.supersedes ? findMemoryFile(mf.fm.supersedes) : null;
    if (!successor && mf.fm.supersedes) {
      throw new Error(`successor ${mf.fm.supersedes} not found`);
    }

    const now = msToRfc3339(Date.now());
    pred.fm.supersedes = successor?.fm.id ?? null;
    pred.fm.updated_at = now;
    pushNote(pred, `curation: unmerged ${id} (undo of automatic duplicate merge)`, opts.by);

    if (successor) {
      successor.fm.superseded_by = pred.fm.id;
      successor.fm.updated_at = now;
      pushNote(successor, `curation: unmerged ${id} (chain relinked)`, opts.by);
      rewriteMemoryFile(successor);
      reindex(successor);
    }

    mf.fm.status = "active";
    mf.fm.superseded_by = null;
    mf.fm.supersedes = null;
    mf.fm.updated_at = now;
    pushNote(mf, `curation: unmerged from ${pred.fm.id}`, opts.by);

    rewriteMemoryFile(pred);
    rewriteMemoryFile(mf);
    reindex(pred);
    reindex(mf);
    return {
      id,
      kind: "merge-duplicate",
      filePaths: [pred.filePath, mf.filePath, ...(successor ? [successor.filePath] : [])],
    };
  }

  if (note.startsWith("curation: normalized title ")) {
    const raw = note.slice("curation: normalized title ".length);
    let pair: unknown;
    try {
      pair = JSON.parse(raw);
    } catch {
      throw new Error(`${id} has an unreadable title-curation marker`);
    }
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`${id} has an unreadable title-curation marker`);
    }
    const [before, after] = pair as [string, string];
    if (typeof before !== "string" || typeof after !== "string") {
      throw new Error(`${id} has an unreadable title-curation marker`);
    }
    const lines = mf.body.split("\n");
    const i = firstNonEmptyLineIndex(mf.body);
    if (i < 0 || lines[i] !== after) {
      throw new Error(`${id} title changed since curation - refusing to overwrite it; edit the file by hand`);
    }
    lines[i] = before;
    mf.body = lines.join("\n");
    pushNote(mf, `curation: restored title ${JSON.stringify(after)} -> ${JSON.stringify(before)}`, opts.by);
    rewriteMemoryFile(mf);
    reindex(mf);
    return { id, kind: "normalize-title", filePaths: [mf.filePath] };
  }

  if (note.startsWith("curation: archived empty body")) {
    if (mf.fm.status !== "archived") {
      throw new Error(`${id} is not archived (status is ${mf.fm.status})`);
    }
    const updated = setStatus(id, "active");
    pushNote(updated, "curation: unarchived empty-body fragment", opts.by);
    rewriteMemoryFile(updated);
    reindex(updated);
    return { id, kind: "archive-empty", filePaths: [updated.filePath] };
  }

  throw new Error(`${id} has no reversible curation action (latest: ${note})`);
}
