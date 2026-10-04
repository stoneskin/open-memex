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
  // D43 — §3.5 memory-hygiene footer (double insurance for opencode users,
  // who never see the MCP handshake / init instructions): teach the agent
  // reading this AGENTS.md to propose distilled captures when a task ends
  // (D53: the checkpoint mechanism is gone).
  lines.push(`### Memory hygiene (open-memex)`);
  lines.push(``);
  lines.push(
    `- When you finish a task the user would describe in one sentence, distill`,
    `  the session: propose 1–3 short memories capturing the useful`,
    `  conclusion — what was learned or decided, how an issue was resolved, what`,
    `  to avoid, where the authoritative doc lives — not the raw transcript.`,
    `  Save nothing without user approval.`,
    `  Worth keeping: decisions and their reasons, preferences, conventions,`,
    `  gotchas, approaches tried and abandoned. Not worth keeping: one-off task`,
    `  details or anything re-derivable from the code.`,
    `- If the knowledge already lives in project docs, save a \`reference\` memory`,
    `  pointing at the doc instead of copying it.`,
    `- When saving via \`memory_add\`, attach 2–4 aliases (alternate phrasings,`,
    `  synonyms, equivalents in the user's other language) when the install has`,
    `  capture aliases enabled — they make reworded questions find the memory.`,
    // D64: the skills runbook and the MCP handshake both teach marking
    // inferred captures source: "inference"; this footer omitted it, so
    // opencode agents saved distilled conclusions as if the user had
    // stated them ("tool"). Keep the rubric one voice across surfaces.
    `- Mark captures you infer (rather than the user stating) with`,
    `  \`source: "inference"\` — provenance matters more than polish.`,
    // D68: same voice for the visibility surface — opencode agents reading
    // this footer never see the MCP handshake either.
    `- When the user asks what you remember, list it conversationally`,
    `  (\`memory_list\` with scope both, or \`open-memex inventory\`) — plain`,
    `  words, not raw ids. Before deleting an entry they point at, read it`,
    `  back in full and confirm; deletion is permanent. Offer hiding`,
    `  (\`memory_forget\` soft / \`forget --soft\`) when they hesitate.`,
  );
  lines.push(``);
  return lines.join("\n");
}
