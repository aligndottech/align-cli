/**
 * Reciprocal rank fusion (ALI-1749). Pure and deterministic.
 *
 * Two rankers disagree in useful ways: a dense embedding finds a paraphrase, BM25 finds the rare
 * identifier the paraphrase blurred. Their scores are not comparable (a cosine and a BM25 sum),
 * but their RANKS are, so each list contributes `weight / (k + rank)` and the sum orders the
 * union. A row only one list found still scores; a row both found scores from both.
 *
 * Ties break on the first list's order, then on the id in code units, so the result never
 * depends on the machine's locale or on insertion order.
 */
/** Smaller than the textbook 60: with the 30-row pool used here, 60 flattens the top ranks so a row
 *  both lists put near the top barely separates from one only a list put at rank 20. Measured
 *  (ALI-1749): k=10 beat k=60 on recall@8 and MRR across 9 repos. */
export const RRF_K = 10;

export function reciprocalRankFusion(
  lists: ReadonlyArray<{ ids: readonly string[]; weight: number }>,
  k = RRF_K,
): string[] {
  const score = new Map<string, number>();
  const firstPos = new Map<string, number>();
  for (const [li, list] of lists.entries()) {
    list.ids.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + list.weight / (k + i + 1));
      if (li === 0 && !firstPos.has(id)) firstPos.set(id, i);
    });
  }
  return [...score.keys()].sort((a, b) =>
    score.get(b)! - score.get(a)!
    || (firstPos.get(a) ?? Infinity) - (firstPos.get(b) ?? Infinity)
    || (a < b ? -1 : a > b ? 1 : 0));
}
