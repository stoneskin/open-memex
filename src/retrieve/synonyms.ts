/**
 * Index-time synonym/translation expansion (D80).
 *
 * Stone's rule: solve vocabulary mismatch at write time, so any related
 * word finds the answer with a plain round-1 query. At sync/index time
 * every memory's keywords are expanded through a curated, checked-in
 * equivalence map and the variants are written into the indexed `aliases`
 * column (FTS + CJK bigram columns both pick them up via sync.ts). The
 * query side stays simple: one FTS round, no trigger, no second chance.
 *
 * Deliberately NOT an embedding model or an LLM call: deterministic,
 * auditable, zero dependencies, and the failure mode (a bad synonym)
 * is a visible line in this file, not a silent vector.
 *
 * Groups are bidirectional — any member expands to the other members.
 * Keep groups tight: an over-broad synonym costs precision on every
 * query, and at index time a bad entry pollutes every document instead
 * of one query. When in doubt, leave it out. A map update only reaches
 * already-indexed memories after a reindex.
 *
 * Design note (D80): the map covers the *precise* slice — EN↔ZH
 * translation pairs and dev-domain equivalents where embeddings are
 * fuzzy (ship/deploy are neighbors in vector space but "单点登录"/SSO
 * is an exact pair no embedding guarantees). Embeddings cover the
 * semantic long tail; this map covers what must never be missed.
 */

import { LATIN_STOPWORDS } from "./query.ts";

type Group = string[];

const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * Curated equivalence groups. EN dev-domain vocabulary, ZH equivalents,
 * and EN↔ZH translation pairs live in one bidirectional group: any member
 * expands to all the others, in either direction.
 */
const GROUPS: Group[] = [
  ["deploy", "ship", "release", "rollout", "publish", "部署", "发布", "上线"],
  ["test", "testing", "tests", "测试", "单测", "集成测试"],
  ["regression test", "回归测试"],
  ["rollback", "revert", "回滚", "撤回", "撤销", "回退"],
  ["incident", "outage", "postmortem", "故障", "事故", "宕机"],
  ["auth", "authentication", "login", "sso", "single sign-on", "单点登录", "登录"],
  ["secret", "secrets", "credential", "credentials", "token", "密钥"],
  ["database", "db", "数据库"],
  ["backup", "restore", "备份", "恢复"],
  ["retention", "保留"],
  ["production", "生产", "生产环境"],
  ["staging", "预发布环境", "预发布"],
  ["wipe", "wipes", "清空", "清除"],
  ["nightly", "night", "每晚"],
  ["thursday", "周四", "星期四"],
  ["mandatory", "强制", "必须"],
  ["flaky", "flake", "unreliable", "intermittent"],
  ["bug", "defect", "issue"],
  ["ci", "pipeline"],
  ["cache", "caching", "cached"],
  ["invalidate", "invalidation", "expire", "expiry"],
  ["oncall", "on-call", "pager"],
  ["migration", "migrate", "migrating"],
  ["index", "indexing", "indexed"],
  ["slow", "latency", "performance", "perf"],
  ["refactor", "refactoring"],
  ["merge", "merging"],
  ["branch", "branches"],
  ["commit", "commits"],
  ["review", "code review", "评审", "代码评审"],
  ["mock", "stub"],
  ["debug", "debugging", "troubleshoot", "troubleshooting"],
  ["log", "logs", "logging"],
  ["monitor", "monitoring", "alert", "alerting"],
  ["scale", "scaling"],
  ["timeout", "timeouts"],
  ["retry", "retries"],
  ["queue", "job", "worker"],
  ["api", "endpoint"],
  ["docker", "container", "image"],
  ["kubernetes", "k8s"],
  ["env", "environment"],
  ["config", "configuration", "setting", "settings"],
  ["hotfix", "hot fix"],
  ["estimate", "estimation"],
  ["乱码", "编码问题"],
  ["并发", "并行"],
  ["重构"],
  ["规范", "约定"],
];

const termLookup = new Map<string, string[]>();
const phraseEntries: Array<{ phrase: string; siblings: string[] }> = [];
const cjkEntries: Array<{ keys: string[]; siblings: string[] }> = [];

for (const g of GROUPS) {
  const cjkKeys = g.filter((m) => CJK_RE.test(m));
  if (cjkKeys.length > 0) cjkEntries.push({ keys: cjkKeys, siblings: [...g] });
  for (const m of g) {
    if (CJK_RE.test(m)) continue;
    const siblings = g.filter((x) => x !== m);
    if (m.includes(" ")) phraseEntries.push({ phrase: m.toLowerCase(), siblings });
    else termLookup.set(m.toLowerCase(), siblings);
  }
}

/**
 * Synonym variants for one lowercased Latin term (excluding the term
 * itself). Empty array when the term has no curated synonyms.
 */
export function synonymVariants(term: string): string[] {
  return termLookup.get(term.toLowerCase()) ?? [];
}

/** Cap on auto-generated variants per memory — bounds index growth. */
export const MAX_AUTO_VARIANTS = 32;

/**
 * Index-time expansion for one memory's text (body + tags). Keyword-
 * centric (Stone): extract content terms, expand each through the
 * curated map, return variants not already present in the text.
 * Pure logic — safe to unit test, runs once per memory at sync time.
 */
export function expansionVariantsForDoc(text: string): string[] {
  const lower = text.toLowerCase();
  // Content terms only: function words carry no signal (same filter the
  // query builder applies, so both sides agree on what a keyword is).
  const latinTokens = new Set(
    (lower.match(/[a-z0-9_.\-]+/g) ?? []).filter(
      (t) => t.length > 1 && !LATIN_STOPWORDS.has(t),
    ),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const key = v.toLowerCase();
    if (seen.has(key) || out.length >= MAX_AUTO_VARIANTS) return;
    seen.add(key);
    out.push(v);
  };
  // A variant is "already present" when the doc has it as a token (Latin),
  // as a substring (Latin phrase), or as a substring (CJK — no tokenizer).
  const present = (v: string): boolean =>
    CJK_RE.test(v)
      ? text.includes(v)
      : v.includes(" ")
        ? lower.includes(v.toLowerCase())
        : latinTokens.has(v.toLowerCase());

  for (const t of latinTokens) {
    for (const v of termLookup.get(t) ?? []) if (!present(v)) push(v);
  }
  for (const { phrase, siblings } of phraseEntries) {
    if (!lower.includes(phrase)) continue;
    for (const v of siblings) if (!present(v)) push(v);
  }
  for (const { keys, siblings } of cjkEntries) {
    if (!keys.some((k) => text.includes(k))) continue;
    for (const v of siblings) if (!present(v)) push(v);
  }
  return out;
}

/**
 * Expand a raw query string with synonym variants (legacy query-time
 * helper, kept for bench scripts). The product no longer expands at
 * query time — D80 moved expansion to the index.
 */
export function expandQueryWithSynonyms(q: string): string {
  const extra = new Set<string>();
  const latinTerms = q.toLowerCase().match(/[a-z0-9_.\-]+/g) ?? [];
  for (const t of latinTerms) {
    for (const s of synonymVariants(t)) extra.add(s);
  }
  for (const { keys, siblings } of cjkEntries) {
    if (keys.some((k) => q.includes(k))) {
      for (const s of siblings) extra.add(s);
    }
  }
  // Don't re-add terms already in the query.
  const have = new Set(latinTerms);
  const additions = [...extra].filter((s) => !have.has(s.toLowerCase()) && !q.includes(s));
  if (additions.length === 0) return q;
  return `${q} ${additions.join(" ")}`;
}
