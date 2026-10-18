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
/** A row more than this far below the best dense score gets no boost, so a weak row with a
 *  matching title cannot climb past strong ones (measured: the motivating miss sat 0.14 down). */
export const MAX_CLIMB = 0.25;

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
    query.replace(/['\u2019](s|t|re|m|ll|ve|d)\b/giu, '').split(/[^\p{L}\p{N}]+/u).filter(w => w && !SCAFFOLDING.has(w.toLowerCase())).map(stem),
  )];
  const titleTerms = rows.map(r => new Set(stems(title(r))));
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = titleTerms.filter(s => s.has(term)).length;
    // A term in no title cannot separate anyone, so it is left out of the denominator too.
    // A term in EVERY title (more than one row) discriminates nothing, so it stays out too.
    if (df > 0 && (df < rows.length || rows.length === 1)) idf.set(term, Math.log(1 + rows.length / df));
  }
  const total = [...idf.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [...rows];
  const best = Math.max(...rows.map(score));
  return rows
    .map((row, i) => {
      if (score(row) < best - MAX_CLIMB) return { row, rank: score(row) };
      let hit = 0;
      for (const [term, w] of idf) if (titleTerms[i].has(term)) hit += w;
      return { row, rank: score(row) + weight * (hit / total) };
    })
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.row);
}
