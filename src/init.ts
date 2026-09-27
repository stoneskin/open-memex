// `open-memex init` — one-command project setup (§17 adoption path).
// Pure file operation: no DB, no network. Safe to run in any directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { DEFAULT_CONFIG, saveConfig } from "./config.ts";

const MARKER = "<!-- open-memex -->";

/** npm dist-tag carrying the 0.3.x preview line. */
const ALPHA_TAG = "open-memex@alpha";

export interface McpCommand {
  command: string;
  args: string[];
  /** false when no durable bin exists (e.g. one-shot npx) and we fell back to npx. */
  durable: boolean;
}

/**
 * Resolve the MCP server command to write into client configs.
 *
 * A one-shot `npx open-memex@alpha init` runs from npm's ephemeral `_npx` cache,
 * so `open-memex` resolving on PATH *inside that process* does not mean it will be
 * there tomorrow. Only a bin found on PATH outside `_npx` cache dirs counts as
 * durable; otherwise fall back to an npx-based command (slower startup, zero install).
 */
export function resolveMcpCommand(): McpCommand {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter((d) => d && !d.includes("_npx"));
  const names = process.platform === "win32" ? ["open-memex.cmd", "open-memex"] : ["open-memex"];
  const durable = dirs.some((d) =>
    names.some((n) => {
      try {
        return fs.existsSync(path.join(d, n));
      } catch {
        return false;
      }
    }),
  );
  if (durable) return { command: "open-memex", args: ["mcp"], durable: true };
  return { command: "npx", args: ["-y", ALPHA_TAG, "mcp"], durable: false };
}

const INSTRUCTIONS = `${MARKER}
# OpenMemex memory

You have a local memory MCP server (\`open-memex\`) with five tools:
\`memory_add\`, \`memory_search\`, \`memory_list\`, \`memory_supersede\`, \`memory_forget\`.

- BE PROACTIVE. When the user shares something worth remembering across sessions
  (a decision, a preference, a project convention, a fix and its cause), call
  \`memory_add\` without being asked. Keep each memory to one self-contained statement.
- Before asking the user about past decisions, conventions, or preferences they may
  have told you before, call \`memory_search\` first — try a few keyword variants
  (including the user's own language) when the first search comes up empty.
- Memories default to this project's scope; use the \`personal\` scope for facts about
  the user that hold across all projects. When a saved fact becomes outdated, call
  \`memory_supersede\` instead of adding a duplicate.
`;

/** Project root: git top-level, falling back to cwd. */
function projectRoot(): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    /* not a git repo — use cwd */
  }
  return process.cwd();
}

function writeMcpJson(root: string, client: string, force: boolean): string | null {
  if (client === "opencode") return writeOpencodeMcpJson(root, force);
  if (client === "visualstudio") return writeVisualStudioMcpJson(root, force);
  const dir = client === "cursor" ? path.join(root, ".cursor") : path.join(root, ".vscode");
  const file = path.join(dir, "mcp.json");
  const sectionKey = client === "cursor" ? "mcpServers" : "servers";

  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      return null;
    }
  }

  const section = ((doc[sectionKey] ??= {}) as Record<string, unknown>);
  if (section["open-memex"] && !force) {
    console.log(`  = ${file} already configures open-memex — left as is (use --force to overwrite)`);
    return file;
  }
  // D17: resolve the server command at init time — a one-shot npx leaves no bin behind.
  const mc = resolveMcpCommand();
  section["open-memex"] =
    client === "cursor"
      ? { command: mc.command, args: mc.args }
      : {
          type: "stdio",
          command: mc.command,
          args: mc.args,
          cwd: "${workspaceFolder}",
        };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file}`);
  if (!mc.durable) {
    console.log(`  ! no durable \`open-memex\` on PATH (one-shot npx?) — wrote an npx-based command.`);
    console.log(`    For faster startup: \`npm i -g ${ALPHA_TAG}\`, then re-run \`open-memex init --force\`.`);
  }
  return file;
}

/** opencode MCP config: project-level opencode.jsonc, `type: "local"` + command array (v1 format). */
function writeOpencodeMcpJson(root: string, force: boolean): string | null {
  const file = path.join(root, "opencode.jsonc");
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      return null;
    }
  }
  const section = ((doc["mcp"] ??= {}) as Record<string, unknown>);
  if (section["open-memex"] && !force) {
    console.log(`  = ${file} already configures open-memex — left as is (use --force to overwrite)`);
    return file;
  }
  // D17: resolve the server command at init time — a one-shot npx leaves no bin behind.
  const mc = resolveMcpCommand();
  section["open-memex"] = {
    type: "local",
    command: [mc.command, ...mc.args],
    enabled: true,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file}`);
  if (!mc.durable) {
    console.log(`  ! no durable \`open-memex\` on PATH (one-shot npx?) — wrote an npx-based command.`);
    console.log(`    For faster startup: \`npm i -g ${ALPHA_TAG}\`, then re-run \`open-memex init --force\`.`);
  }
  return file;
}

/** Visual Studio (Windows-only, 2022 17.14+ / 2026): solution-level `.mcp.json`
 * with the `"servers"` section, per Microsoft Learn. Source-controllable.
 * (VS also auto-discovers `.vscode/mcp.json` and `.cursor/mcp.json`.) */
function writeVisualStudioMcpJson(root: string, force: boolean): string | null {
  const file = path.join(root, ".mcp.json");
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      return null;
    }
  }
  const section = ((doc["servers"] ??= {}) as Record<string, unknown>);
  if (section["open-memex"] && !force) {
    console.log(`  = ${file} already configures open-memex — left as is (use --force to overwrite)`);
    return file;
  }
  // D17: resolve the server command at init time — a one-shot npx leaves no bin behind.
  const mc = resolveMcpCommand();
  section["open-memex"] = {
    type: "stdio",
    command: mc.command,
    args: mc.args,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file}`);
  if (!mc.durable) {
    console.log(`  ! no durable \`open-memex\` on PATH (one-shot npx?) — wrote an npx-based command.`);
    console.log(`    For faster startup: \`npm i -g ${ALPHA_TAG}\`, then re-run \`open-memex init --force\`.`);
  }
  return file;
}

function writeInstructions(root: string): string {
  const dir = path.join(root, ".github");
  const file = path.join(dir, "copilot-instructions.md");
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.includes(MARKER)) {
      console.log(`  = ${file} already has open-memex instructions — left as is`);
      return file;
    }
    fs.writeFileSync(file, cur.replace(/\s+$/, "") + "\n\n" + INSTRUCTIONS);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, INSTRUCTIONS);
  }
  console.log(`  + ${file}`);
  return file;
}

export const INIT_CLIENTS = ["vscode", "cursor", "opencode", "visualstudio"] as const;

/** Normalize --client values; accepts "visual-studio" as an alias. */
export function normalizeClient(c: string): string {
  const lower = c.toLowerCase();
  return lower === "visual-studio" ? "visualstudio" : lower;
}

/** Ask a yes/no question. Only called on a TTY when --yes was not passed. */
async function askBool(q: string, def: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = def ? "Y/n" : "y/N";
    const ans = (await rl.question(`${q} [${hint}]: `)).trim().toLowerCase();
    if (!ans) return def;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

async function promptClient(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (
      await rl.question(
        "Which editor? (1) VS Code  (2) Cursor  (3) opencode  (4) Visual Studio  (5) skip [1]: ",
      )
    ).trim();
    switch (ans) {
      case "":
      case "1":
        return "vscode";
      case "2":
        return "cursor";
      case "3":
        return "opencode";
      case "4":
        return "visualstudio";
      case "5":
        return null;
      default:
        console.log(`  ? unknown choice "${ans}" — editor setup skipped`);
        return null;
    }
  } finally {
    rl.close();
  }
}

export async function initProject(opts: {
  client?: string;
  force: boolean;
  yes: boolean;
}): Promise<void> {
  const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  let client = normalizeClient(opts.client ?? "");
  if (client && !(INIT_CLIENTS as readonly string[]).includes(client)) {
    console.error(`unknown client "${opts.client}" (${INIT_CLIENTS.join("|")})`);
    process.exit(1);
  }
  if (!client && interactive) client = (await promptClient()) ?? "";
  if (!client && !interactive) client = "vscode"; // historical default for scripts / one-shot npx
  if (interactive) {
    // Install-time settings (D19). Non-default answers persist to the JSONC
    // config file; `open-memex config set` changes them later.
    const patch: Record<string, unknown> = {};
    const keywordCaptureEnabled = await askBool(
      "Auto-capture keywords like remember… / note that… into memory?",
      DEFAULT_CONFIG.keywordCaptureEnabled,
    );
    if (keywordCaptureEnabled !== DEFAULT_CONFIG.keywordCaptureEnabled)
      patch.keywordCaptureEnabled = keywordCaptureEnabled;
    const injectOnFirstTurn = await askBool(
      "Inject relevant memories when a session starts?",
      DEFAULT_CONFIG.injectOnFirstTurn,
    );
    if (injectOnFirstTurn !== DEFAULT_CONFIG.injectOnFirstTurn)
      patch.injectOnFirstTurn = injectOnFirstTurn;
    if (Object.keys(patch).length > 0) {
      const file = saveConfig(patch);
      console.log(
        `  + settings saved to ${file} (change later with \`open-memex config set <key> <value>\`)`,
      );
    }
  }
  const root = projectRoot();
  console.log(`open-memex init — project root: ${root}`);
  if (client) {
    writeMcpJson(root, client, opts.force);
    // copilot-instructions.md is VS Code/Cursor-shaped; opencode as a plain MCP
    // consumer already gets the guidance from the tool descriptions (D16).
    if (client !== "opencode") writeInstructions(root);
  } else {
    console.log("  - editor setup skipped");
  }
  console.log(`\nDone. Reload your editor window to start the open-memex MCP server.`);
}
