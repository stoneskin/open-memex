import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import {
  memoriesDirFor,
  memoriesDirPath,
  inRepoMemoriesDirPath,
} from "../paths.ts";

/** v2 content-kind taxonomy (V2-DESIGN §3.1). `type` = what the memory IS
 *  (single-valued, drives behavior). D41: 11 types; `warning`→`gotcha`,
 *  `workflow`→`howto`, `incident`→`lesson`, `architecture`→`knowledge`. */
export const MEMORY_TYPE_TAXONOMY = [
  "fact",
  "preference",
  "decision",
  "constraint",
  "todo",
  "knowledge",
  "howto",
  "gotcha",
  "lesson",
  "observation",
  "reference",
] as const;

const TAXONOMY = new Set<string>(MEMORY_TYPE_TAXONOMY);

export type ScopeKind = "personal" | "project" | "org";
export type Visibility = "private" | "internal" | "shared";
export type MemoryRole = "knowledge" | "instruction";
export type Importance = "low" | "normal" | "high";
export type MemoryStatus =
  | "active"
  | "superseded"
  | "deprecated"
  | "retracted"
  | "archived";

/** v2 frontmatter (V2-DESIGN §3). Markdown is the source of truth; the
 *  SQLite index is derived and rebuildable (D1). `scope_key` is kept as the
 *  local storage address; `scope` is the semantic ownership. */
export interface Frontmatter {
  id: string;
  schema_version: 2;
  scope_key: string;
  scope: ScopeKind;
  visibility: Visibility;
  project_name: string;
  type: string;
  role: MemoryRole;
  importance: Importance;
  status: MemoryStatus;
  tags: string[];
  /**
   * D61: capture-time aliases — alternate phrasings / other-language
   * equivalents of this memory, indexed alongside the body so a
   * differently-worded question still matches (retrieval layer 3).
   * Optional and additive: files without it parse unchanged.
   */
  aliases?: string[];
  source: string;
  created_at: string; // RFC 3339, never bare epoch (§3)
  updated_at: string; // RFC 3339
  supersedes: string | null; // on the NEW memory → points BACK (§3.3)
  superseded_by: string | null; // on the OLD memory → points FORWARD
  /** 2B/D25: where this memory sits in the propose → promote workflow. */
  review_state: ReviewState;
  /** Who proposed / approved it (git user.name, fallback OS user). */
  proposed_by: string | null;
  approved_by: string | null;
  /** For propose-copies: the personal memory this was derived from. */
  derived_from: string | null;
  /** Curator note on the latest review transition (e.g. rejection reason). */
  review_note: string | null;
  /** 2B/D29: append-only audit trail of review transitions. Lives in the
   *  file (source of truth), so it travels through branches and PRs. */
  review_history: ReviewTransition[];
}

/** One step in a memory's review lifecycle — who moved it, when, why. */
export interface ReviewTransition {
  at: string; // RFC 3339
  by: string; // author identity (git user.name, fallback OS user)
  from: ReviewState;
  to: ReviewState;
  note: string | null;
}

/** Defensive parse: malformed entries are dropped, never fatal. */
export function asReviewHistory(v: unknown): ReviewTransition[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewTransition[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const from = asReviewState(r.from);
    const to = asReviewState(r.to);
    const at = typeof r.at === "string" && r.at ? r.at : null;
    const by = typeof r.by === "string" && r.by ? r.by : null;
    if (!at || !by) continue;
    out.push({
      at,
      by,
      from,
      to,
      note: typeof r.note === "string" && r.note ? r.note : null,
    });
  }
  return out;
}

/** Review lifecycle for shared memories (2B/D25): draft → proposed →
 *  approved/rejected → published. Personal memories stay `draft`. */
export type ReviewState = "draft" | "proposed" | "approved" | "rejected" | "published";

const REVIEW_STATES: ReviewState[] = ["draft", "proposed", "approved", "rejected", "published"];

export function asReviewState(v: unknown): ReviewState {
  return typeof v === "string" && (REVIEW_STATES as string[]).includes(v)
    ? (v as ReviewState)
    : "draft";
}

export interface MemoryFile {
  fm: Frontmatter;
  body: string;
  filePath: string;
  mtimeMs: number;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-ish: 10 chars of base32 timestamp + 16 chars of base32 randomness. */
export function ulid(): string {
  let ts = "";
  let n = Date.now();
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[n % 32]! + ts;
    n = Math.floor(n / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32]!;
  return ts + rand;
}

/** epoch ms → RFC 3339 (v2 times). */
export function msToRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** RFC 3339 (or epoch ms) → epoch ms. Falls back to now on garbage. */
export function timeToMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function asScopeKind(v: unknown, scopeKind: unknown): ScopeKind {
  if (v === "personal" || v === "project" || v === "org") return v;
  if (scopeKind === "user") return "personal"; // v1 → v2 (§19)
  if (scopeKind === "project") return "project";
  return "personal";
}

function asVisibility(v: unknown, scope: ScopeKind): Visibility {
  if (v === "private" || v === "internal" || v === "shared") return v;
  // v2 defaults (§4): personal stays local, project is internal.
  return scope === "personal" ? "private" : "internal";
}

function asRole(v: unknown): MemoryRole {
  if (v === "knowledge" || v === "instruction") return v;
  return "knowledge";
}

function asImportance(v: unknown, priority: unknown): Importance {
  if (v === "low" || v === "normal" || v === "high") return v;
  // v1 `priority: N` → importance (§19): 1–3 low, 8–10 high, else normal.
  if (typeof priority === "number" && Number.isFinite(priority)) {
    if (priority <= 3) return "low";
    if (priority >= 8) return "high";
  }
  return "normal";
}

function asStatus(v: unknown): MemoryStatus {
  if (
    v === "active" ||
    v === "superseded" ||
    v === "deprecated" ||
    v === "retracted" ||
    v === "archived"
  )
    return v;
  return "active";
}

/**
 * Normalize raw (possibly v1) frontmatter into v2 shape. Lenient on read:
 * v1 files (epoch times, scope_kind, priority, type: instruction) are mapped
 * per §19 so old files keep working even before `migrate --to-v2` rewrites
 * them. Use `planConversion` in v2migrate.ts for the explicit, reporting
 * migration path.
 */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
): Frontmatter {
  const scope = asScopeKind(raw.scope, raw.scope_kind);
  let scopeKey =
    typeof raw.scope_key === "string" && raw.scope_key ? raw.scope_key : scope;
  if (scopeKey === "user") scopeKey = "personal"; // v1 storage dir → v2

  let type = typeof raw.type === "string" && raw.type ? raw.type : "fact";
  let role = asRole(raw.role);
  if (type === "instruction") {
    // §19: v1 `type: instruction` → content-kind + role split (D11).
    type = "knowledge";
    role = "instruction";
  }

  return {
    id: String(raw.id),
    schema_version: 2,
    scope_key: scopeKey,
    scope,
    visibility: asVisibility(raw.visibility, scope),
    project_name:
      typeof raw.project_name === "string" ? raw.project_name : scopeKey,
    type,
    role,
    importance: asImportance(raw.importance, raw.priority),
    status: asStatus(raw.status),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === "string")
      : [],
    ...(Array.isArray(raw.aliases) && normalizeAliases(raw.aliases).length > 0
      ? { aliases: normalizeAliases(raw.aliases) }
      : {}),
    source: typeof raw.source === "string" ? raw.source : "",
    created_at: msToRfc3339(timeToMs(raw.created_at)),
    updated_at: msToRfc3339(timeToMs(raw.updated_at)),
    supersedes:
      typeof raw.supersedes === "string" && raw.supersedes ? raw.supersedes : null,
    superseded_by:
      typeof raw.superseded_by === "string" && raw.superseded_by
        ? raw.superseded_by
        : null,
    review_state: asReviewState(raw.review_state),
    proposed_by:
      typeof raw.proposed_by === "string" && raw.proposed_by ? raw.proposed_by : null,
    approved_by:
      typeof raw.approved_by === "string" && raw.approved_by ? raw.approved_by : null,
    derived_from:
      typeof raw.derived_from === "string" && raw.derived_from ? raw.derived_from : null,
    review_note:
      typeof raw.review_note === "string" && raw.review_note ? raw.review_note : null,
    review_history: asReviewHistory(raw.review_history),
  };
}

/**
 * D61: normalize capture-time aliases — trim, drop empties, dedupe
 * (case-insensitive), cap at 4. Bad aliases are noise, never an error.
 * Shared by the tool ops, the CLI, and frontmatter parsing.
 */
export function normalizeAliases(input?: string[]): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of input) {
    const t = a.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

export function isTaxonomyType(t: string): boolean {
  return TAXONOMY.has(t);
}

export function serialize(fm: Frontmatter, body: string): string {
  // D61: an empty aliases list is noise in the file — omit the key entirely
  // (same convention as parse, which only sets it when non-empty).
  const out =
    fm.aliases && fm.aliases.length === 0 ? { ...fm, aliases: undefined } : fm;
  const yml = yaml.dump(out, { lineWidth: -1, quotingType: '"' });
  return `---\n${yml}---\n\n${body.trimEnd()}\n`;
}

/** Raw frontmatter parse (no normalization) — for migration tooling. */
export function parseRawFrontmatter(
  raw: string,
): { rawFm: Record<string, unknown>; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  try {
    const rawFm = yaml.load(m[1]!) as Record<string, unknown>;
    if (!rawFm || typeof rawFm !== "object" || !rawFm.id) return null;
    const body = (m[2] ?? "").replace(/^\n+/, "");
    return { rawFm, body };
  } catch {
    return null;
  }
}

export function parse(raw: string): { fm: Frontmatter; body: string } | null {
  const parsed = parseRawFrontmatter(raw);
  if (!parsed) return null;
  return { fm: normalizeFrontmatter(parsed.rawFm), body: parsed.body };
}

export function writeMemoryFile(
  fm: Frontmatter,
  body: string,
): { filePath: string; mtimeMs: number } {
  // 2B/D26: project drafts live in appdata (the outbox) — the in-repo dir
  // only ever holds submitted memories (proposed/approved/published).
  // Personal stays in appdata and never leaves the machine.
  const dir = memoriesDirFor(fm.scope_key);
  const filePath = path.join(dir, `${fm.id}.md`);
  // Atomic publish (D57): write a sibling tmp file and rename over the
  // target, so a concurrent reader (another process mid-sync) never sees a
  // torn half-written memory. Same-directory rename is atomic on one fs.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, serialize(fm, body), "utf8");
  fs.renameSync(tmpPath, filePath);
  const st = fs.statSync(filePath);
  return { filePath, mtimeMs: st.mtimeMs };
}

/** Yield `*.md` files in the in-repo dir (read path — never creates it). */
export function* iterInRepoMemoryFiles(
  root: string,
  memoryDir: string,
): Generator<string> {
  const dir = inRepoMemoriesDirPath(root, memoryDir);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".md")) yield path.join(dir, name);
  }
}

export function readMemoryFile(filePath: string): MemoryFile | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parse(raw);
  if (!parsed) return null;
  const st = fs.statSync(filePath);
  return { fm: parsed.fm, body: parsed.body, filePath, mtimeMs: st.mtimeMs };
}

export function* iterMemoryFiles(scopeKey: string): Generator<string> {
  const dir = memoriesDirPath(scopeKey);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".md")) yield path.join(dir, name);
  }
}
