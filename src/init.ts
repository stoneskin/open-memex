// `open-memex init` — one-command project setup (§17 adoption path).
// Pure file operation: no DB, no network. Safe to run in any directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

export async function initProject(opts: { client: string; force: boolean }): Promise<void> {
  const client = opts.client.toLowerCase();
  if (client !== "vscode" && client !== "cursor") {
    console.error(`unknown client "${opts.client}" (vscode|cursor)`);
    process.exit(1);
  }
  const root = projectRoot();
  console.log(`open-memex init — project root: ${root}`);
  writeMcpJson(root, client, opts.force);
  writeInstructions(root);
  console.log(`\nDone. Reload your editor window to start the open-memex MCP server.`);
}
