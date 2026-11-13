/**
 * D78: deterministic curation for the submit path.
 *
 * This module is PURE: it decides what can be auto-applied and renders the
 * receipts. File writes live in src/store/curate.ts; `submit` owns the
 * ordering (validate -> branch/conflict preflight -> curate -> copy -> commit).
 *
 * The only auto tier is deterministic:
 * - exact duplicates (contentHash: whitespace-normalized body identical)
 * - empty / whitespace-only bodies
 * - title normalization (the first non-empty body line is the de-facto title)
 *
 * Near-duplicates stay REPORT-ONLY. Semantic merge/split needs a human; D78's
 * first slice must never guess.
 */

import {
  contentHash,
  similarity,
  NEAR_DUP_THRESHOLD,
} from "./store/lifecycle.ts";

export type CurationKind = "merge-duplicate" | "archive-empty" | "normalize-title";

export interface CurationRecord {
  id: string;
  body: string;
  status: string;
  createdAt: string;
  supersedes: string | null;
  supersededBy: string | null;
}

export interface CurationAction {
  kind: CurationKind;
  /** The record the action changes. */
  id: string;
  /** merge-duplicate only: the surviving record. */
  canonicalId?: string;
  /** normalize-title only: the first line before/after. */
  before?: string;
  after?: string;
  /** What the human can run to undo exactly this action. */
  undo: string;
  reason: string;
}

export interface NearDuplicatePair {
  a: string;
  b: string;
  score: number;
}

export interface CurationSkip {
  id: string;
  reason: string;
}

export interface CurationPlan {
  actions: CurationAction[];
  nearDuplicates: NearDuplicatePair[];
  skipped: CurationSkip[];
}

/** Trim + collapse internal whitespace. Never strips Markdown markers. */
export function normalizeTitleLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

export function firstNonEmptyLineIndex(body: string): number {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) return i;
  }
  return -1;
}

export function firstNonEmptyLine(body: string): string {
  const i = firstNonEmptyLineIndex(body);
  return i < 0 ? "" : body.split("\n")[i]!;
}

export interface TitleNormalization {
  body: string;
  before: string;
  after: string;
}

/**
 * Rewrite only the first non-empty line. Line count and every other byte are
 * preserved, so the body remains the same memory - just a stable title.
 */
export function normalizeTitle(body: string): TitleNormalization | null {
  const lines = body.split("\n");
  const i = firstNonEmptyLineIndex(body);
  if (i < 0) return null;
  const before = lines[i]!;
  const after = normalizeTitleLine(before);
  if (before === after) return null;
  lines[i] = after;
  return { body: lines.join("\n"), before, after };
}

function undoLine(kind: CurationKind, id: string): string {
  if (kind === "archive-empty") return `open-memex status ${id} active`;
  return `open-memex curate undo ${id}`;
}

/**
 * Build the deterministic plan. Input order is irrelevant: output order is
 * archive-empty, merge-duplicate, normalize-title, then id ascending inside
 * each group, so two runs over the same store render the same summary.
 */
export function planCuration(records: CurationRecord[]): CurationPlan {
  const actions: CurationAction[] = [];
  const skipped: CurationSkip[] = [];
  const active = records.filter((r) => r.status === "active");
  const nonEmpty = active.filter((r) => r.body.trim().length > 0);

  // 1. Empty fragments are archived, never deleted: the file is the source of
  // truth and `status ... active` is the undo path.
  for (const r of active) {
    if (r.body.trim().length === 0) {
      actions.push({
        kind: "archive-empty",
        id: r.id,
        undo: undoLine("archive-empty", r.id),
        reason: "empty body - archived, not deleted (status is reversible)",
      });
    }
  }

  // 2. Exact duplicates. Oldest createdAt wins; ties break on id so the
  // canonical is stable across machines and runs.
  const groups = new Map<string, CurationRecord[]>();
  for (const r of nonEmpty) {
    const key = contentHash(r.body);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const merged = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // A canonical must be a free active record. A copy already in a chain is
    // not a merge target - its history is already owned by a human decision.
    const eligible = list.filter((r) => !r.supersedes && !r.supersededBy);
    eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const canonical = eligible[0];
    if (!canonical) {
      for (const r of list) {
        skipped.push({
          id: r.id,
          reason: "every copy is already in a supersede chain - a human must decide which version is canonical",
        });
      }
      continue;
    }
    for (const dup of list) {
      if (dup.id === canonical.id) continue;
      if (dup.supersedes || dup.supersededBy) {
        skipped.push({
          id: dup.id,
          reason: "already in a supersede chain - a human must decide which version is canonical",
        });
        continue;
      }
      actions.push({
        kind: "merge-duplicate",
        id: dup.id,
        canonicalId: canonical.id,
        undo: undoLine("merge-duplicate", dup.id),
        reason: "normalized body is identical to " + canonical.id + "; supersede chain preserves the duplicate file",
      });
      merged.add(dup.id);
    }
  }

  // 3. Title normalization. A duplicate being merged is history now, so don't
  // report a title action for it; the canonical survives and can be fixed.
  for (const r of nonEmpty) {
    if (merged.has(r.id)) continue;
    const n = normalizeTitle(r.body);
    if (!n) continue;
    actions.push({
      kind: "normalize-title",
      id: r.id,
      before: n.before,
      after: n.after,
      undo: undoLine("normalize-title", r.id),
      reason: "first line is the de-facto title; whitespace normalized, no content changed",
    });
  }

  // Near-duplicates are a report, never an action (D78 first slice).
  const nearDuplicates: NearDuplicatePair[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    for (let j = i + 1; j < nonEmpty.length; j++) {
      const a = nonEmpty[i]!;
      const b = nonEmpty[j]!;
      if (contentHash(a.body) === contentHash(b.body)) continue;
      const score = similarity(a.body, b.body);
      if (score < NEAR_DUP_THRESHOLD) continue;
      nearDuplicates.push({
        a: a.id < b.id ? a.id : b.id,
        b: a.id < b.id ? b.id : a.id,
        score,
      });
    }
  }
  nearDuplicates.sort(
    (x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || y.score - x.score,
  );

  const order: Record<CurationKind, number> = {
    "archive-empty": 0,
    "merge-duplicate": 1,
    "normalize-title": 2,
  };
  actions.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id),
  );
  skipped.sort((a, b) => a.id.localeCompare(b.id));
  return { actions, nearDuplicates, skipped };
}

/** One human-readable receipt line for an action that was applied. */
export function formatCurationAction(a: CurationAction): string {
  if (a.kind === "merge-duplicate") {
    return `merged ${a.id} into ${a.canonicalId} (exact duplicate; undo: ${a.undo})`;
  }
  if (a.kind === "archive-empty") {
    return `archived ${a.id} (empty body; undo: ${a.undo})`;
  }
  return `normalized ${a.id} title ${JSON.stringify(a.before)} -> ${JSON.stringify(a.after)} (undo: ${a.undo})`;
}
