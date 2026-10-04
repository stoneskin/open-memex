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
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(REPO, "dist", "cli.js");
const MCP_TS = path.join(REPO, "src", "mcp.ts");

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

// ---------- 7. pull / push ----------
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

// ---------- 8. migrate / reindex ----------
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

// ---------- 9. capture / doctor / mcp --print-config / init ----------
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

// ---------- 10. MCP: all 11 tools + session-start instructions ----------
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

console.log("\n================ SUMMARY ================");
console.log(`pass: ${pass}, fail: ${fail}`);
if (failures.length) { console.log("failed tests:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
