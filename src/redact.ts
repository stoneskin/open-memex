/**
 * Redaction: secrets must never land in memory files or the index in
 * readable form.
 *
 * Layers, in order:
 *   1. <private>...</private> regions are stripped first (explicit opt-out —
 *      the author marked this span as sensitive, so it is replaced with
 *      [REDACTED] before any detection runs).
 *   2. Built-in provider patterns (always on, reported by id).
 *   3. User patterns from config redactPatterns (reported verbatim).
 *   4. High-entropy assignment heuristic (catches secrets whose provider we
 *      don't have a pattern for, e.g. `deploy_key = "aB3d..."`).
 *
 * A detected secret does NOT refuse the write: the matched string is masked
 * in place — first 4 characters kept, the rest replaced with 'x' — and the
 * write proceeds with the masked content. hadSecret reports that masking
 * happened so callers can surface a notice. A partially-masked memory still
 * identifies which credential it referred to without storing the secret.
 */

export interface SecretPattern {
  /** Stable id reported in matchedPattern. */
  id: string;
  /** Regex source (no slashes). */
  source: string;
  /** Optional RegExp flags, e.g. "i". */
  flags?: string;
  /**
   * Capture-group index holding the secret value. When set, masking replaces
   * only that group — the credential name stays readable (D14: a masked
   * memory should still identify which key it referred to). Default: mask
   * the whole match.
   */
  valueGroup?: number;
}

/**
 * Prefixes like `sk-` also occur inside ordinary English words ("task-…",
 * "risk-…", "disk-…"), which caused confirmed false positives. Require the
 * token prefix NOT to be preceded by a word/hyphen char, so a real key after
 * "=", ":", space, or a quote still matches.
 */
const TOKEN_BOUNDARY = "(?<![A-Za-z0-9_-])";

export const BUILTIN_SECRET_PATTERNS: SecretPattern[] = [
  { id: "openai-key", source: `${TOKEN_BOUNDARY}sk-[A-Za-z0-9_-]{20,}` },
  {
    id: "openai-admin-key",
    source: `${TOKEN_BOUNDARY}sk-admin-[A-Za-z0-9_-]{20,}`,
  },
  {
    id: "openai-session-key",
    source: `${TOKEN_BOUNDARY}sm_[A-Za-z0-9_-]{20,}`,
  },
  { id: "github-pat", source: `${TOKEN_BOUNDARY}ghp_[A-Za-z0-9]{30,}` },
  { id: "github-oauth-token", source: `${TOKEN_BOUNDARY}gho_[A-Za-z0-9]{30,}` },
  { id: "github-user-token", source: `${TOKEN_BOUNDARY}ghu_[A-Za-z0-9]{30,}` },
  {
    id: "github-refresh-token",
    source: `${TOKEN_BOUNDARY}ghr_[A-Za-z0-9]{30,}`,
  },
  {
    id: "github-fine-grained-pat",
    source: `${TOKEN_BOUNDARY}github_pat_[A-Za-z0-9_]{40,}`,
  },
  { id: "aws-access-key-id", source: `${TOKEN_BOUNDARY}AKIA[0-9A-Z]{16}` },
  {
    id: "aws-secret-access-key",
    source:
      "(aws[_-]?secret[_-]?access[_-]?key)([\"']?\\s*[:=]\\s*[\"']?)([A-Za-z0-9/+=]{40})",
    flags: "i",
    valueGroup: 3,
  },
  { id: "slack-token", source: `${TOKEN_BOUNDARY}xox[baprs]-[A-Za-z0-9-]{10,}` },
  { id: "google-api-key", source: `${TOKEN_BOUNDARY}AIza[0-9A-Za-z_-]{30,}` },
  { id: "npm-token", source: `${TOKEN_BOUNDARY}npm_[A-Za-z0-9]{30,}` },
  { id: "gitlab-pat", source: `${TOKEN_BOUNDARY}glpat-[A-Za-z0-9_-]{20,}` },
  {
    id: "stripe-restricted-key",
    source: `${TOKEN_BOUNDARY}rk_(live|test)_[A-Za-z0-9]{20,}`,
  },
  {
    id: "stripe-webhook-secret",
    source: `${TOKEN_BOUNDARY}whsec_[A-Za-z0-9]{20,}`,
  },
  {
    id: "private-key-block",
    // Whole block: masking only the BEGIN header would leave the base64 body
    // readable in the memory file. Non-greedy so two blocks mask separately.
    source:
      "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
  },
  {
    id: "private-key-truncated",
    // No END marker: mask from the header to end of text. A header without a
    // body is still key material; over-masking is the safe direction.
    source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*$",
  },
  {
    id: "jwt",
    source: `${TOKEN_BOUNDARY}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
  },
  {
    id: "generic-secret-assignment",
    source:
      "(api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)([\"']?\\s*[:=]\\s*[\"']?)([A-Za-z0-9_\\-./+=]{16,})([\"']?)",
    flags: "i",
    valueGroup: 3,
  },
];

function compile(p: SecretPattern): RegExp | null {
  try {
    return new RegExp(p.source, p.flags ?? "");
  } catch {
    return null; // ignore malformed builtin (should never happen)
  }
}

/** Returns the matched builtin pattern id, or null. */
export function findBuiltinSecret(text: string): string | null {
  for (const p of BUILTIN_SECRET_PATTERNS) {
    const re = compile(p);
    if (re && re.test(text)) return p.id;
  }
  return null;
}

export function findSecret(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      const re = new RegExp(p);
      if (re.test(text)) return p;
    } catch {
      // ignore malformed regex
    }
  }
  return null;
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// name = value assignments with a long token-ish value.
const ASSIGNMENT_RE =
  /([A-Za-z_][A-Za-z0-9_]{1,63})\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{24,})["']?/g;

/**
 * Heuristic last line of defense: a long, high-entropy value assigned to a
 * name is almost certainly a credential, even when no provider pattern
 * matches. Tuned conservatively (length >= 24, entropy >= 4.5 bits/char):
 * hex digests (<= 4.0) and prose (~4.0) pass through; base64-ish randomness
 * does not. URLs are skipped.
 */
export function findHighEntropySecret(text: string): string | null {
  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const name = m[1];
    const value = m[2];
    if (!isSuspectAssignmentValue(value, m[0], m.index ?? 0, text)) continue;
    return `high-entropy-secret:${name}`;
  }
  return null;
}

/**
 * Shared benign-value rule for detection AND masking: a URL (e.g. the value
 * after "https:") or a low-entropy value must never be touched. Note the
 * "://" check: ASSIGNMENT_RE consumes the colon of "https:" as the separator,
 * so the captured value starts with "//..." — check for "://" in the
 * original text around the match, not just inside the value.
 */
function isSuspectAssignmentValue(value: string, fullMatch: string, offset: number, text: string): boolean {
  // Bare URL: ASSIGNMENT_RE consumed the scheme colon ("https:") as the
  // separator, so the match itself starts with "scheme://".
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(fullMatch)) return false;
  if (value.includes("://")) return false;
  // Reconstruct what preceded the value inside the match (name + separator);
  // if the text right before the value looks like scheme://, it is a URL.
  const before = text.slice(Math.max(0, offset - 12), offset);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?$/.test(before.trim()) || before.includes("://")) return false;
  return shannonEntropy(value) >= 4.5;
}

export function stripPrivate(text: string): string {
  // Closed pairs first...
  let out = text.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
  // ...then an unclosed <private> redacts everything after it. A dangling
  // tag almost always means the author intended the rest to be private.
  out = out.replace(/<private>[\s\S]*$/gi, "[REDACTED]");
  return out;
}

/**
 * Mask a matched secret: keep the first 4 characters, replace the rest
 * with 'x' (length-preserving). "sk-1234567890abcdefghij" → "sk-1xxxxxxxxxxxxx".
 */
function maskMatch(m: string): string {
  return m.slice(0, 4) + "x".repeat(Math.max(0, m.length - 4));
}

/** Apply the builtin patterns as masking (global, all matches). */
function maskBuiltin(content: string): string {
  let out = content;
  for (const p of BUILTIN_SECRET_PATTERNS) {
    const re = compile(p);
    if (!re) continue;
    const g = new RegExp(re.source, re.flags + "g");
    if (p.valueGroup == null) {
      out = out.replace(g, (m) => maskMatch(m));
    } else {
      // Mask only the secret-value group; the credential name stays readable.
      out = out.replace(g, (...args: unknown[]) => {
        const m = args[0] as string;
        const val = args[p.valueGroup as number] as string | undefined;
        if (!val) return m;
        const idx = m.lastIndexOf(val);
        if (idx < 0) return m;
        return m.slice(0, idx) + maskMatch(val) + m.slice(idx + val.length);
      });
    }
  }
  return out;
}

/** Apply user patterns as masking. Invalid regexes are ignored. */
function maskUser(content: string, patterns: string[]): string {
  let out = content;
  for (const p of patterns) {
    try {
      out = out.replace(new RegExp(p, "g"), (m) => maskMatch(m));
    } catch {
      // ignore malformed regex
    }
  }
  return out;
}

/** Mask the value side of high-entropy assignments (name stays readable).
 *  Uses the exact same benign-value rule as detection, so URLs and
 *  low-entropy values are never touched even when another secret triggers. */
function maskEntropy(content: string): string {
  return content.replace(
    ASSIGNMENT_RE,
    (m, name: string, value: string, offset: number) => {
      if (!isSuspectAssignmentValue(value, m, offset, content)) return m;
      return m.split(value).join(maskMatch(value));
    },
  );
}

export function redact(
  text: string,
  patterns: string[],
): { content: string; hadSecret: boolean; matchedPattern: string | null } {
  const stripped = stripPrivate(text);
  // Detection (for reporting) runs in priority order: builtin → user → entropy.
  const builtin = findBuiltinSecret(stripped);
  const user = builtin ? null : findSecret(stripped, patterns);
  const entropic =
    builtin || user ? null : findHighEntropySecret(stripped);
  const matched = builtin ?? user ?? entropic;
  if (!matched) return { content: stripped, hadSecret: false, matchedPattern: null };
  // Masking runs every family over the text (not just the reported one) so
  // multiple credentials in one memory are all masked.
  const masked = maskEntropy(maskUser(maskBuiltin(stripped), patterns));
  return { content: masked, hadSecret: true, matchedPattern: matched };
}
