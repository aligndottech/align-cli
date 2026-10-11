import type { createLocalDb } from './local-db.js';
import { classifyCandidates } from './local-candidate-classify.js';
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
  // ALIGN_DETECTOR (local-candidate-classify.ts): v0 asks how the new capture relates to each
  // existing decision in turn (the EXISTING decision is A, the capture B, stopping after a provider
  // stop); v1 asks once, with the capture as the NEW DECISION and every candidate listed.
  const rows = toClassify.map(c => ({ c, row: db.getDecisionById(c.decisionId) }));
  const known = rows.filter((r): r is { c: typeof r.c; row: NonNullable<typeof r.row> } => r.row !== null);
  const self = db.getDecisionById(id);
  const { version, outcomes } = await classifyCandidates(
    { title, summary, decidedAt: self?.decidedAt ?? null, platform: self?.platform ?? null },
    known.map(({ c, row }) => ({ id: c.decisionId, title: row.title, summary: row.summary, similarity: c.score, platform: row.platform, decidedAt: row.decidedAt, status: db.isSuperseded(c.decisionId) ? 'superseded' : null })),
    'candidate-first',
  );
  const typedBy = new Map(known.map(({ c }, i) => [c.decisionId, outcomes[i]!]));
  // Every edge the v1 pass writes is stamped v1, the untyped fallback included (schema v12).
  const detectorVersion = version;
  for (const c of candidates) {
    const outcome = typedBy.get(c.decisionId);
    if (outcome?.ok) {
      // replaceLink, not insertLink: this upgrades the cosine `relates` edge the ranking
      // would otherwise also write below into a typed one, rather than leaving both on
      // the pair (local-db.ts's unique index is per-relation, so both would coexist).
      db.replaceLink({ sourceId: id, targetId: c.decisionId, relation: outcome.relationship.type, confidence: outcome.relationship.confidence, detectorVersion });
      continue;
    }
    // Falls through to the untyped write on any classifier failure - a candidate still worth
    // surfacing as related even when nothing could type it.
    // ALI-503: `relates`, not `conflicts_with`. This is a cosine score with no judgement
    // behind it, and labelling it a conflict made `align local status` and the
    // align_get_conflicts MCP tool report manufactured findings as detections.
    db.insertLink({ sourceId: id, targetId: c.decisionId, relation: 'relates', confidence: c.score, detectorVersion });
  }
  return candidates;
}
