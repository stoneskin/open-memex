/**
 * Capture length nudge (D94, OptMem small item 3): a soft length hint at
 * capture time. Inspired by OptMem's 280-byte hard cap, but deliberately
 * softer: a long body is saved normally and the caller just gets a hint
 * appended to the result. Nothing is ever refused for length - the only
 * hard ceiling is the keyword-capture `MAX_CAPTURE_CHARS` (2000, D67),
 * which stays untouched.
 *
 * Pure module: no db, no fs, no config, so the threshold behavior is
 * testable in scripts/smoke-pure.ts.
 */

/** Over this many characters a save proceeds but its result carries a hint. */
export const LENGTH_NUDGE_CHARS = 500;

/**
 * One-line hint appended to the save result when the body is long.
 * Returns null at or under the threshold - the boundary is inclusive:
 * 500 chars = no hint, 501 = hint. The wording says the save happened, so
 * an agent reading only the hint never mistakes it for a refusal.
 */
export function lengthNudge(content: string): string | null {
  if (content.length <= LENGTH_NUDGE_CHARS) return null;
  return (
    `Note: this memory is ${content.length} characters, over the ${LENGTH_NUDGE_CHARS}-character soft limit. ` +
    `It saved fine - nothing was refused. Short, self-contained statements retrieve better; ` +
    `consider replacing it with a tighter version (supersede) if one exists.`
  );
}
