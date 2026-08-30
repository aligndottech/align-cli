import { execa } from 'execa';

/**
 * Sizing and credential-discovery helpers for `align setup`.
 *
 * Lives outside setup.ts deliberately: that file is 833 lines and the 900-line
 * ratchet is real, but more importantly these two are pure enough to test
 * directly, which the flow around them is not.
 */

// Lines the prompt needs beyond the option rows themselves: the message, clack's
// top and bottom rules, the submit hint, and enough slack that the previous
// command's last line is not overwritten.
const RESERVED_ROWS = 8;

// Below this a paginated list is unusable, so we overflow slightly rather than
// render one option at a time. clack scrolls within maxItems, so a floor is safe.
const MIN_VISIBLE = 3;

// Used when stdout is not a TTY and reports no size. 24 is the classic default.
const ASSUMED_ROWS = 24;

/**
 * How many options `@clack/prompts` may render at once.
 *
 * Without this, clack draws every option and its in-place redraw miscounts once
 * the list is taller than the viewport, duplicating rows on screen. An outside
 * tester hit exactly that on 2026-08-30: seven connectors, a screenful of git
 * import output above them, and "Notion" painted three times.
 */
export function pickerMaxItems(rows: number | undefined, optionCount: number): number {
  const height = typeof rows === 'number' && Number.isFinite(rows) && rows > 0 ? rows : ASSUMED_ROWS;
  const usable = Math.max(MIN_VISIBLE, height - RESERVED_ROWS);
  return Math.min(optionCount, usable);
}

/**
 * Read an already-authenticated token out of a local CLI, so a user who has
 * `gh` set up is not sent to a browser to mint a PAT by hand.
 *
 * Returns null for every failure - not installed, not logged in, or authenticated
 * but printing nothing. Null means "ask the user normally", so a broken or absent
 * CLI degrades to the flow that existed before rather than to an error.
 */
export async function detectCliToken(bin: string, args: string[]): Promise<string | null> {
  try {
    // execa rejects on a non-zero exit, so the catch covers "not logged in"; the
    // explicit check covers a runner configured with reject:false upstream.
    const result = await execa(bin, args, { timeout: 5_000 });
    if (typeof result?.exitCode === 'number' && result.exitCode !== 0) return null;
    const token = String(result?.stdout ?? '').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Connectors whose token can be read from an already-authenticated local CLI. */
export const CLI_TOKEN_SOURCES: Record<string, { bin: string; args: string[]; label: string }> = {
  github: { bin: 'gh', args: ['auth', 'token'], label: 'GitHub CLI (gh)' },
};

/**
 * Whether to use a token found in a local CLI, ask first, or ignore it.
 *
 * Separate from the prompt chain on purpose. `--approve` is documented as "Skip
 * confirmation prompts (for scripted use)", and this repo has already shipped one
 * prompt that ignored it - setup.ts still carries the comment about `align setup
 * --approve` hanging when two agents were installed. A rule buried in an async
 * prompt chain is not testable; this is.
 */
export function cliTokenDecision(o: { token: string | null; approve: boolean }): 'use' | 'ask' | 'skip' {
  if (!o.token) return 'skip';
  // --approve means the affirmative, not the absence of the step: skipping the
  // connector would silently drop a source the user could have had.
  return o.approve ? 'use' : 'ask';
}
