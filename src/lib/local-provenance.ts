import type { DecisionRow } from './local-db.js';

/**
 * The provenance every decision payload carries, in wire spelling, so an agent
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

/**
 * Both dates, in wire spelling. `decided_at` is the source's own timestamp and is omitted when the
 * source did not say; `created_at` is the import minute. They are separate fields because the
 * second is not a stand-in for the first (a consumer that shows a date must say which it has).
 */
export function datesOf(row: Pick<DecisionRow, 'decidedAt' | 'createdAt'>) {
  return {
    ...(row.decidedAt ? { decided_at: row.decidedAt } : {}),
    created_at: row.createdAt,
  };
}
