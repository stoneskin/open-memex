/**
 * Redaction: secrets must never land in memory files or the index.
 *
 * Three layers, checked in order by redact():
 *   1. <private>...</private> regions are stripped first (explicit opt-out —
 *      the author marked this span as sensitive, so it is replaced with
 *      [REDACTED] before any detection runs).
 *   2. Built-in provider patterns (always on, reported by id).
 *   3. User patterns from config redactPatterns (reported verbatim).
 *   4. High-entropy assignment heuristic (catches secrets whose provider we
 *      don't have a pattern for, e.g. `deploy_key = "aB3d..."`).
 *
 * Any hit refuses the whole write — a memory with a hole in it is worse
 * than no memory, because the hole invites reconstruction.
 */

export interface SecretPattern {
  /** Stable id reported in matchedPattern. */
  id: string;
  /** Regex source (no slashes). */
  source: string;
  /** Optional RegExp flags, e.g. "i". */
  flags?: string;
}

export const BUILTIN_SECRET_PATTERNS: SecretPattern[] = [
  { id: "openai-key", source: "sk-[A-Za-z0-9_-]{20,}" },
  { id: "openai-admin-key", source: "sk-admin-[A-Za-z0-9_-]{20,}" },
  { id: "openai-session-key", source: "sm_[A-Za-z0-9_-]{20,}" },
  { id: "github-pat", source: "ghp_[A-Za-z0-9]{30,}" },
  { id: "github-oauth-token", source: "gho_[A-Za-z0-9]{30,}" },
  { id: "github-user-token", source: "ghu_[A-Za-z0-9]{30,}" },
  { id: "github-refresh-token", source: "ghr_[A-Za-z0-9]{30,}" },
  { id: "github-fine-grained-pat", source: "github_pat_[A-Za-z0-9_]{40,}" },
  { id: "aws-access-key-id", source: "AKIA[0-9A-Z]{16}" },
  {
    id: "aws-secret-access-key",
    source:
      "aws[_-]?secret[_-]?access[_-]?key[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9/+=]{40}",
    flags: "i",
  },
  { id: "slack-token", source: "xox[baprs]-[A-Za-z0-9-]{10,}" },
  { id: "google-api-key", source: "AIza[0-9A-Za-z_-]{30,}" },
  { id: "npm-token", source: "npm_[A-Za-z0-9]{30,}" },
  { id: "gitlab-pat", source: "glpat-[A-Za-z0-9_-]{20,}" },
  { id: "stripe-restricted-key", source: "rk_(live|test)_[A-Za-z0-9]{20,}" },
  { id: "stripe-webhook-secret", source: "whsec_[A-Za-z0-9]{20,}" },
  { id: "private-key-block", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  {
    id: "jwt",
    source: "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  },
  {
    id: "generic-secret-assignment",
    source:
      "(api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9_\\-./+=]{16,}[\"']?",
    flags: "i",
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
    if (value.includes("://")) continue; // URL, not a secret
    if (shannonEntropy(value) >= 4.5) return `high-entropy-secret:${name}`;
  }
  return null;
}

export function stripPrivate(text: string): string {
  // Closed pairs first...
  let out = text.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
  // ...then an unclosed <private> redacts everything after it. A dangling
  // tag almost always means the author intended the rest to be private.
  out = out.replace(/<private>[\s\S]*$/gi, "[REDACTED]");
  return out;
}

export function redact(
  text: string,
  patterns: string[],
): { content: string; hadSecret: boolean; matchedPattern: string | null } {
  const stripped = stripPrivate(text);
  const builtin = findBuiltinSecret(stripped);
  if (builtin)
    return { content: stripped, hadSecret: true, matchedPattern: builtin };
  const user = findSecret(stripped, patterns);
  if (user) return { content: stripped, hadSecret: true, matchedPattern: user };
  const entropic = findHighEntropySecret(stripped);
  if (entropic)
    return { content: stripped, hadSecret: true, matchedPattern: entropic };
  return { content: stripped, hadSecret: false, matchedPattern: null };
}
