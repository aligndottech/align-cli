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

export const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s*/i;
const PR_REFERENCE = /\s*\(#\d+[^)]*\)/g;
// "v5.9.0", "5.11.2", "Version 6.0.0-alpha.1": a subject that is only a version.
const VERSION_ONLY = /^(?:v(?:ersion)?\s*)?\d+\.\d+(?:\.\d+)?(?:[-+.][\w.-]+)?$/i;
// "Bump", "Bumped v5.9.0", "Release 5.9.0": the word alone, or the word and a dotted version.
const BARE_BUMP_OR_RELEASE = /^(?:bump\w*|releas\w*)(?:\s*$|\s+v?\d+\.\d)/i;
// One package token moving to a version, and nothing else: "bump x from 1 to 2", "Update dependency x to v3". More words
// after the version ("... and fix type definition"), or a sentence in between ("Update docs for listening to 0.0.0.0"), is prose.
const DEPENDENCY_MOVE = /^(?:bump\w*|updat\w*|upgrad\w*)(\s+dependency)?\s+([@\w./-]+)\s+(?:from\s+(v?\d[\w.-]*)\s+)?(?:to\s+(?:version\s+)?(v?\d[\w.-]*))(?:\s+in\s.*|\s*\(.*\))?[.]?$/i;
// A subject that says why is a decision whatever its shape: "bump timeout ... because the upstream is slow",
// "bump minimum Node to 20, drops 18", "bump lodash to 4.17.21 (CVE-2021-23337)".
export const STATED_WHY = /\b(?:because|so that|so we|so it|in order to|to keep|to avoid|to prevent|to ensure|to make sure|due to|since|cve-\d+|drops?|dropping|security|breaking)\b/i;

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
export function isReleaseOrBumpSubject(subject: string, opts: { guessPackages?: boolean } = {}): boolean {
  const body = subject.trim().replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim();
  if (STATED_WHY.test(body)) return false;
  if (VERSION_ONLY.test(body) || BARE_BUMP_OR_RELEASE.test(body)) return true;
  const move = DEPENDENCY_MOVE.exec(body);
  if (!move) return false;
  // A "bump" verb is housekeeping whatever it moves (the prefix list drops it at capture as well).
  if (/^bump/i.test(body)) return isMoveShaped(move[2]!, move[3], move[4]!);
  // Anything else needs a package-SHAPED name. "dependency" and "from <version>" are never evidence on their own.
  // Capture (guessPackages: false) stops at the explicit "dependency" qualifier; display surfaces accept the name alone.
  return isPackageToken(move[2]!, move[3], move[4]!) && (!!move[1] || opts.guessPackages !== false);
}

// A mechanical bump is the WHOLE subject: an action, one package-like token, an optional "from <version>", and
// "to|with <version>" (a "with" must repeat the same package), then nothing. Anything after the version,
// or a sentence where the package should be, is prose and stays a decision. "bump" is not here: main's
// MECHANICAL_SUBJECT_PREFIXES already rejects every subject that starts with it, and this must not widen that.
// The shape only finds the parts; `looksLikePackageBump` below decides whether they describe a package.
const PKG = String.raw`[\w@./:-]+`;
const VERSION = String.raw`v?\d[\w.+-]*`;
const DEPENDENCY_BUMP_SHAPE = new RegExp(
  String.raw`^(?:update|upgrade|replace)\w*(\s+(?:dependenc(?:y|ies)|package))?\s+(${PKG})(?:\s+from\s+(${VERSION}))?\s+(to|with)\s+(?:version\s+)?(?:(${PKG})\s+)?(${VERSION})$`,
  'i',
);
// The shape of a token moving to a version, with no opinion on whether it is a package (the "bump" branch only).
const MOVE_NAME = /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*(?:[/:][a-z0-9._-]+)*)$/i;
const DOTTED_OR_V = /^v\d|\d\.\d/i;
function isMoveShaped(name: string, from: string | undefined, version: string): boolean {
  if (/^[A-Z0-9_]+$/.test(name) || name.includes('_')) return false; // a setting written as a constant
  return MOVE_NAME.test(name) && (!!from || DOTTED_OR_V.test(version));
}

// Generic words an internal component or a layer is named with ("auth-service", "db-schema"). A hyphenated name
// containing one is never taken for a package: keeping a bump is noise, dropping a decision is permanent loss.
const GENERIC_SEGMENTS = new Set([
  'service', 'services', 'svc', 'schema', 'schemas', 'api', 'app', 'server', 'client', 'worker', 'config', 'db',
  'auth', 'core', 'web', 'ui', 'backend', 'frontend', 'infra', 'cache', 'queue', 'gateway', 'module', 'layer',
]);
const FILE_EXTENSION = /\.(?:ya?ml|json|toml|md|txt|js|ts|cfg|conf|ini|env|lock|xml|sql|sh|py)$/i;

/**
 * Is this NAME shaped like a published package: scoped (@org/pkg), dotted (socket.io), or a hyphenated lowercase
 * name (xml-apis, jackson-databind, vite-plugin-react)? A digit alone (python3) and a bare noun (postgres, docs,
 * manager) are not. "dependency", "package" and "from <version>" never make a name one. A "group:artifact" pair
 * needs every part to qualify; an image tag (python:3.11) never does.
 */
export function isPackageShapedName(name: string): boolean {
  if (name.includes(':')) {
    const parts = name.split(':');
    return parts.length === 2 && parts.every((p) => p !== '' && !/^v?\d/.test(p) && isPackageShapedName(p));
  }
  if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name)) return true;
  if (/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/i.test(name)) return !FILE_EXTENSION.test(name);
  const segments = name.split('-');
  return segments.length > 1 && segments.every((s) => /^[a-z][a-z0-9]*$/.test(s)) && !segments.some((s) => GENERIC_SEGMENTS.has(s));
}

/** The shape of a package token moving to a version, and the name must be package-shaped. */
function isPackageToken(name: string, from: string | undefined, version: string): boolean {
  return isMoveShaped(name, from, version) && isPackageShapedName(name);
}

function looksLikePackageBump(m: RegExpExecArray): boolean {
  const [, , name, from, joiner, withPkg, version] = m as unknown as string[];
  // "Replace A with B 8" swaps one tool for another. Only the same package at a new version is a bump.
  if (joiner!.toLowerCase() === 'with' && (withPkg ?? '').toLowerCase() !== name!.toLowerCase()) return false;
  if (joiner!.toLowerCase() === 'to' && withPkg) return false;
  return isPackageToken(name!, from, version!);
}

// STATED_WHY plus the words a policy or a requirement is written in. Free-standing only: "get-port" is a package, not a reason.
const DEPENDENCY_WHY = new RegExp(
  String.raw`(?<![-\w./:@])(?:get|as|require|requires|policy|eol|so|allow|enables|in order to)(?![-\w./:@])|${STATED_WHY.source}`,
  'i',
);

/**
 * A subject that moves, replaces or upgrades one package and says nothing more. RENDER ONLY (the decisions file): it
 * guesses at a package name, so capture must never use it. Capture drops only isReleaseOrBumpSubject and isRenovateBump.
 */
export function isDependencyBumpSubject(subject: string): boolean {
  const body = subject.trim().replace(/^\(#\d+\)\s*/, '').replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim();
  const m = DEPENDENCY_BUMP_SHAPE.exec(body);
  return !!m && looksLikePackageBump(m) && !DEPENDENCY_WHY.test(body);
}

/** Renovate's own shape: "Update dependency x to v3", "Replace dependency a with a 1.0". Unambiguous because it says "dependency". */
export function isRenovateBump(subject: string): boolean {
  const body = subject.trim().replace(/^\(#\d+\)\s*/, '').replace(CONVENTIONAL_PREFIX, '').replace(PR_REFERENCE, '').trim();
  const m = DEPENDENCY_BUMP_SHAPE.exec(body);
  return !!m && !!m[1] && /^\s+dependenc/i.test(m[1]) && looksLikePackageBump(m) && !DEPENDENCY_WHY.test(body);
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

const POLICY_WORD = /\b(?:adopt|requires?|standardi[sz]e[sd]?|enforce[sd]?|mandate[sd]?|deprecate[sd]?|always|never|must|only|all|every|no longer|should(?: not)?|should(?:n't)?|do not|don't)\b/i;
const ONE_OFF_VERBS = /^(?:add|fix|rename|update|remove|bump|refactor|document|extend|post|put|modify|typo|tidy)\b/i;
const ONE_OFF_TYPES = new Set(['fix', 'test', 'refactor', 'chore', 'ci', 'docs', 'style', 'build']);
const TYPO = /\btypos?\b/i;
const SWEEPING_QUANTIFIER = /\b(?:all|every)\b/i;
const TYPE_PREFIX = /^([a-z]+)(?:\([^)]*\))?!?:\s*/i;
// A stated numeric bound ("between 400 and 599", "no more than 5", "over 1048576") is a rule, not a change note.
const NUMERIC_BOUND = /\b(?:between\s+\d+\s+and\s+\d+|(?:at least|at most|no more than|no less than|up to|more than|less than|over|under|above|below)\s+\d+)\b/i;

/**
 * Is this a title-only change note: it leads with a one-off verb (add, fix, rename, update,
 * remove, bump, refactor, document, typo, tidy), or a one-off conventional type (fix, test,
 * refactor, chore, ci, docs, style, build), and carries nothing that makes it a decision? A PR
 * title taken from a merge commit has no body to say why, so this is the only thing standing
 * between a "rename abandonment endpoint" and the graph.
 *
 * Anything that does not lead like that is NOT one-off: decision verbs (use, switch, migrate,
 * replace, drop, stop, move, change, make), `feat`, an `RFC:` prefix, and any title in a language
 * whose verbs this list does not know. A one-off lead is rescued by a stated purpose
 * (STATED_WHY: "so that", "to keep", "because" ...), a policy word or modal (adopt, require,
 * never, should not ...), a sweeping quantifier (all, every), or a numeric bound (between 400 and 599).
 */
/** Does the title state a numeric bound? Shared so a title-only rule is kept by every filter, not only this one. */
export function statesNumericBound(title: string): boolean {
  return NUMERIC_BOUND.test(title);
}

// Types whose commits do not set how the code behaves, so a rule word in their title is about a test
// or a doc, not a decision ("test: ... should not crash", "docs: clarify ... must be Errors").
const RULE_EXEMPT_TYPES = new Set(['docs', 'test', 'tests', 'chore', 'ci', 'style', 'build']);
// A word that states a rule or a replacement. The lookarounds keep it from matching inside a package,
// file or code name ("fastify-https-always", "require.cache"). "deprecated" and "required" are left
// out on purpose: as adjectives ("remove deprecated X") they describe, they do not decide.
const SUBJECT_RULE = /(?<![-\w./])(?:do not|don't|never|must(?: not)?|should not|shouldn't|no longer|always|disallow|forbid|deprecates?|in fav(?:o|ou)r of|instead of)(?![-\w./])/i;

/**
 * Does a commit title state a rule on its own, with no body to say why? A prohibition or obligation
 * ("do not force close ...", "should not pass url", "disallow reply status code 600"), a deprecation,
 * or a replacement ("use X instead of Y", "deprecate A in favour of B"). Docs, test, chore, ci, style
 * and build commits never count. Measured on fastify's history, this keeps 45 of the 1,960 body-less
 * commits that a body-only rule dropped, and reading them, most are real decisions.
 */
export function statesSubjectRule(title: string): boolean {
  const t = title.trim().replace(PR_REFERENCE, '').trim();
  const prefix = t.match(TYPE_PREFIX);
  if (prefix && RULE_EXEMPT_TYPES.has(prefix[1].toLowerCase())) return false;
  return SUBJECT_RULE.test(prefix ? t.slice(prefix[0].length) : t);
}

export function isOneOffChangeTitle(title: string): boolean {
  const t = title.trim().replace(PR_REFERENCE, '').trim();
  const prefix = t.match(TYPE_PREFIX);
  let oneOff: boolean;
  if (prefix) oneOff = ONE_OFF_TYPES.has(prefix[1].toLowerCase()) || TYPO.test(t);
  else oneOff = ONE_OFF_VERBS.test(t) || TYPO.test(t);
  if (!oneOff) return false;
  const body = prefix ? t.slice(prefix[0].length) : t;
  return !(STATED_WHY.test(body) || POLICY_WORD.test(body) || SWEEPING_QUANTIFIER.test(body) || statesNumericBound(body));
}
