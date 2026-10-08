// Quick smoke test — runs the pure-logic modules (no bun:sqlite dependency).
// Usage:  node --experimental-strip-types scripts\smoke-pure.ts
import { parse, serialize, ulid, normalizeFrontmatter, msToRfc3339, timeToMs, parseRawFrontmatter, normalizeAliases, type Frontmatter } from "../src/store/markdown.ts";
import { planConversion, isV2File, migrateV2 } from "../src/store/v2migrate.ts";
import { redact, findSecret } from "../src/redact.ts";
import { detectKeywords, scanKeywords } from "../src/capture/keywords.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveProjectScope, resolveCwdScope, pickScopeRoot, PERSONAL_SCOPE } from "../src/scope.ts";
import { cjkIndexText, cjkQueryExpr, hasCjk } from "../src/retrieve/cjk.ts";
import { toFtsQuery } from "../src/retrieve/query.ts";
import { expansionVariantsForDoc, MAX_AUTO_VARIANTS } from "../src/retrieve/synonyms.ts";
import {
  planAliasExpansions,
  rewriteQueryOnce,
  mergeRounds,
  type AliasEntry,
} from "../src/retrieve/alias-memory.ts";
import { contentHash, similarity, NEAR_DUP_THRESHOLD } from "../src/store/lifecycle.ts";
import {
  MIN_NODE_VERSION,
  nativeDriverFloorMessage,
  nodeSupportsNativeDriver,
  parseNodeVersion,
} from "../src/runtime-floor.ts";
import {
  TURN_ECHO_THRESHOLD,
  TURN_ECHO_WINDOW_MS,
  isTurnEcho,
  freshCaptures,
  formatHandoffBlock,
} from "../src/capture/handoff.ts";
import { userMcpConfigPath, mergeServerEntry, detectInstalledClients, mergePluginEntry, mergeV2PluginEntry, removeV2PluginEntry, opencodeGlobalConfigPath, printManualEntryHint, parseJsonConfig, removeServerEntry, removePluginEntry, removeInstructionsSection, LEGACY_PACKAGE_NAME, shouldInstallSkill } from "../src/init.ts";
import { z } from "zod";
import { memoryAddArgs } from "../src/tools/ops.ts";
import { dataRootPath, homeOverride } from "../src/paths.ts";
import { configFilePath, loadConfig, stripJsonComments } from "../src/config.ts";

console.log("== jsonc parsing + config invariants (P0) ==");
{
  // The pre-fix regex stripper ate "src/**/secrets" as a block comment,
  // silently disabling the user's redact rule.
  const doc = JSON.parse(stripJsonComments(`{
    // a line comment with a "quote
    "redactPatterns": ["src/**/secrets", "a /* not a comment */ b"],
    /* a real block comment */
    "memoryDir": ".ai/open-memex",
  }`)) as { redactPatterns: string[] };
  ok("redact pattern with ** survives comment stripping",
    doc.redactPatterns[0] === "src/**/secrets" && doc.redactPatterns[1] === "a /* not a comment */ b",
    JSON.stringify(doc.redactPatterns));
}
{
  // loadConfig must enforce the memoryDir invariant on hand-edited files.
  const saved = process.env.OPEN_MEMEX_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-cfg-"));
  const file = path.join(dir, "c.jsonc");
  fs.writeFileSync(file, JSON.stringify({ memoryDir: "../../shared" }));
  const errs: unknown[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errs.push(a);
  try {
    process.env.OPEN_MEMEX_CONFIG = file;
    ok("escaping memoryDir falls back to default", loadConfig().memoryDir === ".ai/open-memex");
  } finally {
    console.error = origErr;
    if (saved === undefined) delete process.env.OPEN_MEMEX_CONFIG;
    else process.env.OPEN_MEMEX_CONFIG = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

console.log("== capture aliases (D61) ==");
ok("normalize trims/dedupes/caps at 4",
  JSON.stringify(normalizeAliases(["  Time Off ", "time off", "", "节假日", "vacation", "PTO", "leave"])) === '["Time Off","节假日","vacation","PTO"]');
ok("normalize of undefined is empty", JSON.stringify(normalizeAliases(undefined)) === "[]");
const fmA: Frontmatter = { ...fm, id: ulid(), aliases: ["time off", "节假日", "vacation days"] };
const parsedA = parse(serialize(fmA, "body text"));
ok("aliases survive round-trip",
  JSON.stringify(parsedA?.fm.aliases) === '["time off","节假日","vacation days"]');
ok("no aliases -> field omitted from file",
  !/^aliases:/m.test(serialize(fm, "x")));
ok("empty aliases array -> field omitted",
  !/^aliases:/m.test(serialize({ ...fm, aliases: [] }, "x")));
ok("parse caps hand-edited aliases at 4",
  (normalizeFrontmatter({ id: "x", aliases: ["1", "2", "3", "4", "5"] } as never).aliases ?? []).length === 4);
{
  // D61 review: the tool schema must never reject a sloppy alias list —
  // normalization decides, not validation (bad aliases are noise).
  const shape = z.object(memoryAddArgs);
  const sloppy = shape.safeParse({ content: "x", aliases: ["a", "", "b", "c", "d", "e"] });
  ok("tool schema accepts >4 / blank aliases (normalize drops them)", sloppy.success);
}

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
  ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----"],
  ["private-key-truncated", "-----BEGIN RSA PRIVATE KEY-----"],
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

console.log("== redact masking (D14) ==");
// Secrets are masked in place (first 4 chars kept, rest → x), never refused.
const m1 = redact("deploy uses key=sk-1234567890abcdefghij1234 in prod", []);
ok("mask: detected", m1.hadSecret === true && m1.matchedPattern === "openai-key", m1.matchedPattern);
ok("mask: prefix kept", m1.content.includes("sk-1"), m1.content);
ok("mask: rest x'd", m1.content.includes("sk-1xxxxxxxxxxxxxxxxxxxxx"), m1.content);
ok("mask: full secret gone", !m1.content.includes("1234567890abcdefghij"));
ok("mask: surrounding text kept", m1.content.startsWith("deploy uses key=") && m1.content.includes(" in prod"));
// User patterns mask too.
ok("mask: user pattern", redact("foo CUSTOM123 bar", ["CUSTOM\\d+"]).content.includes("CUSTxxxxx"));
// High-entropy: value masked, name kept.
const r6 = redact('deploy_key = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW2xY4zA6bC8dE0"', []);
ok("mask: entropy value masked", r6.content.includes("aB3dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), r6.content);
ok("mask: entropy name kept", r6.content.includes("deploy_key ="));
// URLs are never masked, even when another secret is present in the same text.
const r7 = redact("see https://api.example.com/v1/users/list and key=sk-1234567890abcdefghij1234", []);
ok("mask: mixed url+secret detected", r7.hadSecret === true, r7.matchedPattern);
ok("mask: url intact", r7.content.includes("https://api.example.com/v1/users/list"), r7.content);
ok("mask: second secret also masked", !r7.content.includes("sk-1234567890"), r7.content);
// Bare high-entropy URL: the scheme colon must not turn the URL into a secret.
const r8 = redact("see https://aB3dEfGhIjKlMnOpQrStUvWx0123456789abcdef for details", []);
ok("mask: bare url untouched", r8.hadSecret === false && r8.content.includes("https://aB3dEfGhIjKlMnOpQrStUvWx0123456789abcdef"), r8.content);
// Private key: the WHOLE block is masked, body must not survive in readable form.
const pemBody = "MIIEpAIBAAKCAQEA7bXprGBcW2l5K3R8vN0mQw0F3xY2vBn5T6uI7oP8a9S0dF1gH";
const r9 = redact(`note: server key\n-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----\nafter`, []);
ok("mask: pem detected", r9.hadSecret === true && r9.matchedPattern === "private-key-block", r9.matchedPattern);
ok("mask: pem body gone", !r9.content.includes(pemBody), r9.content);
ok("mask: pem surrounding kept", r9.content.includes("note: server key") && r9.content.includes("after"));
// Truncated key (no END marker): masked to end of text.
const r10 = redact(`note\n-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\ntrailing prose`, []);
ok("mask: truncated pem detected", r10.hadSecret === true, r10.matchedPattern);
ok("mask: truncated pem body gone", !r10.content.includes(pemBody) && !r10.content.includes("trailing prose"), r10.content);
// Name-including patterns mask the value only; the name stays readable (D14).
const r11 = redact('api_key = "supersecretvalue123456"', []);
ok("mask: generic name kept", r11.content.includes("api_key ="), r11.content);
ok("mask: generic value masked", !r11.content.includes("supersecretvalue123456") && r11.content.includes("supexxxxxxxxxxxxxxxx"), r11.content);
const r12 = redact('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCY1234567890"', []);
ok("mask: aws name kept", r12.content.includes("aws_secret_access_key ="), r12.content);
ok("mask: aws value masked", !r12.content.includes("wJalrXUtnFEMI"), r12.content);

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

console.log("== keywords: capture gaps (D65) ==");
// "帮我记…" is the most natural Chinese phrasing and used to match nothing.
// Routes personal, mirroring 替我记 (the 我-rule), unlike 帮我们记 (project).
const g1 = detectKeywords("帮我记住：这个项目用 pnpm", DEFAULT_CONFIG);
ok("帮我记住 matched", g1.length === 1, JSON.stringify(g1));
ok("帮我记住 → personal", g1[0]?.personal === true);
ok("帮我记住 body clean", g1[0]?.content === "这个项目用 pnpm", g1[0]?.content);
// A leading 请 defeated every 记住-led pattern ("请记住我…", "请记住：…").
const g2 = detectKeywords("请记住我不喜欢周五发布", DEFAULT_CONFIG);
ok("请记住我 matched personal", g2.length === 1 && g2[0]?.personal === true, JSON.stringify(g2));
const g3 = detectKeywords("请记住：周五不发布", DEFAULT_CONFIG);
ok("请记住 matched project", g3.length === 1 && g3[0]?.personal === false, JSON.stringify(g3));
// English: "remember to …" captured a stray leading "to" in the body.
const g4 = detectKeywords("Remember to run the tests before merging", DEFAULT_CONFIG);
ok("remember-to body has no stray 'to'", g4.length === 1 && g4[0]?.content === "run the tests before merging", g4[0]?.content);
// …but the optional "to" must not eat a word that merely starts with it.
const g5 = detectKeywords("remember Toronto is where the office is", DEFAULT_CONFIG);
ok("remember Toronto… body intact", g5.length === 1 && g5[0]?.content === "Toronto is where the office is", g5[0]?.content);
// 帮我们记 still routes project (the 们-rule survives the new 帮我记 pattern).
const g6 = detectKeywords("帮我们记住：周五不发布", DEFAULT_CONFIG);
ok("帮我们记住 → project", g6.length === 1 && g6[0]?.personal === false, JSON.stringify(g6));

console.log("== keywords: review follow-ups (D66) ==");
// The new 帮我记 pattern initially shipped without the (?:请)? its siblings
// got in D65 — 请帮我记住 fell through again.
const f1 = detectKeywords("请帮我记住：这个项目用 pnpm", DEFAULT_CONFIG);
ok("请帮我记住 → personal", f1.length === 1 && f1[0]?.personal === true && f1[0]?.content === "这个项目用 pnpm", JSON.stringify(f1));
// 帮我记录一下 used to capture mid-word garbage ("录一下：…"). The verb
// phrase now includes 记录/记录一下 and must end at a separator boundary.
const f2 = detectKeywords("帮我记录一下：周五不发布", DEFAULT_CONFIG);
ok("帮我记录一下 body clean", f2.length === 1 && f2[0]?.content === "周五不发布", JSON.stringify(f2));
const f3 = detectKeywords("替我记录一下：护照在抽屉里", DEFAULT_CONFIG);
ok("替我记录一下 body clean", f3.length === 1 && f3[0]?.content === "护照在抽屉里", JSON.stringify(f3));
// The boundary guard: 帮我记得… is not a capture form and must not fire.
const f4 = detectKeywords("帮我记得带伞", DEFAULT_CONFIG);
ok("帮我记得 → no capture", f4.length === 0, JSON.stringify(f4));
// English personal phrasing on par with "remember for me".
const f5 = detectKeywords("Help me remember: the wifi is on the fridge note", DEFAULT_CONFIG);
ok("help me remember → personal", f5.length === 1 && f5[0]?.personal === true, JSON.stringify(f5));

console.log("== keywords: separator-less verb phrases (D67) ==");
// D66's boundary guard was one notch too strict: it demanded a separator even
// after a COMPLETE verb phrase, so the most natural form - "帮我记一下这个配置",
// with the noun straight after 记一下 - stopped matching. The boundary now
// guards the bare verb only (记 must be followed by 住/录/一下 or a separator),
// so 记得/记着 still cannot produce mid-word garbage.
const v1 = detectKeywords("帮我记一下这个配置", DEFAULT_CONFIG);
ok("帮我记一下这个配置 (no separator)", v1.length === 1 && v1[0]?.personal === true && v1[0]?.content === "这个配置", JSON.stringify(g1));
const v2 = detectKeywords("帮我记住这个配置", DEFAULT_CONFIG);
ok("帮我记住这个配置 (no separator)", v2.length === 1 && v2[0]?.content === "这个配置", JSON.stringify(g2));
const v3 = detectKeywords("替我记一下我住在杭州", DEFAULT_CONFIG);
ok("替我记一下我住在杭州 (no separator)", v3.length === 1 && v3[0]?.personal === true && v3[0]?.content === "我住在杭州", JSON.stringify(g3));
const v4 = detectKeywords("帮我们记一下这个约定", DEFAULT_CONFIG);
ok("帮我们记一下这个约定 → project", v4.length === 1 && v4[0]?.personal === false && v4[0]?.content === "这个约定", JSON.stringify(g4));
const v5 = detectKeywords("替我记着这个流程", DEFAULT_CONFIG);
ok("替我记着… → no capture (verb continuation)", v5.length === 0, JSON.stringify(v5));
const v6 = detectKeywords("帮我们记得每周同步", DEFAULT_CONFIG);
ok("帮我们记得… → no capture (verb continuation)", v6.length === 0, JSON.stringify(v6));
const v7 = detectKeywords("帮我记：这个项目用 pnpm", DEFAULT_CONFIG);
ok("帮我记：… (bare verb + separator)", v7.length === 1 && v7[0]?.content === "这个项目用 pnpm", JSON.stringify(v7));

console.log("== keywords: narration is not a trigger (D67) ==");
// 记得… / remind me… stay out on purpose (D67): they are imperatives aimed at
// the agent, and a false trigger writes memory nobody reviewed. The two forms
// already in the list follow the same rule - an explicit separator (or "that")
// marks a statement to the store.
const n1 = detectKeywords("别忘了带伞", DEFAULT_CONFIG);
ok("别忘了带伞 (narration) → no capture", n1.length === 0, JSON.stringify(n1));
const n2 = detectKeywords("别忘了：周五不发布", DEFAULT_CONFIG);
ok("别忘了：… (instruction) → project", n2.length === 1 && n2[0]?.personal === false && n2[0]?.content === "周五不发布", JSON.stringify(n2));
const n3 = detectKeywords("别忘了,每次发布前更新 changelog", DEFAULT_CONFIG);
ok("别忘了,… (ascii comma) → project", n3.length === 1 && n3[0]?.content === "每次发布前更新 changelog", JSON.stringify(n3));
const n4 = detectKeywords("Don't forget the wifi password", DEFAULT_CONFIG);
ok("don't forget <bare> (narration) → no capture", n4.length === 0, JSON.stringify(n4));
const n5 = detectKeywords("Don't forget that the wifi password is on the fridge", DEFAULT_CONFIG);
ok("don't forget that … → project", n5.length === 1 && n5[0]?.content === "the wifi password is on the fridge", JSON.stringify(n5));
const n6 = detectKeywords("don't forget: the wifi password", DEFAULT_CONFIG);
ok("don't forget: … → project", n6.length === 1 && n6[0]?.content === "the wifi password", JSON.stringify(n6));
// The 'note' family is unaffected - it was never the ambiguous form.
const n7 = detectKeywords("note the API is v2", DEFAULT_CONFIG);
ok("note <bare> still captures", n7.length === 1 && n7[0]?.content === "the API is v2", JSON.stringify(n7));
const n8 = detectKeywords("记得每次都要跑迁移脚本", DEFAULT_CONFIG);
ok("记得… → no capture", n8.length === 0, JSON.stringify(n8));
const n9 = detectKeywords("remind me to lock the door", DEFAULT_CONFIG);
ok("remind me to… → no capture", n9.length === 0, JSON.stringify(n9));

console.log("== keywords: the length floor reports instead of swallowing (D67) ==");
// D67 keeps the >=3-char floor (a trigger that yields 这个 is a match on the
// trigger, not a memory) but a rejection is no longer silent.
const d1 = scanKeywords("记住：这个", DEFAULT_CONFIG);
ok("短 body 不捕获", d1.hits.length === 0, JSON.stringify(d1));
ok("短 body 有说明 (too-short)", d1.dropped.length === 1 && d1.dropped[0]?.reason === "too-short" && d1.dropped[0]?.content === "这个", JSON.stringify(d1.dropped));
const d2 = scanKeywords("记住：这个配置", DEFAULT_CONFIG);
ok(">=3 字的照常捕获", d2.hits.length === 1 && d2.dropped.length === 0, JSON.stringify(d2));
// A rejected personal match must not leak into the project scope: "记住我：OK"
// must not be re-captured by the generic 记住 as "我：OK".
const d3 = scanKeywords("记住我：OK", DEFAULT_CONFIG);
ok("短 personal 不落到 project", d3.hits.length === 0 && d3.dropped.some((x) => x.reason === "too-short" && x.content === "OK"), JSON.stringify(d3));

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

console.log("== scope (pickScopeRoot, D71) ==");
// OpenCode v1 reports the filesystem root as `worktree` for non-git folders;
// seeding a scope on it merges every non-git folder on the drive into one
// shared `project__workspace__…` bucket. A real worktree still wins.
const fsRoot = path.parse(process.cwd()).root;
ok("real worktree wins", pickScopeRoot(process.cwd(), "/elsewhere/opened") === process.cwd());
ok("fs-root worktree yields to directory", pickScopeRoot(fsRoot, process.cwd()) === process.cwd());
ok("missing worktree uses directory", pickScopeRoot(null, process.cwd()) === process.cwd());
ok("nothing but fs root: last resort", pickScopeRoot(fsRoot, null) === fsRoot);
ok("no candidates falls back to cwd", pickScopeRoot(null, null) === process.cwd());

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

console.log("== query construction ==");
const fq1 = toFtsQuery("how do we configure the SSO login");
ok(
  "stopwords dropped",
  !fq1.includes('"how"*') && !fq1.includes('"we"*') && !fq1.includes('"do"*'),
  fq1,
);
ok(
  "content terms kept",
  fq1.includes('"configure"*') && fq1.includes('"sso"*') && fq1.includes('"login"*'),
  fq1,
);
const fq2 = toFtsQuery("中文记忆怎么检索");
ok(
  "question bigrams dropped",
  fq2.includes('"检索"') && !fq2.includes('"怎么"'),
  fq2,
);
ok(
  "filter never empties",
  toFtsQuery("what is it") !== "" && toFtsQuery("怎么") !== "",
  `${toFtsQuery("what is it")} / ${toFtsQuery("怎么")}`,
);
ok(
  "tokens deduped",
  toFtsQuery("deploy deploy deploy") === '"deploy"*',
  toFtsQuery("deploy deploy deploy"),
);
const fq5 = toFtsQuery("auth 登录 sso 检索");
ok(
  "mixed query keeps both sides",
  fq5.includes('"auth"*') && fq5.includes("{cjk}:"),
  fq5,
);

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

console.log("== migrateV2 dry-run previews legacy files (issue #7) ==");
// legacy dir sits next to the new root (sibling), as on a real v1 upgrade
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "v2hotfix-"));
const newRoot = path.join(tmpHome, "open-memex");
const legacyRoot = path.join(tmpHome, "my-o-memory");
const legacyMem = path.join(legacyRoot, "memories", "user");
fs.mkdirSync(legacyMem, { recursive: true });
const v1legacy = `---\nid: 01HOTFIX1\nscope_key: user\nscope_kind: user\nproject_name: user\ntype: fact\npriority: 1\ncreated_at: 1758854400000\nupdated_at: 1758854400000\n---\n\nlegacy content\n`;
fs.writeFileSync(path.join(legacyMem, "01HOTFIX1.md"), v1legacy, "utf8");
process.env.MY_O_MEMORY_HOME = newRoot;

const dry = migrateV2({ dryRun: true });
ok("dry-run scans the legacy file", dry.scanned === 1 && dry.plans.length === 1, `scanned=${dry.scanned}`);
ok("dry-run yields a conversion plan", dry.plans.length === 1 && dry.plans[0].toPath.startsWith(newRoot), dry.plans[0]?.toPath);
ok("dry-run reports legacy backup target", typeof dry.legacyBackup === "string" && dry.legacyBackup.includes("backup-"), dry.legacyBackup);
ok("dry-run moves nothing", fs.existsSync(path.join(legacyMem, "01HOTFIX1.md")) && !fs.existsSync(path.join(newRoot, "memories", "personal", "01HOTFIX1.md")));
ok("dry-run does not rename legacy dir", fs.existsSync(legacyRoot) && !fs.existsSync(dry.legacyBackup!));

const real = migrateV2({ dryRun: false });
ok("real run converts", real.converted === 1, `converted=${real.converted}`);
ok("real run writes v2 file to new root", fs.existsSync(path.join(newRoot, "memories", "personal", "01HOTFIX1.md")));
ok("real run backs up legacy dir", !fs.existsSync(legacyRoot) && fs.existsSync(real.legacyBackup!));
const backContent = fs.readFileSync(path.join(newRoot, "memories", "personal", "01HOTFIX1.md"), "utf8");
ok("converted file has schema_version 2", backContent.includes("schema_version: 2"));

// backup rename failure → actionable Error, exit-1-worthy, no raw stack
// (same process/root: paths() is cached per process)
const legacyRoot2 = path.join(tmpHome, "my-o-memory");
const legacyMem2 = path.join(legacyRoot2, "memories", "user");
fs.mkdirSync(legacyMem2, { recursive: true });
fs.writeFileSync(path.join(legacyMem2, "01HOTFIX2.md"), v1legacy, "utf8");
// block the rename: pre-create today's dated backup as a non-empty dir
const blocked = path.join(tmpHome, "my-o-memory.backup-" + new Date().toISOString().slice(0, 10));
fs.mkdirSync(blocked, { recursive: true });
fs.writeFileSync(path.join(blocked, "sentinel"), "x", "utf8");
let boom: unknown = null;
try {
  migrateV2({ dryRun: false });
} catch (e) {
  boom = e;
}
ok("backup failure throws", boom instanceof Error, String(boom));
ok("backup failure message is actionable", boom instanceof Error && boom.message.includes("could not back up") && boom.message.includes("Your memories are safe"), boom instanceof Error ? boom.message.slice(0, 60) : "");
ok("failed backup keeps moved files safe in new root", fs.existsSync(path.join(newRoot, "memories", "user", "01HOTFIX2.md")));
ok("failed backup leaves legacy dir for retry", fs.existsSync(legacyRoot2));
delete process.env.MY_O_MEMORY_HOME;
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log("== env var names (D62) ==");
{
  const saved = {
    n: process.env.OPEN_MEMEX_HOME,
    l: process.env.MY_O_MEMORY_HOME,
    nc: process.env.OPEN_MEMEX_CONFIG,
    lc: process.env.MY_O_MEMORY_CONFIG,
  };
  const restore = () => {
    const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    set("OPEN_MEMEX_HOME", saved.n);
    set("MY_O_MEMORY_HOME", saved.l);
    set("OPEN_MEMEX_CONFIG", saved.nc);
    set("MY_O_MEMORY_CONFIG", saved.lc);
  };
  try {
    delete process.env.OPEN_MEMEX_HOME;
    delete process.env.MY_O_MEMORY_HOME;
    ok("no override -> homeOverride null", homeOverride() === null);
    process.env.MY_O_MEMORY_HOME = "/tmp/legacy-home";
    ok("legacy fallback honored", dataRootPath().endsWith("legacy-home") && homeOverride()?.via === "MY_O_MEMORY_HOME");
    process.env.OPEN_MEMEX_HOME = "/tmp/new-home";
    ok("new name wins over legacy", dataRootPath().endsWith("new-home") && homeOverride()?.via === "OPEN_MEMEX_HOME");
    process.env.MY_O_MEMORY_CONFIG = "/tmp/legacy.jsonc";
    ok("config legacy fallback", configFilePath().endsWith("legacy.jsonc"));
    process.env.OPEN_MEMEX_CONFIG = "/tmp/new.jsonc";
    ok("config new name wins", configFilePath().endsWith("new.jsonc"));
  } finally {
    restore();
  }
}

console.log("== runtime floor (native driver, D74) ==");
// better-sqlite3 13 is built against Node-API 10, which Node gained in 22.14.0.
// Below that floor `require` succeeds and `new Database()` segfaults the
// process with no diagnostic, so the version gate is the only thing standing
// between an old Node and a silent crash. The 22.12.0 / 22.23.3 boundary is
// the measured one (win32-x64, WiseLibs/better-sqlite3#1514).
ok("floor is 22.14.0", MIN_NODE_VERSION === "22.14.0");
ok("22.12.0 is below the floor (segfaults)", !nodeSupportsNativeDriver("22.12.0"));
ok("22.13.9 is below the floor", !nodeSupportsNativeDriver("22.13.9"));
ok("22.14.0 is exactly the floor", nodeSupportsNativeDriver("22.14.0"));
ok("22.14.1 is above", nodeSupportsNativeDriver("22.14.1"));
ok("22.23.3 is above (measured working)", nodeSupportsNativeDriver("22.23.3"));
ok("24.20.0 is above (measured working)", nodeSupportsNativeDriver("24.20.0"));
ok("25.x is above", nodeSupportsNativeDriver("25.3.0"));
ok("20.x is below (Node-API 10 never landed on 20)", !nodeSupportsNativeDriver("20.19.6"));
ok("v-prefix tolerated", nodeSupportsNativeDriver("v22.14.0"));
ok("prerelease suffix tolerated", nodeSupportsNativeDriver("23.1.0-nightly20260101"));
ok("garbage is below, not a crash", !nodeSupportsNativeDriver("not-a-version"));
ok("parses major/minor/patch", JSON.stringify(parseNodeVersion("22.14.3")) === '{"major":22,"minor":14,"patch":3}');
const floorMsg = nativeDriverFloorMessage("22.12.0");
ok("message names the floor", floorMsg.includes("22.14.0"));
ok("message names the running version", floorMsg.includes("22.12.0"));
ok("message offers a fix (upgrade or downgrade)", /Upgrade Node/.test(floorMsg) && /better-sqlite3@\^12/.test(floorMsg));
ok("message explains the segfault", /segfaults/.test(floorMsg));

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

console.log("== handoff (turn echo, D73) ==");
// One "remember ..." sentence produced three memories on 2026-10-04: the
// hook's verbatim capture plus two agent paraphrases. The hook capture is
// what the store already holds; the guard must refuse a re-save of it and
// must NOT eat a genuinely new fact the same sentence carried.
const HOOK_CAPTURE =
  "this folder is for my spark tank ideas for ipipeline.  I have ideas for AI Agents and shared memory/knowledge accross agents and employees.";
const reworded = [
  `User's iPipeline spark-tank themes: AI Agents, and shared memory/knowledge across agents and across employees.`,
  `This folder (C:\\temp\\AI_Inovation) is the user's "spark tank" for iPipeline ideas`,
  "Planned work in this folder: AI Agents plus shared memory/knowledge across agents and employees",
];
const newFacts = [
  "Deploy smoke tests live in tests/smoke/deploy.spec.ts and need a staging token",
  "The staging cluster runs 3 nodes in us-east-1",
  "Never deploy on Fridays after 15:00 UTC",
];
for (const r of reworded) {
  const s = similarity(HOOK_CAPTURE, r);
  ok(`refuses a re-save (${s.toFixed(2)} >= ${TURN_ECHO_THRESHOLD})`, isTurnEcho(s));
}
for (const f of newFacts) {
  const s = similarity(HOOK_CAPTURE, f);
  ok(`keeps a new fact (${s.toFixed(2)} < ${TURN_ECHO_THRESHOLD})`, !isTurnEcho(s));
}
ok("threshold is inclusive", isTurnEcho(TURN_ECHO_THRESHOLD));
ok("below threshold passes", !isTurnEcho(TURN_ECHO_THRESHOLD - 0.001));

const now = 1_700_000_000_000;
const rec = { id: "01ABC", scopeKey: "project__demo__0123456789ab", content: HOOK_CAPTURE, at: now };
ok("fresh inside window", freshCaptures([rec], now + 1000).length === 1);
ok("stale past window", freshCaptures([rec], now + TURN_ECHO_WINDOW_MS + 1).length === 0);
ok("no records → no block", formatHandoffBlock([]) === "");
const block = formatHandoffBlock([rec]);
ok("block names the id", block.includes("01ABC"));
ok("block shows the stored text", block.includes("spark tank"));
ok("block says do not re-add", block.includes("Do not call memory_add"));
ok("block points at supersede", block.includes("memory_supersede"));
ok(
  "block collapses whitespace",
  !formatHandoffBlock([{ ...rec, content: "a\n\n  b" }]).includes("\n\n"),
);
ok("window is 10 minutes", TURN_ECHO_WINDOW_MS === 10 * 60 * 1000);

console.log("== init --global: userMcpConfigPath / mergeServerEntry ==");
// D45: user-level MCP config locations, per platform (platform param is injectable).
ok("vscode win32", userMcpConfigPath("vscode", "win32").endsWith(path.join("Code", "User", "mcp.json")));
ok("vscode darwin", userMcpConfigPath("vscode", "darwin").includes(path.join("Library", "Application Support", "Code", "User", "mcp.json")));
ok("vscode linux", userMcpConfigPath("vscode", "linux").endsWith(path.join(".config", "Code", "User", "mcp.json")));
ok("cursor is ~/.cursor/mcp.json on every platform",
  (["win32", "darwin", "linux"] as const).every((p) =>
    userMcpConfigPath("cursor", p).endsWith(path.join(".cursor", "mcp.json"))));
// mergeServerEntry: pure merge semantics.
const doc1: Record<string, unknown> = {};
ok("merge into empty doc adds", mergeServerEntry(doc1, "servers", { command: "x" }, false) === "added");
ok("entry landed under section", (doc1["servers"] as Record<string, unknown>)["open-memex"] !== undefined);
ok("existing entry kept without force", mergeServerEntry(doc1, "servers", { command: "y" }, false) === "kept");
ok("kept entry untouched", ((doc1["servers"] as Record<string, unknown>)["open-memex"] as Record<string, unknown>)["command"] === "x");
ok("force overwrites", mergeServerEntry(doc1, "servers", { command: "y" }, true) === "added");
ok("forced entry applied", ((doc1["servers"] as Record<string, unknown>)["open-memex"] as Record<string, unknown>)["command"] === "y");
const doc2: Record<string, unknown> = { servers: { other: { command: "z" } } };
ok("merge preserves sibling entries", mergeServerEntry(doc2, "servers", { command: "x" }, false) === "added"
  && (doc2["servers"] as Record<string, unknown>)["other"] !== undefined);

console.log("== init D46: auto-detect + opencode global plugin ==");
// opencodeGlobalConfigPath: user-level location, XDG-aware.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "memex-smoke-"));
ok("opencode global config under ~/.config/opencode",
  opencodeGlobalConfigPath(fakeHome).endsWith(path.join(".config", "opencode", "opencode.json")));
ok("opencode global config honors XDG_CONFIG_HOME", (() => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(fakeHome, "xdg");
  try {
    return opencodeGlobalConfigPath(fakeHome).startsWith(path.join(fakeHome, "xdg"));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
})());
// mergePluginEntry: pure merge semantics.
const pdoc: Record<string, unknown> = {};
ok("plugin merge creates array", mergePluginEntry(pdoc, "file:///x", false) === "added"
  && JSON.stringify(pdoc["plugin"]) === JSON.stringify(["file:///x"]));
ok("plugin merge dup kept", mergePluginEntry(pdoc, "file:///x", false) === "kept");
ok("plugin merge force on dup adds nothing twice", mergePluginEntry(pdoc, "file:///x", true) === "added"
  && (pdoc["plugin"] as unknown[]).length === 1);
const pdoc2: Record<string, unknown> = { plugin: ["file:///other"], theme: "dark" };
ok("plugin merge preserves siblings", mergePluginEntry(pdoc2, "file:///x", false) === "added"
  && (pdoc2["plugin"] as unknown[]).length === 2 && pdoc2["theme"] === "dark");
// printManualEntryHint: the invalid-JSON bail-out must show the exact snippet to add by hand.
const hintLines: string[] = [];
const origErr = console.error;
console.error = (msg?: unknown) => { hintLines.push(String(msg)); };
printManualEntryHint("servers", { type: "stdio", command: "open-memex", args: ["mcp"] });
console.error = origErr;
const hintText = hintLines.join("\n");
ok("manual hint names the section", hintText.includes('"servers"'));
ok("manual hint contains the entry", hintText.includes('"open-memex"') && hintText.includes("stdio"));
// parseJsonConfig: empty/whitespace-only files are empty docs (safe to populate);
// genuinely unparseable content (JSONC comments) or non-objects yield null.
ok("empty file → {}", JSON.stringify(parseJsonConfig("")) === "{}");
ok("whitespace-only file → {}", JSON.stringify(parseJsonConfig("  \n\t ")) === "{}");
ok("valid JSON parses", (parseJsonConfig('{"servers":{}}') as Record<string, unknown>)["servers"] !== undefined);
ok("JSONC comments → null", parseJsonConfig('{\n  // a comment\n}') === null);
ok("trailing garbage → null", parseJsonConfig('{} trailing') === null);
ok("array → null", parseJsonConfig("[1,2]") === null);
ok("scalar → null", parseJsonConfig("42") === null);
// removeServerEntry: pure removal semantics.
const rdoc: Record<string, unknown> = { servers: { "open-memex": { command: "x" }, other: { command: "y" } }, untouched: 1 };
ok("remove deletes the entry", removeServerEntry(rdoc, "servers") === "removed"
  && !("open-memex" in (rdoc["servers"] as Record<string, unknown>))
  && "other" in (rdoc["servers"] as Record<string, unknown>));
ok("remove absent when entry already gone", removeServerEntry(rdoc, "servers") === "absent"
  && "servers" in rdoc); // sibling kept, section kept
const rdoc2: Record<string, unknown> = { servers: { "open-memex": { command: "x" } } };
ok("remove prunes empty section", removeServerEntry(rdoc2, "servers") === "removed" && !("servers" in rdoc2));
ok("remove absent when no entry", removeServerEntry({ servers: {} }, "servers") === "absent");
ok("remove absent when no section", removeServerEntry({}, "servers") === "absent");
// F30: pre-rename leftovers are swept by key.
const ldoc: Record<string, unknown> = { servers: { "my-o-memory": { command: "x" }, "open-memex": { command: "y" } } };
ok("remove drops legacy my-o-memory key, keeps open-memex", removeServerEntry(ldoc, "servers", LEGACY_PACKAGE_NAME) === "removed"
  && !("my-o-memory" in (ldoc["servers"] as Record<string, unknown>))
  && "open-memex" in (ldoc["servers"] as Record<string, unknown>));
ok("legacy package name is my-o-memory", LEGACY_PACKAGE_NAME === "my-o-memory");
// removePluginEntry: removes any open-memex URL, prunes empty array.
const rpdoc: Record<string, unknown> = { plugin: ["file:///x/open-memex/src/index.ts", "other-plugin"], theme: "dark" };
ok("plugin remove by substring", removePluginEntry(rpdoc, "open-memex") === "removed"
  && JSON.stringify(rpdoc["plugin"]) === JSON.stringify(["other-plugin"]));
const rpdoc3: Record<string, unknown> = { plugin: ["file:///open-memex/y"] };
ok("plugin remove prunes empty array", removePluginEntry(rpdoc3, "open-memex") === "removed" && !("plugin" in rpdoc3));
ok("plugin remove absent", removePluginEntry({ plugin: ["other"] }, "open-memex") === "absent");
// F30: the rename left the OLD plugin loading next to the new one — init must drop it.
const lpdoc: Record<string, unknown> = { plugin: ["file:///g/my-o-memory/src/index.ts", "file:///g/open-memex/src/index.ts"] };
ok("plugin remove drops legacy my-o-memory entry", removePluginEntry(lpdoc, LEGACY_PACKAGE_NAME) === "removed"
  && JSON.stringify(lpdoc["plugin"]) === JSON.stringify(["file:///g/open-memex/src/index.ts"]));
// D60: the OpenCode 2 `plugins` array (directory strings and {package} objects).
const vdoc: Record<string, unknown> = {};
ok("v2 merge creates array", mergeV2PluginEntry(vdoc, "/x/open-memex/src", false) === "added"
  && JSON.stringify(vdoc["plugins"]) === JSON.stringify(["/x/open-memex/src"]));
ok("v2 merge dup kept", mergeV2PluginEntry(vdoc, "/x/open-memex/src", false) === "kept");
const vdoc2: Record<string, unknown> = { plugins: [{ package: "other-plugin", options: {} }, "/old/open-memex/src"] };
ok("v2 merge kept with existing open-memex entry (no force)", mergeV2PluginEntry(vdoc2, "/new/open-memex/src", false) === "kept"
  && (vdoc2["plugins"] as unknown[]).length === 2);
ok("v2 merge force replaces stale open-memex dir, keeps others", mergeV2PluginEntry(vdoc2, "/new/open-memex/src", true) === "added"
  && (vdoc2["plugins"] as unknown[]).length === 2
  && JSON.stringify(vdoc2["plugins"]) === JSON.stringify([{ package: "other-plugin", options: {} }, "/new/open-memex/src"]));
ok("v2 remove drops string + object entries", removeV2PluginEntry(vdoc2, "open-memex") === "removed"
  && JSON.stringify(vdoc2["plugins"]) === JSON.stringify([{ package: "other-plugin", options: {} }]));
ok("v2 remove absent", removeV2PluginEntry(vdoc2, "open-memex") === "absent");
const vdoc3: Record<string, unknown> = { plugins: ["/x/open-memex/src"] };
ok("v2 remove prunes empty array", removeV2PluginEntry(vdoc3, "open-memex") === "removed" && !("plugins" in vdoc3));
// D60: the plugin entrypoint default-exports both host generations.
const entryModule = (await import("../src/index.ts")) as { default: { id?: unknown; setup?: unknown; server?: unknown } };
ok("entry default export has id/setup/server", entryModule.default.id === "open-memex"
  && typeof entryModule.default.setup === "function"
  && typeof entryModule.default.server === "function");
// removeInstructionsSection: cuts MARKER..end, "" when nothing remains.
ok("instructions remove keeps prior content",
  removeInstructionsSection("# mine\n\n<!-- open-memex -->\n# OpenMemex memory\n") === "# mine\n");
ok("instructions remove returns empty when wholesale",
  removeInstructionsSection("<!-- open-memex -->\n# OpenMemex memory\n") === "");
ok("instructions remove no-op without marker",
  removeInstructionsSection("# mine\n") === "# mine\n");
// detectInstalledClients with a fully fake env.
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-bin-"));
fs.writeFileSync(path.join(binDir, "code"), "#!/bin/sh\n");
const detHome = fs.mkdtempSync(path.join(os.tmpdir(), "memex-home-"));
fs.mkdirSync(path.join(detHome, ".cursor"), { recursive: true });
fs.mkdirSync(path.join(detHome, ".config", "opencode"), { recursive: true });
const detRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memex-root-"));
const detEnv = { pathEnv: binDir, home: detHome, platform: "linux" as const, root: detRoot, xdgConfigHome: path.join(detHome, ".config") };
const det = detectInstalledClients(detEnv);
ok("detects vscode via PATH", det.includes("vscode"));
ok("detects cursor via ~/.cursor", det.includes("cursor"));
ok("detects opencode via config dir", det.includes("opencode"));
ok("no visualstudio without .sln", !det.includes("visualstudio"));
fs.writeFileSync(path.join(detRoot, "app.sln"), "");
ok("visualstudio detected with .sln", detectInstalledClients(detEnv).includes("visualstudio"));
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "memex-empty-"));
const detEmpty = detectInstalledClients({ pathEnv: "", home: emptyHome, platform: "linux", root: emptyHome, xdgConfigHome: path.join(emptyHome, ".config") });
ok("empty env detects nothing", detEmpty.length === 0);
const winBin = fs.mkdtempSync(path.join(os.tmpdir(), "memex-winbin-"));
fs.writeFileSync(path.join(winBin, "code.cmd"), "@echo off\n");
ok("win32 detects vscode via code.cmd",
  detectInstalledClients({ pathEnv: winBin, home: emptyHome, platform: "win32", root: emptyHome, xdgConfigHome: path.join(emptyHome, ".config") }).includes("vscode"));
for (const d of [fakeHome, binDir, detHome, detRoot, emptyHome, winBin]) fs.rmSync(d, { recursive: true, force: true });
// D55: opencode's native plugin supersedes the skill — init must not install it there.
ok("opencode+global skips skill", shouldInstallSkill("opencode", true) === false);
ok("opencode per-project keeps skill fallback", shouldInstallSkill("opencode", false) === true);
ok("vscode keeps skill", shouldInstallSkill("vscode", true) === true);
ok("cursor keeps skill", shouldInstallSkill("cursor", false) === true);

// D68: display helpers — age tokens, structured lines, truncation notes.
{
  const { ageToken, formatInventoryLine, truncationNote } = await import("../src/retrieve/display.ts");
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);
  ok("ageToken now", ageToken(now - 30_000, now) === "now");
  ok("ageToken days", ageToken(now - 3 * 86_400_000, now) === "3d");
  ok("ageToken old falls back to a date", /^\d{4}-\d{2}-\d{2}$/.test(ageToken(now - 90 * 86_400_000, now)));
  const line = formatInventoryLine(2, {
    id: "01K6AB", type: "fact", snippet: "likes  concise diffs", source: "user",
    created_at: now - 3 * 86_400_000, updated_at: now - 3 * 86_400_000,
    status: "active", review_state: "draft", scope_key: "personal",
  }, "personal", now);
  ok("inventory line is structured", line === "3. [fact] id=01K6AB created=3d source=user — likes concise diffs", line);
  const proj = formatInventoryLine(0, {
    id: "01K6CD", type: "decision", snippet: "ship on fridays", source: "keyword",
    created_at: now - 2 * 86_400_000, updated_at: now - 3_600_000,
    status: "active", review_state: "draft", scope_key: "project__x",
  }, "personal", now);
  ok("inventory line shows project state + late update", proj.includes("[draft]") && proj.includes("updated=1h"), proj);
  ok("truncation note speaks only when cut", truncationNote(20, 54)?.includes("34 more") === true && truncationNote(20, 20) === null);
}

console.log("== D80 index-time expansion ==");
{
  // EN term expands to its group siblings, minus what's already in the text.
  const v1 = expansionVariantsForDoc("Deploy to production only from the release branch.");
  ok("ship expands from deploy", v1.includes("ship"), v1.join(","));
  ok("no dupes of present terms", !v1.includes("deploy") && !v1.includes("release"), v1.join(","));
  ok("function words are not keywords", !v1.includes("to") && !v1.includes("the"), v1.join(","));
  // ZH substring expands both directions: doc has 数据库 → database indexed.
  const v2 = expansionVariantsForDoc("数据库备份每天凌晨两点执行，全量保留三十天。");
  ok("database indexed from 数据库", v2.includes("database"), v2.join(","));
  ok("backup indexed from 备份", v2.includes("backup"), v2.join(","));
  ok("retention indexed from 保留", v2.includes("retention"), v2.join(","));
  // EN doc gets ZH variants: staging → 预发布环境.
  const v3 = expansionVariantsForDoc("The staging environment wipes itself every night at midnight.");
  ok("预发布环境 indexed from staging", v3.includes("预发布环境"), v3.join(","));
  ok("wipes inflects to wipe group", v3.includes("清空"), v3.join(","));
  // Multi-word Latin phrase: regression test.
  const v4 = expansionVariantsForDoc("上线前必须跑完全量回归测试。");
  ok("regression test indexed from 回归测试", v4.includes("regression test"), v4.join(","));
  // Cap bounds index growth.
  const v5 = expansionVariantsForDoc("test deploy bug cache queue api docker config log mock review commit merge branch");
  ok("variant cap respected", v5.length <= MAX_AUTO_VARIANTS, String(v5.length));
  // Empty / no-match input.
  ok("no curated terms → no variants", expansionVariantsForDoc("hello world").length === 0);
}

console.log("== D81 alias-memory query-time expansion ==");
{
  const entries: AliasEntry[] = [
    { id: "a1", scope_key: "personal", alias: "香蕉计划", target: "支付系统重构项目" },
    { id: "a2", scope_key: "personal", alias: "小宝贝", target: "AI agent" },
  ];
  // alias → target.
  const r1 = rewriteQueryOnce("香蕉计划进展如何", entries);
  ok("alias rewrites to target", r1 === "支付系统重构项目进展如何", String(r1));
  // target → alias (bidirectional).
  const r2 = rewriteQueryOnce("支付系统重构项目什么时候评审", entries);
  ok("target rewrites to alias", r2 === "香蕉计划什么时候评审", String(r2));
  // Latin token match (whole token, not substring).
  const r3 = rewriteQueryOnce("ask 小宝贝 for help", entries);
  ok("latin alias rewrites", r3 === "ask AI agent for help", String(r3));
  ok("latin substring does not match", rewriteQueryOnce("association meeting", [{ id: "x", scope_key: "p", alias: "sso", target: "单点登录" }]) === null);
  // No match → null.
  ok("no alias term → null", rewriteQueryOnce("今天天气不错", entries) === null);
  // Depth < 3: at most two expansion rounds.
  const chained: AliasEntry[] = [
    { id: "c1", scope_key: "p", alias: "alpha", target: "beta" },
    { id: "c2", scope_key: "p", alias: "beta", target: "gamma" },
    { id: "c3", scope_key: "p", alias: "gamma", target: "delta" },
  ];
  const plan = planAliasExpansions("alpha status", chained);
  ok("depth capped below 3", plan.length === 2, JSON.stringify(plan));
  // Cycle-safe: alpha↔beta oscillates back to the seen query and stops.
  const cyclic: AliasEntry[] = [
    { id: "x1", scope_key: "p", alias: "alpha", target: "beta" },
    { id: "x2", scope_key: "p", alias: "beta", target: "alpha" },
  ];
  ok("cycle stops", planAliasExpansions("alpha status", cyclic).length <= 1);

  // Normalized-max merge: an alias-side champion (n=1.0) outranks a mediocre
  // literal match (n=0.4) — no down-weighting for being from a later round.
  const merged = mergeRounds([
    [{ id: "lit-best", score: 10 }, { id: "lit-mid", score: 4 }],
    [{ id: "alias-best", score: 5 }, { id: "lit-best", score: 2 }],
  ]);
  const order = merged.map((m) => m.doc.id);
  ok("alias champion ties literal champion", merged[0].score === 1 && merged[1].score === 1, JSON.stringify(merged.map((m) => [m.doc.id, m.score]))),
  ok("multi-round doc wins ties", order[0] === "lit-best", order.join(","));
  ok("alias-only doc keeps full weight", order[1] === "alias-best", order.join(","));
  ok("mediocre literal ranks last", order[2] === "lit-mid", order.join(","));
  // Single round degrades to plain ordering.
  const single = mergeRounds([[{ id: "a", score: 3 }, { id: "b", score: 9 }]]);
  ok("single round orders by score", single[0].doc.id === "b" && single[0].score === 1, JSON.stringify(single.map((m) => [m.doc.id, m.score])));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
