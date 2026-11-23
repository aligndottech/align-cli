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
 * Follow-up
 *  7. Given a feat: title whose stored 80 characters include the prefix (exactly 80, with and without the prefix),
 *     Then the whole subject is restored and the prefix stripped after.
 *  8. Given a graph larger than the cap whose newest rows have the highest SHAs and oldest the lowest (two sets),
 *     Then the file holds the newest N, not the first N in graph order.
 *  9. Given bumps, repeats and a reversal in the graph, Then left-out counts neither them nor what is shown (two sets).
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

  it('marks a cut title with an ellipsis and loses no word when nothing whole is left', () => {
    const stored = 'Renamed variable, changed class to be final instead of each method, use lists of';
    expect(stored).toHaveLength(80);
    const [d] = selectForFile([row(stored, 'unrelated summary text')], 30).decisions;
    expect(d!.title).toBe(`${stored}...`);
  });

  it('marks a title cut mid-word and keeps the partial word', () => {
    const cut = 'Use one shared connection pool for every worker rather than one pool per requestor and more'.slice(0, 80);
    expect(cut.endsWith('reques')).toBe(false);
    expect(cut).toHaveLength(80);
    const [d] = selectForFile([row(cut, 'unrelated')], 30).decisions;
    expect(d!.title).toBe(`${cut}...`);
  });

  it('marks a complete 80 character title with an ellipsis when the summary is unrelated, so a possible cut is visible', () => {
    const title = 'Use one shared connection pool for every worker rather than one pool per request';
    expect(title).toHaveLength(80);
    const [d] = selectForFile([row(title, 'unrelated summary text')], 30).decisions;
    expect(d!.title).toBe(`${title}...`);
  });

  it('adds nothing to a 79 character title', () => {
    const title = 'Use one shared connection pool for every worker rather than one pool per reques';
    expect(title).toHaveLength(79);
    expect(selectForFile([row(title, 'unrelated summary text')], 30).decisions[0]!.title).toBe(title);
  });

  it('keeps a second complete 80 character title whole too', () => {
    const title = 'Always route the retry queue through a separate worker pool, not one per request';
    expect(title).toHaveLength(80);
    const [d] = selectForFile([row(title, 'something else entirely')], 30).decisions;
    expect(d!.title).toBe(`${title}...`);
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

const exactly80 = (prefix: string): string => `${prefix}${'word '.repeat(30)}`.slice(0, 80);

describe('a feat: title cut at 80 characters including its prefix', () => {
  it.each([['feat: '], ['feat(core): ']])('restores the whole subject, then strips %s', (prefix) => {
    const stored = exactly80(`${prefix}Use immutable value objects instead of mutable beans, `);
    const whole = `${stored}and always copy on write`;
    expect(stored).toHaveLength(80);
    const [d] = selectForFile([row(stored, `${whole}\n\nAuthor: x`)], 30).decisions;
    expect(d!.title).toBe(whole.slice(prefix.length));
  });

  it('does the same for an exactly 80 character title with no prefix', () => {
    const stored = exactly80('Use immutable value objects instead of mutable beans, ');
    const whole = `${stored}and always copy on write`;
    const [d] = selectForFile([row(stored, `${whole}\n\nAuthor: x`)], 30).decisions;
    expect(d!.title).toBe(whole);
  });
});

const hex = (n: number): string => n.toString(16).padStart(40, '0');
const dated = (i: number, title = `Use option ${i} instead of option ${i + 100}`): ListedDecision => ({
  title, summary: '', platform: 'git', source_url: `https://github.com/o/r/commit/${hex(i)}`,
  decided_at: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000 * 400).toISOString(),
});

describe('the cap keeps the newest decisions', () => {
  it('lists the newest 3 of 8, graph order oldest first, newest with the highest SHAs', () => {
    const rows = Array.from({ length: 8 }, (_, i) => dated(i + 1));
    const picked = selectForFile(rows, 3);
    expect(picked.decisions.map((x) => x.title)).toEqual(['Use option 8 instead of option 108', 'Use option 7 instead of option 107', 'Use option 6 instead of option 106']);
    expect(picked.leftOut).toBe(5);
    expect(picked.selected).toHaveLength(3);
  });

  it('does so for 6 rows and a cap of 2, graph order newest first', () => {
    const rows = Array.from({ length: 6 }, (_, i) => dated(6 - i));
    const picked = selectForFile(rows, 2);
    expect(picked.decisions.map((x) => x.title)).toEqual(['Use option 6 instead of option 106', 'Use option 5 instead of option 105']);
    expect(picked.leftOut).toBe(4);
  });
});

describe('what is left out is what is not shown', () => {
  it('counts neither bumps, nor repeats folded into a shown line, nor a hidden reversal', () => {
    const rows = [
      dated(1, 'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b2'),
      dated(2, 'Replace dependency xml-apis:xml-apis with xml-apis:xml-apis 1.0.b3'),
      { ...dated(3, 'Use Text instead of String'), decided_at: '2024-01-01T00:00:00Z' },
      { ...dated(4, 'Use Text instead of String'), decided_at: '2024-02-01T00:00:00Z' },
      { ...dated(5, 'Throw A instead of B'), decided_at: '2020-01-01T00:00:00Z' },
      { ...dated(6, 'Throw B instead of A'), decided_at: '2021-01-01T00:00:00Z' },
      { ...dated(7, 'fix: crash on empty input because the parser never checked'), decided_at: '2022-01-01T00:00:00Z' },
      { ...dated(8, 'Use Path instead of File'), decided_at: '2023-01-01T00:00:00Z' },
    ];
    const picked = selectForFile(rows, 30);
    expect(picked.decisions.map((x) => x.title)).toEqual(['Use Text instead of String', 'Use Path instead of File', 'Throw B instead of A']);
    expect(picked.decisions[0]).toMatchObject({ commits: 2 });
    // Only the fix-shaped row is in the graph and not in the file.
    expect(picked.leftOut).toBe(1);
  });

  it('counts a row the cap cut as left out, once, and the repeats folded into a shown line as neither', () => {
    const rows = [
      { ...dated(1, 'Use Alpha instead of Beta'), decided_at: '2020-01-01T00:00:00Z' },
      { ...dated(2, 'Use Gamma instead of Delta'), decided_at: '2022-01-01T00:00:00Z' },
      { ...dated(3, 'Use Gamma instead of Delta'), decided_at: '2022-02-01T00:00:00Z' },
      { ...dated(4, 'Use Eta instead of Zeta'), decided_at: '2021-01-01T00:00:00Z' },
    ];
    const picked = selectForFile(rows, 2);
    expect(picked.decisions.map((x) => x.title)).toEqual(['Use Gamma instead of Delta', 'Use Eta instead of Zeta']);
    expect(picked.decisions[0]).toMatchObject({ commits: 2 });
    expect(picked.leftOut).toBe(1);
  });
});
