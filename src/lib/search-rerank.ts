import { SCAFFOLDING } from './search-query.js';

/**
 * A deterministic title rerank over dense candidates (ALI-1775, from ALI-1773).
 *
 * A dense embedding rewards a commit that repeats a noun: "why was align setup removed"
 * ranked three commits that say "align setup" over and over (0.666, 0.639, 0.597) above the
 * commit that removed it (0.523, rank 12), which the default `--limit 8` never showed. The
 * answer to a "why did we remove X" question names X AND the action in its title, so the
 * dense score is nudged by how much of the question's content the title carries.
 *
 * Each content word of the query is weighted by how rare it is in THIS candidate pool's
 * titles (idf), so "align", which sits in nearly every title of this repo, moves nothing and
 * "remove" does. The boost is bounded by TITLE_WEIGHT, so a candidate with no lexical overlap
 * keeps its dense order and a title match cannot rescue an unrelated row: it only reorders
 * rows the caller already retrieved above the relevance floor.
 *
 * Pure and deterministic: no model call, no I/O. Ties keep input order (Array.sort is stable).
 */
export const TITLE_WEIGHT = 0.35;

/** Cheap suffix strip so "removed", "removes" and "remove" meet. Not a linguistic stemmer. */
function stem(token: string): string {
  const t = token.toLowerCase();
  for (const suffix of ['ing', 'ed', 'es', 's', 'e', 'd']) {
    if (t.length > suffix.length + 3 && t.endsWith(suffix)) return t.slice(0, -suffix.length);
  }
  return t;
}

function stems(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
}

export function rerankByTitle<T>(
  query: string,
  rows: readonly T[],
  score: (row: T) => number,
  title: (row: T) => string,
  weight = TITLE_WEIGHT,
): T[] {
  const queryTerms = [...new Set(
    query.split(/[^\p{L}\p{N}]+/u).filter(w => w && !SCAFFOLDING.has(w.toLowerCase())).map(stem),
  )];
  const titleTerms = rows.map(r => new Set(stems(title(r))));
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = titleTerms.filter(s => s.has(term)).length;
    // A term in no title cannot separate anyone, so it is left out of the denominator too.
    if (df > 0) idf.set(term, Math.log(1 + rows.length / df));
  }
  const total = [...idf.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [...rows];
  return rows
    .map((row, i) => {
      let hit = 0;
      for (const [term, w] of idf) if (titleTerms[i].has(term)) hit += w;
      return { row, rank: score(row) + weight * (hit / total) };
    })
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.row);
}
