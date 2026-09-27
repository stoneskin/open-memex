// `open-memex init` — one-command project setup (§17 adoption path).
// Pure file operation: no DB, no network. Safe to run in any directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "<!-- open-memex -->";

const INSTRUCTIONS = `${MARKER}
# OpenMemex memory

You have a local memory MCP server (\`open-memex\`) with five tools:
\`memory_add\`, \`memory_search\`, \`memory_list\`, \`memory_supersede\`, \`memory_forget\`.

- Before answering questions about past decisions, conventions, or user preferences,
  call \`memory_search\` first.
- When the user shares something worth remembering (a decision, a preference,
  a fact about their setup), call \`memory_add\`.
- Memories are scoped to this project; personal memories live in the personal scope.
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
  section["open-memex"] =
    client === "cursor"
      ? { command: "open-memex", args: ["mcp"] }
      : {
          type: "stdio",
          command: "open-memex",
          args: ["mcp"],
          cwd: "${workspaceFolder}",
        };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file}`);
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
