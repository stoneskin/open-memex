/**
 * Display helpers (D68): how memory provenance, age, and state are
 * rendered on the user-facing surfaces — the `memory_list` inventory an
 * agent shows its user, and the `open-memex inventory` reports.
 *
 * Two rules from the 3-C design (v2) live here:
 * - The list format is STRUCTURED data (number + id + created= + source=
 *   + state tags). The plain-language renderings ("you said this",
 *   "3 days ago") live in the guidance surfaces (tool descriptions,
 *   SKILL.md, MCP handshake) so an agent rephrases them in the
 *   conversation's language — the raw enums never get localized or
 *   reworded inside the data itself.
 * - Nothing truncates silently: callers pair these lines with the true
 *   totals so a cut list says so.
 */

/** Human age for a saved memory: "just now", "3 days ago", else a date. */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts || Number.isNaN(ts)) return "";
  const diff = now - ts;
  if (diff < 0) return "just now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) {
    const n = Math.floor(diff / minute);
    return `${n} minute${n === 1 ? "" : "s"} ago`;
  }
  if (diff < day) {
    const n = Math.floor(diff / hour);
    return `${n} hour${n === 1 ? "" : "s"} ago`;
  }
  if (diff < 30 * day) {
    const n = Math.floor(diff / day);
    return `${n} day${n === 1 ? "" : "s"} ago`;
  }
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `on ${d.getFullYear()}-${mm}-${dd}`;
}

/** Compact age token for the structured list format: `3d`, `12h`, `now`. */
export function ageToken(ts: number | undefined, now = Date.now()): string {
  if (!ts || Number.isNaN(ts)) return "?";
  const diff = now - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 60 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Provenance in the user's words (D68). Used by prose surfaces (HTML
 * report); the structured list keeps the raw `source=` enum instead.
 * The distinction that matters to the user is *whose words these were* —
 * said outright, asked to be saved, auto-captured, or inferred by the
 * agent and possibly wrong.
 */
export function sourceLabel(source: string | undefined): string {
  switch (source) {
    case "user":
      return "you said this";
    case "cli":
      return "you saved this from the command line";
    case "tool":
      return "you asked me to save this";
    case "keyword":
      return "auto-captured from your own wording";
    case "inference":
      return "I inferred this — not in your words, check me";
    case "import":
      return "imported from another machine";
    default:
      return source ? `saved (${source})` : "saved";
  }
}

/**
 * Review state in plain words for project scopes (D68). Personal
 * memories are always `draft` by design; callers must not show this
 * for them — "not yet shared" would be alarming noise there.
 */
export function reviewStateLabel(reviewState: string | undefined): string {
  switch (reviewState) {
    case "draft":
      return "still in your outbox — not in the repo yet";
    case "proposed":
      return "shared with the project, waiting for review";
    case "approved":
      return "approved, not yet published";
    case "published":
      return "published to the repo";
    case "rejected":
      return "reviewed and rejected";
    default:
      return reviewState ?? "draft";
  }
}

/** Escape user content for HTML. Memory text is arbitrary user input. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface InventoryHit {
  id: string;
  type: string;
  snippet: string;
  source?: string;
  created_at?: number;
  updated_at?: number;
  status: string;
  review_state?: string;
  scope_key: string;
}

/**
 * One structured inventory line (D68):
 *   3. [fact] id=01K6… created=3d source=user [draft] — body text
 * Number and id always appear together: the number is for the user's
 * mouth ("delete #3"), the id is the machine contract. `created=` is
 * when the memory was learned; `updated=` appears only when it moved
 * materially later (supersede/promote touch updated_at).
 *
 * D70: `index` must be a running counter across every section of one
 * listing — a per-section counter produces two "#1"s in a single
 * `scope: both` output, which makes "delete #3" a guess.
 */
export function formatInventoryLine(
  index: number,
  hit: InventoryHit,
  personalKey: string,
  now = Date.now(),
): string {
  const parts = [
    `${index + 1}.`,
    `[${hit.type}]`,
    `id=${hit.id}`,
    `created=${ageToken(hit.created_at ?? hit.updated_at, now)}`,
    `source=${hit.source || "?"}`,
  ];
  const created = hit.created_at ?? hit.updated_at ?? 0;
  if (hit.updated_at && hit.updated_at - created >= 86_400_000) {
    parts.push(`updated=${ageToken(hit.updated_at, now)}`);
  }
  if (hit.scope_key !== personalKey) {
    const state = hit.review_state ?? "draft";
    if (state !== "published") parts.push(`[${state}]`);
  }
  if (hit.status !== "active") parts.push(`[${hit.status}]`);
  const body = hit.snippet.replace(/\s+/g, " ").trim();
  return `${parts.join(" ")} — ${body}`;
}

/**
 * Truncation disclosure (D68): a cut list always says so.
 * D70: the wording names the surface that can show everything — the CLI —
 * so a hidden entry is always reachable.
 */
export function truncationNote(shown: number, total: number, cli = "open-memex"): string | null {
  if (total <= shown) return null;
  return `… and ${total - shown} more not shown (raise limit up to 100, run \`${cli} list --limit 100\`, or use memory_search to find something specific).`;
}
