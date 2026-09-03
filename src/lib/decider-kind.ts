/**
 * ALI-831: which KIND of actor decided - the local graph's single writer of that
 * classification, mirroring align-stack's `deciderKind.ts` so a row classifies the same
 * way on this machine as it does once pushed.
 *
 * The one deliberate difference: 'agent-session' is in the set here. It is the platform a
 * session-imported decision carries (ALI-808; the agent name lives in the source URL and
 * `decision_json.agent`, never in the platform), and the cloud's AGENT_PLATFORMS gains the
 * same value in ALI-832. Until that lands, `align push` of a session row is rejected by the
 * cloud's platform CHECK rather than misclassified, which is the right failure direction.
 *
 * 'unknown' is never derived: it is what a NULL column reads as, for rows captured before
 * the column existed (align-stack migration 113 refuses the retroactive guess; so does the
 * local v5 migration in local-db.ts).
 */
export const DECIDER_KINDS = ['human', 'agent', 'unknown'] as const;

export type DeciderKind = (typeof DECIDER_KINDS)[number];

/** Machine surfaces by construction. Everything else, including an unrecognised value,
 *  classifies human - the cloud's KNOWN BOUNDARY: the platform cannot see who holds the CLI. */
const AGENT_PLATFORMS = new Set(['agent-session', 'mcp', 'github-actions']);

export function deriveDeciderKind(platform: string): DeciderKind {
  return AGENT_PLATFORMS.has(platform) ? 'agent' : 'human';
}

/** The fields every renderer reads, in wire spelling so a cloud payload and a local row
 *  feed the same function. */
export interface DeciderProvenance {
  decider_kind: string | null | undefined;
  ratified_by: string | null | undefined;
  ratified_at: string | null | undefined;
}

/**
 * The label, verbatim across lanes (ALI-831's shared contract): `agent-decided, unratified`
 * or `agent-decided, ratified by <name> on <YYYY-MM-DD>`. Null for anything a human decided
 * or whose origin is unknown - only a claim carries a label, because the label's job is to
 * stop a reader treating a claim as a rule.
 *
 * Date only, not the instant: the line is read by people and by agents reading a context
 * file, and "on 2026-09-03" is the fact that matters. The file stays idempotent because the
 * date is data on the row, not the render time.
 */
export function deciderLabel(p: DeciderProvenance): string | null {
  if (p.decider_kind !== 'agent') return null;
  if (!p.ratified_at) return 'agent-decided, unratified';
  const day = p.ratified_at.slice(0, 10);
  return `agent-decided, ratified by ${p.ratified_by ?? 'a human'} on ${day}`;
}
