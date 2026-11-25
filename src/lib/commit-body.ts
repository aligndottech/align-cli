import { CONVENTIONAL_PREFIX, STATED_WHY, statesNumericBound, statesSubjectRule } from './commit-shape.js';

// A line that IS a git trailer (key: value at the start of the line), not merely a
// sentence that happens to mention one of these words mid-line - "Refs APP-123 and
// closes #45." inside a real paragraph must NOT be stripped, only a line that is
// nothing but the trailer.
const TRAILER_LINE_RE = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|helped-by|cc|refs?|closes?|fixes?|resolves?)\s*:\s*\S/i;
// Attribution lines an agent appends (e.g. "🤖 Generated with [Claude Code](...)")
// carry no rationale either - it's who/what wrote the commit, not why. Anchored to the
// START of the line (past an optional bot emoji): unanchored, this also matched mid-
// sentence, so a real reason like "Regenerated with a fresh script..." was wrongly
// stripped as if it were an attribution line (Copilot review, PR #223).
const GENERATED_WITH_RE = /^(?:🤖\s*)?generated (with|by)\b/i;

function normalizeForEcho(s: string): string {
  return s.toLowerCase().replace(/^[*\-•]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does this commit's body actually state a reason, once the noise is stripped? Measured
 * while filtering the git-only import: a body-shaped string is not automatically a
 * WHY - a git trailer inflates "has a body" with no rationale in it, and a squash-merge
 * bullet that just repeats the subject ("* fix: same as the subject") reads as prose
 * while adding none. This is the same "prose in body, non-mechanical subject" proxy the
 * original measurement itself used to produce its headline numbers, made executable.
 */
export function hasStatedRationale(subject: string, body: string): boolean {
  // A title that states a bound ("between 400 and 599") or a rule ("do not ...", "use X instead of Y")
  // is a decision on its own, with or without a body.
  if (statesNumericBound(subject) || statesSubjectRule(subject)) return true;
  return rationaleLines(subject, body).length > 0;
}

/** The body's lines that are prose beyond the subject: what hasStatedRationale judges, in any language. */
export function rationaleLines(subject: string, body: string): string[] {
  if (!body.trim()) return [];
  const subjectNorm = normalizeForEcho(subject);
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !TRAILER_LINE_RE.test(l) && !GENERATED_WITH_RE.test(l))
    .filter(l => normalizeForEcho(l) !== subjectNorm)
    .filter(l => !SEPARATOR_LINE_RE.test(l) && !FILE_ACTION_LINE_RE.test(l))
    .filter(isReasonBearingLine);
}

// GitHub's squash-merge body is the PR's own commit list: a bullet per commit subject,
// a `---------` rule before the trailers, and (for web-editor commits) lines like
// "Modified 2 files". All of it says WHAT changed; none of it is a reason.
const SEPARATOR_LINE_RE = /^-{3,}$/;
export const FILE_ACTION_LINE_RE = /^(?:[*-]\s+)?(?:added|modified|deleted|renamed|removed)\s+(?:\d+\s+files?|\S*[/.]\S*)\s*$/i;
const BULLET_RE = /^[*-]\s+(.*)$/;
/** A bullet with no stated why only counts as prose from this many words up. */
const MIN_BULLET_WORDS = 8;

/** A plain line is evidence of a reason. A squash bullet is evidence only when it says why
 *  ("because", "to avoid", ...) or is long enough to be a sentence rather than a commit
 *  subject; a bullet in `type(scope): ...` form is a subject however long it is. */
function isReasonBearingLine(line: string): boolean {
  const bullet = line.match(BULLET_RE);
  if (!bullet) return true;
  const text = bullet[1];
  if (STATED_WHY.test(text)) return true;
  if (CONVENTIONAL_PREFIX.test(text)) return false;
  return text.split(/\s+/).length >= MIN_BULLET_WORDS;
}

