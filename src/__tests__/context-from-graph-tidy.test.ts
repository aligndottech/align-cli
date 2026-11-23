/**
 * TEST LIST
 *  1. Given a commit whose stored title was cut at 80 characters mid-word and whose summary starts with the
 *     whole subject, When selected for the file, Then the whole subject is listed.
 *  2. Same for a second cut subject, so a hard-coded string cannot pass.
 *  3. Given a cut title with no whole subject to recover, Then it ends at a word boundary with "...".
 *  3b. Given a very long whole subject, Then it is cut at a word boundary with "...".
 *  4. Given a title under the limit, Then it is untouched.
 *  5. Given a row with decided_at, Then the file decision carries it (the order depends on it).
 *  6. Given a dependency replacement already in the graph, Then it is not listed.
 */
import { describe, expect, it } from 'vitest';
import { type ListedDecision, selectForFile } from '../lib/context-from-graph.js';

const row = (title: string, summary: string, extra: Partial<ListedDecision> = {}): ListedDecision => ({
  title, summary, platform: 'git', source_url: `https://github.com/o/r/commit/${'a'.repeat(40)}`, ...extra,
});

const WHOLE_1 = 'Renamed variable, changed class to be final instead of each method, use Collections.addAll instead of iterating the list';
const WHOLE_2 = 'Prefer immutable value objects instead of mutable beans across the whole request pipeline, and always copy on write';

describe('a subject the graph cut at 80 characters', () => {
  it('is listed whole when the summary still holds it', () => {
    const [d] = selectForFile([row(WHOLE_1.slice(0, 80), `${WHOLE_1}\n\nAuthor: x`)], 30).decisions;
    expect(d!.title).toBe(WHOLE_1);
  });

  it('is listed whole for another subject', () => {
    const [d] = selectForFile([row(WHOLE_2.slice(0, 80), `${WHOLE_2}\n\nAuthor: y`)], 30).decisions;
    expect(d!.title).toBe(WHOLE_2);
  });

  it('ends at a word boundary with an ellipsis when nothing whole is left', () => {
    const [d] = selectForFile([row(WHOLE_1.slice(0, 80), 'unrelated summary text')], 30).decisions;
    expect(d!.title).toBe('Renamed variable, changed class to be final instead of each method, use...');
  });

  it('is cut at a word boundary when even the whole subject is very long', () => {
    const long = `${WHOLE_1} and then keep going for another good while so that the subject runs past the cap`;
    const [d] = selectForFile([row(long.slice(0, 80), long)], 30).decisions;
    expect(d!.title).toBe('Renamed variable, changed class to be final instead of each method, use Collections.addAll instead of iterating the...');
  });

  it('leaves a subject of exactly 80 characters alone when the summary shows it was never cut', () => {
    const exact = 'Revised to use String.format instead of StringBuffer to do string concatenation.';
    const [d] = selectForFile([row(exact, `${exact}\n\nAuthor: z`)], 30).decisions;
    expect(exact).toHaveLength(80);
    expect(d!.title).toBe(exact);
  });

  it('leaves a short title alone', () => {
    const [d] = selectForFile([row('Use pnpm instead of npm', 'Use pnpm instead of npm\n\nDate: x')], 30).decisions;
    expect(d!.title).toBe('Use pnpm instead of npm');
  });
});

describe('what else the file needs from a row', () => {
  it('carries decided_at, which orders the file', () => {
    const [d] = selectForFile([row('Use pnpm instead of npm', '', { decided_at: '2020-04-28T07:20:47.000Z' })], 30).decisions;
    expect(d!.decidedAt).toBe('2020-04-28T07:20:47.000Z');
  });

  it('does not list a dependency replacement already held in the graph', () => {
    const rows = [row('Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2', ''), row('Use pnpm instead of npm', '')];
    expect(selectForFile(rows, 30).decisions.map((x) => x.title)).toEqual(['Use pnpm instead of npm']);
  });
});
