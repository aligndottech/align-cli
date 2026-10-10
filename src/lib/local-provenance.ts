import type { DecisionRow } from './local-db.js';

/**
 * ALI-831: the provenance every decision payload carries, in wire spelling, so an agent
 * reading this server can tell a claim from a rule. `ratified` is a boolean beside the
 * stamp rather than instead of it: a consumer branches on the boolean and cites the stamp.
 * A NULL column (a row from before the column existed) reads 'unknown', never a guess.
 */
export function provenanceOf(row: Pick<DecisionRow, 'deciderKind' | 'ratifiedBy' | 'ratifiedAt'>) {
  return {
    decider_kind: row.deciderKind ?? 'unknown',
    ratified: row.ratifiedAt !== null,
    ...(row.ratifiedAt ? { ratified_at: row.ratifiedAt, ratified_by: row.ratifiedBy } : {}),
  };
}
