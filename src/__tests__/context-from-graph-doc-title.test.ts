import { describe, expect, it } from 'vitest';
import { type ListedDecision, selectForFile } from '../lib/context-from-graph.js';

/*
 * TEST LIST. The graph keeps 80 characters of a title; PR #708 restored whole commit subjects, but an ADR / docs row cut
 * mid-word in DECISIONS.md ("OKF is not mar", vyasdx/adda-cli ADR-0031).
 * 1. A docs row cut at 80 whose summary holds its heading: listed whole (also when the summary opens with comment lines).
 *    1b. another ADR heading.
 * 2. Nothing whole to recover: the title ends at a word boundary and says so with an ellipsis, never a partial word.
 *    2b. another cut title.
 * 3. Controls: a docs title under 80 is untouched; a rule row keeps its rule display.
 */
const FULL_1 = '0031 — Repository text is printed without control characters, and OKF is not marked';
const FULL_2 = '0027 — The one outbound call is disclosed to the user before it is ever made, in writing';
const comments = '<!-- Developed by - Vedavyas Vayalpadu - vyas4c3@gmail.com -->\n<!-- Coded by - Claude Code -->\n\n';
const adr = (full: string, summaryHead = '', title = full.slice(0, 80)): ListedDecision => ({
  title, summary: `${summaryHead}# ${full}\n\nStatus: accepted\n`, platform: 'docs', source_url: `https://github.com/o/r/blob/main/adda/DECISIONS/${full.slice(0, 4)}-x.md`,
});
const titleOf = (r: ListedDecision) => selectForFile([r], 30).decisions[0]!.title;

describe('1. a cut docs title is restored from its heading', () => {
  it('ADR-0031', () => expect(titleOf(adr(FULL_1))).toBe(FULL_1));
  it('ADR-0031 whose summary still opens with the comment header', () => expect(titleOf(adr(FULL_1, comments))).toBe(FULL_1));
  it('another heading', () => expect(titleOf(adr(FULL_2))).toBe(FULL_2));
});

describe('2. with nothing whole to recover, the cut is at a word boundary with an ellipsis', () => {
  it('0031', () => {
    const t = titleOf({ ...adr(FULL_1), summary: 'Unrelated text with no heading.' });
    expect(t).toBe('0031 — Repository text is printed without control characters, and OKF is not...');
  });
  it('0027', () => {
    const t = titleOf({ ...adr(FULL_2), summary: 'No heading here either.' });
    expect(t.endsWith('...')).toBe(true);
    expect(FULL_2.startsWith(t.slice(0, -3))).toBe(true);
    expect(FULL_2[t.length - 3]).toMatch(/[\s,]/); // the next character of the full title is not part of a word
  });
});

describe('3. controls', () => {
  it('a short docs title is untouched', () => expect(titleOf(adr('0001 — Record decisions'))).toBe('0001 — Record decisions'));
  it('a rule row still shows its whole rule', () => {
    const rule: ListedDecision = { title: 'Never use any in new code, always', summary: 'Never use any in new code, always add a type.\n\nFrom the "Style" section.', platform: 'docs', source_url: 'https://github.com/o/r/blob/main/CLAUDE.md#style~x' };
    expect(titleOf(rule)).toBe('Never use any in new code, always add a type.');
  });
});
