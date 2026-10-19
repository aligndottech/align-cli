import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion, RRF_K } from '../lib/hybrid-rank.js';

describe('reciprocalRankFusion', () => {
  it('a row both lists rank well beats a row only one list ranks first', () => {
    expect(reciprocalRankFusion([{ ids: ['a', 'b', 'c'], weight: 1 }, { ids: ['x', 'b', 'y'], weight: 1 }])[0]).toBe('b');
  });
  it('a row only the lexical list found still appears', () => {
    expect(reciprocalRankFusion([{ ids: ['a'], weight: 1 }, { ids: ['z'], weight: 1 }])).toEqual(['a', 'z']);
  });
  it('a heavier list wins a disagreement, and the lighter one wins it back at equal weight', () => {
    const lists = (wl: number) => [{ ids: ['d1', 'd2'], weight: 1 }, { ids: ['l1', 'l2'], weight: wl }];
    expect(reciprocalRankFusion(lists(3))[0]).toBe('l1');
    expect(reciprocalRankFusion(lists(1))[0]).toBe('d1');
  });
  it('ties break on the first list, then on the id in code units', () => {
    // m and q each sit at rank 1 in one list: equal scores. The first list's own row goes first.
    expect(reciprocalRankFusion([{ ids: ['q'], weight: 1 }, { ids: ['m'], weight: 1 }])).toEqual(['q', 'm']);
    // Neither is in the first list: the id decides, 'B' before 'a' by code unit, not by locale.
    expect(reciprocalRankFusion([{ ids: [], weight: 1 }, { ids: ['a'], weight: 1 }, { ids: ['B'], weight: 1 }])).toEqual(['B', 'a']);
  });
  it('scores by weight / (k + rank)', () => {
    const [first, second] = reciprocalRankFusion([{ ids: ['x', 'y'], weight: 1 }], RRF_K);
    expect([first, second]).toEqual(['x', 'y']);
  });
});
