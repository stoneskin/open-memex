/**
 * D78/D95: the write half of deterministic curation.
 *
 * Pure planning lives in src/curate.ts. This module applies a plan to the
 * outbox files through the existing lifecycle primitives (atomic writes,
 * supersede-chain fields, append-only review_history) and keeps the index in
 * step. Every action is reversible:
 *
 * - merge-duplicate / semantic-merge -> open-memex curate undo <duplicate id>
 * - normalize-title                  -> open-memex curate undo <id>
 * - infer-type / infer-tags          -> open-memex curate undo <id>
 * - split                            -> open-memex curate undo <original id>
 * - archive-empty                    -> open-memex status <id> active
 * - a whole accepted batch           -> open-memex curate undo --batch <id>
 */

import {
  findMemoryFile,
  rewriteMemoryFile,
  setStatus,
} from "./lifecycle.ts";
import {
  firstNonEmptyLineIndex,
  normalizeTitle,
  type BatchProposal,
  type CurationAction,
  type CurationPlan,
  type CurationSkip,
} from "../curate.ts";
import {
  iterMemoryFiles,
  iterInRepoMemoryFiles,
  msToRfc3339,
  readMemoryFile,
  ulid,
  writeMemoryFile,
  type MemoryFile,
} from "./markdown.ts";
import { upsertFromFile } from "./sync.ts";
import { projectRoot } from "../paths.ts";
import { loadConfig } from "../config.ts";
import { recordCurationOutcome } from "./curation-feedback.ts";

export interface AppliedCuration {
  action: CurationAction;
  filePaths: string[];
}

export interface CurationApplyResult {
  applied: AppliedCuration[];
  skipped: CurationSkip[];
}

export interface AppliedBatch {
  proposal: BatchProposal;
  filePaths: string[];
  /** split only: the derived memory created for the second half. */
  newId?: string;
}

export interface BatchApplyResult {
  applied: AppliedBatch[];
  /** split only: memories created by the accepted batch (submit them too). */
  created: Array<{ id: string; filePath: string }>;
}

function signalSuffix(signal?: string, batchId?: string): string {
  let out = "";
  if (signal) out += ` (signal ${signal})`;
  if (batchId) out += ` (batch ${batchId})`;
  return out;
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

function requireActive(id: string): MemoryFile {
  const mf = findMemoryFile(id);
  if (!mf) throw new Error(`no memory with id ${id}`);
  if (mf.fm.status !== "active") throw new Error(`${id} is not active`);
  return mf;
}

/**
 * Append a duplicate at the OLDEST end of the canonical's chain. The chain is
 * a single pointer (supersedes points back), so this is the only place a
 * second copy can sit without dropping history.
 */
function mergeIntoChain(
  canonicalId: string,
  dupId: string,
  noteTail: string,
  noteDup: string,
  by: string,
): string[] {
  const canonical = requireActive(canonicalId);
  const dup = requireActive(dupId);
  if (canonical.fm.id === dup.fm.id) throw new Error(`${dupId} cannot merge into itself`);
  if (dup.fm.supersedes || dup.fm.superseded_by) {
    throw new Error(`${dup.fm.id} is already in a supersede chain`);
  }

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
  pushNote(tail, noteTail, by);

  dup.fm.status = "superseded";
  dup.fm.superseded_by = tail.fm.id;
  dup.fm.supersedes = null;
  dup.fm.updated_at = now;
  pushNote(dup, noteDup, by);

  rewriteMemoryFile(dup);
  rewriteMemoryFile(tail);
  reindex(dup);
  reindex(tail);
  return [dup.filePath, tail.filePath];
}

function applyOne(action: CurationAction, by: string): string[] {
  if (action.kind === "archive-empty") {
    const mf = requireActive(action.id);
    const updated = setStatus(action.id, "archived");
    pushNote(updated, "curation: archived empty body (signal archive:empty)", by);
    rewriteMemoryFile(updated);
    reindex(updated);
    return [updated.filePath];
  }

  if (action.kind === "normalize-title") {
    const mf = requireActive(action.id);
    const n = normalizeTitle(mf.body);
    if (!n) throw new Error(`${action.id} title is already normalized`);
    mf.body = n.body;
    pushNote(
      mf,
      `curation: normalized title ${JSON.stringify([n.before, n.after])} (signal title:normalize)`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    return [mf.filePath];
  }

  if (action.kind === "infer-type") {
    const mf = requireActive(action.id);
    const current = mf.fm.type ?? "fact";
    if (current !== action.fromType) {
      throw new Error(`${action.id} type changed since planning (${current})`);
    }
    mf.fm.type = action.toType!;
    pushNote(
      mf,
      `curation: inferred type ${action.fromType} -> ${action.toType}${signalSuffix(action.signal)}`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    return [mf.filePath];
  }

  if (action.kind === "infer-tags") {
    const mf = requireActive(action.id);
    const have = new Set(mf.fm.tags.map((t) => t.toLowerCase()));
    const added = (action.addedTags ?? []).filter((t) => !have.has(t.toLowerCase()));
    if (added.length === 0) throw new Error(`${action.id} already has the inferred tags`);
    mf.fm.tags = [...mf.fm.tags, ...added];
    pushNote(
      mf,
      `curation: added tags ${JSON.stringify(added)}${signalSuffix(action.signal)}`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    return [mf.filePath];
  }

  return mergeIntoChain(
    action.canonicalId!,
    action.id,
    `curation: merged exact duplicate ${action.id} (undo: open-memex curate undo ${action.id})`,
    `curation: merged exact duplicate into ${action.canonicalId} (undo: open-memex curate undo ${action.id}) (signal merge:exact)`,
    by,
  );
}

/**
 * Apply every planned auto action. One action failing is reported and
 * skipped, not fatal: a curation hiccup must never block the submit the human
 * asked for.
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
      recordCurationOutcome(action.kind, action.signal ?? action.kind, "accepted");
    } catch (e) {
      skipped.push({
        id: action.id,
        reason: `auto-apply failed: ${(e as Error).message}`,
      });
    }
  }
  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// batch tier (D95)
// ---------------------------------------------------------------------------

function validateProposal(p: BatchProposal): void {
  const mf = requireActive(p.id);
  if (p.kind === "semantic-merge") {
    const canonical = requireActive(p.canonicalId!);
    if (canonical.fm.id === mf.fm.id) throw new Error(`${p.id} cannot merge into itself`);
    if (mf.fm.supersedes || mf.fm.superseded_by) {
      throw new Error(`${p.id} is already in a supersede chain`);
    }
    return;
  }
  if (p.kind === "split") {
    const actual = mf.body.replace(/\r\n/g, "\n").trim();
    const expected = `${p.firstPart ?? ""}\n\n${p.secondPart ?? ""}`.trim();
    if (actual !== expected) throw new Error(`${p.id} body changed since planning`);
    return;
  }
  if (p.kind === "infer-type") {
    if ((mf.fm.type ?? "fact") !== p.fromType) {
      throw new Error(`${p.id} type changed since planning (${mf.fm.type})`);
    }
    return;
  }
  const have = new Set(mf.fm.tags.map((t) => t.toLowerCase()));
  const missing = (p.addedTags ?? []).filter((t) => !have.has(t.toLowerCase()));
  if (missing.length === 0) throw new Error(`${p.id} already has the inferred tags`);
}

function applyBatchProposal(
  p: BatchProposal,
  by: string,
  batchId: string,
): AppliedBatch {
  const mf = requireActive(p.id);
  if (p.kind === "semantic-merge") {
    const filePaths = mergeIntoChain(
      p.canonicalId!,
      p.id,
      `curation: took in semantic duplicate ${p.id}${signalSuffix(p.signal, batchId)}`,
      `curation: merged semantic duplicate into ${p.canonicalId}${signalSuffix(p.signal, batchId)}`,
      by,
    );
    recordCurationOutcome(p.kind, p.signal, "accepted");
    return { proposal: p, filePaths };
  }

  if (p.kind === "infer-type") {
    mf.fm.type = p.toType!;
    pushNote(
      mf,
      `curation: inferred type ${p.fromType} -> ${p.toType}${signalSuffix(p.signal, batchId)}`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome(p.kind, p.signal, "accepted");
    return { proposal: p, filePaths: [mf.filePath] };
  }

  if (p.kind === "infer-tags") {
    const have = new Set(mf.fm.tags.map((t) => t.toLowerCase()));
    const added = (p.addedTags ?? []).filter((t) => !have.has(t.toLowerCase()));
    mf.fm.tags = [...mf.fm.tags, ...added];
    pushNote(
      mf,
      `curation: added tags ${JSON.stringify(added)}${signalSuffix(p.signal, batchId)}`,
      by,
    );
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome(p.kind, p.signal, "accepted");
    return { proposal: p, filePaths: [mf.filePath] };
  }

  // Split: keep BOTH halves. The original keeps the first part and the
  // second becomes a new memory that derives from it.
  const newId = ulid();
  const now = msToRfc3339(Date.now());
  const state = mf.fm.review_state ?? "draft";
  const derived = {
    ...mf.fm,
    id: newId,
    created_at: now,
    updated_at: now,
    supersedes: null,
    superseded_by: null,
    derived_from: mf.fm.id,
    source: "curation",
    review_history: [
      ...(mf.fm.review_history ?? []),
      {
        at: now,
        by,
        from: state,
        to: state,
        note: `curation: split from ${mf.fm.id} (second part)${signalSuffix(p.signal, batchId)}`,
      },
    ],
  };
  mf.body = (p.firstPart ?? "").trimEnd();
  pushNote(mf, `curation: split into ${newId} (first part kept)${signalSuffix(p.signal, batchId)}`, by);
  rewriteMemoryFile(mf);
  reindex(mf);
  const written = writeMemoryFile(derived, (p.secondPart ?? "").trim());
  const fresh = readMemoryFile(written.filePath);
  if (fresh) upsertFromFile(fresh);
  recordCurationOutcome(p.kind, p.signal, "accepted");
  return {
    proposal: p,
    filePaths: [mf.filePath, written.filePath],
    newId,
  };
}

/**
 * Apply an accepted batch, all-or-nothing. Every proposal is validated before
 * the first write; a failure mid-way rolls the already-applied proposals back,
 * so a batch never leaves a partial merge behind.
 */
export function applyBatchProposals(
  proposals: BatchProposal[],
  opts: { by: string; batchId: string },
): BatchApplyResult {
  for (const p of proposals) validateProposal(p);
  const applied: AppliedBatch[] = [];
  const created: Array<{ id: string; filePath: string }> = [];
  try {
    for (const p of proposals) {
      const a = applyBatchProposal(p, opts.by, opts.batchId);
      applied.push(a);
      if (a.newId) {
        const mf = findMemoryFile(a.newId);
        if (mf) created.push({ id: a.newId, filePath: mf.filePath });
      }
    }
  } catch (e) {
    for (const a of applied.slice().reverse()) {
      try {
        undoCuration(a.proposal.id, { by: opts.by });
      } catch {
        /* best effort - the original batch error is what matters */
      }
    }
    throw e;
  }
  return { applied, created };
}

export function declineBatch(proposals: BatchProposal[]): void {
  for (const p of proposals) recordCurationOutcome(p.kind, p.signal, "declined");
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

function latestCurationNote(mf: MemoryFile): string | null {
  for (let i = (mf.fm.review_history ?? []).length - 1; i >= 0; i--) {
    const note = mf.fm.review_history[i]!.note ?? "";
    if (note.startsWith("curation:")) return note;
  }
  return null;
}

function signalFromNote(note: string): string | null {
  return (/\(signal ([^)\s]+)\)/.exec(note) ?? [])[1] ?? null;
}

export interface UndoCurationResult {
  id: string;
  kind:
    | "merge-duplicate"
    | "semantic-merge"
    | "normalize-title"
    | "archive-empty"
    | "infer-type"
    | "infer-tags"
    | "split";
  filePaths: string[];
}

function undoMerge(mf: MemoryFile, by: string): UndoCurationResult {
  if (!mf.fm.superseded_by) {
    throw new Error(`${mf.fm.id} has no superseded_by pointer to undo`);
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
  pushNote(pred, `curation: unmerged ${mf.fm.id} (undo of automatic merge)`, by);

  if (successor) {
    successor.fm.superseded_by = pred.fm.id;
    successor.fm.updated_at = now;
    pushNote(successor, `curation: unmerged ${mf.fm.id} (chain relinked)`, by);
    rewriteMemoryFile(successor);
    reindex(successor);
  }

  mf.fm.status = "active";
  mf.fm.superseded_by = null;
  mf.fm.supersedes = null;
  mf.fm.updated_at = now;
  pushNote(mf, `curation: unmerged from ${pred.fm.id}`, by);

  rewriteMemoryFile(pred);
  rewriteMemoryFile(mf);
  reindex(pred);
  reindex(mf);
  return {
    id: mf.fm.id,
    kind: "merge-duplicate",
    filePaths: [pred.filePath, mf.filePath, ...(successor ? [successor.filePath] : [])],
  };
}

/**
 * Reverse the specific curation marker `note` against the current `mf`. The
 * marker lives in review_history (the file is the source of truth), so this
 * works across machines/branches and lets a batch undo replay the exact
 * actions it applied - one memory can carry two markers (type, then tags).
 */
function undoFromNote(mf: MemoryFile, note: string, by: string): UndoCurationResult {
  const id = mf.fm.id;
  const signal = signalFromNote(note);

  if (
    note.startsWith("curation: merged exact duplicate into ") ||
    note.startsWith("curation: merged semantic duplicate into ")
  ) {
    const r = undoMerge(mf, by);
    recordCurationOutcome(
      note.startsWith("curation: merged semantic duplicate") ? "semantic-merge" : "merge-duplicate",
      signal ?? "merge:exact",
      "undone",
    );
    return r;
  }

  if (
    note.startsWith("curation: took in semantic duplicate") ||
    note.startsWith("curation: split from ")
  ) {
    throw new Error(
      `${id} is the surviving/split side of a batch action - undo the other memory instead (open-memex curate undo --batch)`,
    );
  }

  if (note.startsWith("curation: inferred type ")) {
    const m = /^curation: inferred type (\S+) -> (\S+)/.exec(note);
    if (!m) throw new Error(`${id} has an unreadable type-inference marker`);
    const [, before, after] = m;
    if ((mf.fm.type ?? "fact") !== after) {
      throw new Error(`${id} type changed since curation - refusing to overwrite it; edit the file by hand`);
    }
    mf.fm.type = before!;
    pushNote(mf, `curation: restored type ${after} -> ${before}`, by);
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome("infer-type", signal ?? "type:unknown", "undone");
    return { id, kind: "infer-type", filePaths: [mf.filePath] };
  }

  if (note.startsWith("curation: added tags ")) {
    const raw = note.slice("curation: added tags ".length).replace(/\s*\(signal .*$/, "");
    let added: unknown;
    try {
      added = JSON.parse(raw);
    } catch {
      throw new Error(`${id} has an unreadable tag-inference marker`);
    }
    if (!Array.isArray(added) || added.some((t) => typeof t !== "string")) {
      throw new Error(`${id} has an unreadable tag-inference marker`);
    }
    const drop = new Set((added as string[]).map((t) => t.toLowerCase()));
    const keep = mf.fm.tags.filter((t) => !drop.has(t.toLowerCase()));
    if (keep.length === mf.fm.tags.length) {
      throw new Error(`${id} no longer has the inferred tags - nothing to undo`);
    }
    mf.fm.tags = keep;
    pushNote(mf, `curation: removed inferred tags ${JSON.stringify(added)}`, by);
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome("infer-tags", signal ?? "tag:unknown", "undone");
    return { id, kind: "infer-tags", filePaths: [mf.filePath] };
  }

  if (note.startsWith("curation: normalized title ")) {
    const raw = note.slice("curation: normalized title ".length).replace(/\s*\(signal .*$/, "");
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
    pushNote(mf, `curation: restored title ${JSON.stringify(after)} -> ${JSON.stringify(before)}`, by);
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome("normalize-title", signal ?? "title:normalize", "undone");
    return { id, kind: "normalize-title", filePaths: [mf.filePath] };
  }

  if (note.startsWith("curation: split into ")) {
    const newId = (/^curation: split into (\S+)/.exec(note) ?? [])[1];
    if (!newId) throw new Error(`${id} has an unreadable split marker`);
    const derived = findMemoryFile(newId);
    if (!derived) throw new Error(`split part ${newId} not found - cannot rejoin`);
    if (derived.fm.status !== "active") {
      throw new Error(`split part ${newId} is ${derived.fm.status} - already undone`);
    }
    const first = mf.body.trimEnd();
    const second = derived.body.trim();
    mf.body = second ? `${first}\n\n${second}` : first;
    pushNote(mf, `curation: unsplit ${newId} (restored the original body)`, by);
    derived.fm.status = "retracted";
    derived.fm.updated_at = msToRfc3339(Date.now());
    pushNote(derived, `curation: unsplit (derived part retracted; original ${id} restored)`, by);
    rewriteMemoryFile(mf);
    rewriteMemoryFile(derived);
    reindex(mf);
    reindex(derived);
    recordCurationOutcome("split", signal ?? "split:paragraph", "undone");
    return { id, kind: "split", filePaths: [mf.filePath, derived.filePath] };
  }

  if (note.startsWith("curation: archived empty body")) {
    if (mf.fm.status !== "archived") {
      throw new Error(`${id} is not archived (status is ${mf.fm.status})`);
    }
    // One write, not two: setStatus would rewrite the file and then this
    // receipt would need a second atomic rename for the same bytes.
    mf.fm.status = "active";
    pushNote(mf, "curation: unarchived empty-body fragment", by);
    rewriteMemoryFile(mf);
    reindex(mf);
    recordCurationOutcome("archive-empty", signal ?? "archive:empty", "undone");
    return { id, kind: "archive-empty", filePaths: [mf.filePath] };
  }

  throw new Error(`${id} has no reversible curation action (latest: ${note})`);
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
  return undoFromNote(mf, note, opts.by);
}

export interface UndoBatchResult {
  batchId: string;
  undone: Array<{ id: string; kind: UndoCurationResult["kind"] }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Undo every still-latest action that belongs to one accepted batch. Scans the
 * outbox and the in-repo dir (submit moves files, the review_history travels
 * with them). An item with a later curation action is skipped, never guessed.
 */
export function undoBatch(
  batchId: string,
  scopeKey: string,
  opts: { by: string },
): UndoBatchResult {
  const files = new Set<string>();
  for (const fp of iterMemoryFiles(scopeKey)) files.add(fp);
  try {
    for (const fp of iterInRepoMemoryFiles(projectRoot(), loadConfig().memoryDir)) files.add(fp);
  } catch {
    /* personal-only usage: no project root */
  }

  // Replay the exact markers this batch wrote, newest first. A memory can
  // carry more than one (type + tags), and the counterpart side of a merge or
  // split is reversed through the target/original, so it is skipped here.
  const token = `(batch ${batchId})`;
  const items: Array<{ id: string; note: string }> = [];
  for (const fp of files) {
    const mf = readMemoryFile(fp);
    if (!mf) continue;
    const notes = (mf.fm.review_history ?? [])
      .map((t) => t.note ?? "")
      .filter((n) => n.startsWith("curation:") && n.includes(token));
    for (const note of notes.slice().reverse()) {
      if (
        note.startsWith("curation: took in semantic duplicate") ||
        note.startsWith("curation: split from ")
      ) {
        continue;
      }
      items.push({ id: mf.fm.id, note });
    }
  }

  const undone: UndoBatchResult["undone"] = [];
  const skipped: UndoBatchResult["skipped"] = [];
  for (const { id, note } of items) {
    try {
      const mf = findMemoryFile(id);
      if (!mf) throw new Error(`memory ${id} not found`);
      const r = undoFromNote(mf, note, opts.by);
      undone.push({ id, kind: r.kind });
    } catch (e) {
      skipped.push({ id, reason: (e as Error).message });
    }
  }
  return { batchId, undone, skipped };
}
