/**
 * §20.4 (D88): graph lint — a health check that only discovers and
 * reports; it never auto-resolves (Principle 5). The findings are the
 * input the promotion flow (§5) and D78's curate step consume later:
 * "which memories contradict (LLM half), which are orphaned, which are
 * stale". Contradiction detection needs the LLM half of §20 and is
 * deliberately out of D91's deterministic subset.
 *
 * Deterministic checks in D91:
 * - orphan        — an active memory with zero structural edges: written
 *                   but never linked, in no topic.
 * - dangling-edge — an edge points at an id that does not exist in the
 *                   index (a mention to a deleted/foreign memory). The
 *                   chain-repair path (§3.3) self-heals frontmatter links
 *                   with a warning; lint just enumerates the leftovers.
 * - stale         — an active memory whose body is a near-duplicate
 *                   (Jaccard ≥ 0.8, the §3.4 threshold) of a superseded or
 *                   deprecated memory: it looks like a replacement that
 *                   should have entered the supersede chain but didn't.
 */

import { similarity, NEAR_DUP_THRESHOLD } from "../store/lifecycle.ts";
import type { GraphEdge, GraphNode } from "./extract.ts";

export type LintKind = "orphan" | "dangling-edge" | "stale";

export interface LintFinding {
  kind: LintKind;
  /** The memory the human should look at (the REPORTED side). */
  id: string;
  /** The other end for dangling-edge / stale findings. */
  other?: string;
  detail: string;
}

export function lintGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  foreignIds: Iterable<string> = [],
): LintFinding[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Ids that exist in the store but OUTSIDE the linted scope: a propose-copy
  // legitimately derives from the personal original, which lives in another
  // scope — that is a foreign link, not a dangling one (D91).
  const foreign = new Set(foreignIds);
  const findings: LintFinding[] = [];

  // Orphans: active memories not touched by any edge at all.
  const connected = new Set<string>();
  for (const e of edges) {
    if (byId.has(e.from)) connected.add(e.from);
    if (byId.has(e.to)) connected.add(e.to);
  }
  for (const n of nodes) {
    if (n.status !== "active") continue;
    if (!connected.has(n.id)) {
      findings.push({
        kind: "orphan",
        id: n.id,
        detail: "active but in no topic and linked to nothing — no tag overlap with other memories, no references",
      });
    }
  }

  // Dangling edges: an endpoint missing from the index. An endpoint that
  // exists in ANOTHER scope is expected (the derive edge from a propose-copy
  // points at the personal original) — skipped, not reported.
  for (const e of edges) {
    const missingFrom = !byId.has(e.from);
    const missingTo = !byId.has(e.to);
    if (!missingFrom && !missingTo) continue;
    if ((missingFrom && foreign.has(e.from)) || (missingTo && foreign.has(e.to))) continue;
    const other = missingFrom ? e.from : e.to;
    const id = other === e.from ? e.to : e.from;
    findings.push({
      kind: "dangling-edge",
      id,
      other,
      detail: `${e.type} edge ${e.via} points at ${other}, which is not in this index (deleted, another scope, or a foreign id)`,
    });
  }

  // Stale: active content that nearly duplicates a superseded/deprecated
  // memory — the newer copy and the old chain never met.
  const retired = nodes.filter((n) => n.status === "superseded" || n.status === "deprecated");
  for (const n of nodes) {
    if (n.status !== "active") continue;
    for (const r of retired) {
      const score = similarity(n.body, r.body);
      if (score < NEAR_DUP_THRESHOLD) continue;
      findings.push({
        kind: "stale",
        id: n.id,
        other: r.id,
        detail: `active but ${score === 1 ? "identical" : `near-duplicate (${score.toFixed(2)})`} to ${r.id} (${r.status}) — one of them should be superseded by the other`,
      });
    }
  }

  findings.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id) ||
      (a.other ?? "").localeCompare(b.other ?? ""),
  );
  return findings;
}
