// `open-memex doctor` — environment health checks.
//
// Read-only except that paths() and the MCP handshake may create the (empty)
// data directories, exactly like a normal `open-memex mcp` start would.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, configSource, DEFAULT_CONFIG } from "./config.ts";
import { paths } from "./paths.ts";
import { resolveCwdScope } from "./scope.ts";
import { LEGACY_PACKAGE_NAME, opencodeGlobalConfigPath, userMcpConfigPath } from "./init.ts";

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

/** Parse JSON tolerating line/block comments plus trailing commas
 * (VS Code's settings.json is JSONC). Health-check grade, not a full parser. */
function parseLenientJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* fall through to comment stripping */
  }
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < raw.length) {
    const c = raw[i];
    const n = raw[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(out) as Record<string, unknown>;
}

function vscodeSettingsPath(): string | null {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    return appdata ? path.join(appdata, "Code", "User", "settings.json") : null;
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "settings.json");
  }
  return path.join(home, ".config", "Code", "User", "settings.json");
}

/** True when a Windows system policy disables MCP (value name contains "mcp",
 * data is 0/0x0/false). Checks HKLM and HKCU policy keys. */
function windowsMcpPolicyDisabled(): string | null {
  if (process.platform !== "win32") return null;
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const stdout = execFileSync(
        "reg",
        ["query", `${hive}\\SOFTWARE\\Policies\\Microsoft\\VSCode`],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
      ) as string;
      for (const line of stdout.split("\n")) {
        const m = line.match(/^\s{2,}(\S+)\s+REG_\w+\s+(\S+)/);
        if (m && /mcp/i.test(m[1]) && /^(0x0|0|false)$/i.test(m[2])) {
          return `${hive}\\SOFTWARE\\Policies\\Microsoft\\VSCode!${m[1]}`;
        }
      }
    } catch {
      /* policy key absent — no policy */
    }
  }
  return null;
}

function settingsMcpDisabled(file: string): boolean {
  try {
    const parsed = parseLenientJson(fs.readFileSync(file, "utf8"));
    return parsed["chat.mcp.enabled"] === false;
  } catch {
    return false; // unreadable file: don't claim anything
  }
}

/** VS Code ignores MCP server entries entirely when MCP is switched off —
 * either in settings.json or, on managed machines, by system policy. */
function vscodeMcpCheck(): Check {
  const name = "vscode-mcp";
  const policyHit = windowsMcpPolicyDisabled();
  if (policyHit) {
    return {
      name,
      ok: false,
      detail:
        `MCP is disabled by system policy (${policyHit}) — managed by your organization. ` +
        `VS Code will ignore open-memex's MCP entry on this machine.`,
    };
  }
  const files: string[] = [];
  const user = vscodeSettingsPath();
  if (user) files.push(user);
  const ws = path.join(process.cwd(), ".vscode", "settings.json");
  if (!files.includes(ws)) files.push(ws);
  const found: string[] = [];
  const disabled: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    found.push(f);
    if (settingsMcpDisabled(f)) disabled.push(f);
  }
  if (disabled.length > 0) {
    return {
      name,
      ok: false,
      detail:
        `chat.mcp.enabled is false in ${disabled.join(", ")} — VS Code will not load ` +
        `MCP servers. Set it to true (or ask IT if the setting shows as managed).`,
    };
  }
  return {
    name,
    ok: true,
    detail:
      found.length > 0
        ? `MCP enabled (checked ${found.join(", ")})`
        : "VS Code settings not found on this machine — nothing to check",
  };
}

export async function runDoctor(): Promise<boolean> {
  console.log("open-memex doctor");
  const checks: Check[] = [nodeCheck(), configCheck(), scopeCheck(), storageCheck(), vscodeMcpCheck()];
  checks.push(await mcpCheck());
  checks.push(legacyCheck());
  let allOk = true;
  for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(allOk ? "All checks passed." : "Some checks failed — see above.");
  return allOk;
}

/**
 * F30: the my-o-memory → open-memex rename left configs and data behind that
 * silently split memories across two data dirs (the exact trap: the old
 * opencode plugin kept loading and writing to the OLD dir). Read-only.
 */
function legacyCheck(): Check {
  const name = "legacy my-o-memory";
  const found: string[] = [];
  const envHome = process.env.MY_O_MEMORY_HOME;
  if (envHome && envHome.includes(LEGACY_PACKAGE_NAME))
    found.push(
      `MY_O_MEMORY_HOME points at a pre-rename dir (${envHome}) — unset it, then merge old data with \`open-memex migrate --to-v2\``,
    );
  const root = paths().root;
  const legacyDir = path.join(path.dirname(root), LEGACY_PACKAGE_NAME);
  if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory())
    found.push(`legacy data dir ${legacyDir} — merge it with \`open-memex migrate --to-v2\``);
  for (const f of [opencodeGlobalConfigPath(), userMcpConfigPath("vscode"), userMcpConfigPath("cursor")]) {
    try {
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(LEGACY_PACKAGE_NAME))
        found.push(`stale "${LEGACY_PACKAGE_NAME}" reference in ${f} — re-run \`open-memex init --force --yes\``);
    } catch {
      /* unreadable — not this check's problem */
    }
  }
  return found.length === 0
    ? { name, ok: true, detail: "no pre-rename leftovers found" }
    : { name, ok: false, detail: found.join("; ") };
}
