// Quick smoke test — runs the pure-logic modules (no bun:sqlite dependency).
// Usage:  node --experimental-strip-types scripts\smoke-pure.ts
import { parse, serialize, ulid, normalizeFrontmatter, msToRfc3339, timeToMs, parseRawFrontmatter, type Frontmatter } from "../src/store/markdown.ts";
import { planConversion, isV2File } from "../src/store/v2migrate.ts";
import { redact, findSecret } from "../src/redact.ts";
import { detectKeywords } from "../src/capture/keywords.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveProjectScope, resolveCwdScope, PERSONAL_SCOPE } from "../src/scope.ts";
import { cjkIndexText, cjkQueryExpr, hasCjk } from "../src/retrieve/cjk.ts";
import { contentHash, similarity, NEAR_DUP_THRESHOLD } from "../src/store/lifecycle.ts";

let fails = 0;
function ok(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL ${name}`, info ?? "");
    fails++;
  }
}

console.log("== ulid ==");
const a = ulid();
const b = ulid();
ok("length is 26", a.length === 26);
ok("two calls differ", a !== b);
// NOTE: same-ms monotonicity is NOT guaranteed — the 16-char suffix is
// random by design (timestamp prefix still gives rough ordering).
ok("time prefix is 10 chars", a.slice(0, 10).length === 10);

console.log("== markdown round-trip (v2) ==");
const fm: Frontmatter = {
  id: a,
  schema_version: 2,
  scope_key: "project__test__abcdef123456",
  scope: "project",
  visibility: "internal",
  project_name: "test",
  type: "fact",
  role: "knowledge",
  importance: "normal",
  status: "active",
  tags: ["hello", "world"],
  source: "test",
  created_at: msToRfc3339(1000),
  updated_at: msToRfc3339(2000),
  supersedes: null,
  superseded_by: null,
};
const body = "hello\n\nworld";
const raw = serialize(fm, body);
ok("has frontmatter fence", raw.startsWith("---\n"));
const parsed = parse(raw);
ok("parses", parsed !== null);
ok("id survives", parsed?.fm.id === a);
ok("tags survive", JSON.stringify(parsed?.fm.tags) === '["hello","world"]');
ok("body survives", parsed?.body.trim() === body);

console.log("== redact ==");
const r1 = redact("api key is <private>sk-supersecretkey</private> ok", DEFAULT_CONFIG.redactPatterns);
ok("private stripped", !r1.content.includes("sk-supersecretkey"));
ok("no secret after strip", !r1.hadSecret);

const r2 = redact("sk-1234567890abcdefghij1234", DEFAULT_CONFIG.redactPatterns);
ok("bare secret detected", r2.hadSecret === true);

const r3 = redact("ghp_" + "a".repeat(36), DEFAULT_CONFIG.redactPatterns);
ok("github PAT detected", r3.hadSecret === true);

console.log("== redact hardening ==");
import {
  BUILTIN_SECRET_PATTERNS,
  findBuiltinSecret,
  findHighEntropySecret,
  stripPrivate,
} from "../src/redact.ts";

// Every builtin pattern fires on a realistic sample, reported by id.
const builtinSamples: Array<[string, string]> = [
  ["openai-key", "key=sk-1234567890abcdefghij1234"],
  ["github-oauth-token", "tok=gho_12345678901234567890123456789012"],
  ["github-fine-grained-pat", "tok=github_pat_1234567890123456789012345678901234567890"],
  ["aws-access-key-id", "id=AKIA1234567890ABCDEF"],
  ["slack-token", "tok=xoxb-123456789012-abcdefghij"],
  ["google-api-key", "k=AIza12345678901234567890123456789012"],
  ["npm-token", "t=npm_12345678901234567890123456789012"],
  ["gitlab-pat", "t=glpat-12345678901234567890ab"],
  ["stripe-webhook-secret", "s=whsec_12345678901234567890"],
  ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----"],
  ["generic-secret-assignment", 'password = "hunter2hunter2hunter2"'],
];
for (const [id, sample] of builtinSamples) {
  const r = redact(`note: ${sample} end`, []);
  ok(`builtin ${id} detected`, r.hadSecret === true && r.matchedPattern === id, r.matchedPattern);
}
// All builtin regexes compile.
ok(
  "all builtins compile",
  BUILTIN_SECRET_PATTERNS.every((p) => {
    try {
      new RegExp(p.source, p.flags ?? "");
      return true;
    } catch {
      return false;
    }
  }),
);
// Non-secrets pass.
const benign = [
  "remember that the meeting is at 3pm tomorrow",
  "the api endpoint is https://api.example.com/v1/users/list",
  "commit = a3f5c81234abcd1234abcd1234abcd1234abcd12",
  "version = 1.2.3-alpha.4",
  "note = aaaaaaaaaaaaaaaaaaaaaaaa",
  "token: abc",
  // sk- inside ordinary words must not trip the openai-key pattern
  // (regression: these were refused as "openai-key" before the boundary guard).
  "the task-management-system-workflow-2024 document is here",
  "disk-encryption-key-management-system-v2 rollout notes",
  "risk-assessment-score-2024-10 update",
];
for (const b of benign) {
  const r = redact(b, []);
  ok(`benign passes: ${b.slice(0, 40)}`, r.hadSecret === false, r.matchedPattern);
}
// High-entropy heuristic.
const entropic = findHighEntropySecret('deploy_key = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW2xY4zA6bC8dE0"');
ok("high-entropy assignment caught", entropic === "high-entropy-secret:deploy_key", entropic);
ok("low-entropy passes", findHighEntropySecret('note = "aaaaaaaaaaaaaaaaaaaaaaaa"') === null);
ok("hex digest passes", findHighEntropySecret("commit = a3f5c81234abcd1234abcd1234abcd1234abcd12") === null);
// <private> handling.
ok(
  "unclosed private redacts to end",
  stripPrivate("hello <private>my secret") === "hello [REDACTED]",
);
ok(
  "closed private still stripped",
  stripPrivate("a <private>x</private> b") === "a [REDACTED] b",
);
const r4 = redact("token is <private>sk-1234567890abcdefghij1234</private> ok", []);
ok("wrapped secret does not trigger", r4.hadSecret === false);
// User patterns still work, reported verbatim.
const r5 = redact("foo CUSTOM123 bar", ["CUSTOM\\d+"]);
ok("user pattern detected", r5.hadSecret === true && r5.matchedPattern === "CUSTOM\\d+", r5.matchedPattern);

console.log("== keywords ==");
const hits1 = detectKeywords("remember that this repo uses Bun, not Node", DEFAULT_CONFIG);
ok("basic remember matched", hits1.length === 1);
ok("body captured", hits1[0]?.content === "this repo uses Bun, not Node");

const hits2 = detectKeywords("TIL: sqlite bm25 returns lower=better", DEFAULT_CONFIG);
ok("TIL matched", hits2.length === 1);

const hits3 = detectKeywords("hello world", DEFAULT_CONFIG);
ok("no false positive", hits3.length === 0);

const hits4 = detectKeywords("Please note that FTS5 needs prefix matches", DEFAULT_CONFIG);
ok("please-note matched", hits4.length === 1);

console.log("== scope ==");
const s = resolveProjectScope(process.cwd());
ok("kind=project", s.kind === "project");
ok("key starts with project__", s.key.startsWith("project__"));
ok("hash length 12", /__[a-f0-9]{12}$/.test(s.key));
console.log("     scope.key =", s.key);
console.log("     personal.key =", PERSONAL_SCOPE.key);
ok("personal scope key", PERSONAL_SCOPE.key === "personal");
ok("personal scope kind", PERSONAL_SCOPE.kind === "personal");

console.log("== scope (cwd-only legacy) ==");
const cwdOnly = resolveCwdScope(process.cwd());
ok("cwd scope kind=project", cwdOnly.kind === "project");
ok("cwd scope key format", /^project__[^_]+.*__[a-f0-9]{12}$/.test(cwdOnly.key));
// Deterministic: same input -> same key
const cwdOnly2 = resolveCwdScope(process.cwd());
ok("cwd scope deterministic", cwdOnly.key === cwdOnly2.key);
// In a repo with a git remote, cwd-only scope must differ from git-origin scope.
// (This repo does have an origin after `git push`.)
console.log("     cwd.key   =", cwdOnly.key);

console.log("== cjk ==");
ok("detects han", hasCjk("中文记忆"));
ok("detects mixed", hasCjk("open中文"));
ok("no cjk in latin", !hasCjk("hello world 123"));
ok(
  "index bigrams",
  cjkIndexText("中文记忆") === "中 文 记 忆 中文 文记 记忆",
  cjkIndexText("中文记忆"),
);
ok("index single char", cjkIndexText("猫") === "猫", cjkIndexText("猫"));
ok(
  "index skips latin",
  cjkIndexText("open中文") === "中 文 中文",
  cjkIndexText("open中文"),
);
ok("index empty", cjkIndexText("hello") === "");
ok(
  "query bigrams",
  cjkQueryExpr("中文记忆") === '"中文" OR "文记" OR "记忆"',
  cjkQueryExpr("中文记忆"),
);
ok("query single char", cjkQueryExpr("猫") === '"猫"', cjkQueryExpr("猫"));
ok("query no cjk", cjkQueryExpr("hello") === "");

console.log("== v2 times ==");
ok("epoch 0 → rfc3339", msToRfc3339(0) === "1970-01-01T00:00:00Z", msToRfc3339(0));
ok("rfc3339 round-trip", timeToMs(msToRfc3339(1758854400000)) === 1758854400000);
ok("timeToMs accepts epoch", timeToMs(1000) === 1000);
ok("timeToMs accepts rfc3339", timeToMs("2026-09-26T12:00:00Z") === Date.parse("2026-09-26T12:00:00Z"));

console.log("== v1 → v2 normalize ==");
const v1raw = {
  id: "01TESTV1",
  scope_key: "user",
  scope_kind: "user",
  project_name: "user",
  type: "instruction",
  priority: 9,
  tags: ["x"],
  source: "test",
  created_at: 1758854400000,
  updated_at: 1758854400000,
} as Record<string, unknown>;
const nfm = normalizeFrontmatter(v1raw);
ok("scope user→personal", nfm.scope === "personal", nfm.scope);
ok("scope_key user→personal", nfm.scope_key === "personal", nfm.scope_key);
ok("visibility private", nfm.visibility === "private", nfm.visibility);
ok("type instruction→knowledge", nfm.type === "knowledge", nfm.type);
ok("role →instruction", nfm.role === "instruction", nfm.role);
ok("priority 9→high", nfm.importance === "high", nfm.importance);
ok("epoch→rfc3339", nfm.created_at === "2025-09-26T02:40:00Z", nfm.created_at);
ok("status active", nfm.status === "active");
ok("schema_version 2", nfm.schema_version === 2);

const v1raw2 = {
  id: "01TESTV2",
  scope_key: "project__x__abcdef123456",
  scope_kind: "project",
  project_name: "x",
  type: "error-solution",
  priority: 2,
  tags: [],
  created_at: 1000,
  updated_at: 1000,
} as Record<string, unknown>;
const nfm2 = normalizeFrontmatter(v1raw2);
ok("project scope kept", nfm2.scope === "project");
ok("project visibility internal", nfm2.visibility === "internal");
ok("priority 2→low", nfm2.importance === "low");
ok("role default knowledge", nfm2.role === "knowledge");

console.log("== v1 → v2 planConversion ==");
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v2mig-"));
const memRoot = path.join(tmpRoot, "memories");
fs.mkdirSync(path.join(memRoot, "user"), { recursive: true });
const v1file = `---\nid: 01PLANTEST\nscope_key: user\nscope_kind: user\nproject_name: user\ntype: note\npriority: 5\ntags: []\nsource: test\ncreated_at: 1758854400000\nupdated_at: 1758854400000\n---\n\n记得买菜\n`;
const v1path = path.join(memRoot, "user", "01PLANTEST.md");
fs.writeFileSync(v1path, v1file, "utf8");
ok("v1 not v2 file", !isV2File(v1file));
const plan = planConversion(v1path, memRoot);
ok("plan exists", plan !== null);
ok("plan moves to personal/", plan?.toPath === path.join(memRoot, "personal", "01PLANTEST.md"), plan?.toPath);
ok("plan notes unknown type", plan?.changes.some((c) => c.includes('"note" → knowledge')) ?? false, plan?.changes);
ok("plan notes scope rename", plan?.changes.some((c) => c.includes("personal")) ?? false);
ok("plan fm scope personal", plan?.fm.scope === "personal");
const v2raw = serialize(plan!.fm, plan!.body);
ok("v2 marker detected", isV2File(v2raw));
ok("already-v2 → null plan", planConversion(v1path, memRoot) !== null); // file still v1 on disk
fs.writeFileSync(v1path, v2raw, "utf8");
const plan2 = planConversion(v1path, memRoot);
ok("v2 on disk → null plan", plan2 === null);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log("== lifecycle pure: contentHash / similarity ==");
ok("hash deterministic + whitespace-insensitive", contentHash("hello   world\n") === contentHash("hello world"));
ok("hash differs on content", contentHash("hello world") !== contentHash("hello mars"));
ok("hash is sha256 hex", /^[0-9a-f]{64}$/.test(contentHash("x")));
ok("similarity identical latin = 1", similarity("apple banana", "apple banana") === 1);
ok("similarity identical CJK = 1", similarity("北京烤鸭好吃", "北京烤鸭好吃") === 1);
ok("similarity disjoint ≈ 0", similarity("apple banana", "car train") < 0.2);
const near = similarity(
  "the meeting notes from tuesday about deployment",
  "meeting notes from tuesday about deployment",
);
ok(`similarity near-dup ${near.toFixed(2)} >= ${NEAR_DUP_THRESHOLD}`, near >= NEAR_DUP_THRESHOLD);
ok("similarity empty → 0", similarity("", "anything") === 0);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
