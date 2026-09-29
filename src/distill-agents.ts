/**
 * distill-to-AGENTS.md assist (Phase 3).
 *
 * Turns distilled project memories (decisions, lessons, gotchas, howtos,
 * constraints) into a proposed AGENTS.md snippet. ASSIST only: it prints
 * (or writes with -o) a markdown section for the human to review and merge
 * by hand — open-memex never rewrites your AGENTS.md on its own.
 */
import { db } from "./store/db.ts";

const DEFAULT_TYPES = ["decision", "constraint", "lesson", "gotcha", "howto"];

export interface DistillAgentsOptions {
  scopeKeys: string[];
  types?: string[];
  limit?: number;
}

interface Row {
  id: string;
  type: string;
  tags: string;
  content: string;
  updated_at: number;
}

export function distillAgentsMarkdown(opts: DistillAgentsOptions): string {
  const types = opts.types?.length ? opts.types : DEFAULT_TYPES;
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
  const sql = `
    SELECT id, type, tags, content, updated_at FROM memories
    WHERE scope_key IN (${opts.scopeKeys.map(() => "?").join(",")})
      AND type IN (${types.map(() => "?").join(",")})
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT ?`;
  const rows = db()
    .prepare(sql)
    .all(...(opts.scopeKeys as any[]), ...(types as any[]), limit) as Row[];

  if (rows.length === 0) return "";
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `## Learned (distilled from open-memex, ${date})`,
    ``,
    `<!-- Proposed by \`open-memex distill-agents\`. Review each line, keep`,
    `what's true, delete the rest, then merge into this file by hand. -->`,
    ``,
  ];
  // Group by type, preserving recency within each group.
  const byType = new Map<string, Row[]>();
  for (const r of rows) {
    const g = byType.get(r.type) ?? [];
    g.push(r);
    byType.set(r.type, g);
  }
  for (const t of types) {
    const g = byType.get(t);
    if (!g?.length) continue;
    lines.push(`### ${t}`);
    lines.push(``);
    for (const r of g) {
      const first = r.content.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
      const snippet = first.length > 160 ? first.slice(0, 160) + "…" : first;
      lines.push(`- ${snippet} \`[${r.id.slice(0, 8)}]\``);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
