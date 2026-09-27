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
 *
 * Personal patterns run first and claim their line: an explicit scope signal
 * (e.g. "记住我对花粉过敏") must not also fire the generic 记住 into the project scope.
 */
export function detectKeywords(userText: string, cfg: MyOMemoryConfig): KeywordHit[] {
  if (!cfg.keywordCaptureEnabled) return [];
  const hits: KeywordHit[] = [];
  const lines = userText.split(/\r?\n/);
  const claimed = new Set<number>();
  const scan = (patterns: string[], personal: boolean, skipClaimed: boolean) => {
    for (const src of patterns) {
      let re: RegExp;
      try {
        re = new RegExp(src, "i");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (skipClaimed && claimed.has(i)) continue;
        const m = lines[i].match(re);
        if (!m || !m[1]) continue;
        const content = m[1].trim().replace(/[.!?]$/, "").trim();
        if (content.length >= 3 && content.length <= 2000) {
          hits.push({ content, pattern: src, personal });
          if (personal) claimed.add(i);
          break; // one hit per pattern per message
        }
      }
    }
  };
  scan(cfg.keywordPersonalPatterns, true, false);
  scan(cfg.keywordPatterns, false, true);
  return hits;
}
