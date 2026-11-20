/**
 * D78/D95: deterministic curation for the submit path.
 *
 * This module is PURE: it decides what can be auto-applied and what needs the
 * one-shot batch decision, and renders the receipts/summary. File writes live
 * in src/store/curate.ts; `submit` owns the ordering (validate ->
 * branch/conflict preflight -> plan -> apply -> copy -> commit).
 *
 * Confidence tiers (D78):
 *
 * auto-apply (deterministic, never guesses about content the human wrote):
 * - exact duplicates (contentHash: whitespace-normalized body identical)
 * - empty / whitespace-only bodies
 * - title normalization (the first non-empty body line is the de-facto title)
 * - type/tag inference from a keyword capture with a HIGH-confidence signal
 *   (the hook never chose a type/tag, so there is nothing explicit to
 *   overwrite)
 *
 * batch-confirm (one summary screen, accept all or decline all):
 * - semantic merges: near-duplicates whose token sets are the same but whose
 *   bytes differ (case/punctuation/order). 0.8-0.9 stays report-only: one
 *   flipped word (thursday/friday) lands there and merging it would drop a
 *   real difference.
 * - splits: an overlong body with two unrelated paragraphs. The accept path
 *   keeps BOTH halves - the original keeps the first, a derived memory gets
 *   the second.
 * - uncertain type/tag inference (tool/CLI saves may have chosen the current
 *   type explicitly, so they are never changed silently).
 *
 * Nothing in the batch tier is ever auto-applied. A declined batch leaves
 * every memory untouched; an accepted batch is undone as a unit with
 * `open-memex curate undo --batch <id>`.
 */

import { createHash } from "node:crypto";
import {
  contentHash,
  similarity,
  NEAR_DUP_THRESHOLD,
} from "./store/lifecycle.ts";

/** D95: near-dup is the "worth a look" signal; a merge proposal needs the
 *  same token content, not a one-word difference. */
export const SEMANTIC_MERGE_THRESHOLD = 0.9;
/** Both sides of a merge proposal must be roughly the same size. */
export const SEMANTIC_MERGE_MIN_LENGTH_RATIO = 0.6;
/** A split needs an overlong body ... */
export const MIN_SPLIT_BODY_CHARS = 320;
/** ... with two substantial halves ... */
export const MIN_SPLIT_PART_CHARS = 100;
/** ... that talk about different things. */
export const MAX_SPLIT_OVERLAP = 0.25;
/** Never add more than this many inferred tags to one memory. */
export const MAX_INFERRED_TAGS = 3;

export type CurationKind =
  | "merge-duplicate"
  | "archive-empty"
  | "normalize-title"
  | "infer-type"
  | "infer-tags";

export type BatchKind = "semantic-merge" | "split" | "infer-type" | "infer-tags";

export interface CurationRecord {
  id: string;
  body: string;
  status: string;
  createdAt: string;
  supersedes: string | null;
  supersededBy: string | null;
  /** D95: current frontmatter values used by inference. Optional so older
   *  callers/tests keep working; an absent type is treated as the default
   *  "fact". */
  type?: string;
  tags?: string[];
  /** D95: capture source. `keyword` means the hook wrote the memory and never
   *  chose a type/tag; anything else may be an explicit human/agent choice. */
  source?: string;
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
  /** infer-type only: the type before/after. */
  fromType?: string;
  toType?: string;
  /** infer-tags only: the tags that were added. */
  addedTags?: string[];
  /** Feedback key for the closed loop (D95), e.g. `type:decision`. */
  signal?: string;
  /** What the human can run to undo exactly this action. */
  undo: string;
  reason: string;
}

export interface BatchProposal {
  kind: BatchKind;
  /** The record the proposal changes. */
  id: string;
  /** semantic-merge only: the surviving record. */
  canonicalId?: string;
  /** semantic-merge only: similarity score. */
  score?: number;
  /** split only: the two halves, blank-line separated. */
  firstPart?: string;
  secondPart?: string;
  /** infer-type only: the type before/after. */
  fromType?: string;
  toType?: string;
  /** infer-tags only: the tags to append (never a rewrite). */
  addedTags?: string[];
  /** Feedback key for the closed loop (D95). */
  signal: string;
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
  proposals: BatchProposal[];
  nearDuplicates: NearDuplicatePair[];
  skipped: CurationSkip[];
  /** Stable id for the batch screen / `curate undo --batch`. Null when there
   *  are no proposals. */
  batchId: string | null;
}

export interface PlanOptions {
  /** Tags already used in the scope; an inferred tag must be either an
   *  explicit hashtag or a word from this vocabulary. */
  knownTags?: string[];
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

/**
 * D95: type inference. Deterministic keyword/frontmatter signals only - no
 * model, no embeddings. The first matching rule wins; "high" means the signal
 * is explicit enough to auto-apply to a keyword capture, "medium" is always
 * batch-confirm. Returning null keeps the current type.
 */
export interface TypeInference {
  type: string;
  confidence: "high" | "medium";
  signal: string;
}

interface TypeRule {
  re: RegExp;
  type: string;
  confidence: "high" | "medium";
}

const TYPE_RULES: TypeRule[] = [
  // Explicit markers.
  { re: /(^|\n)[ \t]*(todo|TODO)[ \t]*[:：]/, type: "todo", confidence: "high" },
  { re: /(^|\n)[ \t]*(待办|TODO)[ \t]*[:：]/, type: "todo", confidence: "high" },
  { re: /(^|\n)[ \t]*(gotcha|beware|warning)[ \t]*[:：]/i, type: "gotcha", confidence: "high" },
  { re: /(^|\n)[ \t]*(坑|注意)[ \t]*[:：]/, type: "gotcha", confidence: "high" },
  { re: /(^|\n)[ \t]*#{0,6}[ \t]*how[ \t]+to\b/i, type: "howto", confidence: "high" },
  { re: /(^|\n)[ \t]*decision[ \t]*[:：]/i, type: "decision", confidence: "high" },
  { re: /(^|\n)[ \t]*preference[ \t]*[:：]/i, type: "preference", confidence: "high" },
  // Explicit prose.
  { re: /\bwe[ \t]+(?:have[ \t]+)?decided\b/i, type: "decision", confidence: "high" },
  { re: /我们(?:已经)?决定/, type: "decision", confidence: "high" },
  { re: /\bi[ \t]+prefer\b/i, type: "preference", confidence: "high" },
  { re: /我(?:更)?喜欢/, type: "preference", confidence: "high" },
  // Weaker signals: always batch-confirm.
  { re: /\b(remember[ \t]+to|follow[ -]?up)\b/i, type: "todo", confidence: "medium" },
  { re: /\b(must|required|never|only[ \t]+if|constraint)\b/i, type: "constraint", confidence: "medium" },
  { re: /\b(learned|lesson|postmortem|retrospective)\b/i, type: "lesson", confidence: "medium" },
  { re: /https?:\/\//, type: "reference", confidence: "medium" },
  { re: /\b(install|setup|set[ \t]+up|run[ \t]+the[ \t]+following|steps?)\b/i, type: "howto", confidence: "medium" },
  { re: /\b(pitfall|watch[ \t]+out|breaks?)\b/i, type: "gotcha", confidence: "medium" },
];

export function inferType(body: string): TypeInference | null {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(body)) {
      return { type: rule.type, confidence: rule.confidence, signal: `type:${rule.type}` };
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * D95: tag inference. Two deterministic sources, both additive only:
 * - explicit hashtags in the body (`#release`);
 * - a tag from the scope's existing vocabulary (used by >=2 memories) that
 *   appears as a whole word in the body.
 * Existing tags are never removed or renamed.
 */
export function inferTags(
  body: string,
  existing: string[],
  knownTags: string[] = [],
): { tags: string[]; signal: string } | null {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const out: string[] = [];
  const add = (tag: string) => {
    const t = tag.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (have.has(k) || out.includes(k)) return;
    if (out.length >= MAX_INFERRED_TAGS) return;
    out.push(k);
  };

  const hashtag = /(^|\s)#([a-z0-9][a-z0-9_-]{1,23})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = hashtag.exec(body)) !== null) add(m[2]!);

  for (const tag of knownTags) {
    if (tag.length < 3) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(tag)}([^\\p{L}\\p{N}_]|$)`, "iu").test(body)) {
      add(tag);
    }
  }

  if (out.length === 0) return null;
  return { tags: out, signal: out[0] ? `tag:${out[0]}` : "tag" };
}

export interface SplitCandidate {
  firstPart: string;
  secondPart: string;
  overlap: number;
}

/**
 * D95: split detection for overloaded memories. Two or more substantial
 * paragraphs with unrelated vocabulary (Jaccard < 0.25) are the signal. Code
 * fences are left alone - splitting a code sample is a human's call.
 */
export function splitCandidate(body: string): SplitCandidate | null {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length < MIN_SPLIT_BODY_CHARS) return null;
  if (text.includes("```")) return null;
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  let best: { i: number; score: number; first: string; second: string } | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const first = parts.slice(0, i + 1).join("\n\n");
    const second = parts.slice(i + 1).join("\n\n");
    if (first.length < MIN_SPLIT_PART_CHARS || second.length < MIN_SPLIT_PART_CHARS) continue;
    const score = similarity(first, second);
    if (score > MAX_SPLIT_OVERLAP) continue;
    if (!best || score < best.score) best = { i, score, first, second };
  }
  if (!best) return null;
  return { firstPart: best.first, secondPart: best.second, overlap: best.score };
}

function undoLine(kind: CurationKind, id: string): string {
  if (kind === "archive-empty") return `open-memex status ${id} active`;
  return `open-memex curate undo ${id}`;
}

export function batchIdFor(proposals: BatchProposal[]): string {
  const keys = proposals
    .map((p) => `${p.kind}:${p.id}:${p.canonicalId ?? ""}:${p.toType ?? ""}:${(p.addedTags ?? []).join(",")}`)
    .sort();
  return `b${createHash("sha1").update(keys.join("|"), "utf8").digest("hex").slice(0, 10)}`;
}

/** A record whose type/tags were chosen by a human or an agent (anything but
 *  a bare keyword capture) is never changed silently. */
function inferenceIsAuto(source: string | undefined, confidence: "high" | "medium"): boolean {
  return confidence === "high" && source === "keyword";
}

function knownTagVocabulary(records: CurationRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const t of r.tags ?? []) {
      const k = t.trim().toLowerCase();
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([t]) => t);
}

/**
 * Build the plan. Input order is irrelevant: output order is
 * archive-empty -> merge-duplicate -> infer-type -> infer-tags ->
 * normalize-title, then id ascending inside each group, so two runs over the
 * same store render the same summary. Proposals follow the same kind order.
 */
export function planCuration(records: CurationRecord[], opts: PlanOptions = {}): CurationPlan {
  const actions: CurationAction[] = [];
  const proposals: BatchProposal[] = [];
  const skipped: CurationSkip[] = [];
  const active = records.filter((r) => r.status === "active");
  const nonEmpty = active.filter((r) => r.body.trim().length > 0);
  const knownTags = opts.knownTags ?? knownTagVocabulary(records);

  // 1. Empty fragments are archived, never deleted: the file is the source of
  // truth and `status ... active` is the undo path.
  for (const r of active) {
    if (r.body.trim().length === 0) {
      actions.push({
        kind: "archive-empty",
        id: r.id,
        undo: undoLine("archive-empty", r.id),
        signal: "archive:empty",
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
        signal: "merge:exact",
        undo: undoLine("merge-duplicate", dup.id),
        reason: "normalized body is identical to " + canonical.id + "; supersede chain preserves the duplicate file",
      });
      merged.add(dup.id);
    }
  }

  const candidates = nonEmpty.filter((r) => !merged.has(r.id));

  // 3. Semantic merge proposals. Near-duplicates whose token content is the
  // same (case/punctuation/order differences only) are genuinely one memory.
  // 0.8-0.9 pairs stay in the report: a single flipped word (thursday/friday)
  // sits there, and a bulk-accepted merge must not drop it.
  const proposalTouched = new Set<string>();
  const mergeTarget = new Set<string>();
  const nearCandidates: Array<{ a: CurationRecord; b: CurationRecord; score: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (contentHash(a.body) === contentHash(b.body)) continue;
      const ratio =
        Math.min(a.body.length, b.body.length) / Math.max(a.body.length, b.body.length);
      if (ratio < SEMANTIC_MERGE_MIN_LENGTH_RATIO) continue;
      const score = similarity(a.body, b.body);
      if (score < NEAR_DUP_THRESHOLD) continue;
      if (score < SEMANTIC_MERGE_THRESHOLD) continue;
      nearCandidates.push({ a, b, score });
    }
  }
  nearCandidates.sort(
    (x, y) =>
      y.score - x.score ||
      x.a.createdAt.localeCompare(y.a.createdAt) ||
      x.a.id.localeCompare(y.a.id),
  );
  for (const { a, b, score } of nearCandidates) {
    if (proposalTouched.has(a.id) || proposalTouched.has(b.id) || mergeTarget.has(a.id) || mergeTarget.has(b.id)) {
      continue;
    }
    // A chain-managed record is never a canonical or a target: its history is
    // already a human decision.
    const free = [a, b].filter((r) => !r.supersedes && !r.supersededBy);
    if (free.length < 2) {
      skipped.push({
        id: a.id,
        reason: "near-duplicate is already in a supersede chain - a human must decide which version is canonical",
      });
      continue;
    }
    free.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
    const canonical = free[0]!;
    const target = free[1]!;
    proposals.push({
      kind: "semantic-merge",
      id: target.id,
      canonicalId: canonical.id,
      score,
      signal: "merge:semantic",
      reason: `similarity ${score.toFixed(2)} with ${canonical.id} (same token content, different bytes); supersede chain keeps both files`,
    });
    proposalTouched.add(canonical.id);
    proposalTouched.add(target.id);
    mergeTarget.add(target.id);
  }

  // 4. Split proposals: overloaded memories with two unrelated paragraphs.
  for (const r of candidates) {
    if (proposalTouched.has(r.id)) continue;
    const split = splitCandidate(r.body);
    if (!split) continue;
    proposals.push({
      kind: "split",
      id: r.id,
      firstPart: split.firstPart,
      secondPart: split.secondPart,
      signal: "split:paragraph",
      reason: `two unrelated paragraphs (overlap ${split.overlap.toFixed(2)}); accepting keeps both halves - the original and a derived memory`,
    });
    proposalTouched.add(r.id);
  }

  // 5. Type/tag inference. High confidence + a keyword capture is the only
  // automatic path: the hook never chose a type or tag. Everything else is a
  // batch proposal, because a tool/CLI save may have set the value on purpose.
  for (const r of candidates) {
    if (proposalTouched.has(r.id)) continue;
    const currentType = r.type ?? "fact";
    if (currentType === "fact") {
      const inferred = inferType(r.body);
      if (inferred && inferred.type !== currentType) {
        const auto = inferenceIsAuto(r.source, inferred.confidence);
        const reason = auto
          ? `keyword capture, no type was chosen; ${inferred.confidence}-confidence signal for "${inferred.type}"`
          : `type is the default "fact" but the save may have chosen it; ${inferred.confidence}-confidence signal for "${inferred.type}"`;
        if (auto) {
          actions.push({
            kind: "infer-type",
            id: r.id,
            fromType: currentType,
            toType: inferred.type,
            signal: inferred.signal,
            undo: undoLine("infer-type", r.id),
            reason,
          });
        } else {
          proposals.push({
            kind: "infer-type",
            id: r.id,
            fromType: currentType,
            toType: inferred.type,
            signal: inferred.signal,
            reason,
          });
          proposalTouched.add(r.id);
        }
      }
    }
    const inferredTags = inferTags(r.body, r.tags ?? [], knownTags);
    if (inferredTags) {
      const auto = inferenceIsAuto(r.source, "high");
      const reason = auto
        ? `keyword capture; ${inferredTags.tags.length} explicit/vocabulary tag(s) added, none removed`
        : `tags are additive but the save may have chosen them; add ${inferredTags.tags.join(", ")} (nothing removed)`;
      if (auto) {
        actions.push({
          kind: "infer-tags",
          id: r.id,
          addedTags: inferredTags.tags,
          signal: inferredTags.signal,
          undo: undoLine("infer-tags", r.id),
          reason,
        });
      } else {
        proposals.push({
          kind: "infer-tags",
          id: r.id,
          addedTags: inferredTags.tags,
          signal: inferredTags.signal,
          reason,
        });
        proposalTouched.add(r.id);
      }
    }
  }

  // 6. Title normalization. A duplicate being merged is history now, so don't
  // report a title action for it; the canonical survives and can be fixed.
  // A record carrying a batch proposal is under one human decision, and its
  // body is the exact text that proposal was validated against - the auto tier
  // must not rewrite the first line out from under it.
  for (const r of nonEmpty) {
    if (merged.has(r.id) || proposalTouched.has(r.id)) continue;
    const n = normalizeTitle(r.body);
    if (!n) continue;
    actions.push({
      kind: "normalize-title",
      id: r.id,
      before: n.before,
      after: n.after,
      signal: "title:normalize",
      undo: undoLine("normalize-title", r.id),
      reason: "first line is the de-facto title; whitespace normalized, no content changed",
    });
  }

  // Near-duplicates are a report (the batch tier promotes only the 0.9+ ones
  // above). Keep the full 0.8 list so a human can see the ambiguous pairs.
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
    "infer-type": 2,
    "infer-tags": 3,
    "normalize-title": 4,
  };
  actions.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id),
  );
  const batchOrder: Record<BatchKind, number> = {
    "semantic-merge": 0,
    split: 1,
    "infer-type": 2,
    "infer-tags": 3,
  };
  proposals.sort(
    (a, b) => batchOrder[a.kind] - batchOrder[b.kind] || a.id.localeCompare(b.id),
  );
  skipped.sort((a, b) => a.id.localeCompare(b.id));
  return {
    actions,
    proposals,
    nearDuplicates,
    skipped,
    batchId: proposals.length > 0 ? batchIdFor(proposals) : null,
  };
}

/** One human-readable receipt line for an action that was applied. */
export function formatCurationAction(a: CurationAction): string {
  if (a.kind === "merge-duplicate") {
    return `merged ${a.id} into ${a.canonicalId} (exact duplicate; undo: ${a.undo})`;
  }
  if (a.kind === "archive-empty") {
    return `archived ${a.id} (empty body; undo: ${a.undo})`;
  }
  if (a.kind === "infer-type") {
    return `inferred type ${a.id}: ${a.fromType} -> ${a.toType} (undo: ${a.undo})`;
  }
  if (a.kind === "infer-tags") {
    return `inferred tags ${a.id}: +${(a.addedTags ?? []).join(", +")} (undo: ${a.undo})`;
  }
  return `normalized ${a.id} title ${JSON.stringify(a.before)} -> ${JSON.stringify(a.after)} (undo: ${a.undo})`;
}

/** One line for the batch-confirm screen. */
export function formatBatchProposal(p: BatchProposal): string {
  if (p.kind === "semantic-merge") {
    return `[merge] ${p.id} -> ${p.canonicalId} (similarity ${(p.score ?? 0).toFixed(2)}): ${p.reason}`;
  }
  if (p.kind === "split") {
    return `[split] ${p.id}: ${p.reason}`;
  }
  if (p.kind === "infer-type") {
    return `[type] ${p.id}: ${p.fromType} -> ${p.toType} (${p.reason})`;
  }
  return `[tag] ${p.id}: +${(p.addedTags ?? []).join(", +")} (${p.reason})`;
}

/**
 * The one summary screen for the batch tier. Nothing here is applied; the
 * caller either passes an accept/decline decision or shows this verbatim.
 */
export function formatBatchSummary(plan: CurationPlan, opts: { ids: string[] }): string {
  if (!plan.batchId || plan.proposals.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    `batch-confirm ${plan.batchId}: ${plan.proposals.length} proposal(s) — one decision, never per-item approval:`,
  );
  for (const p of plan.proposals) lines.push(`  ${formatBatchProposal(p)}`);
  const idList = opts.ids.join(" ");
  lines.push(`  accept all:  open-memex submit ${idList} --accept-batch`);
  lines.push(
    `  decline all: open-memex submit ${idList} --decline-batch   (the batch stays unchanged; the deterministic tier above still ran)`,
  );
  lines.push(`  after accepting, undo the whole batch: open-memex curate undo --batch ${plan.batchId}`);
  return lines.join("\n");
}
