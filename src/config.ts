import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface MyOMemoryConfig {
  maxProjectMemories: number;
  maxProfileItems: number;
  injectOnFirstTurn: boolean;
  keywordCaptureEnabled: boolean;
  /**
   * D61: capture-time aliasing (retrieval layer 3). When on, agents are
   * asked to attach 2–4 aliases (alternate phrasings, other-language
   * equivalents) to each memory they save; ops stores them and the index
   * searches them, so differently-worded questions still hit. Asked once
   * at init, default on; off = aliases passed by agents are dropped.
   */
  captureAliases: boolean;
  /** Patterns whose capture group 1 becomes the memory body; saved to the current scope. */
  keywordPatterns: string[];
  /** Same shape, but hits are forced into the personal scope (e.g. "remember for me"). */
  keywordPersonalPatterns: string[];
  redactPatterns: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * In-repo project-memory directory, relative to the project root (2B/D23).
   * Default `.ai/open-memex/`. Must stay relative and `..`-free so project
   * memories can never escape the repo.
   */
  memoryDir: string;
  /**
   * Sync behavior (§9, D12). Pulls are explicit by default; session start
   * never touches the network unless autoPull is true — and even then a
   * failed pull never blocks the session.
   */
  sync: {
    autoPull: boolean;
  };
}

export const DEFAULT_CONFIG: MyOMemoryConfig = {
  maxProjectMemories: 8,
  maxProfileItems: 5,
  injectOnFirstTurn: true,
  keywordCaptureEnabled: true,
  captureAliases: true,
  keywordPatterns: [
    "^\\s*remember(?!\\s+for\\s+me)(?:\\s+that|\\s+to)?[:,]?\\s+(.+)$",
    "^\\s*(?:please\\s+)?(?:note|don'?t\\s+forget)(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*TIL[:,]?\\s+(.+)$",
    "^\\s*save\\s+(?:this|to\\s+memory)[:,]?\\s+(.+)$",
    // Chinese equivalents
    "^\\s*(?:请)?记住(?!（个人）)[：:,，]?\\s*(.+)$",
    "^\\s*(?:请)?(?:记一下|记录一下)[：:,，]?\\s*(.+)$",
    "^\\s*别忘了[：:,，]?\\s*(.+)$",
    // First-person plural: team/project context, NOT personal
    "^\\s*我们认为[：:,，]?\\s*(.+)$",
    "^\\s*我们决定[：:,，]?\\s*(.+)$",
    "^\\s*帮我们记(?:住|一下)?[：:,，]?\\s*(.+)$",
  ],
  keywordPersonalPatterns: [
    "^\\s*remember\\s+for\\s+me(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*(?:请)?记住（个人）[：:,，]?\\s*(.+)$",
    // First-person singular: personal scope ("我" → 个人, "我们" → 项目)
    "^\\s*(?:请)?记住我(?!们)[：:,，]?\\s*(.+)$",
    "^\\s*替我记(?:住|一下)?[：:,，]?\\s*(.+)$",
    "^\\s*帮我记(?:住|一下)?[：:,，]?\\s*(.+)$",
    "^\\s*我觉得[：:,，]?\\s*(.+)$",
    "^\\s*我喜欢[：:,，]?\\s*(.+)$",
  ],
  // Built-in provider patterns now live in src/redact.ts (always on).
  // Add only your own extra patterns here.
  redactPatterns: [],
  logLevel: "info",
  memoryDir: ".ai/open-memex",
  sync: { autoPull: false },
};

/**
 * Strip JSONC comments and trailing commas with a string-aware scanner.
 * The previous regex version was not string-aware: a config value like
 * "src/**\/secrets" had its `/**…*\/` eaten as a block comment, silently
 * corrupting the user's redact pattern (P0 review, 2026-10-03). Shared
 * with doctor.ts — one parser, not two.
 */
export function stripJsonComments(raw: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < raw.length) {
    const c = raw[i]!;
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
    if (c === ",") {
      // Trailing comma: drop it when the next significant char closes a
      // container. Whitespace/comments between are tolerated.
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === "}" || raw[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Where `config set` / interactive `init` persist. Respects OPEN_MEMEX_CONFIG
 * (D62); MY_O_MEMORY_CONFIG is the pre-rename fallback, still honored.
 */
export function configFilePath(): string {
  return (
    process.env.OPEN_MEMEX_CONFIG ??
    process.env.MY_O_MEMORY_CONFIG ??
    path.join(os.homedir(), ".config", "opencode", "open-memex.jsonc")
  );
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error("must be true/false");
}

function toNonNegInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error("must be a non-negative integer");
  return n;
}

function toRelativeDir(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("must be a non-empty relative directory");
  const t = v.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!t || path.isAbsolute(t) || t.split("/").includes(".."))
    throw new Error('must be a relative path without ".." (e.g. ".ai/open-memex")');
  return t;
}

/** Keys users may change via `open-memex config set <key> <value>`, with validators. */
export const SETTABLE_KEYS: Record<string, (v: unknown) => unknown> = {
  maxProjectMemories: toNonNegInt,
  maxProfileItems: toNonNegInt,
  injectOnFirstTurn: toBool,
  keywordCaptureEnabled: toBool,
  captureAliases: toBool,
  memoryDir: toRelativeDir,
  "sync.autoPull": toBool,
  logLevel: (v) => {
    if (v !== "info" && v !== "debug") throw new Error('must be "info" or "debug"');
    return v;
  },
};

/** Merge a patch into the config file (creates it if missing). Returns the file path. */
export function saveConfig(patch: Record<string, unknown>): string {
  const file = configFilePath();
  let cur: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      cur = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) as Record<
        string,
        unknown
      >;
    } catch {
      console.error(`[open-memex] ${file} is not valid JSONC — it will be replaced`);
    }
  }
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    "// Managed by `open-memex config set` / `open-memex init` — edit freely (JSONC).\n" +
      JSON.stringify(next, null, 2) +
      "\n",
  );
  return file;
}

/** Path of the config file in effect, or null when using built-in defaults. */
export function configSource(): string | null {
  const candidates = [
    process.env.OPEN_MEMEX_CONFIG,
    process.env.MY_O_MEMORY_CONFIG,
    path.join(os.homedir(), ".config", "opencode", "open-memex.jsonc"),
    path.join(os.homedir(), ".config", "opencode", "open-memex.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(): MyOMemoryConfig {
  const p = configSource();
  if (p) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(stripJsonComments(raw)) as Partial<MyOMemoryConfig>;
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      // The config file is hand-editable, so the load path must enforce
      // the same invariants `config set` does (P0 review, 2026-10-03):
      // an unvalidated memoryDir like "../../shared" would put
      // committed project memories outside the repo.
      try {
        merged.memoryDir = toRelativeDir(merged.memoryDir);
      } catch {
        console.error(
          `[open-memex] invalid memoryDir "${merged.memoryDir}" in ${p} — using default "${DEFAULT_CONFIG.memoryDir}"`,
        );
        merged.memoryDir = DEFAULT_CONFIG.memoryDir;
      }
      return merged;
    } catch (err) {
      console.error(`[open-memex] failed to parse ${p}:`, err);
    }
  }
  return DEFAULT_CONFIG;
}
