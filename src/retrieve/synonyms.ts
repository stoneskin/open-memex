/**
 * Query-time synonym expansion (D79).
 *
 * Pure logic, no sqlite — same discipline as query.ts. A curated,
 * checked-in map: dev-domain vocabulary plus general equivalents, EN and
 * ZH. Used for the second-chance retrieval round (see search.ts): when
 * the first FTS pass returns fewer candidates than requested, the query
 * is re-run with synonym variants OR-ed in.
 *
 * Deliberately NOT an embedding model or an LLM call: deterministic,
 * auditable, zero dependencies, and the failure mode (a bad synonym)
 * is a visible line in this file, not a silent vector.
 *
 * Groups are bidirectional — any member expands to the other members.
 * Keep groups tight: an over-broad synonym ("sync" for meetings) costs
 * precision on every query. When in doubt, leave it out.
 */

type Group = string[];

/** English synonym groups (all lowercase; matched against lowered terms). */
const EN_GROUPS: Group[] = [
  ["deploy", "ship", "release", "rollout", "publish"],
  ["test", "testing", "tests"],
  ["flaky", "flake", "unreliable", "intermittent"],
  ["bug", "defect", "issue"],
  ["ci", "pipeline"],
  ["rollback", "revert"],
  ["cache", "caching", "cached"],
  ["invalidate", "invalidation", "expire", "expiry"],
  ["incident", "outage", "postmortem"],
  ["oncall", "on-call", "pager"],
  ["auth", "authentication", "login", "sso"],
  ["secret", "secrets", "credential", "credentials", "token"],
  ["migration", "migrate", "migrating"],
  ["index", "indexing", "indexed"],
  ["slow", "latency", "performance", "perf"],
  ["refactor", "refactoring"],
  ["merge", "merging"],
  ["branch", "branches"],
  ["commit", "commits"],
  ["review", "code review"],
  ["mock", "stub"],
  ["debug", "debugging", "troubleshoot", "troubleshooting"],
  ["log", "logs", "logging"],
  ["monitor", "monitoring", "alert", "alerting"],
  ["backup", "restore"],
  ["scale", "scaling"],
  ["timeout", "timeouts"],
  ["retry", "retries"],
  ["queue", "job", "worker"],
  ["api", "endpoint"],
  ["database", "db"],
  ["docker", "container", "image"],
  ["kubernetes", "k8s"],
  ["env", "environment"],
  ["config", "configuration", "setting", "settings"],
  ["hotfix", "hot fix"],
  ["estimate", "estimation"],
];

/** Chinese synonym groups (substring-matched against the raw query). */
const ZH_GROUPS: Group[] = [
  ["部署", "发布", "上线"],
  ["测试", "单测", "集成测试"],
  ["回滚", "撤回", "撤销"],
  ["故障", "事故", "宕机"],
  ["乱码", "编码问题"],
  ["并发", "并行"],
  ["重构"],
  ["评审", "代码评审"],
  ["规范", "约定"],
  ["回退", "回滚"],
];

const enLookup = new Map<string, string[]>();
for (const g of EN_GROUPS) {
  for (const m of g) enLookup.set(m, g.filter((x) => x !== m));
}

/**
 * Synonym variants for one lowercased Latin term (excluding the term
 * itself). Empty array when the term has no curated synonyms.
 */
export function synonymVariants(term: string): string[] {
  return enLookup.get(term.toLowerCase()) ?? [];
}

/**
 * Expand a raw query string with synonym variants: every EN term with
 * curated synonyms contributes its variants, and every ZH group key
 * found in the query contributes its siblings. Returns the query
 * unchanged when nothing expands (so the caller can skip round two).
 */
export function expandQueryWithSynonyms(q: string): string {
  const extra = new Set<string>();
  const latinTerms = q.toLowerCase().match(/[a-z0-9_.\-]+/g) ?? [];
  for (const t of latinTerms) {
    for (const s of synonymVariants(t)) extra.add(s);
  }
  for (const g of ZH_GROUPS) {
    if (g.some((m) => q.includes(m))) {
      for (const m of g) extra.add(m);
    }
  }
  // Don't re-add terms already in the query.
  const have = new Set(latinTerms);
  const additions = [...extra].filter((s) => !have.has(s.toLowerCase()) && !q.includes(s));
  if (additions.length === 0) return q;
  return `${q} ${additions.join(" ")}`;
}
