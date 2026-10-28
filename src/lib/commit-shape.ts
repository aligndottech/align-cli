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
// "v5.9.0", "5.11.2", "Version 6.0.0-alpha.1": a subject that is only a version.
const VERSION_ONLY = /^(?:v(?:ersion)?\s*)?\d+\.\d+(?:\.\d+)?(?:[-+.][\w.-]+)?$/i;
// "Bump", "Bumped v5.9.0", "Release 5.9.0": the word alone, or the word and a dotted version.
const BARE_BUMP_OR_RELEASE = /^(?:bump\w*|releas\w*)(?:\s*$|\s+v?\d+\.\d)/i;
// One package token moving to a version, and nothing else: "bump x from 1 to 2", "Update dependency x to v3". More words
// after the version ("... and fix type definition"), or a sentence in between ("Update docs for listening to 0.0.0.0"), is prose.
const DEPENDENCY_MOVE = /^(?:bump\w*|updat\w*|upgrad\w*)\s+(?:dependency\s+)?[@\w./-]+\s+(?:from\s+v?\d[\w.-]*\s+)?(?:to\s+v?\d[\w.-]*)(?:\s+in\s.*|\s*\(.*\))?[.]?$/i;
// A subject that says why is a decision whatever its shape: "bump timeout ... because the upstream is slow",
// "bump minimum Node to 20, drops 18", "bump lodash to 4.17.21 (CVE-2021-23337)".
const STATED_WHY = /\b(?:because|so that|in order to|to avoid|to prevent|due to|since|cve-\d+|drops?|dropping|security|breaking)\b/i;

/**
 * A release or version-bump subject with no stated reason. In words, after any `type(scope):` and
 * `(#N)` are removed it is housekeeping when it is only a version ("v5.9.0"), or the word
 * bump/release alone or followed by a dotted version ("Bumped v5.9.0", "Release 5.9.0"), or a
 * bump/update/upgrade of something FROM a version or TO a version ("Bump x from 1 to 2", "Update
 * dependency x to v3") - unless it also states why (because, to avoid, drops, a CVE ...). Its
 * complement keeps: a `release` scope ("feat(release): publish with provenance"), a bump with a
 * reason, "Release 2FA support", "feat!: v6.0.0 drops Node 18", and Revert "Bump x" (the prefix list handles that).
 * Dependency REPLACEMENTS ("replace a with b") are decisions and never match.
 */
export function isReleaseOrBumpSubject(subject: string): boolean {
  const body = subject.trim().replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim();
  if (STATED_WHY.test(body)) return false;
  return VERSION_ONLY.test(body) || BARE_BUMP_OR_RELEASE.test(body) || DEPENDENCY_MOVE.test(body);
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

const NON_BEHAVIOURAL_TYPE = /^(?:docs|style|test|chore|ci|build|release|refactor)(?:\([^)]*\))?!?:/i;

/**
 * A conventional-commit TYPE whose commits do not decide what the lines they touch do: docs, style,
 * test, chore, ci, build, release and refactor. Separate from `isHousekeepingTitle` on purpose: that one
 * feeds the first-run box and starter prompts and must not start hiding refactors there.
 */
export function isNonBehaviouralType(title: string): boolean {
  return NON_BEHAVIOURAL_TYPE.test(title.trim());
}
