/**
 * D77-L3: the reuse report — pure types + rendering, no SQLite import (the
 * data comes from `loadReuseReport` in store/usage.ts). Split like
 * weights.ts so smoke-pure can test the formatting without a database.
 *
 * Report rules (D77):
 * - per-scope reuse rate = useful / retrieved over tracked memories
 *   (counters exist per memory; scopes are personal vs the current project);
 * - the useful side is shown split into self vs team — D77 requires reporting
 *   them separately so the team-knowledge claim stays honest (the combined
 *   total still drives ranking and the rate);
 * - "top reused" = highest useful, then highest exposure;
 * - "zombies" = retrieved at least once, never confirmed useful — the
 *   decay/prune candidates the D77 text calls out;
 * - retracted/archived memories are excluded from the two lists (their
 *   counters still count toward the scope totals — history is history);
 * - superseded/deprecated entries stay in the lists (their reuse is real)
 *   but carry a lifecycle tag, so historical data never reads as current
 *   guidance — supersede itself ticks the OLD memory's useful counter;
 * - lists are capped and the cut is disclosed (D68 honesty rule).
 */

export interface ReuseScopeStat {
  /** Human label: "this project" / "personal". */
  label: string;
  scopeKey: string;
  /** Memories in this scope that have a telemetry row. */
  tracked: number;
  retrieved: number;
  useful: number;
  /** D77: the useful split, reported separately from the combined total. */
  usefulSelf: number;
  usefulTeam: number;
  /** useful / retrieved; null when nothing was ever retrieved. */
  rate: number | null;
}

export interface ReuseEntry {
  id: string;
  scopeKey: string;
  scopeLabel: string;
  type: string;
  reviewState: string;
  /** Lifecycle status — non-active entries are tagged in the render. */
  status: string;
  retrieved: number;
  useful: number;
  usefulSelf: number;
  usefulTeam: number;
  snippet: string;
}

export interface ReuseReport {
  scopes: ReuseScopeStat[];
  top: ReuseEntry[];
  topTotal: number;
  zombies: ReuseEntry[];
  zombieTotal: number;
  /** Total memories with a telemetry row across the reported scopes. */
  tracked: number;
}

export interface FormatReuseOptions {
  /** Entries shown per list before the "and N more" line. Default 5. */
  entryCap?: number;
}

function rateText(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

/**
 * Render the report as plain lines. Always emits the "Reuse (D77" header, so
 * the section exists (with an honest empty-state line) even before any
 * retrieval has been recorded — discoverability over silence.
 */
export function formatReuseReport(
  report: ReuseReport,
  opts: FormatReuseOptions = {},
): string[] {
  const cap = opts.entryCap ?? 5;
  const lines: string[] = ["Reuse (D77 — local counters, never leave this machine):"];
  if (report.tracked === 0) {
    lines.push(
      "  no data yet — search/list/session-start injection record exposure; memory_useful records usefulness.",
    );
    return lines;
  }
  for (const s of report.scopes) {
    if (s.tracked === 0) continue;
    lines.push(
      `  ${s.label}: retrieved ${s.retrieved}, useful ${s.useful} (self ${s.usefulSelf}, team ${s.usefulTeam}) — ${rateText(s.rate)} over ${s.tracked} memor${s.tracked === 1 ? "y" : "ies"}`,
    );
  }
  // Only disambiguate each entry's scope when both scopes have data — the
  // single-scope case would just repeat the same tag on every line.
  const multi = report.scopes.filter((s) => s.tracked > 0).length > 1;
  const tag = (e: ReuseEntry) => (multi ? `[${e.scopeLabel}/${e.type}]` : `[${e.type}]`);
  // Lifecycle tag: superseded/deprecated entries are historical reuse, not
  // current guidance (a supersede ticks the old memory, so it can rank high).
  const life = (e: ReuseEntry) => (e.status && e.status !== "active" ? ` [${e.status}]` : "");
  lines.push(`  top reused: ${report.topTotal}`);
  for (const e of report.top.slice(0, cap)) {
    lines.push(
      `    · ${e.id} ${tag(e)}${life(e)} retrieved=${e.retrieved} useful=${e.useful} (self ${e.usefulSelf}, team ${e.usefulTeam}) — ${e.snippet}`,
    );
  }
  if (report.topTotal > cap) {
    lines.push(`    … and ${report.topTotal - cap} more (full list: open-memex sync-status)`);
  }
  lines.push(`  zombies (retrieved, never confirmed useful): ${report.zombieTotal}`);
  for (const e of report.zombies.slice(0, cap)) {
    lines.push(`    · ${e.id} ${tag(e)}${life(e)} retrieved=${e.retrieved} — ${e.snippet}`);
  }
  if (report.zombieTotal > cap) {
    lines.push(`    … and ${report.zombieTotal - cap} more (full list: open-memex sync-status)`);
  }
  return lines;
}
