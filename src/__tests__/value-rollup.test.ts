import { describe, expect, it, vi } from 'vitest';
import { fetchValueRollup } from '../lib/value-rollup.js';

function stubClient(over: Partial<Record<string, any>> = {}) {
  return {
    getStats: vi.fn().mockResolvedValue({ snapshots: 142 }),
    getConflictImpact: vi.fn().mockResolvedValue({ total: 6, precision: 0.9, adjudicated: 5 }),
    getLinkCounts: vi.fn().mockResolvedValue({
      conflicts_count: 6,
      duplicates_count: 9,
      supersessions_count: 4,
      relates_count: 3,
    }),
    getReuseRate: vi.fn().mockResolvedValue({ referenced: 92, rediscovered: 35, rate: 92 / 127 }),
    getHealth: vi.fn().mockResolvedValue({ compositeScore: { overall: 78, grade: 'B' } }),
    ...over,
  } as any;
}

describe('fetchValueRollup (ALI-215)', () => {
  it('aggregates the gateway value endpoints into a normalized rollup', async () => {
    const out = await fetchValueRollup(stubClient());
    expect(out).toEqual({
      decisions: 142,
      conflictsCaught: 6,
      duplicates: 9,
      supersessions: 4,
      reuseRate: 92 / 127,
      healthGrade: 'B',
    });
  });

  it('maps a different set of values through (no hard-coded fields)', async () => {
    const out = await fetchValueRollup(
      stubClient({
        getStats: vi.fn().mockResolvedValue({ snapshots: 7 }),
        getConflictImpact: vi.fn().mockResolvedValue({ total: 1 }),
        getLinkCounts: vi.fn().mockResolvedValue({ duplicates_count: 2, supersessions_count: 1 }),
        getReuseRate: vi.fn().mockResolvedValue({ referenced: 1, rediscovered: 9, rate: 0.1 }),
        getHealth: vi.fn().mockResolvedValue({ compositeScore: { grade: 'D' } }),
      }),
    );
    expect(out).toEqual({
      decisions: 7,
      conflictsCaught: 1,
      duplicates: 2,
      supersessions: 1,
      reuseRate: 0.1,
      healthGrade: 'D',
    });
  });

  it('is resilient: one failing endpoint nulls its field, others still resolve', async () => {
    const out = await fetchValueRollup(
      stubClient({
        getReuseRate: vi.fn().mockRejectedValue(new Error('404 (old gateway)')),
      }),
    );
    expect(out.decisions).toBe(142);
    expect(out.conflictsCaught).toBe(6);
    expect(out.reuseRate).toBeNull();
  });

  it('passes a null reuse rate through unchanged (0/0 window)', async () => {
    const out = await fetchValueRollup(
      stubClient({
        getReuseRate: vi.fn().mockResolvedValue({ referenced: 0, rediscovered: 0, rate: null }),
      }),
    );
    expect(out.reuseRate).toBeNull();
  });
});
