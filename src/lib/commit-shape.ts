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
