/**
 * One rule for how bad a MODEL-JUDGED conflict is, used by every site that turns a verdict into a severity
 * (local-gateway-client.ts for the graph check, decisions-file-check.ts for --decisions-file).
 *
 * Before this, `confidence >= 0.8` alone made a conflict CRITICAL, and that number is the model's own. A model
 * saying "likely relates to the audit findings ... potentially undermining" at 0.9 was CRITICAL, and in
 * --block-on-critical it could deny an edit. CRITICAL now also needs GROUNDING, text a program can check:
 *
 *  (a) v1 only: both evidence quotes the model gave are present, whitespace, case and markdown emphasis marks
 *      aside, one in the decision and one in the change. The v1 prompt asks for them; v0's byte-pinned prompt
 *      has no such field.
 *  (b) any detector: a distinctive literal from the changed lines also appears in the decision's text - a number of
 *      two or more digits, an identifier-like token (MAX_REVIEW_DAYS, sendInvoices, REDIS_URL), or two different
 *      plain words that are not stop words. Added lines count as well as removed ones, so a change that only adds
 *      ("use Redis" against "no Redis") can still ground. The cost is that two shared plain words can ground a guess;
 *      conflict-severity.test.ts shows that case instead of hiding it. Plain words in a trailing comment the edit left
 *      as it was do not count (withoutUnchangedComments, below).
 *
 * No hedge-word parsing: "likely" and "potentially" are tone, and a confident wrong reason has none. Without
 * grounding the conflict stays a conflict (status and exit codes do not move) and is labelled a warning.
 */
export type Evidence = { new_quote: string; existing_quote: string };
export interface Grounding {
  /** Everything the decision says: its title and summary. */
  decisionText: string;
  /** The change as the model saw it (a unified diff). */
  changeText: string;
  evidence?: Evidence | null;
}

const CRITICAL_CONFIDENCE = 0.8;

// Markdown marks go, so a quote reads through **bold**, `code` and _emphasis_. An underscore inside a name stays:
// without it REDISURL would count as a quote of REDIS_URL.
const squash = (s: string): string => s.toLowerCase().replace(/[*`]|(?<![a-z0-9])_|_(?![a-z0-9])/g, '').replace(/\s+/g, ' ').trim();

type ChangedLine = { added: boolean; text: string };

/** The removed and the added lines, without markers, headers or context. null when the text is not a diff at all. */
function changedLines(diff: string): ChangedLine[] | null {
  const out: ChangedLine[] = [];
  const lines = diff.split(/\r?\n/);
  let header = true;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) { header = true; continue; }
    if (line.startsWith('@@')) { header = false; continue; }
    // A patch with no "diff --git" lines starts its next file with "--- old", "+++ new", then a hunk header. Those
    // two are file names, not changes. Without the hunk header they are a removed "-- x" and an added "++ y" line.
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && lines[i + 2]?.startsWith('@@')) header = true;
    if (header) continue;
    if (line.startsWith('-') || line.startsWith('+')) out.push({ added: line.startsWith('+'), text: line.slice(1) });
  }
  // A text that is not a diff at all (a pasted change) is its own changed text: the caller reads it whole.
  return out.length || /^(diff --git |@@|--- |\+\+\+ )/m.test(diff) ? out : null;
}

// "code  # note" or "code  // note": the code, then the note. The marker needs a space on both sides, so "C# for",
// "#1234" and "https://host" are not comments.
const TRAILING_COMMENT = /^(.*?\S)\s+(?:#|\/\/)\s+(\S.*)$/;

/**
 * The changed lines without any trailing comment that reads the same on a removed line and on an added one. The edit
 * did not change that comment, it changed the code in front of it, so the comment's plain words say nothing about the
 * change. A one-line edit of `DEFAULT_MODE = "warn"  # warn | block | off (start warn; ...)` made three unrelated
 * commits CRITICAL through that comment's words: start, block, once.
 */
function withoutUnchangedComments(lines: ChangedLine[]): string {
  const parts = lines.map((l) => ({ ...l, comment: TRAILING_COMMENT.exec(l.text) }));
  const notesOn = (added: boolean): Set<string> => new Set(parts.filter((p) => p.added === added && p.comment).map((p) => p.comment![2]!));
  const removed = notesOn(false);
  const added = notesOn(true);
  return parts.map((p) => (p.comment && removed.has(p.comment[2]!) && added.has(p.comment[2]!) ? p.comment[1]! : p.text)).join('\n');
}

const STOP = new Set(('that this with from have will would should could there their about which when where what into over under after before '
  + 'because while then than them they been being were also only more most some such each other same just like make made does done used uses using '
  + 'default value values true false null none undefined return import export const class function type string number list item items data file files '
  + 'json http https html yaml yml toml name names text line lines code test tests main code self else elif case break continue public private static void async await').split(' '));

// A number of two or more digits that is not a part of a date, a time, a version or a path (2026-11-25, 1.2.3,
// 10:30): their pieces are everywhere. Either nothing is joined to its left, or a minus SIGN is: a "-" that opens the
// line, or follows an opener, or follows a space with no digit or closing bracket before it. So the 100 in "= -100"
// counts, and the 20 in "10 -20", "(10)-20" and "--20" does not.
const NUMBER = /(?:(?<![\d.:/-])|(?<=(?:^\s*|[=(,[{:<>"'`]|[^\d)\]}\s]\s+)-))\d{2,}(?![\d.\-:/])/gm;

function literals(changed: string): { strong: string[]; plain: string[] } {
  const strong = new Set<string>();
  const plain = new Set<string>();
  for (const n of changed.match(NUMBER) ?? []) strong.add(n);
  for (const id of changed.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    // An underscore or a digit marks a name; JSON, HTTP and GitHub do not, and fall to the plain-word rule.
    const identifierLike = id.length >= 4 && (/_/.test(id) || /\d/.test(id));
    if (identifierLike) strong.add(id.toLowerCase());
    for (const w of id.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/)) {
      const lw = w.toLowerCase();
      if (/^[a-z]{4,}$/.test(lw) && !STOP.has(lw)) plain.add(lw);
    }
  }
  return { strong: [...strong], plain: [...plain] };
}

const hasToken = (text: string, token: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(text);

export function isGrounded(g: Grounding): boolean {
  const { evidence } = g;
  const lines = changedLines(g.changeText);
  const changed = lines ? lines.map((l) => l.text).join('\n') : g.changeText;
  // A quote must be a phrase (two words or eight characters), or "the" would ground anything. The change's quote is read
  // against the changed lines only: a quote of a header or a context line is not a quote of the change.
  const phrase = (q: string): boolean => squash(q).length >= 8 || squash(q).split(' ').length >= 2;
  if (evidence && phrase(evidence.existing_quote) && phrase(evidence.new_quote)
    && squash(g.decisionText).includes(squash(evidence.existing_quote)) && squash(changed).includes(squash(evidence.new_quote))) return true;
  if (literals(changed).strong.some((t) => hasToken(g.decisionText, t))) return true;
  const { plain } = literals(lines ? withoutUnchangedComments(lines) : changed);
  return plain.filter((t) => hasToken(g.decisionText, t)).length >= 2;
}

export function conflictSeverity(confidence: number, g: Grounding): 'critical' | 'warning' {
  return confidence >= CRITICAL_CONFIDENCE && isGrounded(g) ? 'critical' : 'warning';
}
