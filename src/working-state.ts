/**
 * D89 / §3.6 — session working state note.
 *
 * One ephemeral Markdown note per project scope, at
 * `working-state/<scope_key>.md` under the data root — beside the store,
 * never inside `memories/`, never committed to a repo. The note is written
 * or refreshed by the agent at wrap-up, surfaced at session start alongside
 * the §7 injection, and never enters the review ladder: it is scratch
 * state, not knowledge. Worth-keeping content routes through the D61
 * checkpoint-proposal flow — the note is raw material, the ladder is the
 * gate. Expired notes are reported by `audit` (reports only, never
 * auto-deletes — the D57 posture); the next wrap-up write overwrites.
 *
 * Hermetic on purpose: only fs, paths and config types are imported, no
 * sqlite — scripts/smoke-pure.ts keeps its no-sqlite guarantee.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";
import { redact } from "./redact.ts";
import { atomicWriteTextSync } from "./store/markdown.ts";
import type { MyOMemoryConfig } from "./config.ts";

const DAY_MS = 86_400_000;

export interface WorkingStateFile {
  content: string;
  /** Filesystem write time in ms (the note's own age anchor). */
  updatedAtMs: number;
  /** TTL days effective for this note (frontmatter `ttl_days`, falling
   *  back to the given default). */
  ttlDays: number;
  /** Whole-day age of the note. */
  ageDays: number;
  /** True when ageDays > ttlDays — ignored by surfacing, reported by audit. */
  expired: boolean;
}

export interface WriteWorkingStateResult {
  filePath: string;
  hadSecret: boolean;
  matchedPattern: string | null;
}

/** Read-only path helper — never creates the directory (D70 discipline;
 *  contrast the write path below, which mkdirs on demand). */
export function workingStatePath(scopeKey: string): string {
  return path.join(paths().root, "working-state", `${scopeKey}.md`);
}

/**
 * Write or refresh the note. The agent composes the body (task summary /
 * open files / last commands / where the work stands / next step). Content
 * passes through `redact()` so command paste-through from an interrupted
 * session cannot park a readable secret in storage. TTL days is stamped
 * into frontmatter so the user's per-note edit survives config changes.
 */
export function writeWorkingState(
  scopeKey: string,
  content: string,
  defaultTtlDays: number,
  redactPatterns: string[],
): WriteWorkingStateResult {
  const { content: redacted, hadSecret, matchedPattern } = redact(content, redactPatterns);
  const filePath = workingStatePath(scopeKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const ttlDays = Number.isInteger(defaultTtlDays) && defaultTtlDays > 0 ? defaultTtlDays : 7;
  const text =
    "---\n" +
    "schema: working-state\n" +
    `updated_at: ${new Date().toISOString()}\n` +
    `ttl_days: ${ttlDays}\n` +
    "---\n" +
    redacted.trimEnd() +
    "\n";
  atomicWriteTextSync(filePath, text);
  return { filePath, hadSecret, matchedPattern };
}

/**
 * Read the note and compute expiry. Missing file → null. A note older than
 * its TTL is marked expired (surfacing ignores it; audit reports it).
 */
export function readWorkingState(
  scopeKey: string,
  defaultTtlDays: number,
): WorkingStateFile | null {
  const filePath = workingStatePath(scopeKey);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const fm = m[1] ?? "";
  const updatedAt = /^updated_at:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return null;
  const ttlDaysRaw = /^ttl_days:\s*(\d+)\s*$/m.exec(fm)?.[1];
  const ttlDays = ttlDaysRaw
    ? Number.parseInt(ttlDaysRaw, 10)
    : Number.isInteger(defaultTtlDays) && defaultTtlDays > 0
      ? defaultTtlDays
      : 7;
  const ageDays = Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
  return {
    content: raw.slice(m[0].length).trimEnd(),
    updatedAtMs: t,
    ttlDays,
    ageDays,
    expired: ageDays > ttlDays,
  };
}

/**
 * Delete the note. Honest delete (D63 spirit): true — deleted or already
 * gone; false — the unlink failed (keeps reporting to worry about).
 */
export function clearWorkingState(scopeKey: string): boolean {
  const filePath = workingStatePath(scopeKey);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * D89: surfaced at session start, outside the review ladder. Returns null
 * when nothing should surface: the feature is off, or no note exists, or
 * the note has expired (audit is the reporter; silence at session start).
 */
export function workingStateBlock(
  scopeKey: string,
  projectName: string,
  cfg: MyOMemoryConfig,
): string | null {
  if (!cfg.workingStateEnabled) return null;
  const note = readWorkingState(scopeKey, cfg.workingStateTtlDays);
  if (!note || note.expired || !note.content) return null;
  return (
    `[OPEN-MEMEX WORKING STATE — ${projectName}]\n` +
    "Scratch state from an interrupted task, not durable knowledge; do not save it as a memory.\n" +
    note.content +
    "\n\n" +
    "This is the user's own recent work state, for resuming where the work stands. " +
    "If something in it deserves to outlive the task, propose it as a distilled memory — the checkpoint-proposal flow is the gate, the note never enters a review ladder. " +
    "When the user signals the session or task is wrapping up, refresh this note via `memory_workingstate` (action=write) before finishing: task summary, open files, last commands, where the work stands, next step."
  );
}
