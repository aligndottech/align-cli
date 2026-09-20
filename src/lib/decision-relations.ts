/**
 * The relation context a retrieved decision needs, on its way to an agent.
 *
 * A search hit whose status is not `active` is close to useless on its own: it tells an agent
 * the decision is contested or replaced and nothing about by WHAT. The gateway answers both
 * halves - `successor` (what REPLACED this, align-stack ALI-1066/#2443) and `conflicts_with`
 * (what CONTESTS this, ALI-1092/#2461) - as `{ id, title, source_url, relation }`.
 *
 * WHAT THIS DOES NOT DO, because it was already true: it does not make those fields reach the
 * agent. `align mcp`'s search arms have always been a pass-through - `serializeMcpResult` is a
 * DENYLIST of heavy keys, so an unrecognised gateway field reaches the agent untouched. Measured
 * against prod on v0.30.0: a search row arrived carrying `architectural_altitude`, `spaces`,
 * `tier` and `supersession_count`, none of which this repo names anywhere.
 *
 * What it fixes is the one thing pass-through gets WRONG, which is the absent-vs-null
 * distinction:
 *
 *   * `JSON.stringify` renders a null as `"conflicts_with":null`. An agent reading that has been
 *     told NO CONFLICT EXISTS. That is a different claim from "not provided", and it is the more
 *     dangerous of the two, because it reads as a checked fact.
 *   * A relation object with no `id` names an opponent the agent cannot go and read. Silence is
 *     better than an unfollowable pointer.
 *
 * And it makes the contract PINNED rather than incidental. Pass-through is one line from
 * disappearing - a key added to `OMIT_RESULT_KEYS`, or a projection added to a search arm the way
 * `shapeTopicTimeline` and `shapeDecisionRationale` already project their tools - and nothing in
 * this repo would have gone red.
 *
 * Keys are KEPT rather than whitelisted, deliberately. The four named above are preserved by
 * construction, and a field the gateway adds next (the hosted connector already derives `cite` and
 * `decision_url` for a successor) is carried rather than silently dropped - which is the exact
 * class of defect this module exists to close.
 */

/** One end of a relation an agent can follow. `id` is the only field it cannot do without. */
export interface DecisionRelation {
  id: string;
  title?: string;
  source_url?: string;
  /** The stored relation, so `conflicts_with` and `contradicts` stay distinguishable. */
  relation?: string;
  [key: string]: unknown;
}

/**
 * The row fields carrying relation context. Both are attached by the gateway only when the
 * decision's status warrants it (`conflicted` or `superseded` for a successor, `conflicted` for a
 * counterpart), so an ACTIVE row carries neither and this leaves it alone.
 */
export const DECISION_RELATION_FIELDS = ['successor', 'conflicts_with'] as const;

/**
 * Normalise one relation, or return undefined if it cannot be followed.
 *
 * Undefined means "drop the key entirely" to every caller here - never "write undefined", which
 * `JSON.stringify` would omit anyway but which leaves the key present to any in-process reader.
 */
export function normaliseDecisionRelation(raw: unknown): DecisionRelation | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const id = source['id'];
  if (typeof id !== 'string' || id.trim() === '') return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // Absent beats null on every field for the same reason it does on the whole object: a null
    // title reads as "this decision has no title", which is a claim nobody made.
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out as DecisionRelation;
}

/**
 * Apply the contract to a search payload, leaving everything else exactly as the gateway sent it.
 *
 * Non-array `results`, a non-object row, or a row with neither field are all pass-throughs: this
 * runs on every search response including local-embedded ones, where the local graph supplies no
 * typed relation edge at all (`local-db.ts` relabels every `conflicts_with` edge to `relates`,
 * ALI-503) and so has nothing for this to shape.
 */
export function withDecisionRelationContract<T extends { results?: unknown }>(payload: T): T {
  const rows = (payload as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return payload;

  return {
    ...payload,
    results: rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
      const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
      for (const field of DECISION_RELATION_FIELDS) {
        if (!(field in out)) continue;
        const shaped = normaliseDecisionRelation(out[field]);
        if (shaped) out[field] = shaped;
        else delete out[field];
      }
      return out;
    }),
  };
}
