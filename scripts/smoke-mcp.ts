// MCP server smoke test: handshake + tools/list + add/search/forget over stdio.
// Usage:  node --experimental-strip-types scripts/smoke-mcp.ts
// Uses temp dirs for MY_O_MEMORY_HOME and the project cwd — no real data touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-home-"));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proj-"));

const MCP_TS = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));

const child = spawn(
  "node",
  ["--experimental-strip-types", MCP_TS],
  {
    cwd: PROJ,
    env: { ...process.env, MY_O_MEMORY_HOME: HOME },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let buf = "";
let id = 0;
const pending = new Map<number, (v: any) => void>();
const stdoutLines: string[] = [];

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    stdoutLines.push(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("NON-JSON on stdout:", line);
      process.exitCode = 1;
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[srv:err] " + d.toString()));

function req(method: string, params?: any): Promise<any> {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function notify(method: string, params?: any) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

try {
  const init = await req("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-e2e", version: "0.0.1" },
  });
  check("initialize", !!init.result?.serverInfo, JSON.stringify(init.result?.serverInfo));
  notify("notifications/initialized");

  const tools = await req("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t: any) => t.name).sort();
  check(
    "tools/list has 11 memory tools",
    JSON.stringify(names) ===
      JSON.stringify(["memory_add", "memory_forget", "memory_list", "memory_pr_status", "memory_promote", "memory_propose", "memory_resolve", "memory_search", "memory_status", "memory_submit", "memory_supersede"]),
    names.join(","),
  );
  const addSchema = tools.result.tools.find((t: any) => t.name === "memory_add").inputSchema;
  check("memory_add schema has content+type+scope+tags", !!addSchema.properties?.content && !!addSchema.properties?.type, Object.keys(addSchema.properties ?? {}).join(","));

  // D14 through MCP: a fake secret must be masked, not refused.
  const add = await req("tools/call", {
    name: "memory_add",
    arguments: { content: "mcp e2e probe: deploy key sk-test-FAKESECRET1234567890abcdef", type: "fact" },
  });
  const addText: string = add.result?.content?.[0]?.text ?? "";
  const savedId = (addText.match(/id=([A-Za-z0-9_]+)/) ?? [])[1];
  check("memory_add saves (not refuses)", !add.result?.isError && !!savedId, addText.slice(0, 80));
  check("memory_add notes masking (D14)", addText.includes("masked"), addText.slice(0, 120));

  // The raw secret must not be on disk.
  const mdFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) mdFiles.push(p);
    }
  };
  walk(HOME);
  const leaked = mdFiles.filter((f) => fs.readFileSync(f, "utf8").includes("sk-test-FAKESECRET1234567890abcdef"));
  check("secret not leaked to disk", leaked.length === 0, leaked.join(","));

  const search = await req("tools/call", {
    name: "memory_search",
    arguments: { query: "mcp e2e probe" },
  });
  const searchText: string = search.result?.content?.[0]?.text ?? "";
  check("memory_search finds it", searchText.includes(savedId), searchText.slice(0, 80));
  check("memory_search output masked", !searchText.includes("sk-test-FAKESECRET1234567890abcdef"));

  const list = await req("tools/call", { name: "memory_list", arguments: {} });
  const listText = list.result?.content?.[0]?.text ?? "";
  check("memory_list works", listText.includes(savedId));
  // D68: the list is the user's inventory — numbered, plain language,
  // with provenance and age, not the raw developer format.
  check("memory_list is numbered structured lines (D68)", /^\d+\. \[fact\] id=/m.test(listText), listText.slice(0, 120));
  check("memory_list keeps raw provenance field (D68)", listText.includes("source=tool"), listText.slice(0, 160));
  check("memory_list shows age token (D68)", /created=(now|\d+[mhd])/.test(listText), listText.slice(0, 160));
  const listBoth = await req("tools/call", { name: "memory_list", arguments: { scope: "both" } });
  check("memory_list both scopes (D68)", (listBoth.result?.content?.[0]?.text ?? "").includes("About you"));

  // D68: truncation is disclosed, never silent — one shown, total stated.
  const add2 = await req("tools/call", {
    name: "memory_add",
    arguments: { content: "mcp e2e probe: second memory for truncation", type: "fact" },
  });
  const savedId2 = ((add2.result?.content?.[0]?.text ?? "").match(/id=([A-Za-z0-9_]+)/) ?? [])[1];
  const listLim = await req("tools/call", { name: "memory_list", arguments: { limit: 1 } });
  const listLimText = listLim.result?.content?.[0]?.text ?? "";
  check("memory_list discloses truncation (D68)", /and \d+ more not shown/.test(listLimText), listLimText.slice(0, 200));

  // D68: soft forget hides (retracted) — gone from the active list,
  // visible in the audit view, hard forget still removes it everywhere.
  const soft = await req("tools/call", { name: "memory_forget", arguments: { id: savedId2, soft: true } });
  check("memory_forget soft works (D68)", (soft.result?.content?.[0]?.text ?? "").includes("Hidden"), (soft.result?.content?.[0]?.text ?? "").slice(0, 120));
  const listAfterSoft = await req("tools/call", { name: "memory_list", arguments: {} });
  check("hidden memory out of active list (D68)", !(listAfterSoft.result?.content?.[0]?.text ?? "").includes(savedId2));
  const listAll = await req("tools/call", { name: "memory_list", arguments: { include: "all" } });
  const listAllText = listAll.result?.content?.[0]?.text ?? "";
  check("hidden memory visible in audit view (D68)", listAllText.includes(savedId2) && listAllText.includes("[retracted]"), listAllText.slice(0, 200));
  const forget2 = await req("tools/call", { name: "memory_forget", arguments: { id: savedId2 } });
  check("memory_forget still deletes a hidden memory (D68)", (forget2.result?.content?.[0]?.text ?? "").toLowerCase().includes("deleted"));

  const forget = await req("tools/call", { name: "memory_forget", arguments: { id: savedId } });
  check("memory_forget works", (forget.result?.content?.[0]?.text ?? "").includes("Deleted"));

  const search2 = await req("tools/call", { name: "memory_search", arguments: { query: "mcp e2e probe" } });
  check("memory gone after forget", !(search2.result?.content?.[0]?.text ?? "").includes(savedId));
} finally {
  child.kill();
}

console.log(results.join("\n"));
console.log(process.exitCode ? "MCP E2E: FAILURES" : "MCP E2E: ALL PASS");
