/**
 * `open-memex inventory` (D68): what the store remembers, in the open.
 * One data layer, three renderers (text / json / html). The HTML
 * renderer lives in inventory-html.ts; this module owns the data and
 * the two renderers an agent or a terminal consumes directly.
 *
 * Design rules (3-C v2) enforced here:
 * - Default scope is personal + the current project — "can't see it"
 *   is the disease this surface treats.
 * - Nothing truncates silently: every section states its totals, and
 *   hidden history (superseded versions, retracted, archived) is
 *   counted and pointed at, never just omitted.
 * - Drafts that have not reached the repo (the outbox) are their own
 *   section, consistent with what memory_status reports.
 * - The report is read-only. Deleting stays a confirmed conversation.
 */

import { db } from "./store/db.ts";
import { PERSONAL_SCOPE } from "./scope.ts";
import { formatInventoryLine } from "./retrieve/display.ts";

export interface InventoryRow {
  id: string;
  scope_key: string;
  project_name: string;
  type: string;
  status: string;
  review_state: string;
  source: string;
  created_at: number;
  updated_at: number;
  content: string;
  file_path: string;
}

export interface InventoryData {
  generatedAt: string;
  /** Currently-remembered rows (active/deprecated), grouped by scope. */
  scopes: Array<{ scopeKey: string; projectName: string; rows: InventoryRow[] }>;
  /** Project drafts still in the outbox (not in the repo yet). */
  outbox: InventoryRow[];
  /** History that exists but is not "remembered": counted, not listed. */
  hidden: { superseded: number; retracted: number; archived: number };
  total: number;
}

const BASE_COLS = `id, scope_key, project_name, type, status, review_state,
  source, created_at, updated_at, content, file_path`;

/**
 * Load the inventory for the given scopes. `projectScopeKey` separates
 * the outbox drafts (they belong to that scope's draft rows).
 */
export function loadInventory(scopeKeys: string[]): InventoryData {
  const inList = scopeKeys.map(() => "?").join(",");
  const current = db()
    .prepare(
      `SELECT ${BASE_COLS} FROM memories
       WHERE scope_key IN (${inList}) AND status IN ('active', 'deprecated')
       ORDER BY scope_key, updated_at DESC`,
    )
    .all(...scopeKeys) as unknown as InventoryRow[];
  const hiddenRows = db()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM memories
       WHERE scope_key IN (${inList}) AND status IN ('superseded', 'retracted', 'archived')
       GROUP BY status`,
    )
    .all(...scopeKeys) as unknown as Array<{ status: string; n: number }>;

  const hidden = { superseded: 0, retracted: 0, archived: 0 };
  for (const r of hiddenRows) {
    if (r.status === "superseded") hidden.superseded = r.n;
    if (r.status === "retracted") hidden.retracted = r.n;
    if (r.status === "archived") hidden.archived = r.n;
  }

  const outbox = current.filter(
    (r) => r.scope_key !== PERSONAL_SCOPE.key && r.review_state === "draft",
  );
  const outboxIds = new Set(outbox.map((r) => r.id));

  const byScope = new Map<string, InventoryRow[]>();
  for (const r of current) {
    if (outboxIds.has(r.id)) continue;
    const arr = byScope.get(r.scope_key) ?? [];
    arr.push(r);
    byScope.set(r.scope_key, arr);
  }
  // Personal first, then project scopes by key for a stable order.
  const orderedKeys = [
    ...scopeKeys.filter((k) => k === PERSONAL_SCOPE.key),
    ...[...byScope.keys()].filter((k) => k !== PERSONAL_SCOPE.key).sort(),
  ];
  const scopes = orderedKeys
    .filter((k) => byScope.has(k))
    .map((k) => {
      const rows = byScope.get(k)!;
      return {
        scopeKey: k,
        projectName: rows[0]?.project_name || k,
        rows,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    scopes,
    outbox,
    hidden,
    total: current.length,
  };
}

function hiddenLine(data: InventoryData): string {
  const { superseded, retracted, archived } = data.hidden;
  if (superseded + retracted + archived === 0) return "";
  return `Not shown: ${superseded} superseded version(s), ${retracted} retracted, ${archived} archived — inspect with \`open-memex list --include all\`.`;
}

function entriesText(rows: InventoryRow[]): string {
  return rows
    .map((r, i) =>
      formatInventoryLine(
        i,
        { ...r, snippet: r.content },
        PERSONAL_SCOPE.key,
      ),
    )
    .join("\n");
}

/** Plain-text rendering: diffable in any terminal or CI log. */
export function renderInventoryText(data: InventoryData): string {
  const out: string[] = [];
  out.push(`What OpenMemex remembers — ${data.generatedAt}`);
  out.push(
    `${data.total} memories (${data.scopes.reduce((n, s) => n + (s.scopeKey === PERSONAL_SCOPE.key ? s.rows.length : 0), 0)} personal, ${data.outbox.length} in the outbox).`,
  );
  for (const s of data.scopes) {
    const title =
      s.scopeKey === PERSONAL_SCOPE.key
        ? "About you — personal (never leaves this machine)"
        : `Project: ${s.projectName}`;
    out.push("", `## ${title} (${s.rows.length})`, entriesText(s.rows));
  }
  if (data.outbox.length > 0) {
    out.push(
      "",
      `## Not in the repo yet — outbox drafts (${data.outbox.length})`,
      "These exist only on this machine. They reach the repo through review (submit → promote), never automatically.",
      entriesText(data.outbox),
    );
  }
  const hidden = hiddenLine(data);
  if (hidden) out.push("", hidden);
  out.push(
    "",
    "Read-only report. To remove a memory, tell your agent to forget it — it will read the entry back before deleting (deletion is permanent).",
  );
  return out.join("\n") + "\n";
}

/** JSON rendering: same data, for agents. Mirrors the export field names. */
export function renderInventoryJson(data: InventoryData): string {
  const entry = (r: InventoryRow) => ({
    id: r.id,
    scope: r.scope_key,
    project: r.project_name,
    type: r.type,
    status: r.status,
    review_state: r.review_state,
    source: r.source,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    content: r.content,
    file: r.file_path,
  });
  return (
    JSON.stringify(
      {
        format: "open-memex-inventory/1",
        generated_at: data.generatedAt,
        total: data.total,
        scopes: data.scopes.map((s) => ({
          scope: s.scopeKey,
          project: s.projectName,
          memories: s.rows.map(entry),
        })),
        outbox: data.outbox.map(entry),
        hidden: data.hidden,
      },
      null,
      2,
    ) + "\n"
  );
}
