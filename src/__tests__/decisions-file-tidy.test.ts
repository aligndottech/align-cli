/**
 * TEST LIST (Given/When/Then, two examples per rule)
 *
 * Order
 *  1. Given two commits whose SHAs sort opposite to their dates, When rendered, Then newest is first.
 *  2. Same with a second, reversed pair of SHAs, so a constant order cannot pass.
 *  3. Given equal dates, Then the citation label breaks the tie, and a missing date sorts last.
 * Same title
 *  4. Given three commits with one title, Then one line stands for them, newest cite, "(3 commits)".
 *  5. Given two commits with one title, Then "(2 commits)"; a title that appears once has no count.
 * Mirror pair
 *  6. Given "Throw A instead of B" then "Throw B instead of A", Then only the newer is listed, tagged "(reverses <older cite>)".
 *  7. Same for a different pair, the reverse way round in time.
 *  8. Given "Use A instead of B" and "Use C instead of B", Then both stay (not a mirror).
 *  9. Given a mirror pair with equal dates, or one missing a date, Then both stay unchanged.
 * Scope (follow-up)
 * 10. Never collapse or pair across repositories (two examples each).
 * 11. Mirror matching ignores case and spacing; a family of three or more rows is listed unchanged (two examples each).
 * 12. Same-title rows more than 365 days from the row they would collapse into stay listed (two examples).
 * 13. Date-only and zone-less dates are read as UTC, so output is identical in every time zone (two examples).
 */
import { describe, expect, it } from 'vitest';
import { type ContextDecision, renderDecisionsFile } from '../lib/decisions-context.js';

const d = (title: string, cite: string, decidedAt?: string): ContextDecision => ({
  title, cite, kind: 'decision', ...(decidedAt ? { decidedAt } : {}),
});
const bullets = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('- '));

describe('order', () => {
  it('lists the newest decision first, not the one whose SHA sorts first', () => {
    const out = renderDecisionsFile([
      d('Use https instead of http', 'takes@00c556a', '2015-01-01T00:00:00Z'),
      d('Use Text instead of String', 'takes@ffffff1', '2020-01-01T00:00:00Z'),
    ]);
    expect(bullets(out).map((l) => l.split(' (takes')[0])).toEqual(['- Use Text instead of String', '- Use https instead of http']);
  });

  it('does so for a second set whose SHAs sort the other way', () => {
    const out = renderDecisionsFile([
      d('Never cache the token', 'repo@ffffff2', '2018-05-01T00:00:00Z'),
      d('Always cache the token', 'repo@000000a', '2022-05-01T00:00:00Z'),
    ]);
    expect(bullets(out)[0]).toContain('Always cache the token');
  });

  it('breaks an equal date by citation, and puts an undated decision last', () => {
    const out = renderDecisionsFile([
      d('Use Alpha instead of Beta', 'r@bbb', '2020-01-01T00:00:00Z'),
      d('Use Gamma instead of Delta', 'r@aaa'),
      d('Use Eta instead of Zeta', 'r@aaa', '2020-01-01T00:00:00Z'),
    ]);
    expect(bullets(out).map((l) => /\((r@\w+)\)/.exec(l)![1])).toEqual(['r@aaa', 'r@bbb', 'r@aaa']);
    expect(bullets(out)[2]).toContain('Gamma');
  });
});

describe('same title', () => {
  it('collapses three commits into the newest, and says three', () => {
    const out = renderDecisionsFile([
      d('Replace x with y', 'r@1111111', '2021-01-01T00:00:00Z'),
      d('Replace x with y', 'r@3333333', '2021-09-01T00:00:00Z'),
      d('Replace x with y', 'r@2222222', '2021-05-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual(['- Replace x with y (3 commits) (r@3333333)']);
  });

  it('says two for two, and nothing for a title that appears once', () => {
    const out = renderDecisionsFile([
      d('Use Text instead of String', 'r@a1a1a1a', '2020-10-01T00:00:00Z'),
      d('Use Text instead of String', 'r@a2a2a2a', '2021-01-01T00:00:00Z'),
      d('Use Path instead of File', 'r@b1b1b1b', '2019-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual([
      '- Use Text instead of String (2 commits) (r@a2a2a2a)',
      '- Use Path instead of File (r@b1b1b1b)',
    ]);
  });
});

describe('a decision and its reversal', () => {
  it('lists only the newer of a mirror pair, tagged with what it reverses', () => {
    const out = renderDecisionsFile([
      d('(#994) Throw `IOException` instead of `Exception`', 'takes@2934903', '2016-01-01T00:00:00Z'),
      d('(#994) Throw `Exception` instead of `IOException`', 'takes@3c89ded', '2016-02-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual(['- (#994) Throw `Exception` instead of `IOException` (reverses takes@2934903) (takes@3c89ded)']);
  });

  it('does the same for another pair when the older one carries the later SHA', () => {
    const out = renderDecisionsFile([
      d('Prefer Cats instead of Dogs', 'r@aaa1', '2021-01-01T00:00:00Z'),
      d('Prefer Dogs instead of Cats', 'r@zzz9', '2020-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual(['- Prefer Cats instead of Dogs (reverses r@zzz9) (r@aaa1)']);
  });

  it('leaves two decisions that share only the replaced thing alone', () => {
    const out = renderDecisionsFile([
      d('Use A instead of B', 'r@a', '2020-01-01T00:00:00Z'),
      d('Use C instead of B', 'r@c', '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toHaveLength(2);
    expect(out).not.toContain('reverses');
  });

  it('leaves a mirror pair alone when the dates are equal', () => {
    const when = '2020-01-01T00:00:00Z';
    const out = renderDecisionsFile([d('Use A instead of B', 'r@a', when), d('Use B instead of A', 'r@b', when)]);
    expect(bullets(out)).toHaveLength(2);
    expect(out).not.toContain('reverses');
  });

  it('leaves a mirror pair alone when one date is missing', () => {
    const out = renderDecisionsFile([d('Use A instead of B', 'r@a', '2020-01-01T00:00:00Z'), d('Use B instead of A', 'r@b')]);
    expect(bullets(out)).toHaveLength(2);
    expect(out).not.toContain('reverses');
  });
});

const sha = (c: string): string => c.repeat(7);

describe('never across repositories', () => {
  it('does not collapse one title held by two repos', () => {
    const out = renderDecisionsFile([
      d('Use Text instead of String', `one@${sha('a')}`, '2020-01-01T00:00:00Z'),
      d('Use Text instead of String', `two@${sha('b')}`, '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual([`- Use Text instead of String (two@${sha('b')})`, `- Use Text instead of String (one@${sha('a')})`]);
  });

  it('does not collapse another title either', () => {
    const out = renderDecisionsFile([
      d('Replace x with y', `alpha@${sha('1')}`, '2020-01-01T00:00:00Z'),
      d('Replace x with y', `beta@${sha('2')}`, '2020-02-01T00:00:00Z'),
    ]);
    expect(out).not.toContain('commits)');
    expect(bullets(out)).toHaveLength(2);
  });

  it('does not let one repo reverse another repo', () => {
    const out = renderDecisionsFile([
      d('Use A instead of B', `repo1@${sha('a')}`, '2020-01-01T00:00:00Z'),
      d('Use B instead of A', `repo2@${sha('b')}`, '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toHaveLength(2);
    expect(out).not.toContain('reverses');
  });

  it('does not pair across repos for a second pair either', () => {
    const out = renderDecisionsFile([
      d('Prefer Cats instead of Dogs', `x@${sha('c')}`, '2019-01-01T00:00:00Z'),
      d('Prefer Dogs instead of Cats', `y@${sha('d')}`, '2022-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toHaveLength(2);
  });
});

describe('mirror matching is exact about what a pair is', () => {
  it('matches regardless of case and spacing', () => {
    const out = renderDecisionsFile([
      d('Use  Json instead of XML', `r@${sha('a')}`, '2020-01-01T00:00:00Z'),
      d('use xml instead of  JSON', `r@${sha('b')}`, '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual([`- use xml instead of  JSON (reverses r@${sha('a')}) (r@${sha('b')})`]);
  });

  it('matches regardless of case for a second pair', () => {
    const out = renderDecisionsFile([
      d('Prefer TABS instead of spaces', `r@${sha('a')}`, '2021-01-01T00:00:00Z'),
      d('Prefer Spaces instead of Tabs', `r@${sha('b')}`, '2020-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual([`- Prefer TABS instead of spaces (reverses r@${sha('b')}) (r@${sha('a')})`]);
  });

  it('lists a family of three unchanged (A over B, B over A, A again)', () => {
    const out = renderDecisionsFile([
      d('Use A instead of B', `r@${sha('1')}`, '2015-01-01T00:00:00Z'),
      d('Use B instead of A', `r@${sha('2')}`, '2018-01-01T00:00:00Z'),
      d('Use A instead of B', `r@${sha('3')}`, '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toHaveLength(3);
    expect(out).not.toContain('reverses');
  });

  it('lists another family of three unchanged', () => {
    const out = renderDecisionsFile([
      d('Use X instead of Y', `r@${sha('1')}`, '2015-01-01T00:00:00Z'),
      d('Use Y instead of X', `r@${sha('2')}`, '2018-01-01T00:00:00Z'),
      d('Use y instead of x', `r@${sha('3')}`, '2021-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toHaveLength(3);
  });
});

describe('a long gap is not one decision', () => {
  it('keeps a 2018 commit apart from two 2024 commits', () => {
    const out = renderDecisionsFile([
      d('Replace x with y', `r@${sha('1')}`, '2018-01-01T00:00:00Z'),
      d('Replace x with y', `r@${sha('2')}`, '2024-01-01T00:00:00Z'),
      d('Replace x with y', `r@${sha('3')}`, '2024-03-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual([`- Replace x with y (2 commits) (r@${sha('3')})`, `- Replace x with y (r@${sha('1')})`]);
  });

  it('keeps two commits 400 days apart apart, and joins two 300 days apart', () => {
    const far = renderDecisionsFile([
      d('Use P instead of Q', `r@${sha('1')}`, '2020-01-01T00:00:00Z'),
      d('Use P instead of Q', `r@${sha('2')}`, '2021-02-05T00:00:00Z'),
    ]);
    expect(bullets(far)).toHaveLength(2);
    const near = renderDecisionsFile([
      d('Use P instead of Q', `r@${sha('1')}`, '2020-01-01T00:00:00Z'),
      d('Use P instead of Q', `r@${sha('2')}`, '2020-10-27T00:00:00Z'),
    ]);
    expect(bullets(near)).toEqual([`- Use P instead of Q (2 commits) (r@${sha('2')})`]);
  });
});

describe('dates are read as UTC', () => {
  const inZone = (tz: string, rows: ContextDecision[]): string => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try { return renderDecisionsFile(rows); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  };

  it('renders a date-only and a zone-less datetime identically in two zones, tied and broken by citation', () => {
    const rows = [d('Use A instead of C', `r@${sha('b')}`, '2020-06-01'), d('Use E instead of F', `r@${sha('a')}`, '2020-06-01T00:00:00')];
    const auckland = inZone('Pacific/Auckland', rows);
    expect(auckland).toBe(inZone('America/Los_Angeles', rows));
    expect(bullets(auckland).map((l) => /\((r@\w+)\)/.exec(l)![1])).toEqual([`r@${sha('a')}`, `r@${sha('b')}`]);
  });

  it('does so for a second pair of dates', () => {
    const rows = [d('Use G instead of H', `r@${sha('d')}`, '2021-12-31T23:30:00'), d('Use I instead of J', `r@${sha('c')}`, '2021-12-31T23:30:00Z')];
    const a = inZone('Pacific/Auckland', rows);
    expect(a).toBe(inZone('America/Los_Angeles', rows));
    expect(bullets(a).map((l) => /\((r@\w+)\)/.exec(l)![1])).toEqual([`r@${sha('c')}`, `r@${sha('d')}`]);
  });
});
