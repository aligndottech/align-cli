import { describe, expect, it } from 'vitest';
import { dropMergeCarriers } from '../lib/local-merge-dedupe.js';
import type { DecisionRow } from '../lib/local-db.js';

// A merge row repeats the commit it merged: same title, plus a "Merge pull request" line.
const rows: Record<string, Partial<DecisionRow>> = {
  commit: { title: 'Run the lab at 10 Hz', summary: 'Set the tick to 0.1s.' },
  merge: { title: 'Run the lab at 10 Hz', summary: 'Merge pull request #12 from x/tick\n\nSet the tick to 0.1s.' },
  other: { title: 'Cover hops', summary: 'Unrelated.' },
};
const twin = { id: 'commit', summary: 'Set the tick to 0.1s.' };
const rowOf = (id: string) => (rows[id] as DecisionRow | undefined) ?? null;

describe('dropMergeCarriers never loses the decision a merge row carries', () => {
  it('drops the merge when its non-merge twin ranks above it', () => {
    expect(dropMergeCarriers(['commit', 'other', 'merge'], rowOf)).toEqual(['commit', 'other']);
  });

  it('puts the twin in the merge row\'s better slot when the merge ranks first, so a limit cut cannot drop it', () => {
    expect(dropMergeCarriers(['merge', 'other', 'commit'], rowOf)).toEqual(['commit', 'other']);
  });

  it('keeps the merge when the twin is hidden (marked not-a-decision)', () => {
    expect(dropMergeCarriers(['commit', 'merge'], rowOf, new Set(['commit']))).toEqual(['commit', 'merge']);
  });

  // The twin was imported earlier (or ranks outside the pool): it is in the graph, not in the results.
  describe('a twin that is in the graph but not among the results', () => {
    it('puts the twin in the merge row\'s slot, so the decision stays and the merge does not', () => {
      expect(dropMergeCarriers(['other', 'merge'], rowOf, new Set(), () => twin)).toEqual(['other', 'commit']);
    });

    it('does the same at another rank, and once when the twin is also a result', () => {
      expect(dropMergeCarriers(['merge', 'other'], rowOf, new Set(), () => twin)).toEqual(['commit', 'other']);
      expect(dropMergeCarriers(['merge', 'commit'], rowOf, new Set(), () => twin)).toEqual(['commit']);
    });

    it('keeps the merge when the graph has no twin for it', () => {
      expect(dropMergeCarriers(['other', 'merge'], rowOf, new Set(), () => undefined)).toEqual(['other', 'merge']);
    });

    it('never asks for a twin of a row that is not a merge', () => {
      const asked: string[] = [];
      dropMergeCarriers(['commit', 'other'], rowOf, new Set(), (row) => { asked.push(row.title); return twin; });
      expect(asked).toEqual([]);
    });

    it('keeps a merge that carries its own decision text even when a twin is in the graph', () => {
      rows['own'] = { title: 'Run the lab at 10 Hz', summary: 'Merge pull request #13 from x/rollback\n\nWe roll back to 0.05 because the 0.1 clamp broke aim.' };
      expect(dropMergeCarriers(['other', 'own'], rowOf, new Set(), () => twin)).toEqual(['other', 'own']);
    });
  });
});
