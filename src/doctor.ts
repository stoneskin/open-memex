// `open-memex doctor` — environment health checks.
//
// Read-only except that paths() and the MCP handshake may create the (empty)
// data directories, exactly like a normal `open-memex mcp` start would.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, configSource, DEFAULT_CONFIG, stripJsonComments } from "./config.ts";
import { paths, homeOverride } from "./paths.ts";
import { resolveCwdScope } from "./scope.ts";
import { db, backendName } from "./store/db.ts";
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
    // D62: when the root came from the legacy env var, say so (still ok —
    // the fallback is supported, doctor just names the current one).
    const via = homeOverride()?.via;
    const note =
      via === "MY_O_MEMORY_HOME"
        ? " (via legacy MY_O_MEMORY_HOME — OPEN_MEMEX_HOME is the current name)"
        : "";
    return { name: "storage", ok: true, detail: `${p.root} (writable)${note}` };
  } catch (err) {
    return { name: "storage", ok: false, detail: String(err) };
  }
}

/**
 * D57: several processes share one index (CLI, MCP per editor, opencode
 * plugin). WAL + a 5s busy timeout is what keeps an overlapping write a
 * brief wait instead of an instant failure — report the live settings.
 */
function lockingCheck(): Check {
  try {
    const d = db();
    const jm = (d.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const bt = (d.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    const ok = jm === "wal" && bt >= 1000;
    return {
      name: "locking",
      ok,
      detail: `journal=${jm}, busy_timeout=${bt}ms (${backendName()})`,
    };
  } catch (err) {
    return { name: "locking", ok: false, detail: String(err) };
  }
}

/**
 * D59/D60: patrol the opencode native-plugin entries. The D58 field failure
 * was silent — the entry was configured, the host never loaded it, and
 * nothing anywhere said why. Death modes to catch:
 *   1. the entry's target does not exist (package moved, nvm rolled to a
 *      new version dir, checkout deleted);
 *   2. the plugin's import closure runtime-imports a host SDK package
 *      (@opencode-ai/plugin on v1, @opencode/plugin on v2) — unresolvable
 *      from a global install, the host silently skips the plugin (D58);
 *   3. (D60) the config wires only the other host generation: an
 *      opencode 2 host never reads the v1 `plugin` file entry (it demands
 *      a directory under `plugins`), and opencode 1 cannot read `plugins`.
 * Read-only; only inspects the user-level opencode configs.
 */
function opencodePluginCheck(): Check {
  const name = "opencode plugin";
  try {
    const jsonPath = opencodeGlobalConfigPath();
    const candidates = [jsonPath, jsonPath.replace(/\.json$/, ".jsonc")];
    const v1Entries: string[] = [];
    const v2Entries: string[] = [];
    let sawConfig = false;
    const v2EntryPackage = (entry: unknown): string | null => {
      if (typeof entry === "string") return entry;
      if (entry !== null && typeof entry === "object" && "package" in entry) {
        const p = (entry as { package?: unknown }).package;
        return typeof p === "string" ? p : null;
      }
      return null;
    };
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      sawConfig = true;
      const text = fs.readFileSync(f, "utf8");
      try {
        const doc = JSON.parse(text) as { plugin?: unknown; plugins?: unknown };
        if (Array.isArray(doc.plugin)) {
          for (const e of doc.plugin) if (typeof e === "string") v1Entries.push(e);
        }
        if (Array.isArray(doc.plugins)) {
          for (const e of doc.plugins) {
            const p = v2EntryPackage(e);
            if (p !== null) v2Entries.push(p);
          }
        }
      } catch {
        // JSONC (comments/trailing commas): fall back to scanning quoted
        // strings for plugin entries.
        for (const m of text.matchAll(/"(file:[^"]+|[^"]+\.(?:ts|js|mts|mjs))"/g)) {
          v1Entries.push(m[1]!);
        }
      }
    }
    if (!sawConfig) {
      return { name, ok: true, detail: "no global opencode config found (skipped)" };
    }

    const problems: string[] = [];
    // Host SDK packages per generation; a runtime import of either from a
    // globally installed plugin cannot resolve (D58).
    const RUNTIME_SDK_IMPORT =
      /^\s*import\s+(?!type\b)[^;]*?["']@opencode(?:-ai)?\/plugin(?:\/[^"']*)?["']/m;
    const RUNTIME_SDK_REQUIRE = /require\(\s*["']@opencode(?:-ai)?\/plugin(?:\/[^"']*)?["']\s*\)/;

    const toPath = (entry: string): string | null => {
      try {
        return entry.startsWith("file:") ? fileURLToPath(entry) : entry;
      } catch {
        return null;
      }
    };
    // An entry is ours when its path names the package, or when the target
    // file carries the plugin's "[open-memex]" log marker (source checkouts
    // can live at any path).
    const fileHasMarker = (target: string): boolean => {
      try {
        return fs.readFileSync(target, "utf8").slice(0, 65536).includes("[open-memex]");
      } catch {
        return false;
      }
    };
    /** Resolve an OpenCode 2 directory entry to its entry file, if any. */
    const resolveV2EntryFile = (target: string): string | null => {
      try {
        if (!fs.existsSync(target)) return null;
        if (fs.statSync(target).isFile()) return target;
        for (const idx of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
          const p = path.join(target, idx);
          if (fs.existsSync(p)) return p;
        }
        const pkgJson = path.join(target, "package.json");
        if (fs.existsSync(pkgJson)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { main?: unknown };
          if (typeof pkg.main === "string") {
            const main = path.join(target, pkg.main);
            if (fs.existsSync(main)) return main;
          }
        }
      } catch {
        return null;
      }
      return null;
    };
    const isOursV1 = (entry: string): boolean => {
      if (entry.includes("open-memex")) return true;
      const target = toPath(entry);
      return target !== null && fs.existsSync(target) && fileHasMarker(target);
    };
    const isOursV2 = (entry: string): boolean => {
      if (entry.includes("open-memex")) return true;
      const target = toPath(entry);
      if (target === null) return false;
      const file = resolveV2EntryFile(target);
      return file !== null && fileHasMarker(file);
    };
    const scanSdkImports = (entryFile: string): string[] => {
      // Walk the entry's relative-import closure looking for host-SDK
      // runtime imports (type-only imports are erased and fine).
      const offenders: string[] = [];
      const seen = new Set<string>();
      const queue = [entryFile];
      while (queue.length > 0 && seen.size < 300) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        let src: string;
        try {
          src = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (RUNTIME_SDK_IMPORT.test(src) || RUNTIME_SDK_REQUIRE.test(src)) {
          offenders.push(file);
        }
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
          const spec = m[1]!;
          const base = path.resolve(path.dirname(file), spec);
          for (const cand of [base, `${base}.ts`, `${base}.js`, path.join(base, "index.ts")]) {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              queue.push(cand);
              break;
            }
          }
        }
      }
      return offenders;
    };

    const oursV1 = v1Entries.filter(isOursV1);
    const oursV2 = v2Entries.filter(isOursV2);
    if (oursV1.length === 0 && oursV2.length === 0) {
      return { name, ok: true, detail: "no global plugin entry (per-project or MCP wiring is not checked)" };
    }
    for (const entry of oursV1) {
      const target = toPath(entry);
      if (target === null) {
        problems.push(`entry "${entry}" is not a parseable file URL`);
        continue;
      }
      if (!fs.existsSync(target)) {
        problems.push(
          `entry points at ${target}, which does not exist — run \`open-memex init --client opencode --global --force\` to re-point it`,
        );
        continue;
      }
      for (const f of scanSdkImports(target)) {
        problems.push(
          `${f} runtime-imports a host SDK package — opencode silently skips plugins whose imports it cannot resolve from a global install (D58)`,
        );
      }
    }
    for (const entry of oursV2) {
      // A bare package name ("open-memex" via `opencode plugin add`) is
      // resolved by the host's plugin manager; there is no local path to
      // verify.
      const isPackageName =
        !entry.startsWith("file:") &&
        !entry.startsWith(".") &&
        !path.isAbsolute(entry) &&
        !/^[a-zA-Z]:[\\/]/.test(entry);
      if (isPackageName) continue;
      const target = toPath(entry);
      if (target === null || !fs.existsSync(target)) {
        problems.push(
          `opencode 2 entry "${entry}" does not resolve to an existing path — run \`open-memex init --client opencode --global --force\` to re-point it`,
        );
        continue;
      }
      const entryFile = resolveV2EntryFile(target);
      if (entryFile === null) {
        problems.push(
          `opencode 2 entry "${entry}" has no loadable plugin file (looked for index.ts/index.js and package.json main)`,
        );
        continue;
      }
      for (const f of scanSdkImports(entryFile)) {
        problems.push(
          `${f} runtime-imports a host SDK package — opencode silently skips plugins whose imports it cannot resolve from a global install (D58)`,
        );
      }
    }

    // D60: generation mismatch — the config wires only the generation the
    // installed host cannot read. Best-effort: no binary, no opinion.
    let hostMajor: number | null = null;
    try {
      const out = execFileSync("opencode", ["--version"], {
        timeout: 3000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) hostMajor = Number(m[1]);
    } catch {
      hostMajor = null;
    }
    if (hostMajor !== null && hostMajor >= 2 && oursV1.length > 0 && oursV2.length === 0) {
      problems.push(
        `the installed opencode is v${hostMajor} but the config only has the opencode 1 "plugin" entry — v2 loads directories from "plugins" and will silently skip this plugin; run \`open-memex init --client opencode --global --force\` to add the v2 entry`,
      );
    } else if (hostMajor === 1 && oursV2.length > 0 && oursV1.length === 0) {
      problems.push(
        `the installed opencode is v1 but the config only has the opencode 2 "plugins" entry — v1 reads the "plugin" key and will not load this plugin; run \`open-memex init --client opencode --global --force\` to add the v1 entry`,
      );
    }

    if (problems.length > 0) {
      return { name, ok: false, detail: problems.join("; ") };
    }
    return {
      name,
      ok: true,
      detail: `${oursV1.length + oursV2.length} plugin ${oursV1.length + oursV2.length === 1 ? "entry" : "entries"}: target exists, no host-SDK runtime imports`,
    };
  } catch (err) {
    return { name, ok: false, detail: String(err) };
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
 * (VS Code's settings.json is JSONC). Uses config.ts's string-aware
 * stripper — one parser, not two (P0 review, 2026-10-03). */
function parseLenientJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* fall through to comment stripping */
  }
  return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
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
  const checks: Check[] = [nodeCheck(), configCheck(), scopeCheck(), storageCheck(), lockingCheck(), opencodePluginCheck(), vscodeMcpCheck()];
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
  // D62: the override may arrive via either env var name; check the value
  // in effect, not just the legacy one.
  const envHome = homeOverride()?.dir;
  if (envHome && envHome.includes(LEGACY_PACKAGE_NAME))
    found.push(
      `memory home points at a pre-rename dir (${envHome}) — unset it, then merge old data with \`open-memex migrate --to-v2\``,
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
