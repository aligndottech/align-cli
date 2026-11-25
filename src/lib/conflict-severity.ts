/**
 * One rule for how bad a MODEL-JUDGED conflict is, used by every site that turns a verdict into a severity
 * (local-gateway-client.ts for the graph check, decisions-file-check.ts for --decisions-file).
 *
 * Before this, `confidence >= 0.8` alone made a conflict CRITICAL, and that number is the model's own. A model
 * saying "likely relates to the audit findings ... potentially undermining" at 0.9 was CRITICAL, and in
 * --block-on-critical it could deny an edit. CRITICAL now also needs GROUNDING, text a program can check:
 *
 *  (a) v1 only: both evidence quotes the model gave are present, whitespace and case aside, one in the decision
 *      and one in the change. The v1 prompt asks for them; v0's byte-pinned prompt has no such field.
 *  (b) any detector: a distinctive literal from the changed lines also appears in the decision's text - a number of
 *      two or more digits, an identifier-like token (MAX_REVIEW_DAYS, sendInvoices, REDIS_URL), or two different
 *      plain words that are not stop words. Added lines count as well as removed ones, so a change that only adds
 *      ("use Redis" against "no Redis") can still ground. The cost is that two shared plain words can ground a guess;
 *      conflict-severity.test.ts shows that case instead of hiding it.
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

const squash = (s: string): string => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

/** The removed lines then the added ones, without markers, headers or context. */
function changedLines(diff: string): string {
  const out: string[] = [];
  let header = true;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { header = true; continue; }
    if (line.startsWith('@@')) { header = false; continue; }
    if (header) continue;
    if (line.startsWith('-') || line.startsWith('+')) out.push(line.slice(1));
  }
  // A text that is not a diff at all (a pasted change) is its own changed text.
  return out.length || /^(diff --git |@@|--- |\+\+\+ )/m.test(diff) ? out.join('\n') : diff;
}

const STOP = new Set(('that this with from have will would should could there their about which when where what into over under after before '
  + 'because while then than them they been being were also only more most some such each other same just like make made does done used uses using '
  + 'default value values true false null none undefined return import export const class function type string number list item items data file files '
  + 'json http https html yaml yml toml name names text line lines code test tests main code self else elif case break continue public private static void async await').split(' '));

function literals(changed: string): { strong: string[]; plain: string[] } {
  const strong = new Set<string>();
  const plain = new Set<string>();
  // Not a part of a date, a time, a version or a path (2026-11-25, 1.2.3, 10:30): their pieces are everywhere.
  for (const n of changed.match(/(?<![\d.\-:/])\d{2,}(?![\d.\-:/])/g) ?? []) strong.add(n);
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
  const changed = changedLines(g.changeText);
  // A quote must be a phrase (two words or eight characters), or "the" would ground anything. The change's quote is read
  // against the changed lines only: a quote of a header or a context line is not a quote of the change.
  const phrase = (q: string): boolean => squash(q).length >= 8 || squash(q).split(' ').length >= 2;
  if (evidence && phrase(evidence.existing_quote) && phrase(evidence.new_quote)
    && squash(g.decisionText).includes(squash(evidence.existing_quote)) && squash(changed).includes(squash(evidence.new_quote))) return true;
  const { strong, plain } = literals(changed);
  if (strong.some((t) => hasToken(g.decisionText, t))) return true;
  return plain.filter((t) => hasToken(g.decisionText, t)).length >= 2;
}

export function conflictSeverity(confidence: number, g: Grounding): 'critical' | 'warning' {
  return confidence >= CRITICAL_CONFIDENCE && isGrounded(g) ? 'critical' : 'warning';
}
