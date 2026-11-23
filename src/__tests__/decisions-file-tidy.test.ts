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
      d('Replace x with y', 'r@1111111', '2019-01-01T00:00:00Z'),
      d('Replace x with y', 'r@3333333', '2021-01-01T00:00:00Z'),
      d('Replace x with y', 'r@2222222', '2020-01-01T00:00:00Z'),
    ]);
    expect(bullets(out)).toEqual(['- Replace x with y (3 commits) (r@3333333)']);
  });

  it('says two for two, and nothing for a title that appears once', () => {
    const out = renderDecisionsFile([
      d('Use Text instead of String', 'r@a1a1a1a', '2020-01-01T00:00:00Z'),
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
