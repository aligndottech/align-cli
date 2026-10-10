import type { createLocalDb } from './local-db.js';
import { type ClassificationOutcome, classifyRelationship } from './local-relationship-classifier.js';
import { hasConfiguredProvider } from './local-llm.js';
import { selectForClassification } from './local-ingest.js';
import { RELATED_FLOOR, RELATED_TOP_K, SIMILARITY_THRESHOLD } from './local-thresholds.js';
import type { Ranker } from './similarity/embedding-matrix.js';

type LocalDb = ReturnType<typeof createLocalDb>;

/** The similarity and link pass of one ingest: rank, classify the top tier when allowed,
 *  write the edges. Returns the candidates it linked.
 *
 *  Moved out of local-gateway-client.ts (LB) so that file stays under its size limit; the
 *  ranking itself goes through `ranker`: the in-memory matrix of every stored embedding, or
 *  the streaming scan on a graph too large for one. */
export async function linkPass(
  db: LocalDb, ranker: Ranker,
  id: string, embedding: Float32Array, title: string, summary: string, classify: boolean | undefined,
): Promise<Array<{ decisionId: string; score: number }>> {
  // One ranked pass, two rules united. Absolute (>= SIMILARITY_THRESHOLD, cap 10)
  // as before, PLUS the top RELATED_TOP_K overall when they clear RELATED_FLOOR -
  // the cross-tool edges live between those two lines (see RELATED_FLOOR's note).
  // If the top-K are all absolute matches the relative rule adds nothing, which is
  // the correct degenerate case rather than a special one.
  const ranked = await ranker.topK(embedding, 10, { excludeId: id, threshold: 0 });
  const candidates = ranked.filter(
    (c, i) => c.score >= SIMILARITY_THRESHOLD || (i < RELATED_TOP_K && c.score >= RELATED_FLOOR),
  );

  // Which candidates the paid classifier sees: see selectForClassification. chainStopped
  // mirrors checkAlignment's own short-circuit: once one candidate's classification fails
  // with a stopped provider, further calls in THIS capture are skipped rather than repeated.
  const toClassify = selectForClassification(candidates, {
    classify, threshold: SIMILARITY_THRESHOLD, hasProvider: hasConfiguredProvider,
  });
  const classifyIds = new Set(toClassify.map(c => c.decisionId));
  const newDecision = { title, summary };
  let chainStopped = false;
  for (const c of candidates) {
    if (classifyIds.has(c.decisionId) && !chainStopped) {
      // The EXISTING decision is the subject (A); the new capture is the candidate (B) -
      // "how does B relate to A" reads naturally as "does this new thing supersede/conflict
      // with what's already there", which is the direction a capture-time check asks in.
      const existingRow = db.getDecisionById(c.decisionId);
      const outcome: ClassificationOutcome = existingRow
        ? await classifyRelationship({ title: existingRow.title, summary: existingRow.summary }, newDecision)
        : { ok: false, reason: 'classifier_error' };
      if (!outcome.ok && outcome.failure?.kind === 'provider_stopped') chainStopped = true;
      if (outcome.ok) {
        // replaceLink, not insertLink: this upgrades the cosine `relates` edge the ranking
        // would otherwise also write below into a typed one, rather than leaving both on
        // the pair (local-db.ts's unique index is per-relation, so both would coexist).
        db.replaceLink({
          sourceId: id,
          targetId: c.decisionId,
          relation: outcome.relationship.type,
          confidence: outcome.relationship.confidence,
        });
        continue;
      }
      // Falls through to the untyped write below on any classifier failure - a candidate
      // still worth surfacing as related even when nothing could type it.
    }
    // ALI-503: `relates`, not `conflicts_with`. This is a cosine score with no judgement
    // behind it, and labelling it a conflict made `align local status` and the
    // align_get_conflicts MCP tool report manufactured findings as detections.
    db.insertLink({ sourceId: id, targetId: c.decisionId, relation: 'relates', confidence: c.score });
  }
  return candidates;
}
