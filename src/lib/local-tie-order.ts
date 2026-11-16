/**
 * Local search order: equal dense scores are ordered newest first, then by id.
 *
 * `findSimilar` already breaks a tie on id, which is a random uuid here, so two decisions with the
 * same score came back in an order that depended on nothing a person could name. A date is something
 * one can name, and on a tie the newer decision is the more useful one to meet first. This only
 * reorders rows whose scores are EQUAL: it never moves a row past a higher or lower score, so it is
 * not the "promote newer decisions" reordering that cannot tell a correction from a related note.
 *
 * `dateMs` is called only for rows that share a score with another row, so a large graph with
 * mostly distinct scores pays for almost no lookups.
 */
export function orderTiesNewestFirst<T extends { decisionId: string; score: number }>(
  rows: readonly T[],
  dateMs: (id: string) => number | undefined,
): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j]!.score === rows[i]!.score) j++;
    const run = rows.slice(i, j);
    if (run.length > 1) {
      const date = new Map(run.map(r => [r.decisionId, dateMs(r.decisionId) ?? 0]));
      run.sort((a, b) => {
        const da = date.get(a.decisionId)!, db = date.get(b.decisionId)!;
        return db - da || (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0);
      });
    }
    out.push(...run);
    i = j;
  }
  return out;
}
