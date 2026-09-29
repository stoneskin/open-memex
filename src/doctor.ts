// `open-memex doctor` — environment health checks.
//
// Read-only except that paths() and the MCP handshake may create the (empty)
// data directories, exactly like a normal `open-memex mcp` start would.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, configSource, DEFAULT_CONFIG } from "./config.ts";
import { paths } from "./paths.ts";
import { resolveCwdScope } from "./scope.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const EXPECTED_TOOLS = [
  "memory_add",
  "memory_search",
  "memory_list",
  "memory_supersede",
  "memory_forget",
];

function nodeCheck(): Check {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 6);
  return {
    name: "node",
    ok,
    detail: `v${process.versions.node} (need >= 22.6 for --experimental-strip-types)`,
  };
}

function configCheck(): Check {
  try {
    const cfg = loadConfig();
    const src = configSource();
    const customized = (Object.keys(DEFAULT_CONFIG) as (keyof typeof DEFAULT_CONFIG)[]).filter(
      (k) => JSON.stringify(cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k]),
    );
    const detail =
      (src ?? "built-in defaults") +
      (customized.length > 0 ? ` — customized: ${customized.join(", ")}` : "");
    return { name: "config", ok: true, detail };
  } catch (err) {
    return { name: "config", ok: false, detail: String(err) };
  }
}

function scopeCheck(): Check {
  try {
    const s = resolveCwdScope(process.cwd());
    return { name: "scope", ok: true, detail: `cwd → ${s.kind} scope "${s.key}"` };
  } catch (err) {
    return { name: "scope", ok: false, detail: String(err) };
  }
}

function storageCheck(): Check {
  try {
    const p = paths();
    fs.accessSync(p.memories, fs.constants.W_OK);
    return { name: "storage", ok: true, detail: `${p.root} (writable)` };
  } catch (err) {
    return { name: "storage", ok: false, detail: String(err) };
  }
}

/** Spawn the real MCP server, handshake, and verify the five tools list. */
function mcpCheck(): Promise<Check> {
  const name = "mcp";
  return new Promise((resolve) => {
    // D21: the installed package runs compiled JS from dist/ (Node refuses
    // --experimental-strip-types for files under node_modules), while a source
    // checkout runs src/ directly. Resolve the server entry the same way this
    // file itself is running.
    const here = fileURLToPath(import.meta.url);
    const fromDist = here.endsWith(`dist${path.sep}doctor.js`);
    const server = fromDist
      ? path.join(path.dirname(here), "mcp.js")
      : path.join(path.dirname(path.dirname(here)), "src", "mcp.ts");
    if (!fs.existsSync(server)) {
      resolve({ name, ok: false, detail: `server entry not found: ${server}` });
      return;
    }
    const child = spawn(
      process.execPath,
      fromDist ? [server] : ["--experimental-strip-types", server],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const done = (c: Check) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(c);
    };
    const timer = setTimeout(
      () => done({ name, ok: false, detail: "handshake timed out after 20s" }),
      20000,
    );

    let buf = "";
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON lines on stdout
        }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
          done({
            name,
            ok: missing.length === 0,
            detail:
              missing.length === 0
                ? `handshake OK, ${names.length} tools listed (${names.join(", ")})`
                : `missing tools: ${missing.join(", ")}`,
          });
        }
      }
    });
    child.on("error", (err) =>
      done({ name, ok: false, detail: `spawn failed: ${(err as Error).message}` }),
    );
    // Server stderr is its own log; not a doctor failure signal.

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "open-memex-doctor", version: "0.0.0" },
      },
    });
  });
}

export async function runDoctor(): Promise<boolean> {
  console.log("open-memex doctor");
  const checks: Check[] = [nodeCheck(), configCheck(), scopeCheck(), storageCheck()];
  checks.push(await mcpCheck());
  let allOk = true;
  for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(allOk ? "All checks passed." : "Some checks failed — see above.");
  return allOk;
}
