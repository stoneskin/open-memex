/**
 * LLM half (§20, docs/design/llm-half.md §4): the admissibility check.
 *
 * Pure — no DB, no model, no network. The check verifies FORM, never
 * truth: endpoints, span resolution, the relation sentence, and the
 * contradicts resolution rule. A verdict that fails any rule is dropped
 * before staging, and the drop is counted in the ingress report.
 *
 * The check is the only gate between an agent's verdict and the review
 * queue: the verdict ingress (`graph verdict`) runs it before staging,
 * and it is the only writer of semantic edges. `memory_add` /
 * `memory_propose` refuse structured verdicts outright (see
 * `looksLikeEdgeVerdict`), so the verifier cannot be bypassed by
 * convention — smuggling a verdict in as a memory.
 *
 * Rule 3 operationalization: "states the relation in one sentence naming
 * both sides" is checked deterministically as — the relation contains both
 * cited spans verbatim (the spans ARE each side's claim, quoted), and
 * after stripping those spans the remainder is exactly one sentence (one
 * trailing terminator, no other terminator). A span may itself contain
 * punctuation, which is why the spans are stripped before counting.
 */

import type { Confidence, GraphNode } from "./extract.ts";

export type SemanticEdgeType = "supports" | "contradicts";
export type VerdictResolution = "unresolved" | "superseded-by";

/** One structured verdict, as the agent loop hands it to the ingress. */
export interface SemanticVerdict {
  from: string;
  to: string;
  type: SemanticEdgeType;
  /** Quoted fragment from the `from` endpoint's body — verbatim, not a paraphrase. */
  spanFrom: string;
  /** Quoted fragment from the `to` endpoint's body. */
  spanTo: string;
  /** One sentence naming both sides (their quoted spans). */
  relation: string;
  /** `contradicts` only; default "unresolved". Ignored for `supports`. */
  resolution?: VerdictResolution;
  /** The model's own confidence, if it gave one — recorded, ignored for the cap. */
  modelConfidence?: string;
}

export interface AdmissibilityResult {
  admissible: boolean;
  /** "admissible", or the drop reason (counted in the ingress report). */
  reason: string;
  /**
   * Model-generated edges cap at `medium`, however cleanly they pass —
   * the check verifies form, never truth. Only a human accept promotes
   * an edge to `high` (§4).
   */
  cappedConfidence: Confidence;
}

const fail = (reason: string): AdmissibilityResult => ({
  admissible: false,
  reason,
  cappedConfidence: "medium",
});

/**
 * Rule 3: the relation is one sentence naming both sides. Both cited
 * spans must appear verbatim, and the text around them must be a single
 * sentence — one trailing terminator, no other terminator.
 */
export function relationNamesBothSides(
  relation: string,
  spanFrom: string,
  spanTo: string,
): boolean {
  const r = relation.trim();
  if (!r) return false;
  if (!r.includes(spanFrom) || !r.includes(spanTo)) return false;
  const rest = r.replaceAll(spanFrom, "").replaceAll(spanTo, "").trim();
  if (!/[.!?]$/.test(rest)) return false;
  return !/[.!?]/.test(rest.slice(0, -1));
}

/**
 * The §4 admissibility check. Every rule is deterministic and testable
 * with canned verdicts (§7a); model precision is an external observation,
 * never measured here.
 */
export function checkAdmissibility(
  verdict: SemanticVerdict,
  nodes: GraphNode[],
): AdmissibilityResult {
  // Shape: an edge needs two distinct endpoints of a known semantic type.
  if (verdict.from === verdict.to) return fail("endpoints must differ");
  if (verdict.type !== "supports" && verdict.type !== "contradicts") {
    return fail(`unknown edge type "${verdict.type}" — expected supports or contradicts`);
  }

  // Rule 1: both endpoints are active memories in the project scope.
  const fromNode = nodes.find((n) => n.id === verdict.from);
  if (!fromNode) return fail(`endpoint ${verdict.from} not found in this scope`);
  const toNode = nodes.find((n) => n.id === verdict.to);
  if (!toNode) return fail(`endpoint ${verdict.to} not found in this scope`);
  if (fromNode.status !== "active") {
    return fail(`endpoint ${verdict.from} is ${fromNode.status} — only active memories take semantic edges`);
  }
  if (toNode.status !== "active") {
    return fail(`endpoint ${verdict.to} is ${toNode.status} — only active memories take semantic edges`);
  }

  // Rule 2: each cited span resolves verbatim in its own endpoint's body.
  if (!verdict.spanFrom || !verdict.spanFrom.trim()) {
    return fail("spanFrom is empty — cite a quoted fragment from the from endpoint");
  }
  if (!fromNode.body.includes(verdict.spanFrom)) {
    return fail("spanFrom does not resolve verbatim in the from endpoint's body (quote, don't paraphrase)");
  }
  if (!verdict.spanTo || !verdict.spanTo.trim()) {
    return fail("spanTo is empty — cite a quoted fragment from the to endpoint");
  }
  if (!toNode.body.includes(verdict.spanTo)) {
    return fail("spanTo does not resolve verbatim in the to endpoint's body (quote, don't paraphrase)");
  }

  // Rule 3: one sentence naming both sides.
  if (!relationNamesBothSides(verdict.relation, verdict.spanFrom, verdict.spanTo)) {
    return fail("relation must be one sentence naming both sides (quote both spans in it)");
  }

  // Rule 4: a contradicts edge additionally names its resolution status.
  if (verdict.type === "contradicts") {
    const resolution = verdict.resolution ?? "unresolved";
    if (resolution !== "unresolved" && resolution !== "superseded-by") {
      return fail(`unknown resolution "${resolution}" — expected unresolved or superseded-by`);
    }
    if (resolution === "superseded-by") {
      return fail("redundant: superseded-by — the supersede chain already states the conflict");
    }
    if (fromNode.supersedes === toNode.id || toNode.supersedes === fromNode.id) {
      return fail("redundant: the supersede chain already links these endpoints");
    }
  }

  return { admissible: true, reason: "admissible", cappedConfidence: "medium" };
}

/**
 * The narrow detector behind the `memory_add` / `memory_propose`
 * refusal (§4): a body that IS a structured edge verdict — a JSON object
 * carrying the full verdict shape (from/to/type/spans/relation). Ordinary
 * prose never matches: it does not parse as JSON with all six keys, so a
 * memory that merely says "A supports B" saves normally. The refusal
 * keeps the ingress the only writer of semantic edges.
 */
export function looksLikeEdgeVerdict(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const o = parsed as Record<string, unknown>;
  return (
    typeof o.from === "string" &&
    typeof o.to === "string" &&
    (o.type === "supports" || o.type === "contradicts") &&
    typeof o.spanFrom === "string" &&
    typeof o.spanTo === "string" &&
    typeof o.relation === "string"
  );
}
