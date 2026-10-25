import { pickAskableTitle } from './next-step.js';

/**
 * The question the outro and the second-run card hand the agent names a REAL
 * decision from the graph, so "why did we X" is checkable against the repo the user is
 * sitting in. Read straight back from the graph rather than trusting an import's tally
 * (the same rule as the local found-summary), and one read answers both "is there
 * anything in here" and "what can we ask about".
 *
 * A page, not one row: the newest decision is often a subject the question cannot take
 * ("fix: error throwing in reply"), so with one row most graphs got the generic question.
 *
 * Best effort by design: an expired token or an unreachable gateway must not turn bare
 * `align` or the wizard's last line into an error, so a failed read is an empty graph with
 * no title, and the caller falls back to the import suggestion or the generic question.
 */
const TITLE_PAGE = 10;

export async function firstDecision(
  client: { listDecisions(params: { limit?: number }): Promise<Array<{ title?: string }>> },
): Promise<{ hasDecisions: boolean; firstTitle: string | undefined; titles: string[] }> {
  try {
    const some = await client.listDecisions({ limit: TITLE_PAGE });
    const titles = Array.isArray(some) ? some.map((d) => d.title).filter((t): t is string => Boolean(t)) : [];
    const hasDecisions = Array.isArray(some) && some.length > 0;
    return { hasDecisions, firstTitle: pickAskableTitle(titles) ?? titles[0], titles };
  } catch {
    return { hasDecisions: false, firstTitle: undefined, titles: [] };
  }
}
