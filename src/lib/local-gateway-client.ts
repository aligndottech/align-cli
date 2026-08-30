import { createLocalDb } from './local-db.js';
import { cosineSimilarity, getEmbedding } from './local-embeddings.js';
import { type ClassificationOutcome, classifyRelationship } from './local-relationship-classifier.js';
import { RECOMMENDED_OLLAMA_PULL } from './local-llm.js';
import { citationFor, repositoryOf } from './decision-links.js';
import { contentWordQuery } from './search-query.js';
// Type-only import (erased at runtime, so no cycle with gateway-client.ts): the
// local client returns the SAME shapes as the cloud client, so the CLI commands
// (ask/search/check) work identically in local mode.
import type { AlignmentResult, SearchResults } from './gateway-client.js';
import type { CheckDepth } from './check-depth.js';

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
/**
 * Candidate floor for ADJUDICATION - the path that then pays an LLM per candidate.
 *
 * Deliberately higher than the retrieval floor below, because this surface is expensive in
 * three ways the hook is not: up to 5 sequential calls to the user's own provider, ~11s of
 * latency, and an exit code. A keyless CI runner that gets `no-context` today exits 0; the
 * moment retrieval finds anything it gets `unknown` and exits 2. And the classifier cannot
 * reject a candidate - its vocabulary is ten positive relations with no "unrelated" - so a
 * loose candidate that reaches it is reported rather than filtered.
 *
 * Deliberately NOT recalibrated with the retrieval floor. Measured on the corpus, 0.30 would
 * recover four more related pairs here too, and that trade is a separate decision with a
 * separate blast radius (see relatedness-calibration.test.ts).
 */
export const RELATES_THRESHOLD = 0.45;

/**
 * Candidate floor for RETRIEVAL ONLY (`depth: 'related'`, the agent editor hook).
 *
 * Measured, not chosen. Against fixtures/relatedness-corpus.json: 0.45 recovered 3 of 8 related
 * pairs, 0.30 recovers 7 of 8, and neither admits a single unrelated pair. 0.25 scores the same
 * 7 of 8, so the tie-break is margin over the worst false positive (0.2051): 0.30 clears it by
 * 0.095 against 0.25's 0.045.
 *
 * 0.30 is also where this constant sat until commit 0cbef08 raised it to 0.45 inside a rename,
 * unmentioned and unmeasured. So this is a revert with evidence attached rather than a new
 * guess, and the evidence is a test that fails if the corpus stops supporting it.
 *
 * Safe to be looser here precisely because this path is cheap and honest: it returns above
 * Stage 2, so it makes no provider call, and what the hook prints declines to assert anything
 * ("related by content search and have NOT been adjudicated"). That is the same posture as
 * `align search`, which has run at 0.25 all along - as has MCP `align_get_related_decisions`.
 */
export const RETRIEVAL_RELATES_THRESHOLD = 0.3;
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
  ): Promise<{ id: string; title: string; summary: string; sourceUrl: string | null; platform: string; related: Array<{ decisionId: string; score: number }>; created: boolean }> {
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

    // BEFORE the upsert: insertDecision returns the surviving id whether it inserted or
    // refreshed, so this is the only moment the difference is visible. Without it a
    // re-import reports every decision as imported while the graph does not move, which
    // reads as having imported twice (ALI-770).
    const created = db.findIdBySource(sourceUrl, title) === null;
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
    return { id, title, summary, sourceUrl, platform, related: candidates, created };
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
          created: r.created,
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

    /**
     * One decision by id, for `align decisions show` (ALI-772).
     *
     * `decisions` was left off the preferLocalEmbedded redirect that ask, search and import
     * have, so the obvious command for "show me my graph" resolved to an unauthenticated
     * cloud default and 401'd for a no-account user. The redirect could not be added while
     * this method was missing: `show` would have failed with `client.getDecision is not a
     * function`, which is worse than the 401 it replaced.
     *
     * A missing id THROWS rather than returning null: the renderer reads `d.id` straight
     * away, so null would surface as "Cannot read properties of null", which is the raw
     * stack trace the CLI's fatal handler exists to avoid.
     *
     * `ai` and `spaces` are cloud-side enrichment and simply absent here. The renderer
     * already guards both with optional chaining, so there is nothing to fake.
     */
    async getDecision(id: string) {
      const row = db.getDecisionById(id);
      if (!row) {
        throw new Error(`No decision ${id} in your local graph. \`align decisions list\` shows what is there.`);
      }
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        platform: row.platform,
        source_url: row.sourceUrl,
        created_at: row.createdAt,
        external_references: [] as unknown[],
        spaces: [] as unknown[],
      };
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
      let similar = await findSimilar(embedding, limit, SEARCH_THRESHOLD);
      // A natural-language question embeds less densely than its subject does, so on a
      // small graph it can miss a decision that its own content words hit. Retry once,
      // only on an empty result, mirroring the gateway's own keyword-to-semantic
      // fallback (align-stack#1706). The raw query still goes first, so ALI-105 holds
      // and a query that already matched costs exactly one embedding.
      if (!similar.length) {
        const reduced = contentWordQuery(query);
        if (reduced) {
          similar = await findSimilar(await getEmbedding(reduced), limit, SEARCH_THRESHOLD);
        }
      }
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

    async checkAlignment(
      diff: string,
      _context?: string,
      // 'exhaustive' deliberately collapses into 'full' here: local mode has no gateway
      // similarity cost gate to skip adjudication - so there is nothing extra to pay for.
      // The member is accepted so one CheckDepth union serves both
      // clients (ALI-708 review: the previous two-member spelling drifted behind the
      // createGatewayClient cast, invisible to tsc).
      opts: { depth?: CheckDepth; title?: string } = {},
    ): Promise<AlignmentResult> {
      // Stage 1: embeddings find candidate related decisions (free, local).
      //
      // The floor depends on what the caller will DO with the candidates. Retrieval-only stops
      // above Stage 2, so a looser match costs one extra title in prose that asserts nothing;
      // adjudication pays a provider call per candidate and can move an exit code, so it keeps
      // the stricter bar. One constant could not serve both.
      const threshold = opts.depth === 'related' ? RETRIEVAL_RELATES_THRESHOLD : RELATES_THRESHOLD;
      const embedding = await getEmbedding(diff);
      const similar = await findSimilar(embedding, 5, threshold);
      const candidates = similar
        .map(s => {
          const row = db.getDecisionById(s.decisionId);
          return row ? { ...row, score: s.score } : null;
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);

      if (!candidates.length) {
        return { status: 'no-context', confidence: 0, relevant_decisions: [], conflicts: [], message: 'No related decisions found in your local graph.' };
      }

      // `depth:'related'` means retrieval only, and honouring it matters more here than in the
      // cloud client. The editor hook asks for it to fit a <=10s budget (check.ts), but in
      // local mode Stage 2 is also the only EGRESS in the pipeline: it posts the proposed
      // content plus a stored decision to the user's own LLM provider, once per candidate, on
      // every agent Write/Edit. This signature took two arguments, so the option was silently
      // dropped and adjudication ran anyway - up to 5 provider calls per keystroke-level event,
      // whose results the hook then abandoned at its 2.5s race.
      //
      // Matched as an allowlist-of-one rather than `!== 'full'`, which would be the safer
      // polarity for an egress guard, because the two callers that MUST adjudicate
      // (`align check` and `--ci`, check.ts) pass no depth at all. Inverting it would silence
      // them. The cost of this direction: a future caller misspelling the value adjudicates,
      // so keep `depth` typed as the union at every call site rather than widening it.
      if (opts.depth === 'related') {
        return {
          status: 'retrieved',
          confidence: Math.max(...candidates.map(c => c.score)),
          relevant_decisions: candidates.map(c => ({
            id: c.id,
            title: c.title,
            summary: c.summary,
            similarity: c.score,
            url: c.sourceUrl ?? undefined,
          })),
          conflicts: [],
          message: `Found ${candidates.length} related decision(s) - retrieval only, not adjudicated.`,
        };
      }

      // Stage 2: type each candidate against the proposed change (LLM, user's key,
      // lazy - only the few candidates we surface here). Degrades to untyped.
      // The caller's title when it gave one: `align check --title` exists because adjudicating
      // on a bare diff means judging a file header and a few `+` lines. Accepting the option in
      // the signature and then classifying against a placeholder is the dropped-`depth` defect
      // one field over.
      const subject = { title: opts.title ?? 'Proposed change', summary: diff.slice(0, 2000) };
      const typed = [];
      let chainStopped = false;
      for (const c of candidates) {
        // ALI-692: a recorded chain stop is a property of the PROVIDER, not of this
        // candidate, so asking again per candidate repeats one doomed call N times -
        // on a 429 that burns the retry budget while `--advisory` races its deadline.
        // The remaining candidates still report, untyped, which is what `unknown` means.
        const outcome: ClassificationOutcome = chainStopped
          ? { ok: false, reason: 'classifier_error' }
          : await classifyRelationship(subject, { title: c.title, summary: c.summary });
        if (!outcome.ok && outcome.failure?.kind === 'provider_stopped') chainStopped = true;
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
          // The diagnosis travels WITH the candidate it describes, so the hint below
          // names the model that failed on this one rather than whatever a module
          // getter happened to hold by the time the loop finished.
          failure: outcome.ok ? undefined : outcome.failure,
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
        // ALI-692: the third rung. A recorded chain stop names the model that failed,
        // and this is the surface agents gate on - it used to fall through to an empty
        // hint, discarding the diagnosis one frame above where it was recorded.
        const failure = unclassified.failure;
        const hint = unclassified.failureReason === 'unvetted_local_model'
          ? ` Ollama is running, but no recognised model is installed: \`ollama pull ${RECOMMENDED_OLLAMA_PULL}\`, or set ALIGN_OLLAMA_MODEL to name your own.`
          : unclassified.failureReason === 'no_llm_key'
            ? ' Set ANTHROPIC_API_KEY or OPENAI_API_KEY (or run a local Ollama) so these can be classified.'
            : failure?.kind === 'provider_stopped'
              ? ` ${failure.model} (${failure.provider}) returned an unusable response (${failure.detail}), and no weaker model was asked in its place.`
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
