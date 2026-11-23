/**
 * Split a section that is a list of standalone rules into one entry per rule.
 *
 * Why: a section of nine rules stored as one decision matches a query about any one of them
 * weakly (the other eight dilute it), and a diff check misses a rule the section only mentions
 * in passing. One decision per rule fixes both, and DECISIONS.md can then print each rule.
 *
 * Conservative on purpose. A section splits only when ALL of these hold:
 *  - it holds a bulleted or numbered list of at least MIN_RULES top-level items;
 *  - nothing but a short intro (and `###` group headings) sits outside the list, so a prose
 *    paragraph, before or after the list, keeps the section whole;
 *  - it is a bulleted list, never a numbered one (numbered lists are install steps and procedures);
 *  - at least 60% of the items carry a modal or a negation (never, always, must, do not, should, avoid, prefer,
 *    only, require), so a list of commands, options, links or changelog lines keeps the section whole.
 * Indented continuation lines and sub-bullets stay with their parent rule.
 */
export interface SplitRule {
  /** The rule's first line exactly as written, list marker removed. Verbatim so the committed-file check finds it. */
  text: string;
  /** The rule with its sub-bullets and continuation lines. */
  full: string;
  /** The nearest `###` heading above it, if any. */
  group?: string;
}

export const MIN_RULES = 3;
export const MAX_RULES_PER_SECTION = 30;
export const MAX_INTRO_CHARS = 300;
/** The share of items that must state an obligation or a prohibition. 3 of 5 splits, 4 of 7 does not. */
export const MODAL_SHARE = 0.6;

const MARKER = /^[-*+]\s+(\S.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s/;
const MODAL = /\b(?:never|always|must|do not|don't|dont|should|avoid|prefer|only|require[ds]?)\b/i;

function clean(s: string): string {
  return s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

export interface RuleList {
  rules: SplitRule[];
  /** Rules past MAX_RULES_PER_SECTION, which are not kept. */
  dropped: number;
}

/** Returns the rules, or null when the section is not a plain list of rules. */
export function splitRuleList(rawBody: string): RuleList | null {
  const lines = rawBody.replace(/\r\n?/g, '\n').split('\n');
  const rules: Array<{ first: string; lines: string[]; group?: string }> = [];
  let intro = '';
  let group: string | undefined;
  let seenList = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (NUMBERED.test(line) && !/^\s{2,}/.test(line)) return null;
    const indented = /^\s{2,}\S|^\t/.test(line);
    const m = !indented ? line.match(MARKER) : null;
    if (m) {
      seenList = true;
      rules.push({ first: m[1]!, lines: [m[1]!], ...(group ? { group } : {}) });
      continue;
    }
    const h = line.match(/^###+\s+(.+)$/);
    if (h) {
      group = clean(h[1]!);
      continue;
    }
    if (!seenList) {
      intro += `${line} `;
      continue;
    }
    // Indented text under a rule belongs to it; unindented text after a rule is prose or a lazy continuation.
    if (indented) {
      rules[rules.length - 1]!.lines.push(line.trim());
      continue;
    }
    return null;
  }
  if (!seenList || rules.length < MIN_RULES || intro.trim().length > MAX_INTRO_CHARS) return null;
  const modal = rules.filter((r) => MODAL.test(clean(r.first))).length;
  if (modal / rules.length < MODAL_SHARE) return null;
  return {
    rules: rules.slice(0, MAX_RULES_PER_SECTION).map((r) => ({
      text: r.first.trim(),
      full: r.lines.join('\n'),
      ...(r.group ? { group: r.group } : {}),
    })),
    dropped: Math.max(0, rules.length - MAX_RULES_PER_SECTION),
  };
}
