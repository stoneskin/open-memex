/**
 * D95: closed-loop signal for curation confidence thresholds.
 *
 * The D78 endgame is thresholds that learn from human undos. This is the data
 * half only: every accepted action, declined batch and human undo bumps a
 * counter keyed by (kind, signal). Nothing here changes a threshold yet - the
 * counters are observational, local, and never leave the machine.
 *
 * Like the D77 usage counters, this table lives beside the rebuildable index
 * with `CREATE TABLE IF NOT EXISTS` (outside the versioned schema): the numbers
 * are accumulated telemetry with no Markdown source to rebuild from, so
 * `rebuildIndexSchema` must not drop them.
 */

import { db } from "./db.ts";

export type CurationOutcome = "accepted" | "declined" | "undone";

export interface CurationFeedbackRow {
  kind: string;
  signal: string;
  accepted: number;
  declined: number;
  undone: number;
}

function ensureTable(): void {
  db().exec(
    `CREATE TABLE IF NOT EXISTS curation_feedback (
       kind TEXT NOT NULL,
       signal TEXT NOT NULL,
       accepted INTEGER NOT NULL DEFAULT 0,
       declined INTEGER NOT NULL DEFAULT 0,
       undone INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (kind, signal)
     )`,
  );
}

export function recordCurationOutcome(
  kind: string,
  signal: string,
  outcome: CurationOutcome,
): void {
  ensureTable();
  const col =
    outcome === "accepted" ? "accepted" : outcome === "declined" ? "declined" : "undone";
  db()
    .prepare(
      `INSERT INTO curation_feedback (kind, signal, accepted, declined, undone)
       VALUES (?, ?, ${col === "accepted" ? 1 : 0}, ${col === "declined" ? 1 : 0}, ${col === "undone" ? 1 : 0})
       ON CONFLICT(kind, signal) DO UPDATE SET ${col} = curation_feedback.${col} + 1`,
    )
    .run(kind, signal);
}

export function loadCurationFeedback(): CurationFeedbackRow[] {
  ensureTable();
  return db()
    .prepare(
      `SELECT kind, signal, accepted, declined, undone FROM curation_feedback
       ORDER BY kind, signal`,
    )
    .all() as CurationFeedbackRow[];
}

export function formatCurationFeedback(rows: CurationFeedbackRow[]): string {
  if (rows.length === 0) {
    return "curation feedback: no decisions recorded yet.";
  }
  const lines = ["curation feedback (accepted / declined / undone):"];
  for (const r of rows) {
    lines.push(
      `  ${r.kind} ${r.signal}: ${r.accepted} / ${r.declined} / ${r.undone}`,
    );
  }
  lines.push(
    "thresholds are still fixed; these counters are the local input for a future learning pass (D95).",
  );
  return lines.join("\n");
}
