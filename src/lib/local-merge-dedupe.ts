import type { DecisionRow } from './local-db.js';

const MERGE_LINE = /^merge (?:pull request|branch)\b/im;
const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A merge commit that only carries another commit's change is not a decision of its own. A promoted
 * merge takes the PR title as its subject and keeps the "Merge pull request #N" line in its text, so
 * it repeats the commit it merged and takes a result slot beside it. Drop such a row when another
 * candidate has the same title. A merge-titled row that matches nothing else stays.
 */
export function dropMergeCarriers(ids: readonly string[], rowOf: (id: string) => DecisionRow | null): string[] {
  const rows = ids.map(id => ({ id, row: rowOf(id) }));
  return rows.filter(({ id, row }) => {
    if (!row || !MERGE_LINE.test(row.summary)) return true;
    const title = norm(row.title);
    return !rows.some(o => o.id !== id && o.row && !MERGE_LINE.test(o.row.summary) && norm(o.row.title) === title);
  }).map(r => r.id);
}
