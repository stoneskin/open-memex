/**
 * Turn hand-off between keyword capture and the agent (D73).
 *
 * The keyword hook and the agent are two writers for one user turn. The hook
 * stores the user's sentence verbatim, with no agent in the loop; the agent
 * then sees only the chat transcript and cannot tell the sentence is already
 * stored, so it saves its own paraphrase — the same statement lands two or
 * three times (observed 2026-10-04: one `remember …` sentence → one
 * `source: keyword` file plus two `source: tool` files).
 *
 * Two mechanisms, in this order:
 *   (a) the hand-off note — this module's `formatHandoffBlock`, pushed into the
 *       turn's system context so the agent knows what is already stored;
 *   (b) the turn-echo guard — `TURN_ECHO_THRESHOLD` below, enforced in
 *       `addMemory` (src/tools/ops.ts) over what the hook just wrote.
 *
 * Pure module: no db, no fs, no config, so the threshold behavior is testable
 * in scripts/smoke-pure.ts.
 */

/**
 * Overlap bar for refusing a re-save of a just-captured user statement.
 *
 * Deliberately high, and only ever applied to memories the *hook* wrote
 * (`source: keyword` / `user`) inside `TURN_ECHO_WINDOW_MS`. Measured on the
 * reported case and its near neighbours (token Jaccard, see
 * `similarity` in src/store/lifecycle.ts): a wholesale re-save of the captured
 * sentence scores 0.29–0.36, while a genuinely distinct fact the same
 * sentence also contained scores 0.21 and below. Lexical overlap cannot
 * separate an agent's gloss from a new fact — those two measured 0.211 and
 * 0.214 — so the guard sits at the high-confidence end and everything under
 * the bar is left to (a) and the agent's judgment. A refusal is always
 * reported with the stored id, so the caller can supersede or rephrase.
 */
export const TURN_ECHO_THRESHOLD = 0.28;

/** How long a hook capture counts as "this turn" (10 minutes). */
export const TURN_ECHO_WINDOW_MS = 10 * 60 * 1000;

/** One hook capture, in memory only — never persisted (like `injectedSessions`). */
export interface CaptureRecord {
  id: string;
  scopeKey: string;
  content: string;
  at: number;
  /** The note has already been pushed for this capture. */
  delivered?: boolean;
}

export function isTurnEcho(score: number): boolean {
  return score >= TURN_ECHO_THRESHOLD;
}

/** Records still inside the window. */
export function freshCaptures(records: CaptureRecord[], now: number): CaptureRecord[] {
  return records.filter((r) => now - r.at <= TURN_ECHO_WINDOW_MS);
}

function preview(content: string): string {
  const one = content.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 160)}…` : one;
}

/** The hand-off note (a). Empty string when there is nothing to hand off. */
export function formatHandoffBlock(records: CaptureRecord[]): string {
  if (records.length === 0) return "";
  const lines = records.map((r) => `- id=${r.id} (${r.scopeKey}) — "${preview(r.content)}"`);
  return [
    "[open-memex] The user's own wording in this turn was ALREADY stored verbatim, before you saw it. It is not unsaved.",
    ...lines,
    "Do not call memory_add to save that text again in any rewording — one statement is already one memory, and a rewording only adds a second copy that retrieval will return alongside the first.",
    "Save a memory only for information those lines do NOT contain, as its own self-contained statement. If your version is meant to replace one of them, call memory_supersede with that id instead of memory_add.",
  ].join("\n");
}
