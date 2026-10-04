// Full feature test — exercises every CLI command and every MCP tool.
// Usage: node --experimental-strip-types scripts/test-full.ts
// Isolated: uses temp HOME + MY_O_MEMORY_HOME + temp git repos. Touches nothing real.
//
// NOTE on flakiness: better-sqlite3 11.x intermittently crashes at process
// exit on Node 24 (RemoveEnvironmentCleanupHook assertion, exit 134) — a
// known pre-existing issue. The work itself always completes; only the exit
// code/output flush is affected. Id-generating calls retry until an id is
// parsed, and crash-prone commands retry up to 5 times.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO, "dist", "cli.js");
const MCP_TS = path.join(REPO, "src", "mcp.ts");

// Freshness guard: the CLI under test is the built dist/cli.js. A stale build
// turns src fixes into phantom product failures, so refuse to run against one.
// The check is a content fingerprint written by the build (scripts/build-stamp.mjs),
// not an mtime comparison: `git checkout` rewrites src mtimes, so switching
// branches can leave an older-branch dist looking newer than the branch's src.
{
  try {
    execFileSync("node", [path.join(REPO, "scripts", "build-stamp.mjs"), "--check"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    console.error((e.stderr ?? "").toString().trim() || "dist/ is stale — run `npm run build` first");
    process.exit(1);
  }
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), "om-full-"));
const TESTENV = {
  ...process.env,
  HOME: path.join(T, "home"),
  MY_O_MEMORY_HOME: path.join(T, "data"),
};
fs.mkdirSync(TESTENV.HOME, { recursive: true });

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${info ? " — " + info : ""}`); }
}
function isCrash(err: string): boolean {
  return /RemoveEnvironmentCleanupHook|Assertion failed/.test(err);
}
// Base runner: transparently retries the known better-sqlite3 exit crash
// (work completes; only exit code/output flush is affected).
function cliRaw(args: string[], cwd: string, env: NodeJS.ProcessEnv): { out: string; err: string; code: number } {
  let last = { out: "", err: "", code: 1 };
  for (let i = 0; i < 5; i++) {
    try {
      const out = execFileSync("node", [CLI, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { out, err: "", code: 0 };
    } catch (e: any) {
      last = { out: e.stdout ?? "", err: e.stderr ?? "", code: e.status ?? 1 };
      if (!isCrash(last.err)) break; // real error, not the flaky crash
    }
  }
  return last;
}
function cli(args: string[], cwd: string): { out: string; err: string; code: number } {
  return cliRaw(args, cwd, TESTENV);
}
function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, env: TESTENV, stdio: "ignore" });
}
function mkproj(name: string): string {
  const p = path.join(T, name);
  fs.mkdirSync(p, { recursive: true });
  git(["init", "-q"], p);
  git(["config", "user.email", "test@example.com"], p);
  git(["config", "user.name", "Test"], p);
  fs.writeFileSync(path.join(p, "README.md"), "# test\n");
  git(["add", "."], p);
  git(["commit", "-qm", "init"], p);
  return p;
}
const grabId = (out: string) => (out.match(/saved ([A-Z0-9]{26})/) || [])[1] ?? "";
const grabArrowId = (out: string) => (out.match(/→\s*([A-Z0-9]{26})/) || [])[1] ?? "";
function tarRead(tarfile: string, member: string): string {
  try {
    return execFileSync("tar", ["-xzOf", tarfile, member], { env: TESTENV, encoding: "utf8" });
  } catch { return ""; }
}
function cliRetry(args: string[], cwd: string): { out: string; err: string; code: number } {
  return cli(args, cwd); // retry is built into cliRaw
}
// add is the id factory — the known better-sqlite3 exit crash can eat the
// output, so retry until we actually get an id back.
function addMem(args: string[], cwd: string): string {
  for (let i = 0; i < 5; i++) {
    const id = grabId(cli(["add", ...args], cwd).out);
    if (id) return id;
  }
  return "";
}
function proposeMem(id: string, cwd: string): string {
  for (let i = 0; i < 5; i++) {
    const d = grabArrowId(cli(["propose", id, "--to", "project"], cwd).out);
    if (d) return d;
  }
  return "";
}
// Separate data dir = separate machine (the real export/import scenario).
const TESTENV2 = { ...TESTENV, MY_O_MEMORY_HOME: path.join(T, "data2") };
function cli2(args: string[], cwd: string): { out: string; err: string; code: number } {
  return cliRaw(args, cwd, TESTENV2);
}

console.log("== setup ==");
const PROJ = mkproj("proj");
const REMOTE = path.join(T, "remote.git");
execFileSync("git", ["init", "-q", "--bare", REMOTE], { env: TESTENV });
git(["remote", "add", "origin", REMOTE], PROJ);
ok("proj + bare remote ready", fs.existsSync(path.join(PROJ, ".git")));

// ---------- 1. where / scopes / config ----------
console.log("== where / scopes / config ==");
let r = cli(["where"], PROJ);
ok("where shows project scope", /project__/.test(r.out), r.out.slice(0, 120));
r = cli(["scopes"], PROJ);
ok("scopes empty → graceful message", /no scopes with memories yet/.test(r.out), r.out.slice(0, 120));
r = cli(["config", "set", "sync.autoPull", "true"], PROJ);
r = cli(["config"], PROJ);
ok("config set/get dotted key", /autoPull/.test(r.out) && /true/.test(r.out), r.out.slice(0, 200));
cli(["config", "set", "sync.autoPull", "false"], PROJ);

// ---------- 2. add / list / search ----------
console.log("== add / list / search ==");
const idFact = addMem(["fulltest fact about deploys", "--type", "fact", "--tag", "t1"], PROJ);
const idDecision = addMem(["fulltest decision to use ff merges", "--type", "decision", "--tag", "t2"], PROJ);
const idPersonal = addMem(["fulltest personal pref", "--scope", "personal"], PROJ);
ok("add returns ids", !!idFact && !!idDecision && !!idPersonal);
r = cli(["list"], PROJ);
ok("list default = project only", r.out.includes(idFact) && r.out.includes(idDecision) && !r.out.includes(idPersonal));
r = cli(["list", "--scope", "personal"], PROJ);
ok("list --scope personal", r.out.includes(idPersonal) && !r.out.includes(idFact));
r = cli(["scopes"], PROJ);
ok("scopes lists populated scopes", /personal/.test(r.out) && /project__/.test(r.out), r.out.slice(0, 160));
r = cli(["list", "--type", "decision"], PROJ);
ok("list --type filter", r.out.includes(idDecision) && !r.out.includes(idFact));
r = cli(["search", "ff merges"], PROJ);
ok("search finds decision", r.out.includes(idDecision), r.out.slice(0, 150));

// D61: capture-time aliases — a differently-worded query still hits.
const idAlias = addMem(["fulltest holiday policy lives in the handbook", "--aliases", "time off;vacation days"], PROJ);
r = cli(["search", "vacation"], PROJ);
ok("search hits via alias-only term", r.out.includes(idAlias), r.out.slice(0, 150));
ok("alias-only hit explains itself (aka)", /aka:/i.test(r.out), r.out.slice(0, 150));

// D61 review: aliases go through the same redaction as content. (The
// secret is assembled at runtime so no credential-shaped literal sits
// in this file.)
const fakePat = "ghp_" + "Ab3".repeat(12);
const idSecretAlias = addMem(["fulltest alias redaction target", "--aliases", `${fakePat}; benign alias`], PROJ);
r = cli(["search", "benign"], PROJ);
ok("benign alias still searchable", r.out.includes(idSecretAlias), r.out.slice(0, 150));
{
  const dir = path.join(TESTENV.MY_O_MEMORY_HOME, "memories");
  const stack = [dir];
  let hit = "";
  while (stack.length && !hit) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (p.endsWith(`${idSecretAlias}.md`)) hit = fs.readFileSync(p, "utf8");
    }
  }
  ok("secret-looking alias is masked in the stored file", !!hit && !hit.includes(fakePat), hit.slice(0, 200));
}

// ---------- 3. supersede / status / forget ----------
console.log("== supersede / status / forget ==");
r = cli(["supersede", idFact, "fulltest fact about deploys v2"], PROJ);
const idV2 = grabArrowId(r.out);
ok("supersede creates new version", !!idV2 && idV2 !== idFact, r.out.slice(0, 150));
const idDep = addMem(["fulltest to deprecate", "--type", "fact"], PROJ);
r = cli(["status", idDep, "deprecated"], PROJ);
ok("status deprecated", r.code === 0, (r.err || r.out).slice(0, 150));
r = cli(["status", idFact, "deprecated"], PROJ);
ok("status on superseded chain-member is refused", r.code !== 0 && /chain-managed|supersede/i.test(r.err + r.out), (r.err || r.out).slice(0, 120));
r = cli(["forget", idDecision], PROJ);
ok("forget deletes", r.code === 0 && /delet/i.test(r.out), r.out.slice(0, 120));
r = cli(["list"], PROJ);
ok("forgotten id gone from list", !r.out.includes(idDecision));

// P0: forget must not report success when the file cannot be deleted —
// the file is the source of truth and would be re-indexed on next sync.
// (Simulated by putting a directory where the file belongs: unlink fails
// with EISDIR even for root, unlike permission bits.)
{
  const idF = addMem(["fulltest forget failure"], PROJ);
  const memRoot = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories");
  let memFile = "";
  const findFile = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) findFile(p2);
      else if (e.name === idF + ".md") memFile = p2;
    }
  };
  findFile(memRoot);
  ok("forget-failure setup found the file", !!memFile);
  const backup = fs.readFileSync(memFile, "utf8");
  fs.rmSync(memFile);
  fs.mkdirSync(memFile);
  try {
    r = cli(["forget", idF], PROJ);
    ok("forget reports failure when unlink fails",
      r.code !== 0 && /could not delete/i.test(r.err + r.out),
      (r.err || r.out).slice(0, 150));
  } finally {
    fs.rmSync(memFile, { recursive: true });
    fs.writeFileSync(memFile, backup);
  }
  r = cli(["list"], PROJ);
  ok("memory survives failed forget", r.out.includes(idF), r.out.slice(0, 150));
  r = cli(["forget", idF], PROJ);
  ok("forget succeeds once the file is deletable again", r.code === 0, (r.err || r.out).slice(0, 150));
}
// ---------- 4. propose / submit / promote / sync-status ----------
console.log("== review workflow: propose / submit / promote ==");
const idProp = addMem(["fulltest proposal candidate", "--scope", "personal"], PROJ);
const idDraft = proposeMem(idProp, PROJ);
ok("propose stages outbox draft", !!idDraft);
r = cli(["sync-status"], PROJ);
ok("sync-status shows outbox draft", /outbox/.test(r.out) && r.out.includes(idDraft));
r = cli(["submit", idDraft], PROJ);
ok("submit commits locally", r.code === 0, (r.err || r.out).slice(0, 150));
const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: PROJ, env: TESTENV, encoding: "utf8" });
ok("submit created a git commit", /submit|mem/i.test(log), log.trim());
r = cli(["promote", idDraft, "--note", "fulltest approval"], PROJ);
ok("promote → approved", r.code === 0, (r.err || r.out).slice(0, 150));
r = cli(["promote", idDraft, "--note", "fulltest publish"], PROJ);
ok("promote → published", r.code === 0, (r.err || r.out).slice(0, 150));
const idRej = addMem(["fulltest reject candidate", "--scope", "personal"], PROJ);
const idRejDraft = proposeMem(idRej, PROJ);
r = cliRetry(["submit", idRejDraft], PROJ);
ok("reject-path submit", r.code === 0, (r.err || r.out).slice(0, 120));
r = cli(["promote", idRejDraft, "--reject", "--note", "fulltest rejection"], PROJ);
ok("promote --reject with note", r.code === 0, (r.err || r.out).slice(0, 150));

// ---------- 5. export / import ----------
console.log("== export / import ==");
const expFile = path.join(T, "bundle.tar.gz");
r = cliRetry(["export", "-o", expFile], PROJ);
ok("export creates bundle", r.code === 0 && fs.existsSync(expFile), (r.err || r.out).slice(0, 120));
const man = JSON.parse(tarRead(expFile, "manifest.json") || "{}");
ok("manifest format valid", man.format === "open-memex-export/1" && Array.isArray(man.memories) && man.memories.length > 0, JSON.stringify(man).slice(0, 120));
r = cliRetry(["export", "--scope", "personal", "--all", "-o", path.join(T, "p.tar.gz")], PROJ);
const manP = JSON.parse(tarRead(path.join(T, "p.tar.gz"), "manifest.json") || "{}");
ok("export --all includes private", manP.include_private === true && manP.memories.length >= 2);
const PROJ2 = mkproj("proj2");
function cli2Retry(args: string[], cwd: string): { out: string; err: string; code: number } {
  return cli2(args, cwd); // retry is built into cliRaw
}
r = cli2Retry(["import", expFile, "--dry-run"], PROJ2);
ok("import --dry-run", /DRY RUN/.test(r.out), r.out.slice(0, 120));
r = cli2Retry(["import", expFile], PROJ2);
ok("import real run", /imported [1-9]/.test(r.out), r.out.slice(0, 120));
r = cli2(["list"], PROJ2);
ok("imported memories visible in target project", /fulltest/.test(r.out), r.out.slice(0, 160));
r = cli2Retry(["import", expFile], PROJ2);
ok("import identical → skipped", /skipped [1-9]+ identical/.test(r.out), r.out.slice(0, 120));
// conflict: craft bundle with same id, different content
const cid = man.memories[0].id;
const cstage = path.join(T, "cstage");
fs.mkdirSync(path.join(cstage, "memories", "project"), { recursive: true });
fs.writeFileSync(path.join(cstage, "memories", "project", cid + ".md"),
  `---\nid: ${cid}\nscope: project\nscope_key: project__old__x\nvisibility: internal\ntype: fact\nstatus: active\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n\nCONFLICT CONTENT\n`);
fs.writeFileSync(path.join(cstage, "manifest.json"), JSON.stringify({ format: "open-memex-export/1", exported_at: "2026-01-01T00:00:00Z", open_memex_version: "t", include_private: false, filters: {}, memories: [{ id: cid, scope: "project", file: `memories/project/${cid}.md` }] }));
const cfile = path.join(T, "conflict.tar.gz");
execFileSync("tar", ["-czf", cfile, "-C", cstage, "manifest.json", "memories"], { env: TESTENV });
r = cli2Retry(["import", cfile], PROJ2);
ok("import conflict reported, never overwritten", /conflict/.test(r.out) && /imported 0/.test(r.out), r.out.slice(0, 160));
// P0: a bundle manifest pointing outside the bundle must be rejected —
// it otherwise imports arbitrary local .md files into the store. The
// secret is planted next to the import staging dir (os.tmpdir()), which
// is where "../" from a manifest entry lands.
{
  const secretName = `outside-secret-${process.pid}.md`;
  const secretFile = path.join(os.tmpdir(), secretName);
  const secretId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  fs.writeFileSync(secretFile, `---\nid: ${secretId}\nscope: personal\nscope_key: personal\nvisibility: private\ntype: fact\nstatus: active\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n\nfulltest traversal secret\n`);
  const tstage = path.join(T, "tstage");
  fs.mkdirSync(tstage, { recursive: true });
  fs.writeFileSync(path.join(tstage, "manifest.json"), JSON.stringify({ format: "open-memex-export/1", exported_at: "2026-01-01T00:00:00Z", open_memex_version: "t", include_private: true, filters: {}, memories: [{ id: secretId, scope: "personal", file: `../${secretName}` }] }));
  const tfile = path.join(T, "traversal.tar.gz");
  execFileSync("tar", ["-czf", tfile, "-C", tstage, "manifest.json"], { env: TESTENV });
  r = cli2Retry(["import", tfile], PROJ2);
  ok("import rejects path outside bundle", /imported 0/.test(r.out) && /rejected/.test(r.out), r.out.slice(0, 160));
  r = cli2(["search", "traversal", "--scope", "personal"], PROJ2);
  ok("traversed file never landed in store", !/traversal secret/.test(r.out), r.out.slice(0, 160));
  fs.rmSync(secretFile, { force: true });
}

// ---------- 6. distill-agents ----------
console.log("== distill-agents ==");
addMem(["fulltest distill decision: always fast-forward", "--type", "decision"], PROJ);
addMem(["fulltest distill gotcha: sqlite crashes on exit", "--type", "gotcha"], PROJ);
r = cliRetry(["distill-agents"], PROJ);
ok("distill-agents proposes snippet", /## Learned/.test(r.out), r.out.slice(0, 120));
r = cliRetry(["distill-agents", "--type", "decision", "-o", path.join(T, "snip.md")], PROJ);
ok("distill-agents -o writes file", fs.existsSync(path.join(T, "snip.md")));

// ---------- 7. inventory (D68) ----------
console.log("== inventory (D68) ==");
addMem(["fulltest inventory entry with <script>alert(1)</script> tail", "--scope", "personal"], PROJ);
r = cliRetry(["inventory"], PROJ);
ok("inventory text lists the personal memory", r.out.includes("fulltest inventory entry"));
ok("inventory text keeps structured provenance", /source=cli/.test(r.out));
const invJson = cliRetry(["inventory", "--format", "json"], PROJ);
const invData = JSON.parse(invJson.out.slice(invJson.out.indexOf("{")));
ok("inventory json is the shared data layer", invData.format === "open-memex-inventory/2" && invData.total >= 1 && Array.isArray(invData.scopes), invData.format);
const invFile = path.join(T, "inventory.json");
r = cliRetry(["inventory", "--format", "json", "--out", invFile], PROJ);
ok("inventory --out writes the file", r.code === 0 && fs.existsSync(invFile), (r.err || r.out).slice(0, 150));
// D68/3-C v2: a personal-bearing report must not land in a git worktree.
const inTree = path.join(PROJ, "inv.json");
r = cliRetry(["inventory", "--out", inTree], PROJ);
ok("inventory refuses a worktree path without --allow-personal", r.code !== 0 && !fs.existsSync(inTree));
r = cliRetry(["inventory", "--out", inTree, "--allow-personal"], PROJ);
ok("inventory allows the worktree path with --allow-personal", r.code === 0 && fs.existsSync(inTree));
fs.rmSync(inTree, { force: true });
// D68: soft forget hides; audit view still shows it; delete still works.
const softId = addMem(["fulltest soft-hide candidate"], PROJ);
r = cliRetry(["forget", softId, "--soft"], PROJ);
ok("forget --soft hides the memory", r.code === 0 && /hidden/.test(r.out), r.out.slice(0, 120));
r = cliRetry(["list"], PROJ);
ok("hidden memory out of the default list", !r.out.includes(softId));
r = cliRetry(["list", "--include", "all"], PROJ);
ok("hidden memory visible with --include all", r.out.includes(softId) && r.out.includes("[retracted]"), r.out.slice(0, 160));
r = cliRetry(["forget", softId], PROJ);
ok("hard forget still deletes a hidden memory", r.code === 0 && /deleted/.test(r.out));
// D68 follow-up: the HTML rendering of the same data layer.
const htmlId = addMem(["fulltest html page entry"], PROJ);
cliRetry(["forget", htmlId, "--soft"], PROJ);
const htmlFile = path.join(T, "inventory-page.html");
r = cliRetry(["inventory", "--format", "html", "--out", htmlFile], PROJ);
ok("inventory --format html writes the page", r.code === 0 && fs.existsSync(htmlFile), (r.err || r.out).slice(0, 150));
const page = fs.readFileSync(htmlFile, "utf8");
ok("html page shows current memories", page.includes("fulltest inventory entry"));
ok("html page escapes memory content", page.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !page.includes("<script>alert(1)</script>"));
ok("html page folds the hidden history", page.includes("Replaced &amp; hidden history") && page.includes(htmlId) && page.includes("retracted"));
ok("html page enforces 'no network' with a CSP", /Content-Security-Policy/.test(page) && /default-src 'none'/.test(page));
r = cliRetry(["inventory", "--format", "html"], PROJ);
ok("html defaults to the data dir", r.code === 0 && fs.existsSync(path.join(T, "data", "inventory.html")), (r.err || r.out).slice(0, 150));
const inTreePage = path.join(PROJ, "page.html");
r = cliRetry(["inventory", "--format", "html", "--out", inTreePage], PROJ);
ok("html refuses a worktree path without --allow-personal", r.code !== 0 && !fs.existsSync(inTreePage));

// ---------- 8. pull / push ----------
console.log("== pull / push ==");
r = cliRetry(["push"], PROJ);
ok("push explicit", r.code === 0, (r.err || r.out).slice(0, 150));
const PROJ3 = path.join(T, "proj3");
execFileSync("git", ["clone", "-q", REMOTE, PROJ3], { env: TESTENV });
git(["config", "user.email", "test@example.com"], PROJ3);
git(["config", "user.name", "Test"], PROJ3);
const idRemote = addMem(["fulltest remote memory", "--type", "fact"], PROJ3);
cliRetry(["submit", idRemote], PROJ3);
cliRetry(["push"], PROJ3);
r = cliRetry(["pull"], PROJ);
ok("pull fast-forward", r.code === 0 && /up.to.date|fast-forward|pulled/i.test(r.out + r.err), (r.out + r.err).slice(0, 150));
// diverged: commit on both sides
fs.writeFileSync(path.join(PROJ, "div1.txt"), "a");
git(["add", "."], PROJ); git(["commit", "-qm", "div1"], PROJ);
fs.writeFileSync(path.join(PROJ3, "div2.txt"), "b");
git(["add", "."], PROJ3); git(["commit", "-qm", "div2"], PROJ3);
cli(["push"], PROJ3);
r = cli(["pull"], PROJ);
ok("pull diverged → clear failure", r.code !== 0 && /diverg|behind|ahead/i.test(r.out + r.err), (r.out + r.err).slice(0, 160));

// ---------- 9. migrate / reindex ----------
console.log("== migrate / reindex ==");
r = cli(["migrate", "--dry-run"], PROJ);
ok("migrate bare → graceful no-op message", /no --from given/.test(r.out + r.err), (r.out + r.err).slice(0, 150));
const idMig = addMem(["fulltest migrate me", "--scope", "personal"], PROJ);
r = cli(["migrate", "--from", "personal", "--to", "project", "--dry-run"], PROJ);
ok("migrate personal→project dry-run", r.code === 0, (r.err || r.out).slice(0, 150));
const dbPath = path.join(TESTENV.MY_O_MEMORY_HOME as string, "index.db");
fs.rmSync(dbPath);
const beforeReindex = Date.now();
cli(["reindex"], PROJ); // exit code unreliable (known sqlite exit crash); verify by artifact
let dbOk = false;
try { dbOk = fs.existsSync(dbPath) && fs.statSync(dbPath).mtimeMs >= beforeReindex - 1000; } catch { /* no */ }
ok("reindex rebuilds", dbOk, `db exists: ${fs.existsSync(dbPath)}`);
r = cli(["list", "--scope", "personal"], PROJ);
ok("list works after reindex", r.out.includes(idMig) || r.out.includes(idPersonal));
// P0: a real migrate must re-scope the file, not just re-key it — a
// personal memory migrated to the project key must become submittable
// project memory (scope: project in its frontmatter).
r = cli(["migrate", "--from", "personal", "--to", "project"], PROJ);
ok("migrate personal→project runs", r.code === 0, (r.err || r.out).slice(0, 150));
{
  const memRoot = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories");
  let moved = "";
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === idMig + ".md") moved = fs.readFileSync(p, "utf8");
    }
  };
  walk(memRoot);
  ok("migrated file is now scope: project", /^scope: project$/m.test(moved), moved.slice(0, 200));
}

// ---------- 10. capture / doctor / mcp --print-config / init ----------
console.log("== capture / doctor / mcp / init ==");
r = cli(["capture", "--dry-run", "remember: we deploy on Fridays and use ff merges"], PROJ);
ok("capture --dry-run", r.code === 0 && /deploy|friday/i.test(r.out), r.out.slice(0, 150));
for (const c of ["vscode", "cursor", "claude", "opencode", "visualstudio"]) {
  r = cli(["mcp", "--print-config", c], PROJ);
  ok(`mcp --print-config ${c}`, r.code === 0 && r.out.trim().length > 10, r.err.slice(0, 100));
}
r = cli(["init", "--client", "vscode", "--yes"], PROJ);
ok("init --client vscode --yes", r.code === 0 && fs.existsSync(path.join(PROJ, ".vscode", "mcp.json")), (r.err || r.out).slice(0, 150));
// P0: VS init must merge into an existing .mcp.json, not replace it —
// the parsed doc used to be dropped, wiping other MCP servers.
{
  const mcpFile = path.join(PROJ, ".mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify({ servers: { "other-server": { type: "stdio", command: "other" } } }));
  r = cli(["init", "--client", "visualstudio", "--yes"], PROJ);
  const after = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as { servers?: Record<string, unknown> };
  ok("VS init preserves other servers in .mcp.json",
    r.code === 0 && !!after.servers?.["other-server"] && !!after.servers?.["open-memex"],
    JSON.stringify(after).slice(0, 160));
}
r = cliRetry(["doctor"], PROJ);
ok("doctor", r.code === 0 && /All checks passed/.test(r.out), (r.err || r.out).slice(0, 200));

// ---------- 11. MCP: all 11 tools + session-start instructions ----------
console.log("== MCP tools ==");
{
  const child = spawn("node", ["--experimental-strip-types", MCP_TS], {
    cwd: PROJ, env: TESTENV, stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      } catch { /* ignore */ }
    }
  });
  const req = (method: string, params: any) => new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ __timeout: true }); } }, 30000);
  });
  const call = async (tool: string, args: any) => {
    const resp = await req("tools/call", { name: tool, arguments: args });
    const text = (resp.result?.content || []).map((c: any) => c.text || "").join("\n");
    return { resp, text };
  };

  const init = await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  const instructions: string = init.result?.instructions || "";
  ok("MCP initialize returns instructions", instructions.length > 200, instructions.slice(0, 100));
  ok("instructions mention sync/memory_status", /memory_status|sync/i.test(instructions));
  await req("notifications/initialized", {});
  const tools = await req("tools/list", {});
  const names: string[] = (tools.result?.tools || []).map((t: any) => t.name);
  const expected = ["memory_add","memory_forget","memory_list","memory_pr_status","memory_promote","memory_propose","memory_resolve","memory_search","memory_status","memory_submit","memory_supersede"];
  ok("11 MCP tools listed", expected.every((n) => names.includes(n)), names.join(","));

  let m = await call("memory_add", { content: "mcptest fact via MCP", type: "fact" });
  const mid = (m.text.match(/([A-Z0-9]{26})/) || [])[1] || "";
  ok("memory_add", !!mid, m.text.slice(0, 120));
  m = await call("memory_search", { query: "mcptest fact" });
  ok("memory_search", m.text.includes(mid), m.text.slice(0, 120));
  m = await call("memory_list", { limit: 5 });
  ok("memory_list", m.text.includes(mid) || /fact/.test(m.text), m.text.slice(0, 120));
  m = await call("memory_status", {});
  ok("memory_status", /project|outbox|sync/i.test(m.text), m.text.slice(0, 120));
  m = await call("memory_supersede", { id: mid, content: "mcptest fact via MCP v2" });
  const mid2 = (m.text.match(/with ([A-Z0-9]{26})/) || [])[1] || "";
  ok("memory_supersede", !!mid2 && mid2 !== mid, m.text.slice(0, 120));
  // propose → submit → promote via MCP
  const pid = ((await call("memory_add", { content: "mcptest proposal", scope: "personal" })).text.match(/([A-Z0-9]{26})/) || [])[1] || "";
  m = await call("memory_propose", { ids: [pid] });
  const pdraft = (m.text.match(/→\s*([A-Z0-9]{26})/) || m.text.match(/([A-Z0-9]{26})/) || [])[1] || "";
  ok("memory_propose", !!pdraft && pdraft !== pid, m.text.slice(0, 120));
  m = await call("memory_submit", { ids: [pdraft] });
  ok("memory_submit", !/error/i.test(m.text) || /commit|submit/i.test(m.text), m.text.slice(0, 120));
  m = await call("memory_promote", { id: pdraft, note: "mcptest approve" });
  ok("memory_promote", !/__timeout/.test(JSON.stringify(m.resp)), m.text.slice(0, 120));
  m = await call("memory_resolve", {});
  ok("memory_resolve (list)", !/__timeout/.test(JSON.stringify(m.resp)), m.text.slice(0, 120));
  m = await call("memory_pr_status", {});
  ok("memory_pr_status (report)", !/__timeout/.test(JSON.stringify(m.resp)), m.text.slice(0, 120));
  m = await call("memory_forget", { id: mid2 });
  ok("memory_forget", /delet|forget/i.test(m.text), m.text.slice(0, 120));
  child.kill();
}

// ---------- 12. D64: P1 review-flow honesty fixes ----------
console.log("== D64: p1 fixes (propose visibility / supersede published / status door / plugin sync / status cap / doctor v1 / uninstall jsonc) ==");
{
  r = cli(["where"], PROJ);
  const pkey = (/project:\s*(\S+)/.exec(r.out) || [])[1] ?? "";

  // propose: the project copy must not inherit visibility: private, or
  // export would silently drop it from every team bundle.
  const seedId = addMem(["zzq p1 visible fact for the team", "--scope", "personal"], PROJ);
  const copyId = proposeMem(seedId, PROJ);
  const copyFile = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories", pkey, `${copyId}.md`);
  const copyText = fs.existsSync(copyFile) ? fs.readFileSync(copyFile, "utf8") : "";
  ok("propose copy is internal, not private", /visibility: internal/.test(copyText), copyText.slice(0, 160));

  // supersede a published memory: the replacement must re-enter review
  // at "proposed" (promotable), not land as a stranded repo draft.
  const did = addMem(["zzq p1 publish flow fact"], PROJ);
  cli(["submit", did], PROJ);
  cli(["promote", did], PROJ);
  r = cli(["promote", did], PROJ);
  const pubFile = path.join(PROJ, ".ai", "open-memex", `${did}.md`);
  ok("setup: promoted to published", r.code === 0 && /review_state: published/.test(fs.readFileSync(pubFile, "utf8")), (r.err || r.out).slice(0, 150));
  r = cli(["supersede", did, "zzq p1 publish flow fact v2"], PROJ);
  const nid = grabArrowId(r.out);
  const newFile = nid ? path.join(PROJ, ".ai", "open-memex", `${nid}.md`) : "";
  const newText = newFile && fs.existsSync(newFile) ? fs.readFileSync(newFile, "utf8") : "";
  ok("supersede of published → proposed (not stranded draft)", /review_state: proposed/.test(newText), (r.out + newText).slice(0, 200));
  r = cli(["promote", nid], PROJ);
  ok("promote advances the replacement", r.code === 0 && /approved/.test(r.out + (fs.existsSync(newFile) ? fs.readFileSync(newFile, "utf8") : "")), (r.err || r.out).slice(0, 150));

  // status: retracted cannot silently return to active.
  const sid = addMem(["zzq p1 retract flow fact"], PROJ);
  r = cli(["status", sid, "retracted"], PROJ);
  ok("status → retracted", r.code === 0, (r.err || r.out).slice(0, 120));
  r = cli(["status", sid, "active"], PROJ);
  ok("retracted → active is refused", r.code !== 0 && /retracted/.test(r.err), (r.out + r.err).slice(0, 160));

  // plugin host: per-call sync — wipe the (rebuildable) index and the
  // opencode tools must still see memories written by other processes.
  const marker = `zzqp1sync${Date.now()}`;
  const pmid = addMem([`${marker} plugin freshness fact`, "--scope", "personal"], PROJ);
  fs.rmSync(path.join(TESTENV.MY_O_MEMORY_HOME as string, "index.db"), { force: true });
  fs.rmSync(path.join(TESTENV.MY_O_MEMORY_HOME as string, "index.db-wal"), { force: true });
  fs.rmSync(path.join(TESTENV.MY_O_MEMORY_HOME as string, "index.db-shm"), { force: true });
  const probe = path.join(T, "p1-plugin-probe.ts");
  fs.writeFileSync(probe, [
    // file:// URLs, not raw paths — Windows rejects drive-letter specifiers.
    `import { makeTools } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "tools", "memory.ts")).href)};`,
    `import { PERSONAL_SCOPE } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "scope.ts")).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "config.ts")).href)};`,
    `const tools = makeTools(() => PERSONAL_SCOPE, loadConfig());`,
    `const r = await tools.memory_search.execute({ query: ${JSON.stringify(marker)} });`,
    `console.log(r.output);`,
  ].join("\n"));
  let probeOut = "";
  try {
    probeOut = execFileSync("node", ["--experimental-strip-types", probe], { cwd: PROJ, env: TESTENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) { probeOut = (e.stdout ?? "") + (e.stderr ?? ""); }
  ok("plugin tools sync before answering (index rebuilt)", probeOut.includes(pmid) || probeOut.includes(marker), probeOut.slice(0, 200));

  // sync-status: long sections are capped with an "and N more" line.
  const outboxDir = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories", pkey);
  const template = fs.readFileSync(copyFile, "utf8");
  for (let i = 0; i < 21; i++) {
    const cid = `01P1CAP${String(i).padStart(19, "0")}`;
    fs.writeFileSync(path.join(outboxDir, `${cid}.md`), template.replace(copyId, cid).replace("zzq p1 visible fact for the team", `zzq cap filler ${i}`));
  }
  cli(["reindex"], PROJ);
  r = cli(["sync-status"], PROJ);
  // CLI shows the full list (the 20-line cap applies to agent tool
  // results, whose "… and N more" line points back here).
  const fillerShown = (r.out.match(/zzq cap filler/g) ?? []).length;
  ok("sync-status shows the full list", fillerShown === 21 && !/… and \d+ more/.test(r.out), `shown=${fillerShown}`);
  // ...and the agent-facing render (what memory_status returns) caps per section
  // and names the CLI, so a hidden entry is still reachable.
  const capProbe = path.join(T, "p1-cap-probe.ts");
  fs.writeFileSync(capProbe, [
    `import { getSyncStatus, formatSyncStatus } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "submit.ts")).href)};`,
    `console.log(formatSyncStatus(getSyncStatus()));`,
  ].join("\n"));
  let capOut = "";
  try {
    capOut = execFileSync("node", ["--experimental-strip-types", capProbe], { cwd: PROJ, env: TESTENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) { capOut = (e.stdout ?? "") + (e.stderr ?? ""); }
  const outboxSection = (capOut.split("outbox (appdata")[1] ?? "").split("repo .ai/open-memex")[0];
  const capEntries = (outboxSection.match(/\[(draft|proposed|approved|published|rejected)\]/g) ?? []).length;
  const capFiller = (outboxSection.match(/zzq cap filler/g) ?? []).length;
  ok(
    "agent-facing sync-status caps and points at the CLI",
    capEntries === 20 && capFiller < 21 && /… and \d+ more \(full list: open-memex sync-status\)/.test(outboxSection),
    `entries=${capEntries} fillers=${capFiller} ${outboxSection.slice(0, 200)}`,
  );
  for (let i = 0; i < 21; i++) fs.rmSync(path.join(outboxDir, `01P1CAP${String(i).padStart(19, "0")}.md`), { force: true });

  // doctor: v1 memories left under memories/user/ must be flagged.
  const userDir = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories", "user");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "legacy-one.md"), "---\nid: legacy\n---\nold personal note\n");
  r = cliRetry(["doctor"], PROJ);
  ok("doctor flags invisible v1 user memories", /v1 personal memories/.test(r.out), r.out.slice(0, 200));
  fs.rmSync(userDir, { recursive: true, force: true });
  cli(["reindex"], PROJ);

  // uninstall: a .jsonc-only global opencode config must be found.
  const home2 = path.join(T, "home-opencode");
  const ocDir = path.join(home2, ".config", "opencode");
  fs.mkdirSync(ocDir, { recursive: true });
  const jsoncFile = path.join(ocDir, "opencode.jsonc");
  fs.writeFileSync(jsoncFile, JSON.stringify({ plugin: ["file:///plugins/open-memex/src/index.ts"] }, null, 2));
  // USERPROFILE too: os.homedir() ignores HOME on Windows.
  r = cliRaw(["uninstall", "--client", "opencode", "--global", "--yes"], PROJ, { ...TESTENV, HOME: home2, USERPROFILE: home2 });
  const afterText = fs.readFileSync(jsoncFile, "utf8");
  ok("uninstall finds and cleans .jsonc global config", r.code === 0 && !/open-memex/.test(afterText), (r.out + r.err).slice(0, 160) + " || " + afterText.slice(0, 120));
}

// ---------- 12. D70: the visibility fixes from the 3-C review ----------
// Last section on purpose: nothing here may perturb the flows above it.
// It writes only into a scratch project and into appdata fixtures (no
// commits in PROJ, no extra CLI spawns beyond a handful) so the suite stays
// order-independent and cheap — the shared PROJ git state is never dirtied.
console.log("== D70: honest counts, stable numbers, one guard ==");
{
  const fixture = (dir: string, id: string, body: string, scopeKey: string) => {
    const now = new Date().toISOString();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.md`),
      `---
id: ${id}
schema_version: 2
scope_key: ${scopeKey}
scope: project
visibility: internal
project_name: d70
type: fact
role: knowledge
importance: normal
status: active
tags: []
source: cli
created_at: "${now}"
updated_at: "${now}"
supersedes: null
superseded_by: null
review_state: draft
proposed_by: null
approved_by: null
derived_from: null
review_note: null
review_history: []
---

${body}
`,
      "utf8",
    );
  };

  // The guard must not fail open: a --out whose parent directory does not
  // exist used to skip the worktree check (git -C on a missing dir throws)
  // and then die with a raw ENOENT. Outside a worktree the missing directory
  // is the only problem left, so it gets its own message.
  const missingDir = path.join(T, "no-such-dir", "report.json");
  r = cliRetry(["inventory", "--out", missingDir], PROJ);
  ok(
    "inventory explains a missing parent directory",
    r.code !== 0 && /does not exist/.test(r.err) && !r.err.includes("ENOENT"),
    (r.err || r.out).slice(0, 160),
  );
  // ...and inside a worktree the personal-content refusal wins over it.
  const missingInTree = path.join(PROJ, "no-such-dir", "report.json");
  r = cliRetry(["inventory", "--out", missingInTree], PROJ);
  ok(
    "worktree refusal wins over a missing directory",
    r.code !== 0 && /git working tree/.test(r.err) && !fs.existsSync(missingInTree),
    (r.err || r.out).slice(0, 160),
  );

  // `open-memex list` is the surface a sceptical user runs first: it must
  // not look complete when it isn't. Fixtures go straight into the outbox
  // (appdata, never the repo), so this needs no commits and no cleanup in git.
  const d70Key = (/project:\s*(\S+)/.exec(cli(["where"], PROJ).out) || [])[1] ?? "";
  const outboxDir = path.join(TESTENV.MY_O_MEMORY_HOME as string, "memories", d70Key);
  const fillerIds: string[] = [];
  for (let i = 0; i < 22; i++) {
    const cid = `01P1D70${String(i).padStart(19, "0")}`;
    fillerIds.push(cid);
    fixture(outboxDir, cid, `fulltest d70 filler ${i} padding text`, d70Key);
  }
  cli(["reindex"], PROJ);
  r = cliRetry(["list", "--limit", "5"], PROJ);
  ok("cli list discloses truncation", /… and \d+ more not shown/.test(r.out), r.out.slice(-160));
  ok(
    "cli list renders the structured inventory line",
    /^\d+\. \[[a-z]+\] id=\S+ created=\S+ source=/m.test(r.out),
    r.out.slice(0, 200),
  );
  // Numbering runs across the whole listing, so a number names one entry.
  r = cliRetry(["list", "--scope", "both", "--limit", "5"], PROJ);
  const nums = [...r.out.matchAll(/^(\d+)\. \[/gm)].map((m) => Number(m[1]));
  ok(
    "numbers are unique and ascending across scopes",
    nums.length > 2 && new Set(nums).size === nums.length && nums[0] === 1 && nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1),
    JSON.stringify(nums),
  );
  // The text report numbers the same way.
  r = cliRetry(["inventory", "--scope", "project"], PROJ);
  const textNums = [...r.out.matchAll(/^(\d+)\. \[/gm)].map((m) => Number(m[1]));
  ok(
    "inventory text numbers continuously too",
    textNums.length > 2 && new Set(textNums).size === textNums.length && textNums.every((n, i) => i === 0 || n === textNums[i - 1]! + 1),
    JSON.stringify(textNums.slice(0, 8)),
  );
  for (const id of fillerIds) fs.rmSync(path.join(outboxDir, `${id}.md`), { force: true });
  cli(["reindex"], PROJ);

  // A retraction of an in-repo memory is a local working-tree edit until it
  // is committed - "hidden" must not read as "gone for the team". Runs in its
  // own project so PROJ's git state stays clean for the sections above.
  const d70Proj = mkproj("d70-proj");
  const repoHideId = addMem(["fulltest d70 repo retraction"], d70Proj);
  cliRetry(["submit", repoHideId], d70Proj);
  r = cliRetry(["forget", repoHideId, "--soft"], d70Proj);
  ok(
    "soft hide of a repo memory warns about the commit",
    /commit and push/i.test(r.out) && /team still sees it/i.test(r.out),
    r.out.slice(0, 200),
  );
  r = cliRetry(["forget", repoHideId], d70Proj);
  ok("hard forget of a hidden repo memory still deletes", r.code === 0 && /deleted/i.test(r.out), (r.err || r.out).slice(0, 120));

  // An empty scope must still appear: "this project has nothing" is an answer.
  const emptyProj = mkproj("empty-proj");
  r = cliRetry(["inventory", "--scope", "project"], emptyProj);
  ok(
    "inventory shows an empty scope as 0",
    /Project:.*\(0\)/.test(r.out) && /nothing remembered/i.test(r.out),
    r.out.slice(0, 200),
  );

  // JSON: no absolute local paths, and the format id records the change.
  r = cliRetry(["inventory", "--format", "json"], PROJ);
  const invJson2 = JSON.parse(r.out.slice(r.out.indexOf("{")));
  ok(
    "inventory json is /2 and carries no absolute file paths",
    invJson2.format === "open-memex-inventory/2" &&
      !JSON.stringify(invJson2).includes(TESTENV.MY_O_MEMORY_HOME as string) &&
      !/"file":/.test(JSON.stringify(invJson2)),
    `${invJson2.format} ${JSON.stringify(invJson2).slice(0, 120)}`,
  );
  ok(
    "inventory json counts hidden without the entries",
    invJson2.hidden !== undefined && !("hiddenEntries" in invJson2),
  );
}

console.log("\n================ SUMMARY ================");
console.log(`pass: ${pass}, fail: ${fail}`);
if (failures.length) { console.log("failed tests:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
