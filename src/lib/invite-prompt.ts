/**
 * ALI-938: the invite nudge - what replaces the three "Share this graph with your team:
 * https://align.tech/pricing" lines in mcp.ts, why.ts and value-rollup.ts. A URL asks
 * someone to go somewhere else and figure it out; `align invite <email>` is a command
 * they can run right there.
 *
 * Pure and I/O-free, same discipline as connect-prompt.ts's gap lines: the callers
 * (why.ts, in particular) gather whatever local git/graph state the decision requires,
 * and this module only turns already-known facts into copy.
 */

export const INVITE_HINT = 'align invite <their-email>';

export type InviteNudgeReason = 'value' | 'answered-by-other' | 'empty-with-committers';

/**
 * One line, reason-specific lead-in + the shared command hint. Three reasons:
 *  - 'value': the graph has done something worth sharing (mcp.ts, value-rollup.ts's
 *    existing `hasValue` trigger - an aggregate signal, not tied to one decision).
 *  - 'answered-by-other': `align ask` answered from a decision someone else made -
 *    the clearest single moment the bottom-up thesis is about ("this would be amazing
 *    if my whole team's decisions were in here").
 *  - 'empty-with-committers': the question came back empty, but the repo has commits
 *    from people other than whoever is running the command - their graph isn't in
 *    here yet.
 */
export function inviteNudgeLine(reason: InviteNudgeReason = 'value'): string {
  switch (reason) {
    case 'answered-by-other':
      return `That came from a decision someone else made. Get your whole team in here: ${INVITE_HINT}`;
    case 'empty-with-committers':
      return `Nothing matched, but this repo has other committers. Bring them into your graph: ${INVITE_HINT}`;
    case 'value':
    default:
      return `Add a teammate to this graph: ${INVITE_HINT}`;
  }
}

export interface DecisionAuthorLike {
  name?: string;
  email?: string;
}

export interface LocalIdentity {
  email: string | null;
  name: string | null;
}

/**
 * Whether at least one of these decisions was authored by someone other than whoever is
 * running the command - the signal `inviteNudgeLine('answered-by-other')` is for.
 *
 * Deliberately conservative in both directions:
 *  - with no local identity at all, this can't compare anything and returns false
 *    rather than guessing (verification.md: never claim a comparison you didn't make).
 *  - for one author, it compares email-to-email if both sides have an email, else
 *    name-to-name if both sides have a name. It never compares an email against a
 *    name (no cheap way to know they refer to the same person), and an author with
 *    neither field carries no attribution to judge.
 */
export function answeredBySomeoneElse(
  authors: Array<DecisionAuthorLike | null | undefined>,
  me: LocalIdentity,
): boolean {
  const myEmail = me.email?.toLowerCase() ?? null;
  const myName = me.name?.toLowerCase() ?? null;
  if (!myEmail && !myName) return false;

  return authors.some((a) => {
    if (!a) return false;
    const email = a.email?.toLowerCase();
    const name = a.name?.toLowerCase();
    if (email && myEmail) return email !== myEmail;
    if (name && myName) return name !== myName;
    return false;
  });
}
