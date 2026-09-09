/**
 * ALI-950: the question the outro and the second-run card hand the agent names a REAL
 * decision from the graph, so "why did we X" is checkable against the repo the user is
 * sitting in. Read straight back from the graph rather than trusting an import's tally
 * (the same rule as the local found-summary), and one read answers both "is there
 * anything in here" and "what is the most recent thing".
 *
 * Best effort by design: an expired token or an unreachable gateway must not turn bare
 * `align` or the wizard's last line into an error, so a failed read is an empty graph with
 * no title, and the caller falls back to the import suggestion or the generic question.
 */
export async function firstDecision(
  client: { listDecisions(params: { limit?: number }): Promise<Array<{ title?: string }>> },
): Promise<{ hasDecisions: boolean; firstTitle: string | undefined }> {
  try {
    const some = await client.listDecisions({ limit: 1 });
    const hasDecisions = Array.isArray(some) && some.length > 0;
    return { hasDecisions, firstTitle: (hasDecisions && some[0]?.title) || undefined };
  } catch {
    return { hasDecisions: false, firstTitle: undefined };
  }
}
