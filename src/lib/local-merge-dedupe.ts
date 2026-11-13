import type { DecisionRow } from './local-db.js';

const MERGE_LINE = /^merge (?:pull request|branch)\b/im;
const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A merge commit that only carries another commit's change is not a decision of its own. A promoted
 * merge takes the PR title as its subject and keeps the "Merge pull request #N" line in its text, so
 * it repeats the commit it merged and takes a result slot beside it. Drop such a row only when a
 * non-merge row with the same title ranks ABOVE it and is not hidden: then the carrier survives any
 * cut the merge row would have, so dropping the merge can never lose the decision. A merge-titled
 * row that matches nothing else, or whose match is hidden or ranks lower, stays.
 */
export function dropMergeCarriers(ids: readonly string[], rowOf: (id: string) => DecisionRow | null, hidden: { has(id: string): boolean } = new Set()): string[] {
  const rows = ids.map(id => ({ id, row: rowOf(id) }));
  return rows.filter(({ row }, i) => {
    if (!row || !MERGE_LINE.test(row.summary)) return true;
    const title = norm(row.title);
    return !rows.slice(0, i).some(o => o.row && !hidden.has(o.id) && !MERGE_LINE.test(o.row.summary) && norm(o.row.title) === title);
  }).map(r => r.id);
}
