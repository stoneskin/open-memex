import type { MyOMemoryConfig } from "../config.ts";

export interface KeywordHit {
  content: string;
  pattern: string;
  /** True when the hit came from a personal-scope pattern: force personal scope. */
  personal: boolean;
}

/**
 * Scan user text for memory-capture keyword triggers.
 * Each pattern must have a single capture group whose value becomes the memory body.
 * Personal patterns (cfg.keywordPersonalPatterns) force the personal scope.
 */
export function detectKeywords(userText: string, cfg: MyOMemoryConfig): KeywordHit[] {
  if (!cfg.keywordCaptureEnabled) return [];
  const hits: KeywordHit[] = [];
  const scan = (patterns: string[], personal: boolean) => {
    for (const src of patterns) {
      let re: RegExp;
      try {
        re = new RegExp(src, "i");
      } catch {
        continue;
      }
      const lines = userText.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(re);
        if (!m || !m[1]) continue;
        const content = m[1].trim().replace(/[.!?]$/, "").trim();
        if (content.length >= 3 && content.length <= 2000) {
          hits.push({ content, pattern: src, personal });
          break; // one hit per pattern per message
        }
      }
    }
  };
  scan(cfg.keywordPatterns, false);
  scan(cfg.keywordPersonalPatterns, true);
  return hits;
}
