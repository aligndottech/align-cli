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
 *  - at least 80% of the items open with an imperative or a modal ("Never ...", "Use ...",
 *    "Do not ..."), so a list of links, files or examples keeps the section whole.
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
const MAX_INTRO_CHARS = 300;

const MARKER = /^([-*+]|\d{1,3}[.)])\s+(\S.*)$/;
const IMPERATIVE = new RegExp(
  `^(?:${[
    'never', 'always', 'do', "don't", 'dont', 'must', 'should', 'shall', 'no', 'only', 'avoid', 'prefer', 'use', 'keep', 'ask',
    'run', 'write', 'add', 'make', 'ensure', 'require', 'commit', 'push', 'check', 'follow', 'put', 'name', 'create', 'update',
    'delete', 'remove', 'read', 'test', 'document', 'review', 'open', 'stop', 'wait', 'confirm', 'verify', 'treat', 'store',
    'pin', 'prefix', 'return', 'handle', 'log', 'set', 'limit', 'reuse', 'document', 'respect', 'explain', 'mention', 'include',
    'surface', 'flag', 'fail', 'start', 'build', 'format', 'lint', 'validate', 'sanitize', 'escape', 'cite', 'link', 'tag',
  ].join('|')})\\b`,
  'i',
);

function clean(s: string): string {
  return s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

/** Returns the rules, or null when the section is not a plain list of rules. */
export function splitRuleList(body: string): SplitRule[] | null {
  const lines = body.split('\n');
  const rules: Array<{ first: string; lines: string[]; group?: string }> = [];
  let intro = '';
  let group: string | undefined;
  let seenList = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indented = /^\s{2,}\S|^\t/.test(line);
    const m = !indented ? line.match(MARKER) : null;
    if (m) {
      seenList = true;
      rules.push({ first: m[2]!, lines: [m[2]!], ...(group ? { group } : {}) });
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
  const imperative = rules.filter((r) => IMPERATIVE.test(clean(r.first))).length;
  if (imperative / rules.length < 0.8) return null;
  return rules.slice(0, MAX_RULES_PER_SECTION).map((r) => ({
    text: r.first.trim(),
    full: r.lines.join('\n'),
    ...(r.group ? { group: r.group } : {}),
  }));
}
