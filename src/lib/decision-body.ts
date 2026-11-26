import { proseWordCount, rationaleLines } from './commit-body.js';
import { TITLE_CUT_AT } from './commit-shape.js';
import { BUMP_BODY, cap, DUMP_HEADING, extractReason, hasImporterMetadata, stripImporterMetadata, stripTrailers } from './reason-extract.js';

/** Words a choice is written in. Measured on objectionary/eo: these find the replacements and rules, not the fixes. */
export const DECISION_SHAPED = /\b(?:adopt|switch(?:ed)? to|move to|migrate|replace[sd]?\b.*\bwith|instead of|deprecate|drop support|requires?|must|always|never|no longer|policy|convention|prefer|standardi[sz]e|forbid|disallow)\b|^use\b/i;

/** A commit that is housekeeping or a reversal. Its body never makes it a decision. */
export const MECHANICAL_PREFIX = /^(?:tests?|ci|style|chore|build|revert|bump|deps?|merge)\b/i;

/** Fewer prose words than this in a body is a label or a note, not a statement. Counts words of any script. */
const MIN_BODY_WORDS = 8;
/**
 * Function words that mark English and that no other language written in the Latin script uses as one: "a", "in", "as",
 * "do", "was", "an" and "no" are left out (Spanish, Italian, Portuguese, German, Dutch). isMostlyEnglish cannot tell
 * the two apart, since Spanish is 98% ASCII letters.
 */
const ENGLISH_WORDS = new Set(['the', 'and', 'of', 'to', 'is', 'are', 'were', 'that', 'this', 'with', 'from', 'when', 'because', 'which', 'it', 'be', 'we', 'not', 'has', 'have', 'had', 'will', 'but', 'does', 'would', 'should', 'can', 'instead', 'if']);
// Technical English is thin in function words ("Fixes MD013 violations introduced by the section"), so the bar is low:
// two of them, and one word in sixteen.
const ENGLISH_MIN_WORDS = 2;
const ENGLISH_SHARE = 0.06;
function looksEnglish(text: string): boolean {
  const ws = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  const hits = ws.filter((w) => ENGLISH_WORDS.has(w)).length;
  return hits >= ENGLISH_MIN_WORDS && hits / ws.length >= ENGLISH_SHARE;
}

const MERGE_LINE = /^merge (?:pull request|pr|branch|remote-tracking)\b/i;
// A pointer ("Relates: #894", "See #12") or a byline with an address is provenance, not a reason.
const POINTER_OR_BYLINE = /^[A-Za-z][\w-]*:\s*https?:\/\/\S+$|^(?:relates?(?: to)?|related|see|refs?|part of)\b[^.]{0,40}(?:#\d+|https?:)|\b[\w.+-]+@[\w-]+\.[\w.-]+/i;
const flat = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A line that is the subject again says nothing the subject did not. A line that merely contains its words (\"We cache sessions because ...\") is prose. */
const echoesSubject = (line: string, subject: string): boolean => !!flat(subject) && flat(line) === flat(subject);

/**
 * The reason a commit's own body gives, for a row whose subject says only WHAT changed ("docs(gotchas): escalar 3
 * gotchas", "feat: add session cache"). Null when there is none.
 *
 * The signal is structural, so it works in any language: the body holds prose beyond the subject (the same lines the git
 * importer judged when it kept the commit: no trailers, no "Fixes #N", no echo of the subject, no file lists) and that
 * prose is at least MIN_BODY_WORDS words. The shown reason is the first such paragraph in the author's words, cut at a
 * word boundary.
 *
 * English prose gets one more test, because a fix's body usually says what broke and that is not a choice (1,317 of
 * objectionary/eo's 1,817 reasoned commits were fixes): it must carry a causal clause (reason-extract.ts) or decision
 * wording. Prose with too few English function words (Spanish, German, Chinese ...) is trusted on structure, since those English word lists cannot read it.
 */
/** A leading issue reference ("#10073:", "bug(#10058):", "fix(#9858):"), which hides the word that follows it. */
const ISSUE_PREFIX = /^(?:(?:[a-z]+\(#?\d+\)|#\d+):\s*)+/i;
export const withoutIssuePrefix = (title: string): string => title.replace(ISSUE_PREFIX, '');

/**
 * A choice, not just a cause: a contrast or an alternative ("instead of", "rather than") or a decision verb. A fix's
 * body says why it broke; only these say what was picked over what.
 */
const CHOICE_VERB = /\b(?:decided?|chose|chosen|opted|settled on|rather than|we prefer|preferred over|on purpose|deliberately|trade-?off)\b/i;
// "Instead of" counts only with its reason in the same sentence ("400 instead of 500 because clients retry").
const INSTEAD_BECAUSE = /\binstead of\b[^.!?]*\b(?:because|since|so that|to avoid|to prevent|in order to)\b|\b(?:because|since|so that|to avoid|to prevent)\b[^.!?]*\binstead of\b/i;
const isChoice = (sentence: string): boolean => CHOICE_VERB.test(sentence) || INSTEAD_BECAUSE.test(sentence);

/**
 * `needsChoice`: the subject is shaped like a fix, so an English body must state a choice, not merely a cause.
 * Non-English prose is still trusted on structure.
 */
export function statedBodyReason(title: string, summary: string | null | undefined, needsChoice = false): string | null {
  if (!summary) return null;
  const bare = stripImporterMetadata(summary);
  let text = hasImporterMetadata(summary) ? stripTrailers(bare, title) : bare;
  // Someone else's changes: release notes say what a dependency did, not why we took it.
  if (BUMP_BODY.test(text)) return null;
  const dump = DUMP_HEADING.exec(text);
  if (dump) text = text.slice(0, dump.index);
  // Code and hidden template text are not prose, whatever words they hold (extractReason drops the same two).
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '\n').replace(/^\s*(```|~~~)[\s\S]*?(?:^\s*\1|$(?![\s\S]))/gm, '\n');
  // The stored text opens with the whole subject, of which the row's title holds the first 80 characters.
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim();
  // The graph keeps 80 characters of a title, so a longer stored subject starts with it; anything else that merely begins
  // with the words is a sentence of the body.
  const opensWithSubject = first === title.trim() || (title.length >= TITLE_CUT_AT && first.startsWith(title));
  if (opensWithSubject) text = nl < 0 ? '' : text.slice(nl);
  const subject = opensWithSubject ? first : title;

  const prose = text.split(/\n\s*\n/)
    .map((p) => rationaleLines(subject, p).filter((l) => !MERGE_LINE.test(l) && !POINTER_OR_BYLINE.test(l) && !echoesSubject(l, subject)).map((l) => l.replace(/\*\*|__/g, '')))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join(' ').replace(/\s+/g, ' ').trim());
  const all = prose.join(' ');
  if (proseWordCount(all) < MIN_BODY_WORDS) return null;
  if (!looksEnglish(all)) return cap(prose[0]!);
  // English: print the sentence that carries the reason or the choice, not the paragraph it sits in.
  if (needsChoice) {
    const picked = all.split(/(?<=[.!?])\s+/).find((sentence) => isChoice(sentence));
    return picked ? cap(picked) : null;
  }
  const stated = extractReason(title, summary);
  if (stated) return stated;
  const choice = all.split(/(?<=[.!?])\s+/).find((sentence) => DECISION_SHAPED.test(sentence));
  return choice ? cap(choice) : null;
}

/** A reason written in the subject itself ("Use X instead of Y because Z is faster"): the clause from the cause word on.
 *  The cause word is followed by a space and a word, so `because.js` is a file name, not a reason. */
const SUBJECT_CAUSE = /\b(?:because|so that|to avoid|to prevent|in order to)\s+\S.*$/i;
export function subjectReason(title: string): string | null {
  const m = SUBJECT_CAUSE.exec(title);
  return m ? cap(m[0].trim()) : null;
}
