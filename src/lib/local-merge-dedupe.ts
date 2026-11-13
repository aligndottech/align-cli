import type { DecisionRow } from './local-db.js';

const MERGE_LINE = /^merge (?:pull request|branch)\b/im;
const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A merge commit that only carries another commit's change is not a decision of its own. A promoted
 * merge takes the PR title as its subject and keeps the "Merge pull request #N" line in its text, so
 * it repeats the commit it merged and takes a result slot beside it. When a non-hidden, non-merge row
 * with the same title is also a candidate, keep ONE row: the plain commit, at the better of the two
 * ranks. Rank between the two is close to a coin flip (their text is nearly identical), so the rule
 * must not depend on which came first, and taking the better rank means a limit cut can never drop
 * the decision. A merge row with no such twin stays where it is.
 */
export function dropMergeCarriers(ids: readonly string[], rowOf: (id: string) => DecisionRow | null, hidden: { has(id: string): boolean } = new Set()): string[] {
  const rows = ids.map(id => ({ id, row: rowOf(id) }));
  const isMerge = (r: DecisionRow | null) => !!r && MERGE_LINE.test(r.summary);
  const twinOf = (id: string, row: DecisionRow) => rows.find(o => o.id !== id && o.row && !hidden.has(o.id) && !isMerge(o.row) && norm(o.row.title) === norm(row.title));
  const out: string[] = [];
  const placed = new Set<string>();
  for (const { id, row } of rows) {
    const pick = row && isMerge(row) ? (twinOf(id, row)?.id ?? id) : id;
    if (!placed.has(pick)) { placed.add(pick); out.push(pick); }
  }
  return out;
}
