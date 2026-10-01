// `open-memex init` — one-command project setup (§17 adoption path).
// Pure file operation: no DB, no network. Safe to run in any directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, saveConfig } from "./config.ts";
import { projectRoot } from "./paths.ts";
import { markFirstRunDone, clearFirstRunMarker } from "./first-run.ts";

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

> Applies only when the \`open-memex\` MCP server is available in this session
> (the \`memory_*\` tools exist). Otherwise ignore this section.

You have a local memory MCP server (\`open-memex\`) with eleven tools:
\`memory_add\`, \`memory_search\`, \`memory_list\`, \`memory_supersede\`, \`memory_forget\`,
\`memory_status\`, \`memory_submit\`, \`memory_propose\`, \`memory_promote\`, \`memory_resolve\`,
\`memory_pr_status\`.

- BE PROACTIVE. When the user shares something worth remembering across sessions
  (a decision, a preference, a project convention, a fix and its cause), call
  \`memory_add\` without being asked. Keep each memory to one self-contained statement.
- At checkpoints (session start, end of a work chunk, after the user commits, after
  any memory_* action), DISTILL the session: propose 1–3 short memories capturing the
  useful conclusion — what was learned or decided, how an issue was resolved, what to
  avoid, where the authoritative doc lives — not the raw transcript. Save NOTHING the
  user did not approve; on approval call \`memory_add\` with source "inference" at the
  confirmed scope. If the knowledge already lives in project docs, save a \`reference\`
  memory pointing at the doc instead of copying it. Long-form notes are fine ONLY when
  the user explicitly asks to save one.
- Before asking the user about past decisions, conventions, or preferences they may
  have told you before, call \`memory_search\` first — try a few keyword variants
  (including the user's own language) when the first search comes up empty.
- Memories default to this project's scope; use the \`personal\` scope for facts about
  the user that hold across all projects. When a saved fact becomes outdated, call
  \`memory_supersede\` instead of adding a duplicate.

## Syncing project memories for review (D26)

Project memories you save land in a local outbox first — they are NOT in git yet.
Syncing them into the repo for review is an explicit, user-approved step:

- At session start, when you finish a meaningful chunk of work, after the user
  commits (git commit), and after any memory_* action completes, call
  \`memory_status\`. If the outbox has drafts, summarize them (one line each) and ask
  the user which ones to sync. Sync NOTHING the user did not name.
- When the user says "sync memory" (or "同步记忆"), treat it as a request to run
  the sync flow above: call \`memory_status\`, summarize the outbox drafts, and ask
  which ones to sync.
- When the user approves, call \`memory_submit\` with the approved ids. It copies
  the drafts into the repo as \`proposed\`, commits locally on the CURRENT branch,
  and prints the push + PR commands. It NEVER creates a branch on its own.
- After the submit, ask ONE follow-up: "want me to create a branch + push +
  open the PR, or will you handle it yourself?" A "yes, you do it" answer covers
  the whole chain — branch creation, push, PR creation — do NOT re-ask at each
  step. If the user says they will do it themselves, hand them the printed
  push/PR commands and do nothing. NEVER create branches, push, or open PRs
  without their explicit approval.
- Base branch for the memory PR defaults to the branch you are on; the user may
  redirect it to the integration branch (main) for branch-independent knowledge.
- If anything conflicts (same id with different content, push rejected), STOP and
  let the user judge — never overwrite.
- After the PR merges, call \`memory_pr_status\` (with \`apply\` when the user
  approves) to map the PR's review state back onto each memory — merged means
  \`published\`, an approval means \`approved\` (credited to the reviewer).
- \`personal\` scope memories NEVER leave the machine.
`;

function writeMcpJson(root: string, client: string, force: boolean): string | null {
  if (client === "opencode") return writeOpencodeMcpJson(root, force);
  if (client === "visualstudio") return writeVisualStudioMcpJson(root, force);
  const dir = client === "cursor" ? path.join(root, ".cursor") : path.join(root, ".vscode");
  const file = path.join(dir, "mcp.json");
  const sectionKey = client === "cursor" ? "mcpServers" : "servers";
  const { entry, durable } = stdioServerEntry(client);
  const written = writeServerEntryFile(file, sectionKey, entry, force, true);
  if (written) warnNonDurable(durable);
  return written;
}

/**
 * D45: user-level MCP config path — `init --global` writes here so one init
 * covers all projects. `platform` and `home` are parameters (default: current)
 * so tests can cover all OS layouts without mocking.
 */
export function userMcpConfigPath(
  client: "vscode" | "cursor",
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (client === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "mcp.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, "Code", "User", "mcp.json");
}

/** The open-memex server entry, same shape init writes at project level. */
function stdioServerEntry(client: string): { entry: Record<string, unknown>; durable: boolean } {
  // D17: resolve the server command at init time — a one-shot npx leaves no bin behind.
  const mc = resolveMcpCommand();
  const entry: Record<string, unknown> =
    client === "cursor"
      ? { command: mc.command, args: mc.args }
      : {
          type: "stdio",
          command: mc.command,
          args: mc.args,
          // VS Code substitutes ${workspaceFolder} per window, so the server
          // starts with the open project as cwd and scope resolution just works.
          cwd: "${workspaceFolder}",
        };
  return { entry, durable: mc.durable };
}

/** Warn when init had to fall back to an npx-based server command. */
function warnNonDurable(durable: boolean): void {
  if (durable) return;
  console.log(`  ! no durable \`open-memex\` on PATH (one-shot npx?) — wrote an npx-based command.`);
  console.log(`    For faster startup: \`npm i -g ${ALPHA_TAG}\`, then re-run \`open-memex init --force\`.`);
}

/**
 * Pure merge of one server entry into a parsed config doc.
 * Returns "added" when the entry was written, "kept" when an entry already
 * existed and force was not set. Mutates `doc`.
 */
export function mergeServerEntry(
  doc: Record<string, unknown>,
  sectionKey: string,
  entry: Record<string, unknown>,
  force: boolean,
): "added" | "kept" {
  const section = ((doc[sectionKey] ??= {}) as Record<string, unknown>);
  if (section["open-memex"] && !force) return "kept";
  section["open-memex"] = entry;
  return "added";
}

/**
 * D46-followup: when a config file isn't valid JSON we leave it untouched —
 * but "fix it manually" alone isn't helpful. Print the exact snippet the
 * user needs to add by hand (same idea as the opencode --global hint).
 */
export function printManualEntryHint(sectionKey: string, entry: Record<string, unknown>): void {
  console.error(`    Add this under "${sectionKey}":`);
  const pretty = JSON.stringify({ "open-memex": entry }, null, 2).replace(/\n/g, "\n    ");
  console.error(`    ${pretty}`);
}

/**
 * Parse a JSON config file's raw text for merging. An empty or
 * whitespace-only file counts as `{}` — there is nothing to preserve, so
 * writers can safely populate it (an empty mcp.json is a normal first-run
 * state, e.g. created by the editor, not a corrupt file). Returns null when
 * the content is genuinely unparseable (e.g. JSONC comments) or not an
 * object, in which case the caller leaves the file untouched and prints the
 * manual step.
 */
export function parseJsonConfig(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  return doc as Record<string, unknown>;
}

/**
 * Read (or create) a JSON config file, merge the open-memex server entry, write
 * it back. Existing files are merged, never clobbered; invalid JSON is left
 * untouched. `mkdir` controls whether parent dirs are created (user-level
 * configs) or expected to exist via the project root.
 */
function writeServerEntryFile(
  file: string,
  sectionKey: string,
  entry: Record<string, unknown>,
  force: boolean,
  mkdir: boolean,
): string | null {
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseJsonConfig(fs.readFileSync(file, "utf8"));
    if (parsed === null) {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      printManualEntryHint(sectionKey, entry);
      return null;
    }
    doc = parsed;
  }
  const merged = mergeServerEntry(doc, sectionKey, entry, force);
  if (merged === "kept") {
    console.log(`  = ${file} already configures open-memex — left as is (use --force to overwrite)`);
    return file;
  }
  if (mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file}`);
  return file;
}

/** D45: `init --global` — one-time user-level wiring for VS Code / Cursor. */
function writeGlobalMcpJson(client: "vscode" | "cursor", force: boolean): string | null {
  const file = userMcpConfigPath(client);
  const sectionKey = client === "cursor" ? "mcpServers" : "servers";
  const { entry, durable } = stdioServerEntry(client);
  const written = writeServerEntryFile(file, sectionKey, entry, force, true);
  if (written) {
    warnNonDurable(durable);
    const projFile = client === "cursor" ? ".cursor/mcp.json" : ".vscode/mcp.json";
    console.log(`  i user-level config — the open-memex MCP server now starts in every project.`);
    console.log(`    (a per-project ${projFile} still wins if a project defines its own)`);
  }
  return written;
}

/** Where this installed copy's opencode native plugin entry point lives. */
function opencodePluginUrl(): string {
  // init.ts sits in <pkg>/src — the plugin entry is <pkg>/src/index.ts.
  const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return pathToFileURL(path.join(pkgRoot, "src", "index.ts")).href;
}

/**
 * D46: opencode's user-level config. opencode reads `~/.config/opencode/`
 * (`$XDG_CONFIG_HOME` when set) on every platform; a `plugin` entry there
 * loads open-memex in every project with no per-project init.
 */
export function opencodeGlobalConfigPath(home: string = os.homedir()): string {
  return path.join(opencodeConfigDir(home, process.env.XDG_CONFIG_HOME), "opencode.json");
}

/**
 * Pure merge of the open-memex plugin URL into a parsed opencode config doc.
 * Creates the `plugin` array when missing; never duplicates the URL.
 * Returns "added" when the doc changed, "kept" when already present.
 */
export function mergePluginEntry(
  doc: Record<string, unknown>,
  url: string,
  force: boolean,
): "added" | "kept" {
  let plugins = doc["plugin"];
  if (!Array.isArray(plugins)) {
    plugins = [] as unknown[];
    doc["plugin"] = plugins;
  }
  const list = plugins as unknown[];
  if (list.includes(url) && !force) return "kept";
  if (!list.includes(url)) list.push(url);
  return "added";
}

/**
 * D46: wire the native plugin at the opencode user level — the one-time
 * global setup. Merges into the existing config when it parses as JSON;
 * a file with comments (JSONC) is left untouched with a manual hint instead
 * of being clobbered.
 */
function writeOpencodeGlobalPlugin(force: boolean): string | null {
  const dir = path.dirname(opencodeGlobalConfigPath());
  const file =
    ["opencode.jsonc", "opencode.json"]
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f)) ?? path.join(dir, "opencode.json");
  const url = opencodePluginUrl();
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      console.log(`  ! ${file} has comments or invalid JSON — left untouched, fix it manually.`);
      console.log(`    To enable open-memex everywhere, add "plugin": ["${url}"] to it.`);
      return null;
    }
  }
  if (mergePluginEntry(doc, url, force) === "kept") {
    console.log(`  = ${file} already loads the open-memex plugin — left as is (use --force to overwrite)`);
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  + ${file} (native plugin — works in every project, no per-project init needed)`);
  return file;
}

/** opencode MCP config: project-level opencode.jsonc, `type: "local"` + command array (v1 format). */
function writeOpencodeMcpJson(root: string, force: boolean): string | null {
  const file = path.join(root, "opencode.jsonc");
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = parseJsonConfig(fs.readFileSync(file, "utf8"));
    if (parsed === null) {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      const mc = resolveMcpCommand();
      printManualEntryHint("mcp", {
        type: "local",
        command: [mc.command, ...mc.args],
        enabled: true,
      });
      return null;
    }
    doc = parsed;
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
    const parsed = parseJsonConfig(fs.readFileSync(file, "utf8"));
    if (parsed === null) {
      console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
      const mc = resolveMcpCommand();
      printManualEntryHint("servers", {
        type: "stdio",
        command: mc.command,
        args: mc.args,
      });
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

function writeInstructions(
  root: string,
  scope: "personal" | "project",
  client: string,
): string {
  const file =
    scope === "project"
      ? path.join(root, ".github", "copilot-instructions.md")
      : client === "visualstudio"
        ? path.join(os.homedir(), "copilot-instructions.md")
        : path.join(os.homedir(), ".copilot", "copilot-instructions.md");
  if (scope === "personal") {
    // A previous project-scoped init may have left the section behind — flag it
    // so the repo can go back to being open-memex-free for teammates.
    const proj = path.join(root, ".github", "copilot-instructions.md");
    if (fs.existsSync(proj) && fs.readFileSync(proj, "utf8").includes(MARKER)) {
      console.log(`  ! project-level instructions still present at ${proj}`);
      console.log(`    remove the open-memex section there to keep the repo clean.`);
    }
  }
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.includes(MARKER)) {
      console.log(`  = ${file} already has open-memex instructions — left as is`);
      return file;
    }
    fs.writeFileSync(file, cur.replace(/\s+$/, "") + "\n\n" + INSTRUCTIONS);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, INSTRUCTIONS);
  }
  console.log(`  + ${file}`);
  return file;
}

export const INIT_CLIENTS = ["vscode", "cursor", "opencode", "visualstudio"] as const;
export type InitClient = (typeof INIT_CLIENTS)[number];

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

/** D22: where the Copilot memory instructions live. Personal (default) is the
 * Copilot user-level location — all projects, never checked in. */
async function promptInstructionsScope(): Promise<"personal" | "project"> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Where should the Copilot memory instructions live?");
    console.log("  1) personal — user-level, all projects, never checked into a repo");
    console.log("  2) project  — .github/copilot-instructions.md, shared with the repo");
    const ans = (await rl.question("Choice [1]: ")).trim();
    return ans === "2" ? "project" : "personal";
  } finally {
    rl.close();
  }
}

/** D45: ask whether the MCP server config should be project-level or user-level. */
async function promptConfigLevel(): Promise<boolean> {
  console.log("Where should the MCP server config live?");
  console.log("  1) this project only — .vscode/mcp.json (or .cursor/mcp.json)");
  console.log("  2) user-level — all projects, init once (VS Code / Cursor)");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question("Choice [1]: ")).trim();
    return ans === "2";
  } finally {
    rl.close();
  }
}

/** D46: injectable environment for editor detection (tests pass fakes). */
export interface DetectEnv {
  pathEnv?: string;
  home?: string;
  platform?: NodeJS.Platform;
  root?: string;
  /** Overrides $XDG_CONFIG_HOME for the opencode global config dir. */
  xdgConfigHome?: string;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** True when `name` resolves on PATH (honors .cmd/.exe on Windows). */
function binOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): boolean {
  const names = platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  return pathEnv
    .split(path.delimiter)
    .filter((d) => d && !d.includes("_npx"))
    .some((d) => names.some((n) => exists(path.join(d, n))));
}

function opencodeConfigDir(home: string, xdg: string | undefined): string {
  return path.join(xdg || path.join(home, ".config"), "opencode");
}

/**
 * D46: detect which supported editors are installed. Used when `init` runs
 * without --client — one init wires every detected editor (user-level where
 * the editor supports it). Visual Studio is included only when the project
 * has a solution file, since VS config is solution-scoped by design.
 */
export function detectInstalledClients(env: DetectEnv = {}): InitClient[] {
  const platform = env.platform ?? process.platform;
  const pathEnv = env.pathEnv ?? process.env.PATH ?? "";
  const home = env.home ?? os.homedir();
  const found: InitClient[] = [];
  // VS Code: bin on PATH, well-known install location, or an existing
  // user-level MCP config (a previous init counts as installed).
  const vscodeInstallPaths =
    platform === "win32"
      ? [path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe")]
      : platform === "darwin"
        ? ["/Applications/Visual Studio Code.app"]
        : ["/usr/bin/code", "/usr/share/code/bin/code", "/snap/bin/code"];
  if (
    binOnPath("code", pathEnv, platform) ||
    vscodeInstallPaths.some(exists) ||
    exists(userMcpConfigPath("vscode", platform, home))
  ) {
    found.push("vscode");
  }
  // Cursor: bin on PATH or its user config dir exists.
  if (binOnPath("cursor", pathEnv, platform) || exists(path.join(home, ".cursor"))) {
    found.push("cursor");
  }
  // opencode: bin on PATH or its global config dir exists.
  const xdg = env.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  if (binOnPath("opencode", pathEnv, platform) || exists(opencodeConfigDir(home, xdg))) {
    found.push("opencode");
  }
  // Visual Studio: solution-scoped — only when the project has a .sln.
  let hasSln = false;
  try {
    hasSln = fs.readdirSync(env.root ?? projectRoot()).some((f) => f.toLowerCase().endsWith(".sln"));
  } catch {
    hasSln = false;
  }
  if (hasSln) found.push("visualstudio");
  return found;
}

export async function initProject(opts: {
  client?: string;
  force: boolean;
  yes: boolean;
  instructions?: string;
  /** D45: write the MCP server entry to the editor's user-level config. */
  global?: boolean;
}): Promise<void> {
  const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const explicit = normalizeClient(opts.client ?? "");
  if (explicit && !(INIT_CLIENTS as readonly string[]).includes(explicit)) {
    console.error(`unknown client "${opts.client}" (${INIT_CLIENTS.join("|")})`);
    process.exit(1);
  }
  // D46: no --client → auto-detect installed editors and wire them all
  // (user-level where the editor supports it — init once). An explicit
  // --client keeps the old single-editor behavior.
  let clients: InitClient[];
  let autoGlobal = false;
  if (explicit) {
    clients = [explicit as InitClient];
  } else if (interactive) {
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      console.log("  - no supported editors detected — editor setup skipped");
      clients = [];
    } else {
      console.log(`Detected editors: ${detected.join(", ")}`);
      const all = await askBool(
        "Wire up open-memex in all of them (one-time, user-level where supported)?",
        true,
      );
      if (all) {
        clients = detected;
        autoGlobal = true;
      } else {
        const one = await promptClient();
        clients = one ? [one as InitClient] : [];
      }
    }
  } else {
    clients = detectInstalledClients();
    autoGlobal = true;
    if (clients.length === 0) {
      console.log("  - no supported editors detected — editor setup skipped");
    } else {
      console.log(`Detected editors: ${clients.join(", ")} — wiring all (use --client to pick one)`);
    }
  }
  let global = !!opts.global || autoGlobal;
  // The project-vs-user-level choice only applies to an explicit single
  // client; auto mode is user-level by design (init once).
  if (explicit && !global && interactive && (clients[0] === "vscode" || clients[0] === "cursor")) {
    global = await promptConfigLevel();
  }
  let scope: "personal" | "project" = "personal";
  if (opts.instructions) {
    if (opts.instructions !== "personal" && opts.instructions !== "project") {
      console.error(`unknown --instructions "${opts.instructions}" (personal|project)`);
      process.exit(1);
    }
    scope = opts.instructions;
  } else if (interactive) {
    scope = await promptInstructionsScope();
  }
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
  for (const client of clients) {
    if (client === "vscode" || client === "cursor") {
      if (global) writeGlobalMcpJson(client, opts.force);
      else writeMcpJson(root, client, opts.force);
    } else if (client === "opencode") {
      // D46: the native plugin is the one-time global setup; without --global
      // (explicit single-client mode) keep the per-project plain-MCP config.
      if (global) writeOpencodeGlobalPlugin(opts.force);
      else writeMcpJson(root, client, opts.force);
    } else if (client === "visualstudio") {
      if (explicit && global) {
        console.log(`  - visualstudio: --global not supported — VS uses solution-level .mcp.json by design.`);
      } else {
        writeMcpJson(root, client, opts.force);
      }
    }
  }
  if (clients.length === 0) {
    console.log("  - editor setup skipped");
  } else if (clients.some((c) => c !== "opencode")) {
    // copilot-instructions.md is VS Code/Cursor-shaped; opencode as a plain MCP
    // consumer already gets the guidance from the tool descriptions (D16).
    // D22: personal scope (default) writes to the Copilot user-level location
    // so the repo stays clean for teammates without open-memex.
    writeInstructions(root, scope, clients.find((c) => c !== "opencode")!);
  }
  console.log(`\nDone. Reload your editor window to start the open-memex MCP server.`);
  // D50: init completed — the bare-`open-memex` first-run offer won't ask again.
  markFirstRunDone("initialized");
}

// ---------------------------------------------------------------------------
// uninstall — the reverse of init (D48). Removes the editor wiring init wrote:
// the MCP server entry, the opencode native plugin line, and the Copilot
// instructions section. Memory data is never touched.
// ---------------------------------------------------------------------------

/**
 * Pure removal of the open-memex server entry from a parsed config doc.
 * Prunes the section when it becomes empty. Mutates `doc`.
 */
export function removeServerEntry(
  doc: Record<string, unknown>,
  sectionKey: string,
): "removed" | "absent" {
  const section = doc[sectionKey];
  if (!section || typeof section !== "object" || !("open-memex" in section)) return "absent";
  delete (section as Record<string, unknown>)["open-memex"];
  if (Object.keys(section as Record<string, unknown>).length === 0) delete doc[sectionKey];
  return "removed";
}

/**
 * Pure removal of open-memex plugin entries from a parsed opencode config doc.
 * Matches any plugin URL containing `match` (robust against the package moving
 * between installs). Prunes the `plugin` array when it becomes empty.
 * Mutates `doc`.
 */
export function removePluginEntry(doc: Record<string, unknown>, match: string): "removed" | "absent" {
  const plugins = doc["plugin"];
  if (!Array.isArray(plugins)) return "absent";
  const kept = (plugins as unknown[]).filter(
    (p) => !(typeof p === "string" && p.includes(match)),
  );
  if (kept.length === plugins.length) return "absent";
  if (kept.length === 0) delete doc["plugin"];
  else doc["plugin"] = kept;
  return "removed";
}

/**
 * Pure removal of the open-memex instructions section from a
 * copilot-instructions.md body. init always appends it last (MARKER..end),
 * so cutting from the marker to the end is exact; returns "" when nothing
 * but the section remains so the caller can delete the file.
 */
export function removeInstructionsSection(text: string): string {
  const idx = text.lastIndexOf(MARKER);
  if (idx < 0) return text;
  const rest = text.slice(0, idx).replace(/\s+$/, "");
  return rest ? rest + "\n" : "";
}

/**
 * Remove the server entry from one JSON config file. Existing files are
 * merged, never clobbered; invalid JSON is left untouched with the manual
 * step (same D47 treatment as the init write path).
 */
function removeServerEntryFile(file: string, sectionKey: string): "removed" | "absent" | null {
  if (!fs.existsSync(file)) return "absent";
  const doc = parseJsonConfig(fs.readFileSync(file, "utf8"));
  if (doc === null) {
    console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
    console.error(`    Delete the "open-memex" key under "${sectionKey}".`);
    return null;
  }
  const res = removeServerEntry(doc, sectionKey);
  if (res === "removed") {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`  - ${file} (open-memex entry removed)`);
  }
  return res;
}

/** Remove the open-memex plugin URL from one opencode user-level config file. */
function removeOpencodePluginFile(file: string): "removed" | "absent" | null {
  if (!fs.existsSync(file)) return "absent";
  const doc = parseJsonConfig(fs.readFileSync(file, "utf8"));
  if (doc === null) {
    console.error(`  ! ${file} is not valid JSON — left untouched, fix it manually`);
    console.error(`    Delete the open-memex URL from the "plugin" array.`);
    return null;
  }
  const res = removePluginEntry(doc, "open-memex");
  if (res === "removed") {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`  - ${file} (open-memex plugin removed)`);
  }
  return res;
}

/** Remove the open-memex section from one copilot-instructions.md file. */
function removeInstructionsFile(file: string): "removed" | "absent" {
  if (!fs.existsSync(file)) return "absent";
  const cur = fs.readFileSync(file, "utf8");
  if (!cur.includes(MARKER)) return "absent";
  const next = removeInstructionsSection(cur);
  if (next === "") {
    fs.unlinkSync(file);
    console.log(`  - ${file} (deleted — it only held open-memex instructions)`);
  } else {
    fs.writeFileSync(file, next);
    console.log(`  - ${file} (open-memex instructions removed)`);
  }
  return "removed";
}

export async function uninstallProject(opts: {
  client?: string;
  /** D48: only the user-level config; without it, both levels are cleaned. */
  global?: boolean;
  yes: boolean;
}): Promise<void> {
  const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const explicit = normalizeClient(opts.client ?? "");
  if (explicit && !(INIT_CLIENTS as readonly string[]).includes(explicit)) {
    console.error(`unknown client "${opts.client}" (${INIT_CLIENTS.join("|")})`);
    process.exit(1);
  }
  // Mirror init's client resolution: explicit --client, else auto-detect.
  let clients: InitClient[];
  if (explicit) {
    clients = [explicit as InitClient];
  } else if (interactive) {
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      console.log("  - no supported editors detected — nothing to remove");
      return;
    }
    console.log(`Detected editors: ${detected.join(", ")}`);
    const all = await askBool("Remove open-memex wiring from all of them?", true);
    if (all) {
      clients = detected;
    } else {
      const one = await promptClient();
      clients = one ? [one as InitClient] : [];
    }
  } else {
    clients = detectInstalledClients();
    if (clients.length > 0) {
      console.log(`Detected editors: ${clients.join(", ")} — removing from all (use --client to pick one)`);
    }
  }
  if (clients.length === 0) {
    console.log("  - nothing to remove");
    return;
  }
  // Without --global, clean both levels: init may have written either one,
  // and a leftover entry at the other level would be a surprise.
  const levels = opts.global ? ["user"] : ["project", "user"];
  const root = projectRoot();
  console.log(`open-memex uninstall — project root: ${root}`);
  let changed = 0;
  const bump = (r: "removed" | "absent" | null) => {
    if (r === "removed") changed++;
  };
  for (const client of clients) {
    if (client === "vscode" || client === "cursor") {
      const sectionKey = client === "cursor" ? "mcpServers" : "servers";
      for (const level of levels) {
        const file =
          level === "user"
            ? userMcpConfigPath(client)
            : path.join(root, client === "cursor" ? ".cursor/mcp.json" : ".vscode/mcp.json");
        bump(removeServerEntryFile(file, sectionKey));
      }
    } else if (client === "opencode") {
      for (const level of levels) {
        if (level === "user") bump(removeOpencodePluginFile(opencodeGlobalConfigPath()));
        else bump(removeServerEntryFile(path.join(root, "opencode.jsonc"), "mcp"));
      }
    } else if (client === "visualstudio") {
      // Solution-level only — --global is meaningless, same as init.
      bump(removeServerEntryFile(path.join(root, ".mcp.json"), "servers"));
    }
  }
  // Copilot instructions: init may have written personal (default) or project.
  if (clients.some((c) => c !== "opencode")) {
    bump(removeInstructionsFile(path.join(os.homedir(), ".copilot", "copilot-instructions.md")));
    bump(removeInstructionsFile(path.join(os.homedir(), "copilot-instructions.md")));
    bump(removeInstructionsFile(path.join(root, ".github", "copilot-instructions.md")));
  }
  console.log(
    changed > 0
      ? `\nDone. Removed open-memex wiring from ${changed} file(s).`
      : "\nDone. Nothing to remove — no open-memex wiring found.",
  );
  console.log("Your memories are untouched (uninstall never deletes data).");
  // D50: unwiring is the reverse of init — drop the first-run marker so the
  // next bare `open-memex` offers to wire again.
  if (changed > 0) clearFirstRunMarker();
}
