import { describe, expect, it } from 'vitest';
import { orderTiesNewestFirst } from '../lib/local-tie-order.js';

describe('orderTiesNewestFirst', () => {
  it('handles a tie run larger than the argument limit and keeps newest-first order', () => {
    const n = 200_000;
    const rows = Array.from({ length: n }, (_, i) => ({ decisionId: String(i).padStart(7, '0'), score: 0.5 }));
    const started = Date.now();
    const out = orderTiesNewestFirst(rows, (id) => Number(id));
    expect(out).toHaveLength(n);
    expect(out[0]!.decisionId).toBe(String(n - 1).padStart(7, '0'));
    expect(out[n - 1]!.decisionId).toBe('0000000');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps a higher score ahead of a newer lower one', () => {
    const rows = [{ decisionId: 'a', score: 0.9 }, { decisionId: 'b', score: 0.5 }, { decisionId: 'c', score: 0.5 }];
    expect(orderTiesNewestFirst(rows, (id) => ({ a: 1, b: 2, c: 3 })[id]).map(r => r.decisionId)).toEqual(['a', 'c', 'b']);
  });
});
