import type { DecisionRow } from './local-db.js';

const MERGE_LINE = /^merge (?:pull request|branch)\b/im;
const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

// Lines and sentences, normalised, without a closing full stop. The unit two texts are compared in, so
// "set the tick" never matches inside "do not set the tick", and "tick" never matches inside "ticket".
const sentences = (t: string) => t.split(/\n+|(?<=[.!?])\s+/).map(u => norm(u).replace(/[.!?]+$/, '')).filter(Boolean);

/**
 * What a merge says beyond its own title: `text` minus its FIRST "Merge pull request/branch" line (the
 * boilerplate git writes) and one copy of the title. Empty, or only whole sentences the plain commit it
 * carries already has, means the merge adds nothing to it. Only the first such line goes, so a decision line that itself starts with
 * "Merge branch ..." still counts. The import rule and the search rule both use this one predicate.
 */
export function mergeAddsNothing(title: string, text: string, plainText = ''): boolean {
  const lines = text.split('\n');
  const at = lines.findIndex(l => /^merge (?:pull request|branch)\b/i.test(l.trim()));
  if (at !== -1) lines.splice(at, 1);
  // Normalised like a sentence (closing full stop dropped), or a title ending in "." never matches.
  const t = norm(title).replace(/[.!?]+$/, '');
  const units = sentences(lines.join('\n'));
  const at2 = units.findIndex(u => u.includes(t));
  if (at2 !== -1) units[at2] = units[at2]!.replace(t, '').trim();
  const plain = new Set(sentences(plainText));
  return units.filter(Boolean).every(u => plain.has(u));
}

/**
 * A merge commit that only carries another commit's change is not a decision of its own. A promoted
 * merge takes the PR title as its subject and keeps the "Merge pull request #N" line in its text, so
 * it repeats the commit it merged and takes a result slot beside it. When a non-hidden, non-merge row
 * with the same title is also a candidate, keep ONE row: the plain commit, at the better of the two
 * ranks. Rank between the two is close to a coin flip (their text is nearly identical), so the rule
 * must not depend on which came first, and taking the better rank means a limit cut can never drop
 * the decision. When the twin is not a candidate but is in the graph, it replaces the merge at the
 * merge's rank. A merge row with no such twin anywhere stays where it is.
 */
export function dropMergeCarriers(
  ids: readonly string[],
  rowOf: (id: string) => DecisionRow | null,
  hidden: { has(id: string): boolean } = new Set(),
  /** The id of a visible non-merge row in the GRAPH with this merge's title, when that twin is not a
   *  result (imported by an earlier run, or ranked outside the pool). It takes the merge's slot. */
  graphTwin: (merge: DecisionRow) => { id: string; summary: string } | undefined = () => undefined,
): string[] {
  const rows = ids.map(id => ({ id, row: rowOf(id) }));
  const isMerge = (r: DecisionRow | null) => !!r && MERGE_LINE.test(r.summary);
  const twinOf = (id: string, row: DecisionRow) => rows.find(o => o.id !== id && o.row && !hidden.has(o.id) && !isMerge(o.row) && norm(o.row.title) === norm(row.title));
  const graphTwinFor = (row: DecisionRow) => {
    const t = graphTwin(row);
    return t && mergeAddsNothing(row.title, row.summary, t.summary) ? t.id : undefined;
  };
  const out: string[] = [];
  const placed = new Set<string>();
  for (const { id, row } of rows) {
    const pick = row && isMerge(row) ? (twinOf(id, row)?.id ?? graphTwinFor(row) ?? id) : id;
    if (!placed.has(pick)) { placed.add(pick); out.push(pick); }
  }
  return out;
}
