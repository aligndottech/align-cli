import { createLocalDb, type DecisionRow, normaliseDecidedAt } from './local-db.js';
import { deriveDeciderKind } from './decider-kind.js';
import { currentRepoIdentity, repoFromSourceUrl } from './repo-identity.js';
import { cosineSimilarity, getEmbedding } from './local-embeddings.js';
import { type ClassificationOutcome, classifyRelationship } from './local-relationship-classifier.js';
import { noProviderHintInline, RECOMMENDED_OLLAMA_PULL } from './local-llm.js';
import { repositoryOf } from './decision-links.js';
import { localCitationFor } from './commit-cite.js';
import { extractRefs, refIdentityFor } from './decision-refs.js';
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
// ALI-785: the ABSOLUTE floor above is unreachable for cross-register pairs on
// MiniLM-L6 - measured on a 403-decision six-source corpus, near-duplicates score
// ~0.95, genuine cross-tool paraphrases 0.45-0.62, background noise 0.28-0.40, and
// 0 of 1,729 links crossed a platform. So linking also takes each item's top few
// neighbours RELATIVE to its own ranking, floored where the noise band ends. 0.45 is
// the adjudication floor the product already uses elsewhere; text-cleaning schemes
// were lab-tested first and moved nothing (title+cleaned scored 0.274 vs 0.286 raw).
export const RELATED_TOP_K = 3;
export const RELATED_FLOOR = RELATES_THRESHOLD;

// Below this similarity between a decision and new content, the content is
// considered to have drifted from the decision.
export const DRIFT_THRESHOLD = 0.5;

/**
 * ALI-831: the provenance every decision payload carries, in wire spelling, so an agent
 * reading this server can tell a claim from a rule. `ratified` is a boolean beside the
 * stamp rather than instead of it: a consumer branches on the boolean and cites the stamp.
 * A NULL column (a row from before the column existed) reads 'unknown', never a guess.
 */
function provenanceOf(row: Pick<DecisionRow, 'deciderKind' | 'ratifiedBy' | 'ratifiedAt'>) {
  return {
    decider_kind: row.deciderKind ?? 'unknown',
    ratified: row.ratifiedAt !== null,
    ...(row.ratifiedAt ? { ratified_at: row.ratifiedAt, ratified_by: row.ratifiedBy } : {}),
  };
}

export function createLocalGatewayClient(dbPath: string, clientOpts: { cwd?: string } = {}) {
  const db = createLocalDb(dbPath);

  // Memoized: every retrieval call in one command invocation (a single `align ask`, one
  // MCP tool call) runs in the same repo, so resolving it once per process is correct and
  // saves N redundant `git remote`/`git rev-parse` subprocess calls. `undefined` is "not
  // resolved yet" - distinct from the real result `null` ("not in a git repo"), which a
  // plain `??`-based cache could not tell apart from "never checked".
  let cachedCurrentRepo: string | null | undefined;
  async function getCurrentRepo(): Promise<string | null> {
    if (cachedCurrentRepo === undefined) {
      cachedCurrentRepo = await currentRepoIdentity(clientOpts);
    }
    return cachedCurrentRepo;
  }

  /**
   * Resolves a `--repo <name>` argument against what actually exists, so a user can type
   * the short repo name ("align-cli") or "owner/repo" instead of memorising the full
   * `host/owner/repo` identity. Falls through to the literal argument on no match - an
   * honest empty result (via includeUnattributed's OR, or a genuine "nothing found") beats
   * silently guessing at a typo, and this is a convenience over a security boundary.
   */
  function resolveRepoArg(arg: string): string {
    const known = db.listRepos();
    if (known.includes(arg)) return arg;
    const lower = arg.toLowerCase();
    const matches = known.filter((r) => r === lower || r.endsWith(`/${lower}`) || r.split('/').pop() === lower);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`"${arg}" matches more than one repo in your graph: ${matches.join(', ')}. Use the full name to disambiguate.`);
    }
    return arg;
  }

  /**
   * ALI-798's actual scoping rule, in one place so every retrieval caller (CLI command,
   * MCP tool) gets it uniformly rather than re-implementing it: `all` drops the filter
   * entirely; an explicit `repo` scopes to it (resolved against what is actually in the
   * graph); naming neither defaults to the CURRENT repo when one exists, and to unscoped
   * outside a git repo (nothing to scope to).
   *
   * `effectiveRepo` is what a caller shows the user ("answering from X") - null means
   * "showed everything", which is itself worth saying, not just silence.
   */
  async function resolveScope(
    scope?: { repo?: string; all?: boolean },
  ): Promise<{ dbFilter: { repo?: string; includeUnattributed?: boolean }; effectiveRepo: string | null }> {
    if (scope?.all) return { dbFilter: {}, effectiveRepo: null };
    if (scope?.repo !== undefined) {
      const repo = resolveRepoArg(scope.repo);
      return { dbFilter: { repo, includeUnattributed: true }, effectiveRepo: repo };
    }
    const current = await getCurrentRepo();
    if (current === null) return { dbFilter: {}, effectiveRepo: null };
    return { dbFilter: { repo: current, includeUnattributed: true }, effectiveRepo: current };
  }

  async function findSimilar(
    embedding: Float32Array,
    topK: number,
    threshold = 0.0,
    excludeId?: string,
    // Undefined (the default) is UNSCOPED - relationship linking (ingestOne) wants
    // candidates across every repo, so it must never pass one. Retrieval callers
    // (searchDecisions, checkAlignment) pass the resolved dbFilter from resolveScope.
    // Scoping HERE rather than after ranking is what keeps `topK` honest: filtering
    // post-rank could silently return fewer than topK whenever some of the best global
    // matches fall outside the scope.
    scopeFilter?: { repo?: string; includeUnattributed?: boolean },
  ): Promise<Array<{ decisionId: string; score: number }>> {
    const all = db.getAllEmbeddings(scopeFilter);
    return all
      .filter(e => e.decisionId !== excludeId)
      .map(e => ({ decisionId: e.decisionId, score: cosineSimilarity(embedding, e.embedding) }))
      .filter(e => e.score >= threshold)
      // ALI-218: id tiebreaker so equal-similarity candidates slice deterministically.
      // Code-unit tiebreak, not localeCompare: collation varies by machine locale,
      // and which equal-scored candidate makes the slice must not.
      .sort((a, b) => b.score - a.score || (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))
      .slice(0, topK);
  }

  // Shared ingest path: insert, embed (title + summary), link similar decisions.
  // Used by both captureDecision (single, may parse a URL) and ingestBatch.
  // Says "similar", not "conflicts": an embedding cannot tell agreement from opposition,
  // and calling this conflict detection is what ALI-503 was (see SIMILARITY_THRESHOLD).
  async function ingestOne(
    input: string,
    platform: string,
    opts: { titleOverride?: string; sourceUrlOverride?: string | null; createdAt?: string } = {},
  ): Promise<{ id: string; title: string; summary: string; sourceUrl: string | null; platform: string; related: Array<{ decisionId: string; score: number }>; created: boolean }> {
    let title = input.slice(0, 80);
    let summary = input;
    let sourceUrl: string | null = opts.sourceUrlOverride ?? null;
    let capturedAsUrl = false;
    if (opts.sourceUrlOverride === undefined) {
      try {
        const url = new URL(input);
        sourceUrl = url.href;
        title = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
        summary = `Captured from ${url.hostname}`;
        capturedAsUrl = true;
      } catch { /* plain text - use as-is */ }
    }
    if (opts.titleOverride) title = opts.titleOverride.slice(0, 80);

    // ALI-792: what the text points at, stored beside the decision. When the whole
    // input IS the URL being captured, there is nothing to point at - and comparing
    // the extracted ref against the WHATWG-normalized href leaks on every
    // normalization delta (default-port stripping, scheme case), so the URL-capture
    // branch skips extraction outright rather than filtering (review finding,
    // 2026-09-01). Batch ingest still filters the decision's own source_url so a
    // raw_text that quotes its own address is not a self-reference.
    const refs = capturedAsUrl ? [] : extractRefs(input).filter(r => r.ref !== sourceUrl);

    // ALI-798: which repo this decision belongs to. A hosted code URL (any platform, not
    // just 'git' - a GitHub PR captured by hand is still code) names its own repo directly.
    // Only a git-sourced item with NO hosted remote (a self-hosted GHES, a repo never
    // pushed) falls back to the CURRENT repo - that fallback is deliberately narrow: a
    // Jira ticket or Slack thread imported from inside a repo is not that repo's, and
    // widening the fallback to every platform would misattribute them.
    const repo = repoFromSourceUrl(sourceUrl) ?? (platform === 'git' ? await getCurrentRepo() : null);

    // BEFORE the upsert: insertDecision returns the surviving id whether it inserted or
    // refreshed, so this is the only moment the difference is visible. Without it a
    // re-import reports every decision as imported while the graph does not move, which
    // reads as having imported twice (ALI-770).
    const created = db.findIdBySource(sourceUrl, title) === null;
    // ALI-829: a Slack thread arriving under a real title replaces the tombstone-titled row
    // an older fetcher may have written for the same source_url (see local-db.ts).
    if (platform === 'slack') db.deleteSlackTombstoneTwin(sourceUrl);
    // ALI-829: the source's own date, normalised once. An unparseable date drops the FIELD,
    // never the item: the summary is the thing the user came for.
    const decidedAt = normaliseDecidedAt(opts.createdAt);
    // ALI-831: origin, from the platform - the same rule the cloud applies on insert.
    const deciderKind = deriveDeciderKind(platform);
    const id = db.insertDecision({ title, summary, sourceUrl, platform, repo, decidedAt, deciderKind });
    db.replaceRefs(id, refs);
    // ALI-796's payoff: if some earlier decision already cited THIS one (a git commit
    // citing a Jira key before Jira was ever connected), resolve that gap into a real
    // link now that the cited item has arrived. Harmless no-op for platforms with no
    // citable identity (refIdentityFor returns [] for a plain git/slack/cli capture).
    db.resolveRefs(id, refIdentityFor(platform, sourceUrl));
    // Embed title + summary so URL captures (whose summary is just "Captured
    // from <host>") still carry the path-derived title's semantic content.
    const embedText = title === summary ? summary : `${title}. ${summary}`;
    const embedding = await getEmbedding(embedText);
    db.setEmbedding(id, embedding);

    // One ranked pass, two rules united. Absolute (>= SIMILARITY_THRESHOLD, cap 10)
    // as before, PLUS the top RELATED_TOP_K overall when they clear RELATED_FLOOR -
    // the cross-tool edges live between those two lines (see RELATED_FLOOR's note).
    // If the top-K are all absolute matches the relative rule adds nothing, which is
    // the correct degenerate case rather than a special one.
    const ranked = await findSimilar(embedding, 10, 0, id);
    const candidates = ranked.filter(
      (c, i) => c.score >= SIMILARITY_THRESHOLD || (i < RELATED_TOP_K && c.score >= RELATED_FLOOR),
    );
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
      // ALI-831: provenanceOf needs the stored row, not ingestOne's return shape (which has
      // no ratifiedAt/ratifiedBy) - a fresh capture is always unratified, but reading it back
      // rather than asserting it keeps this one writer honest if that ever stops being true.
      const row = db.getDecisionById(r.id);
      return {
        id: r.id, title: r.title, summary: r.summary, sourceUrl: r.sourceUrl, platform: r.platform,
        related: r.related.map(c => c.decisionId),
        ...(row ? provenanceOf(row) : {}),
      };
    },

    async ingestBatch(items: Array<{ source_url?: string; platform?: string; raw_text: string; title?: string; created_at?: string }>) {
      const snapshots = [];
      for (const item of items) {
        const r = await ingestOne(item.raw_text, item.platform ?? 'cli', {
          titleOverride: item.title,
          sourceUrlOverride: item.source_url ?? null,
          createdAt: item.created_at,
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
        ...(row.decidedAt ? { decided_at: row.decidedAt } : {}),
        ...provenanceOf(row),
        external_references: db.getRefs(row.id),
        spaces: [] as unknown[],
      };
    },

    // ALI-602: `align context sync --env local` lists the graph without a query.
    // The db reads newest-first; the renderer re-sorts deterministically, so the
    // order here only decides WHICH rows survive the limit (newest do).
    //
    // ALI-798: `repo`/`all` mirror searchDecisions' scope resolution - naming neither
    // defaults to the current repo (+ unattributed rows) when one exists.
    async listDecisions(params: { limit?: number; repo?: string; all?: boolean; unratified?: boolean } = {}) {
      const limit = params.limit ?? 200;
      const { dbFilter } = await resolveScope({ repo: params.repo, all: params.all });
      // ALI-831: the human queue - agent-decided rows no human has ratified.
      const filter = params.unratified ? { ...dbFilter, unratified: true } : dbFilter;
      return db.listDecisions(filter).slice(0, limit).map((row) => {
        const cite = localCitationFor(row.sourceUrl);
        return {
          id: row.id,
          title: row.title,
          summary: row.summary,
          platform: row.platform,
          status: 'active',
          created_at: row.createdAt,
          // ALI-829: absent when the source did not say, so a consumer sees the shape it
          // saw before (the field's meaning is on the type in gateway-client.ts).
          ...(row.decidedAt ? { decided_at: row.decidedAt } : {}),
          ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
          ...(cite ? { cite } : {}),
          ...provenanceOf(row),
        };
      });
    },

    /**
     * ALI-831: the human act, local half. The TTY guard that makes it a HUMAN act lives in
     * the command (`align ratify`), the way the cloud's 403 lives in its use case: this
     * method trusts its caller's `ratifiedBy`. First ratification stands (markRatified is
     * guarded by `ratified_at IS NULL`), and only a real write records an audit row.
     */
    async ratifyDecision(id: string, opts: { ratifiedBy: string }) {
      const before = db.getDecisionById(id);
      if (!before) {
        throw new Error(`No decision ${id} in your local graph. \`align decisions list\` shows what is there.`);
      }
      const stamp = db.markRatified(id, opts.ratifiedBy);
      if (!stamp) {
        // Already ratified (the guard refused the write): report the standing state.
        return { alreadyRatified: true, ratifiedBy: before.ratifiedBy, ratifiedAt: before.ratifiedAt };
      }
      db.insertAudit({ decisionId: id, action: 'ratified', actor: opts.ratifiedBy });
      return { alreadyRatified: false, ratifiedBy: opts.ratifiedBy, ratifiedAt: stamp.ratifiedAt };
    },

    async searchDecisions(query: string, limit = 10, scope?: { repo?: string; all?: boolean }): Promise<SearchResults> {
      const { dbFilter, effectiveRepo } = await resolveScope(scope);
      const embedding = await getEmbedding(query);
      let similar = await findSimilar(embedding, limit, SEARCH_THRESHOLD, undefined, dbFilter);
      // A natural-language question embeds less densely than its subject does, so on a
      // small graph it can miss a decision that its own content words hit. Retry once,
      // only on an empty result, mirroring the gateway's own keyword-to-semantic
      // fallback (align-stack#1706). The raw query still goes first, so ALI-105 holds
      // and a query that already matched costs exactly one embedding.
      if (!similar.length) {
        const reduced = contentWordQuery(query);
        if (reduced) {
          similar = await findSimilar(await getEmbedding(reduced), limit, SEARCH_THRESHOLD, undefined, dbFilter);
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
          const cite = localCitationFor(row.sourceUrl);
          return {
            id: row.id,
            title: row.title,
            summary: row.summary,
            status: 'active',
            similarity: s.score,
            created_at: row.createdAt,
            ...(row.decidedAt ? { decided_at: row.decidedAt } : {}),
            platform: row.platform,
            ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
            ...(repository ? { repository } : {}),
            ...(cite ? { cite } : {}),
            // No decision_url: a local-embedded decision lives only in this machine's
            // SQLite file, so any Align URL built for it would 404 wherever it pointed.
            // Absent beats fabricated - a wrong link looks clickable.
            // ALI-796: what this decision cites, so `align ask` can name a gap.
            external_references: db.getRefs(row.id),
            ...provenanceOf(row),
          };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
      return { results, count: results.length, strategy: 'semantic', scope: effectiveRepo };
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
            ...provenanceOf(c),
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
          provenance: provenanceOf(c),
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

      const relevant_decisions = typed.map(t => ({ id: t.id, title: t.title, summary: t.summary, similarity: t.similarity, url: t.url, ...t.provenance }));
      const conflicts = typed
        .filter(t => t.relationship === 'conflicts_with' || t.relationship === 'contradicts')
        .map(t => ({
          decision_id: t.id,
          title: t.title,
          summary: t.summary,
          url: t.url,
          ...t.provenance,
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
            ? noProviderHintInline('these can be classified')
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
