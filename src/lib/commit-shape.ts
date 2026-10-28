/**
 * What makes a commit SUBJECT mechanical, in one place. `isDecisionCommit` (git.ts)
 * builds its regex from this, and the capture report (fetchers/git.ts) names the list in
 * the line a user reads - so the two cannot drift, which they had by the time a
 * review read them (the report named four prefixes of eight). A leaf module with no
 * imports, so the tests that mock `lib/git.js` still print the real list.
 */
export const MECHANICAL_SUBJECT_PREFIXES = [
  'chore', 'wip', 'merge', 'revert', 'bump', 'update deps', 'release', 'typo',
] as const;

/** Below this many characters a subject is a label, not a decision. */
export const MIN_DECISION_SUBJECT_CHARS = 20;

/**
 * The predicate's regex, built from the list with every prefix escaped. Eight plain
 * words need no escaping today; a future `c++` interpolated raw would read as "one or
 * more c" and reject `ccc:` while looking exactly like a list entry (Copilot on #240).
 * Anchored and case-insensitive, as the hand-written literal it replaced was.
 */
export function mechanicalSubjectRegex(prefixes: readonly string[]): RegExp {
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(${escaped.join('|')})`, 'i');
}

const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s*/i;
const PR_REFERENCE = /\s*\(#\d+[^)]*\)/g;
const RELEASE_SCOPE = /^[a-z]+\(release\)/i;
// Bump, Bumps, Bumped ... as the first word once any `type(scope):` is gone; Release only when
// it names a version or stands alone, so "fix: release the socket when the client aborts" stays a decision.
const RELEASE_OR_BUMP_WORD = /^(?:bump\w*(?:\s|$)|releas\w*\s*$|releas\w*\s+v?\d)/i;
// "v5.9.0", "5.11.2", "Version 6.0.0-alpha.1": a subject that is only a version.
const VERSION_ONLY = /^(?:v(?:ersion)?\s*)?\d+\.\d+(?:\.\d+)?(?:[-+.][\w.-]+)?$/i;

/**
 * A release or version-bump subject: "Bumped v5.9.0", "Release v5.9.0", "v5.9.0",
 * "chore(release): 5.9.0", "build(deps): bump x from 1 to 2". The prefix list above only sees a
 * subject that STARTS with a word, so a scoped type ("build(deps): bump ...") slipped past it, and
 * a PR title never went through it at all. Dependency REPLACEMENTS ("build(deps): replace a with
 * b") are decisions and stay out: only the bump and release words count, not the `deps` scope.
 */
export function isReleaseOrBumpSubject(subject: string): boolean {
  const t = subject.trim();
  if (RELEASE_SCOPE.test(t)) return true;
  const body = t.replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim();
  return RELEASE_OR_BUMP_WORD.test(body) || VERSION_ONLY.test(body);
}

/**
 * Subjects that read as housekeeping, not as a choice. Conventional `type:` / `type(scope):` shapes
 * only, so prose like "document the retry policy" is not demoted; git's own Merge subjects (not
 * prose like "Merge the two workers"); a `[DRAFT` / `[WIP` / `[Backport` marker (a backport repeats a decision made in the original).
 */
const HOUSEKEEPING_SHAPE = /^(?:(?:docs|chore|ci|test|style|build)(?:\([^)]*\))?!?:|merge\s+(?:pull request|branch|remote-tracking|tag)\b|\[(?:draft|wip|backport)\b)/i;

/** What the first-run box and the starter prompts must not show as a decision. */
export function isHousekeepingTitle(title: string): boolean {
  return HOUSEKEEPING_SHAPE.test(title.trim()) || isReleaseOrBumpSubject(title);
}

/** The graph keeps a title as its first 80 characters (local-gateway-client.ts), so one this long may be cut mid-word. */
export const TITLE_CUT_AT = 80;
export function isCutTitle(title: string): boolean {
  return title.trim().length >= TITLE_CUT_AT;
}
