/**
 * HTML renderer for the inventory (D68 follow-up): a single local file
 * a user opens in any browser to read what the store remembers. It
 * renders the SAME data layer as the text/JSON formats
 * (`src/inventory.ts`) — one source, three renderings, no drift.
 *
 * Design rules (3-C v2) enforced here:
 * - Every byte of memory content is HTML-escaped. Memory text can come
 *   from an imported bundle or a pasted web page; under file:// an
 *   unescaped <script> would execute in the user's own browser.
 * - The filter box is plain show/hide over server-rendered entries
 *   (no innerHTML, no network, no external resources).
 * - History (superseded versions, retracted, archived) is a folded
 *   section with supersede-chain pointers — auditable, never mixed
 *   into "what is remembered now". At scale (>50 current entries) the
 *   scope sections fold too.
 * - Read-only: no delete buttons, no server callback. Deletion stays a
 *   confirmed conversation; the page says so, with the id to quote.
 */

import path from "node:path";

import { PERSONAL_SCOPE } from "./scope.ts";
import {
  escapeHtml,
  relativeTime,
  reviewStateLabel,
  sourceLabel,
} from "./retrieve/display.ts";
import type { InventoryData, InventoryRow } from "./inventory.ts";

const FOLD_THRESHOLD = 50;

function entryHtml(row: InventoryRow, now: number): string {
  const meta: string[] = [escapeHtml(sourceLabel(row.source))];
  const when = relativeTime(row.created_at, now);
  if (when) meta.push(escapeHtml(when));
  if (row.scope_key !== PERSONAL_SCOPE.key) {
    meta.push(escapeHtml(reviewStateLabel(row.review_state)));
    if (row.review_state !== "draft") {
      meta.push(
        row.file_path.replace(/\\/g, "/").includes("/.ai/open-memex/")
          ? "file is in the repo"
          : "file is not in the repo yet",
      );
    }
  }
  if (row.status !== "active") meta.push(escapeHtml(`marked ${row.status}`));
  return `    <article class="entry">
      <p class="body">${escapeHtml(row.content.trim())}</p>
      <p class="meta">${meta.join(" · ")} · <span class="id">id ${escapeHtml(row.id)}</span></p>
    </article>`;
}

function hiddenEntryHtml(row: InventoryRow, now: number): string {
  const when = relativeTime(row.created_at, now);
  const chain = row.superseded_by
    ? ` · replaced by <span class="id">${escapeHtml(row.superseded_by)}</span>`
    : "";
  return `    <article class="entry hidden-entry">
      <p class="body">${escapeHtml(row.content.trim())}</p>
      <p class="meta">${escapeHtml(row.status)}${when ? ` · saved ${escapeHtml(when)}` : ""}${chain} · <span class="id">id ${escapeHtml(row.id)}</span></p>
    </article>`;
}

function sectionHtml(
  title: string,
  blurb: string,
  entries: string,
  count: number,
  fold: boolean,
  open: boolean,
): string {
  if (fold) {
    return `  <details${open ? " open" : ""}>
    <summary>${escapeHtml(title)} <span class="count">${count}</span></summary>
    <p class="blurb">${escapeHtml(blurb)}</p>
${entries}
  </details>`;
  }
  return `  <section>
    <h2>${escapeHtml(title)} <span class="count">${count}</span></h2>
    <p class="blurb">${escapeHtml(blurb)}</p>
${entries || '    <p class="empty">(nothing here yet)</p>'}
  </section>`;
}

export function renderInventoryHtml(data: InventoryData): string {
  const now = Date.now();
  const fold = data.total > FOLD_THRESHOLD;
  const personalCount = data.scopes
    .filter((s) => s.scopeKey === PERSONAL_SCOPE.key)
    .reduce((n, s) => n + s.rows.length, 0);

  const parts: string[] = [];
  data.scopes.forEach((s, i) => {
    const isPersonal = s.scopeKey === PERSONAL_SCOPE.key;
    parts.push(
      sectionHtml(
        isPersonal ? "About you — personal" : `Project: ${s.projectName}`,
        isPersonal
          ? "These describe you, apply in every project, and never leave this machine."
          : "Project memories. Each entry says whether it is still only on this machine (the outbox) or has reached the repo.",
        s.rows.map((r) => entryHtml(r, now)).join("\n"),
        s.rows.length,
        fold,
        isPersonal || i === 0,
      ),
    );
  });
  if (data.outbox.length > 0) {
    parts.push(
      sectionHtml(
        "Not in the repo yet — outbox drafts",
        "These drafts exist only on this machine. They reach the repo through review (submit → promote), never automatically.",
        data.outbox.map((r) => entryHtml(r, now)).join("\n"),
        data.outbox.length,
        fold,
        false,
      ),
    );
  }
  if (data.hiddenEntries.length > 0) {
    const h = data.hiddenEntries.map((r) => hiddenEntryHtml(r, now)).join("\n");
    parts.push(`  <details>
    <summary>Replaced &amp; hidden history <span class="count">${data.hiddenEntries.length}</span></summary>
    <p class="blurb">Older versions and withdrawn memories. Kept so you can audit how a fact changed; none of this is used for recall.</p>
${h}
  </details>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- D70: the page claims it makes no network requests - enforce it. Inline
     style/script are the only allowances; anything else (a stray <img
     src>, a remote font) is blocked by the browser, not just by our promise. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>What OpenMemex remembers</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; color: #1a1a1a; background: #fdfdfb; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  h2, summary { font-size: 1.1rem; font-weight: 600; }
  summary { cursor: pointer; margin: 1.2rem 0 0.4rem; }
  .sub { color: #666; font-size: 0.9rem; margin-top: 0; }
  .count { color: #888; font-weight: normal; font-size: 0.85em; }
  .blurb { color: #555; font-size: 0.9rem; }
  .entry { border-top: 1px solid #e5e2d9; padding: 0.75rem 0; }
  .hidden-entry { opacity: 0.75; }
  .body { white-space: pre-wrap; margin: 0 0 0.35rem; }
  .meta { color: #666; font-size: 0.82rem; margin: 0; }
  .id { font-family: ui-monospace, monospace; font-size: 0.78rem; }
  .empty { color: #888; }
  .howto { background: #f4f1e8; border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.9rem; }
  input[type="search"] { width: 100%; padding: 0.5rem; font-size: 1rem; margin: 1rem 0; box-sizing: border-box; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>What OpenMemex remembers about you</h1>
<p class="sub">Generated ${escapeHtml(data.generatedAt)} · ${data.total} memories (${personalCount} personal, ${data.total - personalCount} project incl. outbox). Read-only report.</p>
<input type="search" id="filter" placeholder="Filter memories…" aria-label="Filter memories">
<div class="howto">
  <strong>Checking my work:</strong> every entry shows where it came from.
  “I inferred this” means I wrote it from context, not from your words — those are the ones to check.
  To remove one, tell your agent <em>“forget the memory about …”</em> (quote the id if you like) and it will read the entry back before deleting it — deletion is permanent, there is no undo.
  A memory that lives in a repo is only truly gone once the deletion is committed.
</div>
${parts.join("\n")}
<script>
  var input = document.getElementById('filter');
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var entries = document.querySelectorAll('.entry');
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i];
      el.classList.toggle('hidden', q !== '' && el.textContent.toLowerCase().indexOf(q) === -1);
    }
  });
</script>
</body>
</html>
`;
}

/** Default report location: the data dir, never a working tree. */
export function defaultHtmlOutPath(dataRoot: string): string {
  return path.join(dataRoot, "inventory.html");
}
