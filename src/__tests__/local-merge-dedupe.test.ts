import { describe, expect, it } from 'vitest';
import { dropMergeCarriers } from '../lib/local-merge-dedupe.js';
import type { DecisionRow } from '../lib/local-db.js';

// A merge row repeats the commit it merged: same title, plus a "Merge pull request" line.
const rows: Record<string, Partial<DecisionRow>> = {
  commit: { title: 'Run the lab at 10 Hz', summary: 'Set the tick to 0.1s.' },
  merge: { title: 'Run the lab at 10 Hz', summary: 'Merge pull request #12 from x/tick\n\nSet the tick to 0.1s.' },
  other: { title: 'Cover hops', summary: 'Unrelated.' },
};
const rowOf = (id: string) => (rows[id] as DecisionRow | undefined) ?? null;

describe('dropMergeCarriers never loses the decision a merge row carries', () => {
  it('drops the merge when its non-merge twin ranks above it', () => {
    expect(dropMergeCarriers(['commit', 'other', 'merge'], rowOf)).toEqual(['commit', 'other']);
  });

  it('keeps the merge when the twin ranks below it, so a limit cut cannot drop both', () => {
    expect(dropMergeCarriers(['merge', 'other', 'commit'], rowOf)).toEqual(['merge', 'other', 'commit']);
  });

  it('keeps the merge when the twin is hidden (marked not-a-decision)', () => {
    expect(dropMergeCarriers(['commit', 'merge'], rowOf, new Set(['commit']))).toEqual(['commit', 'merge']);
  });
});
