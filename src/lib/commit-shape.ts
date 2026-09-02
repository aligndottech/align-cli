/**
 * What makes a commit SUBJECT mechanical, in one place. `isDecisionCommit` (git.ts)
 * builds its regex from this, and the capture report (fetchers/git.ts) names the list in
 * the line a user reads - so the two cannot drift, which they had by the time ALI-827's
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
