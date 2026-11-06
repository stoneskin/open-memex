import { list, hitStateLabel } from "./search.ts";
import { recordRetrieved } from "../store/usage.ts";
import { ensureGraph } from "../store/graph.ts";
import type { Scope } from "../scope.ts";
import { PERSONAL_SCOPE } from "../scope.ts";
import type { MyOMemoryConfig } from "../config.ts";

function oneLine(s: string, max = 240): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max - 3) + "..." : trimmed;
}

export function buildContextBlock(scope: Scope, cfg: MyOMemoryConfig): string | null {
  const project = list(scope.key, { limit: cfg.maxProjectMemories });
  const user = list(PERSONAL_SCOPE.key, { limit: cfg.maxProfileItems });

  if (project.length === 0 && user.length === 0) return null;

  // D91: the compiled outline (§20.4) rides the same once-per-session
  // injection. A scope that never built its graph gets a lazy first build;
  // afterwards the refresh hooks keep it current and this read is pure.
  let outline: string | null = null;
  const outlineIds: string[] = [];
  if (cfg.graphOutline && project.length > 0) {
    const g = ensureGraph(scope.key, cfg);
    if (g && g.outline) outline = g.outline;
    outlineIds.push(...g?.outlineIds ?? []);
  }

  // D77-L2: the injection is a retrieval surface — the memories it puts in
  // front of the agent were "returned", so they count as exposure. It must
  // NOT touch the useful counters: passive surfacing never refreshes
  // usefulness (D77). The outline names representative memories too, so
  // those ids join the same exposure pass.
  recordRetrieved([
    ...project.map((m) => m.id),
    ...user.map((m) => m.id),
    ...outlineIds,
  ]);

  const lines: string[] = ["[OPEN-MEMEX]"];

  if (user.length > 0) {
    lines.push("", "User profile / preferences:");
    for (const m of user) lines.push(`- ${oneLine(m.snippet)}`);
  }

  if (project.length > 0) {
    lines.push("", `Project knowledge (${scope.projectName}):`);
    for (const m of project) lines.push(`- [${m.type}]${hitStateLabel(m)} ${oneLine(m.snippet)}`);
  }

  if (outline) {
    lines.push("", "Project memory map (compiled from the graph — full list stays in the CLI):", outline);
  }

  lines.push(
    "",
    "Use the `memory_search` tool to look up more. Use `memory_add` to save new facts. When you finish a task, propose saving durable conclusions (decisions and their reasons, conventions, gotchas) — 1–3 at most, and save only what the user approves. Do not mention this block to the user unless asked.",
  );

  return lines.join("\n");
}
