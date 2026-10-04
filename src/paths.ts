import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * D62: the data-root override env var. `OPEN_MEMEX_HOME` is the current
 * name; `MY_O_MEMORY_HOME` (pre-rename package name) is still honored as a
 * fallback so existing setups and scripts keep working. New name wins
 * when both are set.
 */
export function homeOverride(): { dir: string; via: "OPEN_MEMEX_HOME" | "MY_O_MEMORY_HOME" } | null {
  if (process.env.OPEN_MEMEX_HOME)
    return { dir: path.resolve(process.env.OPEN_MEMEX_HOME), via: "OPEN_MEMEX_HOME" };
  if (process.env.MY_O_MEMORY_HOME)
    return { dir: path.resolve(process.env.MY_O_MEMORY_HOME), via: "MY_O_MEMORY_HOME" };
  return null;
}

function dataRoot(): string {
  const override = homeOverride();
  if (override) return override.dir;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "open-memex");
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "open-memex");
}

export interface Paths {
  root: string;
  memories: string;
  indexDb: string;
}

let _cached: Paths | null = null;

/**
 * Read-only data-root path — never creates the directory. For existence
 * checks (D50 first-run detection) that must not pollute storage; contrast
 * `paths()`, which mkdirs as a side effect.
 */
export function dataRootPath(): string {
  return dataRoot();
}

export function paths(): Paths {
  if (_cached) return _cached;
  const root = dataRoot();
  const memories = path.join(root, "memories");
  const indexDb = path.join(root, "index.db");
  fs.mkdirSync(memories, { recursive: true });
  _cached = { root, memories, indexDb };
  return _cached;
}

export function memoriesDirFor(scopeKey: string): string {
  const { memories } = paths();
  const dir = path.join(memories, scopeKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same as `memoriesDirFor` but never creates the directory. For read-only
 *  callers (iteration, existence checks) that must not pollute storage. */
export function memoriesDirPath(scopeKey: string): string {
  const { memories } = paths();
  return path.join(memories, scopeKey);
}

/** Project root: git top-level, falling back to cwd (2B: in-repo memory dir anchor). */
export function projectRoot(cwd: string = process.cwd()): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    /* not a git repo — use cwd */
  }
  return path.resolve(cwd);
}

/**
 * In-repo memory directory for a project scope (2B/D23): `<root>/<memoryDir>/`,
 * default `<root>/.ai/open-memex/`. Created on demand. `memoryDir` must be a
 * relative path without `..` segments (validated by `config set`).
 */
export function inRepoMemoriesDir(root: string, memoryDir: string): string {
  const dir = path.join(root, memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same as `inRepoMemoriesDir` but never creates the directory. */
/**
 * True when a memory file lives inside the user's git working tree (the
 * in-repo `.ai/open-memex/` copy) rather than in the local data root.
 *
 * D70: both destructive/corrective surfaces need this — the hard delete
 * already said "commit the deletion so the team sees it" (D64), and the
 * soft hide has to say the same, because a retraction that never gets
 * committed leaves the memory standing on every teammate's clone.
 */
export function isInRepoMemoryFile(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/.ai/open-memex/") && !normalized.startsWith(root());
}

function root(): string {
  return paths().root.replace(/\\/g, "/");
}

export function inRepoMemoriesDirPath(root: string, memoryDir: string): string {
  return path.join(root, memoryDir);
}
