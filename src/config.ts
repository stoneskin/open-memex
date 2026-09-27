import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface MyOMemoryConfig {
  maxProjectMemories: number;
  maxProfileItems: number;
  injectOnFirstTurn: boolean;
  keywordCaptureEnabled: boolean;
  keywordPatterns: string[];
  redactPatterns: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_CONFIG: MyOMemoryConfig = {
  maxProjectMemories: 8,
  maxProfileItems: 5,
  injectOnFirstTurn: true,
  keywordCaptureEnabled: true,
  keywordPatterns: [
    "^\\s*remember(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*(?:please\\s+)?(?:note|don'?t\\s+forget)(?:\\s+that)?[:,]?\\s+(.+)$",
    "^\\s*TIL[:,]?\\s+(.+)$",
    "^\\s*save\\s+(?:this|to\\s+memory)[:,]?\\s+(.+)$",
  ],
  // Built-in provider patterns now live in src/redact.ts (always on).
  // Add only your own extra patterns here.
  redactPatterns: [],
  logLevel: "info",
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

export function loadConfig(): MyOMemoryConfig {
  const candidates = [
    process.env.MY_O_MEMORY_CONFIG,
    path.join(os.homedir(), ".config", "opencode", "open-memex.jsonc"),
    path.join(os.homedir(), ".config", "opencode", "open-memex.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
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
