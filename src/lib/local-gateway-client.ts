import { createLocalDb } from './local-db.js';
import { cosineSimilarity, getEmbedding } from './local-embeddings.js';
import { classifyRelationship } from './local-relationship-classifier.js';
import { citationFor, repositoryOf } from './decision-links.js';
// Type-only import (erased at runtime, so no cycle with gateway-client.ts): the
// local client returns the SAME shapes as the cloud client, so the CLI commands
// (ask/search/check) work identically in local mode.
import type { AlignmentResult, SearchResults } from './gateway-client.js';

/**
 * Cosine floor for linking two decisions as related on ingest.
 *
 * Named CONFLICT_THRESHOLD until ALI-503, which was the same category error as the code
 * it governed: the value decides similarity, and similarity is not opposition. The
 * classifier prompt in local-relationship-classifier.ts says so directly - "high textual
 * similarity alone is NOT a conflict" - and the link written here is `relates` because an
 * embedding cannot tell agreement from opposition. Only a classifier reading both can, and
 * its verdict is never persisted as a link.
 */
export const SIMILARITY_THRESHOLD = 0.65;
/**
 * Relevance floor for align_ask / align_search.
 *
 * Was an inline 0.1, the only unnamed threshold in this file and less than a quarter of
 * its neighbours. It let align_ask answer "what happens when the brain service is down"
 * with two unrelated decisions at 0.18 and 0.14 - noise the agent had to recognise by
 * reading the decimals itself, and an audience cannot.
 *
 * 0.25 matches the gateway's own /decisions/smart-search floor, so the same question gets
 * the same relevance bar in local and cloud mode. Lower than the 0.45 used for relatedness
 * on purpose: search is a human asking a natural-language question, where a looser match is
 * still worth showing, while relatedness is machinery acting on its own.
 *
 * An honest empty result is the point. "The graph has nothing on this" is a better answer
 * than two wrong decisions, because the caller can act on it.
 */
export const SEARCH_THRESHOLD = 0.25;
// Embeddings flag a decision as a related CANDIDATE at/above this score; the
// relationship type is then assigned lazily by the LLM classifier.
export const RELATES_THRESHOLD = 0.45;
// Below this similarity between a decision and new content, the content is
// considered to have drifted from the decision.
export const DRIFT_THRESHOLD = 0.5;

export function createLocalGatewayClient(dbPath: string) {
  const db = createLocalDb(dbPath);

  async function findSimilar(
    embedding: Float32Array,
    topK: number,
    threshold = 0.0,
    excludeId?: string,
  ): Promise<Array<{ decisionId: string; score: number }>> {
    const all = db.getAllEmbeddings();
    return all
      .filter(e => e.decisionId !== excludeId)
      .map(e => ({ decisionId: e.decisionId, score: cosineSimilarity(embedding, e.embedding) }))
      .filter(e => e.score >= threshold)
      // ALI-218: id tiebreaker so equal-similarity candidates slice deterministically.
      .sort((a, b) => b.score - a.score || a.decisionId.localeCompare(b.decisionId))
      .slice(0, topK);
  }

  // Shared ingest path: insert, embed (title + summary), link similar decisions.
  // Used by both captureDecision (single, may parse a URL) and ingestBatch.
  // Says "similar", not "conflicts": an embedding cannot tell agreement from opposition,
  // and calling this conflict detection is what ALI-503 was (see SIMILARITY_THRESHOLD).
  async function ingestOne(
    input: string,
    platform: string,
    opts: { titleOverride?: string; sourceUrlOverride?: string | null } = {},
  ): Promise<{ id: string; title: string; summary: string; sourceUrl: string | null; platform: string; related: Array<{ decisionId: string; score: number }> }> {
    let title = input.slice(0, 80);
    let summary = input;
    let sourceUrl: string | null = opts.sourceUrlOverride ?? null;
    if (opts.sourceUrlOverride === undefined) {
      try {
        const url = new URL(input);
        sourceUrl = url.href;
        title = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
        summary = `Captured from ${url.hostname}`;
      } catch { /* plain text - use as-is */ }
    }
    if (opts.titleOverride) title = opts.titleOverride.slice(0, 80);

    const id = db.insertDecision({ title, summary, sourceUrl, platform });
    // Embed title + summary so URL captures (whose summary is just "Captured
    // from <host>") still carry the path-derived title's semantic content.
    const embedText = title === summary ? summary : `${title}. ${summary}`;
    const embedding = await getEmbedding(embedText);
    db.setEmbedding(id, embedding);

    const candidates = await findSimilar(embedding, 10, SIMILARITY_THRESHOLD, id);
    for (const c of candidates) {
      // ALI-503: `relates`, not `conflicts_with`. This is a cosine score with no judgement
      // behind it, and labelling it a conflict made `align local status` and the
      // align_get_conflicts MCP tool report manufactured findings as detections.
      db.insertLink({ sourceId: id, targetId: c.decisionId, relation: 'relates', confidence: c.score });
    }
    return { id, title, summary, sourceUrl, platform, related: candidates };
  }

  return {
    /** Release the underlying SQLite handle (required on Windows before deleting the file). */
    close() {
      db.close();
    },

    async whoami() {
      return { email: 'local', tenantId: 'local', mode: 'local-embedded' };
    },

    async captureDecision(input: string, platform = 'cli') {
      const r = await ingestOne(input, platform);
      return { id: r.id, title: r.title, summary: r.summary, sourceUrl: r.sourceUrl, platform: r.platform, related: r.related.map(c => c.decisionId) };
    },

    async ingestBatch(items: Array<{ source_url?: string; platform?: string; raw_text: string; title?: string }>) {
      const snapshots = [];
      for (const item of items) {
        const r = await ingestOne(item.raw_text, item.platform ?? 'cli', {
          titleOverride: item.title,
          sourceUrlOverride: item.source_url ?? null,
        });
        snapshots.push({
          id: r.id,
          title: r.title,
          summary: r.summary,
          analysis: {
            relatedDecisions: r.related.map(c => ({
              id: c.decisionId,
              title: db.getDecisionById(c.decisionId)?.title ?? '',
              // Must match the relation actually written above, or this is a second writer
              // of the same fact that can drift from it (ALI-503).
              relationship: 'relates',
              confidence: c.score,
            })),
          },
        });
      }
      return { snapshots };
    },

    // ALI-602: `align context sync --env local` lists the graph without a query.
    // The db reads newest-first; the renderer re-sorts deterministically, so the
    // order here only decides WHICH rows survive the limit (newest do).
    async listDecisions(params: { limit?: number } = {}) {
      const limit = params.limit ?? 200;
      return db.listDecisions().slice(0, limit).map((row) => {
        const cite = citationFor(row.sourceUrl);
        return {
          id: row.id,
          title: row.title,
          summary: row.summary,
          platform: row.platform,
          status: 'active',
          ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
          ...(cite ? { cite } : {}),
        };
      });
    },

    async searchDecisions(query: string, limit = 10): Promise<SearchResults> {
      const embedding = await getEmbedding(query);
      const similar = await findSimilar(embedding, limit, SEARCH_THRESHOLD);
      const results = similar
        .map(s => {
          const row = db.getDecisionById(s.decisionId);
          if (!row) return null;
          // source_url and platform were read from SQLite here and then discarded, so
          // nothing downstream could say which repository a decision came from. The
          // hosted connector has derived both since #1441; this is that parity.
          const repository = repositoryOf(row.sourceUrl);
          const cite = citationFor(row.sourceUrl);
          return {
            id: row.id,
            title: row.title,
            summary: row.summary,
            status: 'active',
            similarity: s.score,
            created_at: row.createdAt,
            platform: row.platform,
            ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
            ...(repository ? { repository } : {}),
            ...(cite ? { cite } : {}),
            // No decision_url: a local-embedded decision lives only in this machine's
            // SQLite file, so any Align URL built for it would 404 wherever it pointed.
            // Absent beats fabricated - a wrong link looks clickable.
          };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
      return { results, count: results.length, strategy: 'semantic' };
    },

    async checkAlignment(diff: string, _context?: string): Promise<AlignmentResult> {
      // Stage 1: embeddings find candidate related decisions (free, local).
      const embedding = await getEmbedding(diff);
      const similar = await findSimilar(embedding, 5, RELATES_THRESHOLD);
      const candidates = similar
        .map(s => {
          const row = db.getDecisionById(s.decisionId);
          return row ? { ...row, score: s.score } : null;
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);

      if (!candidates.length) {
        return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: 'No related decisions found in your local graph.' };
      }

      // Stage 2: type each candidate against the proposed change (LLM, user's key,
      // lazy - only the few candidates we surface here). Degrades to untyped.
      const subject = { title: 'Proposed change', summary: diff.slice(0, 2000) };
      const typed = [];
      for (const c of candidates) {
        const outcome = await classifyRelationship(subject, { title: c.title, summary: c.summary });
        const rel = outcome.ok ? outcome.relationship : null;
        typed.push({
          id: c.id,
          title: c.title,
          summary: c.summary,
          url: c.sourceUrl ?? undefined,
          relationship: rel?.type ?? 'relates', // ALI-219: canonical (was 'relates_to')
          confidence: rel?.confidence ?? c.score,
          typed: rel !== null,
          failureReason: outcome.ok ? undefined : outcome.reason,
          reason: rel?.reason,
          similarity: c.score,
        });
      }

      const relevant_decisions = typed.map(t => ({ id: t.id, title: t.title, summary: t.summary, similarity: t.similarity, url: t.url }));
      const conflicts = typed
        .filter(t => t.relationship === 'conflicts_with' || t.relationship === 'contradicts')
        .map(t => ({
          decision_id: t.id,
          title: t.title,
          summary: t.summary,
          url: t.url,
          reason: t.reason ?? 'Conflicts with an existing decision in your local graph',
          severity: (t.confidence >= 0.8 ? 'critical' : 'warning') as 'critical' | 'warning',
        }));

      // ALI-414: a candidate we retrieved but could not classify is exactly the case
      // where we do not know - it could be the conflict. Reporting `aligned` there is
      // a fail-open, and an agent reads `aligned` as permission to proceed. A conflict
      // we DID find still wins: it is strictly more actionable than "unknown".
      const unclassified = typed.find(t => !t.typed);
      const confidence = Math.max(...typed.map(t => t.confidence));

      if (conflicts.length) {
        return {
          status: 'conflicting',
          confidence,
          relevant_decisions,
          conflicts,
          message: `This change conflicts with ${conflicts.length} existing decision(s) in your local graph - review before proceeding.`,
        };
      }

      if (unclassified) {
        // ALI-420: an unvetted local model gets its own remedy. The no_llm_key hint below
        // says "or run a local Ollama", which is nonsense to someone already running one.
        const hint = unclassified.failureReason === 'unvetted_local_model'
          ? ' Ollama is running, but no vetted model is installed: `ollama pull llama3.2`, or set ALIGN_OLLAMA_MODEL to name your own.'
          : unclassified.failureReason === 'no_llm_key'
            ? ' Set ANTHROPIC_API_KEY or OPENAI_API_KEY (or run a local Ollama) so these can be classified.'
            : '';
        return {
          status: 'unknown',
          reason: unclassified.failureReason,
          confidence: 0,
          relevant_decisions,
          conflicts: [],
          message:
            `Could not check ${relevant_decisions.length} related decision(s) - the relationship classifier did not run. ` +
            `This is NOT a pass: treat it as unchecked and review these decisions before proceeding.${hint}`,
        };
      }

      return {
        status: 'aligned',
        confidence,
        relevant_decisions,
        conflicts,
        message: `Found ${relevant_decisions.length} related decision(s) to review.`,
      };
    },

    async checkDrift(decisionId: string, content: string, _sourceType?: string) {
      const decisionEmbedding = db.getEmbedding(decisionId);
      if (!decisionEmbedding) return { decisionId, score: null, drifted: null, note: 'Decision not found or not yet embedded.' };
      const contentEmbedding = await getEmbedding(content);
      const score = cosineSimilarity(decisionEmbedding, contentEmbedding);
      return { decisionId, score, drifted: score < DRIFT_THRESHOLD };
    },

    async getImpact(decisionId: string) {
      const allLinks = db.listLinks({ decisionId });
      const upstream = allLinks.filter(l => l.targetId === decisionId);
      const downstream = allLinks.filter(l => l.sourceId === decisionId);
      return { upstream, downstream };
    },

    async getConflicts() {
      // Same tool name as the cloud client, so the same vocabulary: conflict_count is the
      // whole-set total (the local store is fully in hand, so it is simply the length).
      // contradicts is included because the local classifier genuinely emits it and the
      // cloud query has always asked for both relations.
      const links = [
        ...db.listLinks({ relation: 'conflicts_with' }),
        ...db.listLinks({ relation: 'contradicts' }),
      ];
      return { links, conflict_count: links.length };
    },
  };
}

export type LocalGatewayClient = ReturnType<typeof createLocalGatewayClient>;
