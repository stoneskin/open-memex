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
    "^\\s*remember(?!\\s+for\\s+me)(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*(?:please\\s+)?(?:note|don'?t\\s+forget)(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*TIL[:,]?\\s+(.+)$",
    "^\\s*save\\s+(?:this|to\\s+memory)[:,]?\\s+(.+)$",
    // Chinese equivalents
    "^\\s*记住(?!（个人）)[：:,，]?\\s*(.+)$",
    "^\\s*(?:请)?(?:记一下|记录一下)[：:,，]?\\s*(.+)$",
    "^\\s*别忘了[：:,，]?\\s*(.+)$",
    // First-person plural: team/project context, NOT personal
    "^\\s*我们认为[：:,，]?\\s*(.+)$",
    "^\\s*我们决定[：:,，]?\\s*(.+)$",
    "^\\s*帮我们记(?:住|一下)?[：:,，]?\\s*(.+)$",
  ],
  keywordPersonalPatterns: [
    "^\\s*remember\\s+for\\s+me(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*记住（个人）[：:,，]?\\s*(.+)$",
    // First-person singular: personal scope ("我" → 个人, "我们" → 项目)
    "^\\s*记住我(?!们)[：:,，]?\\s*(.+)$",
    "^\\s*替我记(?:住|一下)?[：:,，]?\\s*(.+)$",
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

function stripJsonComments(raw: string): string {
  // Line comments
  let out = raw.replace(/^\s*\/\/.*$/gm, "");
  // Block comments (non-greedy)
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  // Trailing commas before closing brackets
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

/** Where `config set` / interactive `init` persist. Respects MY_O_MEMORY_CONFIG. */
export function configFilePath(): string {
  return (
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
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      console.error(`[open-memex] failed to parse ${p}:`, err);
    }
  }
  return DEFAULT_CONFIG;
}
