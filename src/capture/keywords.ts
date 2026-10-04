import type { MyOMemoryConfig } from "../config.ts";

export interface KeywordHit {
  content: string;
  pattern: string;
  /** True when the hit came from a personal-scope pattern: force personal scope. */
  personal: boolean;
}

/**
 * D67: capture-body length bounds. The lower bound rejects fragments — a
 * trigger that yields "这个" or "OK" is a match on the trigger, not a memory,
 * and a 2-char memory is noise in every future session's injection. The floor
 * stays deliberately above 1: D67 considered lowering it and decided against
 * it. What changed is that a rejection is no longer silent (see KeywordDrop).
 */
export const MIN_CAPTURE_CHARS = 3;
export const MAX_CAPTURE_CHARS = 2000;

/** A pattern that matched but whose body was rejected before capture. */
export interface KeywordDrop {
  content: string;
  pattern: string;
  personal: boolean;
  reason: "too-short" | "too-long";
}

export interface KeywordScan {
  hits: KeywordHit[];
  dropped: KeywordDrop[];
}

/**
 * Scan user text for memory-capture keyword triggers, reporting both what
 * would be captured and what matched but was rejected (D67) — a dropped match
 * that says nothing reads as a broken feature.
 * Each pattern must have a single capture group whose value becomes the memory body.
 * Personal patterns (cfg.keywordPersonalPatterns) force the personal scope.
 *
 * Personal patterns run first and claim their line: an explicit scope signal
 * (e.g. "记住我对花粉过敏") must not also fire the generic 记住 into the project scope.
 */
export function scanKeywords(userText: string, cfg: MyOMemoryConfig): KeywordScan {
  const hits: KeywordHit[] = [];
  const dropped: KeywordDrop[] = [];
  if (!cfg.keywordCaptureEnabled) return { hits, dropped };
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
        if (personal) claimed.add(i);
        if (content.length >= MIN_CAPTURE_CHARS && content.length <= MAX_CAPTURE_CHARS) {
          hits.push({ content, pattern: src, personal });
          break; // one hit per pattern per message
        }
        // Rejected: record it once per pattern. The line stays claimed for
        // personal patterns even here - "记住我：OK" must not fall through to
        // the generic 记住 and be saved as "我：OK" (D67).
        if (!dropped.some((d) => d.pattern === src && d.content === content)) {
          dropped.push({
            content,
            pattern: src,
            personal,
            reason: content.length < MIN_CAPTURE_CHARS ? "too-short" : "too-long",
          });
        }
        break;
      }
    }
  };
  scan(cfg.keywordPersonalPatterns, true, false);
  scan(cfg.keywordPatterns, false, true);
  if (cfg.logLevel === "debug" && dropped.length > 0) {
    for (const d of dropped) {
      console.error(
        `[open-memex] keyword match not captured (${d.reason === "too-short" ? `body ${d.content.length} chars < ${MIN_CAPTURE_CHARS}` : `body ${d.content.length} chars > ${MAX_CAPTURE_CHARS}`}): "${d.content}"`,
      );
    }
  }
  return { hits, dropped };
}

/** Capture-only view of {@link scanKeywords} (drops are logged, not returned). */
export function detectKeywords(userText: string, cfg: MyOMemoryConfig): KeywordHit[] {
  return scanKeywords(userText, cfg).hits;
}
