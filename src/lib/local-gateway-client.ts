import { createLocalDb, type DecisionRow, identifyingSourceUrl, type LinkRow, normaliseDecidedAt } from './local-db.js';
import { deriveDeciderKind } from './decider-kind.js';
import { currentRepoIdentity, repoFromSourceUrl } from './repo-identity.js';
import { cosineSimilarity, EMBEDDING_MODEL_ID, getEmbedding } from './local-embeddings.js';
import { type ClassificationOutcome, classifyRelationship } from './local-relationship-classifier.js';
import { noProviderHintInline, RECOMMENDED_OLLAMA_PULL } from './local-llm.js';
import { repositoryOf } from './decision-links.js';
import { localCitationFor } from './commit-cite.js';
import { extractRefs, refIdentityFor } from './decision-refs.js';
import { contentWordQuery } from './search-query.js';
import { linkPass } from './local-link-pass.js';
import { EmbeddingMatrix, MATRIX_MAX_ROWS, type Ranker } from './similarity/embedding-matrix.js';
import { captureFieldsForUrl, type IngestOptions, type IngestResult, type IngestSession, ingestStep, type LocalBatchItem, type LocalBatchOptions } from './local-ingest.js';
// Type-only import (erased at runtime, so no cycle with gateway-client.ts): the
// local client returns the SAME shapes as the cloud client, so the CLI commands
// (ask/search/check) work identically in local mode.
import type { AlignmentResult, SearchResults } from './gateway-client.js';
import type { CheckDepth } from './check-depth.js';

import {
  DRIFT_THRESHOLD, RELATED_FLOOR, RELATED_TOP_K, RELATES_THRESHOLD, RETRIEVAL_RELATES_THRESHOLD, SEARCH_THRESHOLD,
  SIMILARITY_THRESHOLD,
} from './local-thresholds.js';

export {
  DRIFT_THRESHOLD, RELATED_FLOOR, RELATED_TOP_K, RELATES_THRESHOLD, RETRIEVAL_RELATES_THRESHOLD, SEARCH_THRESHOLD,
  SIMILARITY_THRESHOLD,
};
export { CAPTURE_CLASSIFY_TOP_K } from './local-ingest.js';

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

export function createLocalGatewayClient(dbPath: string, clientOpts: { cwd?: string; matrixMaxRows?: number } = {}) {
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
    scopeFilter?: { repo?: string; includeUnattributed?: boolean; createdBefore?: string },
  ): Promise<Array<{ decisionId: string; score: number }>> {
    // ALI-787: unconditional, not opt-in. `embedding` is always current-model (getEmbedding's
    // one production path), so a stored vector tagged with a DIFFERENT model would produce a
    // plausible, meaningless cosine score rather than an error - excluded here rather than
    // trusted, the same "degrade honestly" rule checkDrift below applies to a single decision.
    const all = db.getAllEmbeddings({ ...scopeFilter, model: EMBEDDING_MODEL_ID });
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
  /**
   * ALI-1065: the capture-time typed edges, shaped for the wire the SAME way the cloud
   * gateway spells them (align-stack ALI-1066/ALI-1092: `successor`/`conflicts_with`, as
   * `{ id, title, source_url, relation }`) - so `withDecisionRelationContract` in
   * decision-relations.ts needs no local-specific branch to carry them to an agent.
   */
  /**
   * ALI-1087 (Copilot #320): `DecisionRow.createdAt` is written only by SQLite's own
   * `datetime('now')` default - 'YYYY-MM-DD HH:MM:SS', a space, no offset - while
   * `createdBefore` is validated as an ISO-8601 instant with a 'T' and an offset/Z. On any
   * date the two share, ' ' (0x20) sorts before 'T' (0x54) regardless of the actual clock
   * time, so a plain string compare calls every decision captured LATER on the cutoff's own
   * calendar day "before" it. `getAllEmbeddings`/`listLinks` push the equivalent SQL
   * comparison through `julianday(...)`, which parses both formats correctly; this is the
   * same fix for the two JS-side comparisons below, which read an already-fetched
   * `DecisionRow` rather than issuing SQL.
   */
  function isBeforeCutoff(storedCreatedAt: string, cutoff: string): boolean {
    const normalised = storedCreatedAt.includes('T') ? storedCreatedAt : `${storedCreatedAt.replace(' ', 'T')}Z`;
    return new Date(normalised).getTime() < new Date(cutoff).getTime();
  }

  /**
   * ALI-1087: `createdBefore`, when given, bounds an as-of query - mirroring the cloud's
   * `attachSupersessionSuccessors`/`attachConflictCounterparts` (align-stack#2447). BOTH
   * halves of an edge are bounded separately, because they can differ: the edge itself may
   * have been recorded after the cutoff even though both decisions it joins predate it (a
   * relation nobody had recorded yet is not one the as-of answer may use), and the OTHER
   * decision may itself postdate the cutoff even though the edge and this decision do not
   * (a decision that did not exist yet cannot be reported as this one's conflict/successor).
   *
   * Iterates every candidate rather than stopping at the first found (Copilot #320): with
   * more than one supersession edge, `links.find(...)` returning the one whose successor
   * postdates the cutoff used to end the search there, hiding an EARLIER, genuinely valid
   * successor. Supersession candidates are tried most-recent-edge-first, matching the
   * cloud's `ORDER BY dl.created_at DESC` - the first one whose OWN counterpart also
   * predates the cutoff wins.
   */
  function relationFieldsFor(decisionId: string, createdBefore?: string): {
    status?: 'superseded' | 'conflicted';
    successor?: { id: string; title: string; source_url?: string; relation: string };
    conflicts_with?: { id: string; title: string; source_url?: string; relation: string };
  } {
    const links: LinkRow[] = db.listLinks({ decisionId, createdBefore });

    // Conflict is symmetric: either end of the edge reports it, pointing at the other end.
    const conflictCandidates = links.filter(l => l.relation === 'contradicts' || l.relation === 'conflicts_with');
    for (const conflict of conflictCandidates) {
      const otherId = conflict.sourceId === decisionId ? conflict.targetId : conflict.sourceId;
      const row = db.getDecisionById(otherId);
      if (row && (createdBefore === undefined || isBeforeCutoff(row.createdAt, createdBefore))) {
        return {
          status: 'conflicted',
          conflicts_with: {
            id: row.id,
            title: row.title,
            ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
            relation: conflict.relation,
          },
        };
      }
    }

    // Asymmetric, deliberately: THIS decision must be the TARGET (the superseded one),
    // not the source - or a decision would report itself replaced by something it superseded.
    const supersessionCandidates = links
      .filter(l => (l.relation === 'supersedes' || l.relation === 'partially_supersedes') && l.targetId === decisionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    for (const supersession of supersessionCandidates) {
      const row = db.getDecisionById(supersession.sourceId);
      if (row && (createdBefore === undefined || isBeforeCutoff(row.createdAt, createdBefore))) {
        return {
          status: 'superseded',
          successor: {
            id: row.id,
            title: row.title,
            ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
            relation: supersession.relation,
          },
        };
      }
    }
    return {};
  }

  /** What ranks a new item against the graph. Normally the in-memory matrix of every stored
   *  embedding, read from SQLite on first use and kept for the run (`session`) so N items read
   *  the table once. A kept matrix is trusted only while nothing under it moved: rowSetEpoch
   *  (this connection deleted or replaced rows, whichever code path did it) and dataVersion
   *  (ANOTHER connection committed) must both match what it was built at, else it is rebuilt.
   *  Above the row cap there is no matrix and each item streams the table, as before.
   *  Model-filtered exactly as findSimilar is: a stale-model vector must not be scored. */
  function rankerFor(session: IngestSession): Ranker {
    const epoch = db.rowSetEpoch();
    const dataVersion = db.dataVersion();
    if (session.matrix === undefined || session.epoch !== epoch || session.dataVersion !== dataVersion) {
      session.matrix = undefined;
      if (db.countEmbeddings() > (clientOpts.matrixMaxRows ?? MATRIX_MAX_ROWS)) {
        return { topK: (q, k, o) => findSimilar(q, k, o?.threshold ?? 0, o?.excludeId) };
      }
      session.matrix = EmbeddingMatrix.fromRows(db.getAllEmbeddings({ model: EMBEDDING_MODEL_ID }));
      session.epoch = epoch;
      session.dataVersion = dataVersion;
    }
    return session.matrix;
  }

  async function ingestOne(
    input: string,
    platform: string,
    opts: IngestOptions = {},
    session: IngestSession = {},
  ): Promise<IngestResult> {
    let title = input.slice(0, 80);
    let summary = input;
    let sourceUrl: string | null = opts.sourceUrlOverride ?? null;
    let capturedAsUrl = false;
    if (opts.sourceUrlOverride === undefined) {
      try {
        const url = new URL(input);
        sourceUrl = url.href;
        ({ title, summary } = captureFieldsForUrl(url));
        capturedAsUrl = true;
      } catch { /* plain text - use as-is */ }
    }
    if (opts.titleOverride) title = opts.titleOverride.slice(0, 80);
    // L2: a capture of a URL whose item a connector already imported adds nothing to it.
    const heldRow = capturedAsUrl ? db.noteCaptureOfHeldItem(sourceUrl!) : null;
    if (heldRow) return { id: heldRow.id, title: heldRow.title, summary: heldRow.summary, sourceUrl: heldRow.sourceUrl, platform: heldRow.platform, related: [], created: false, changed: false };

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
    //
    // ALI-829: a Slack thread arriving under a real title replaces the tombstone-titled row
    // an older fetcher may have written for the same source_url (see local-db.ts). Removed
    // BEFORE the lookup: L2 finds a Slack thread by its source_key, which the tombstone shares.
    //
    // One normalisation, used by both folds: the tombstone delete and insertDecision's own fold
    // already trim, and a raw url here made the two disagree about which twin they were looking at.
    const identity = identifyingSourceUrl(sourceUrl);
    if (platform === 'slack') db.deleteSlackTombstoneTwin(identity);
    if (opts.keyed) db.foldPendingTwin(identity, title, platform, true);
    const existingId = db.findIdBySource(sourceUrl, title, platform, opts.keyed);
    // L3: an items-first arrival over a complete row merges onto the stored discussion; the row stays complete.
    let pending = opts.detailPending;
    if (opts.keyed && existingId !== null) {
      const kept = db.keepProtectedText(existingId, title, summary, opts.detailPending);
      ({ title, summary } = kept);
      if (kept.keptDiscussion) pending = false;
    }
    const created = existingId === null;
    // ALI-829: the source's own date, normalised once. An unparseable date drops the FIELD,
    // never the item: the summary is the thing the user came for.
    const decidedAt = normaliseDecidedAt(opts.createdAt);

    // L1/L2: connector imports (classify:false) only - capture re-ranks every time. Only the
    // missing steps run (Decision 30): nothing for a finished row, the link pass alone for a
    // row whose ingest died after storing its embedding. Refs stay current and citations INTO
    // the row resolve either way: both are local and cheap.
    if (opts.classify === false && existingId !== null) {
      const step = ingestStep(db.getDecisionById(existingId), { title, summary, platform, repo, decidedAt },
        db.getEmbeddingModel(existingId), EMBEDDING_MODEL_ID, db.getEnrichedAt(existingId));
      const stored = step === 'full' ? null : db.getEmbedding(existingId);
      if (stored !== null) {
        db.replaceRefs(existingId, refs);
        db.resolveRefs(existingId, refIdentityFor(platform, sourceUrl));
        const related = step === 'relink' ? await linkPass(db, rankerFor(session), existingId, stored, title, summary, opts.classify) : [];
        if (step === 'relink') db.markEnriched(existingId);
        return { id: existingId, title, summary, sourceUrl, platform, related, created: false, changed: false };
      }
    }
    // Embed title + summary so URL captures (whose summary is just "Captured
    // from <host>") still carry the path-derived title's semantic content. Embedded BEFORE the
    // row is rewritten: a failed embed then leaves the row (and its enriched_at) as it was,
    // rather than new text beside the old text's vector.
    const embedText = title === summary ? summary : `${title}. ${summary}`;
    const embedding = await getEmbedding(embedText);
    // ALI-831: origin, from the platform - the same rule the cloud applies on insert.
    const deciderKind = deriveDeciderKind(platform);
    const id = db.insertDecision({ title, summary, sourceUrl, platform, repo, decidedAt, deciderKind, keyed: opts.keyed, detailPending: pending });
    db.replaceRefs(id, refs);
    // ALI-796's payoff: if some earlier decision already cited THIS one (a git commit
    // citing a Jira key before Jira was ever connected), resolve that gap into a real
    // link now that the cited item has arrived. Harmless no-op for platforms with no
    // citable identity (refIdentityFor returns [] for a plain git/slack/cli capture).
    db.resolveRefs(id, refIdentityFor(platform, sourceUrl));
    const epochBefore = db.rowSetEpoch();
    db.setEmbedding(id, embedding, EMBEDDING_MODEL_ID);
    // This run's own write: the matrix learns it by append, so the bump setEmbedding makes when
    // it REPLACES a vector is not a graph that moved under the copy. But only a matrix that was
    // current before the write may absorb it; one the insert's own fold already outdated is
    // left alone and rebuilt by rankerFor.
    if (session.matrix !== undefined && session.epoch === epochBefore) {
      session.matrix.add(id, embedding);
      session.epoch = db.rowSetEpoch();
    }
    const candidates = await linkPass(db, rankerFor(session), id, embedding, title, summary, opts.classify);
    // L2, Decision 30: the LAST write. Only now is the ingest done.
    db.markEnriched(id);
    return { id, title, summary, sourceUrl, platform, related: candidates, created, changed: true };
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

    async ingestBatch(items: LocalBatchItem[], opts: LocalBatchOptions = {}) {
      const snapshots = [];
      const session: IngestSession = {};
      for (const item of items) {
        const r = await ingestOne(item.raw_text, item.platform ?? 'cli', {
          titleOverride: item.title,
          sourceUrlOverride: item.source_url ?? null,
          createdAt: item.created_at,
          classify: opts.classify, keyed: opts.keyed, detailPending: item.detail_pending,
        }, session);
        snapshots.push({
          id: r.id,
          created: r.created,
          changed: r.changed,
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
     * L5, Decision 30: finish ingests that never finished (`enriched_at` NULL: every row after the
     * v7 upgrade, or one that died between its embedding and its link pass). Runs only the
     * missing step, the way ingestOne does for a connector re-ingest: a row that already holds a
     * current-model embedding gets the link pass alone (no embed call); one that does not is
     * re-ingested from its own stored text. A row with no URL and no embedding cannot be
     * re-ingested without inserting a twin, so it is counted and left. Never classifies.
     */
    async relinkUnfinished(rows: Array<{ id: string; keyed: boolean; pending?: boolean }>): Promise<{ linked: number; embedded: number; skipped: number }> {
      const session: IngestSession = {};
      const out = { linked: 0, embedded: 0, skipped: 0 };
      for (const { id, keyed, pending } of rows) {
        const row = db.getDecisionById(id);
        if (!row) continue;
        const stored = db.getEmbeddingModel(id) === EMBEDDING_MODEL_ID ? db.getEmbedding(id) : null;
        if (stored !== null) {
          await linkPass(db, rankerFor(session), id, stored, row.title, row.summary, false);
          db.markEnriched(id);
          out.linked += 1;
        } else if (row.sourceUrl === null) {
          out.skipped += 1;
        } else {
          await ingestOne(row.summary, row.platform, { titleOverride: row.title, sourceUrlOverride: row.sourceUrl, createdAt: row.decidedAt ?? undefined, classify: false, keyed,
            // The stored flag, passed through: a re-ingest that says nothing resets a row still waiting for its discussion.
            detailPending: pending === true }, session);
          out.embedded += 1;
        }
      }
      return out;
    },

    /**
     * ALI-808: the confirm-each session importer's one write path. Ingests exactly like
     * ingestBatch does above (same ingestOne, so platform 'agent-session' derives
     * decider_kind 'agent' for free via deriveDeciderKind - see decider-kind.ts) then stamps
     * confirmed_by/confirmed_at via local-db.ts's markConfirmed, the column ALI-831 reserved
     * for this. Not exposed through ingestBatch/captureDecision: those exist for every other
     * platform and stay untouched; this is a new, narrow path with its own name so a caller
     * cannot reach it by accident with the wrong platform string.
     */
    async confirmSessionDecision(
      item: { source_url: string; raw_text: string; title: string; created_at?: string },
      confirmedBy: string,
    ): Promise<{ id: string; title: string; confirmedBy: string; confirmedAt: string }> {
      const r = await ingestOne(item.raw_text, 'agent-session', {
        titleOverride: item.title,
        sourceUrlOverride: item.source_url,
        createdAt: item.created_at,
      });
      const stamp = db.markConfirmed(r.id, confirmedBy);
      // ingestOne just inserted this exact row, so a missing id here would mean insertDecision
      // itself is broken - not a real caller-facing case, but fail loudly rather than return
      // a stamp that lies about who confirmed what.
      if (!stamp) throw new Error(`markConfirmed found no row for the decision it just inserted (${r.id})`);
      return { id: r.id, title: r.title, confirmedBy, confirmedAt: stamp.confirmedAt };
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
    async listDecisions(
      params: { limit?: number; repo?: string; all?: boolean; unratified?: boolean; status?: string } = {},
    ) {
      const limit = params.limit ?? 200;
      const { dbFilter } = await resolveScope({ repo: params.repo, all: params.all });
      // ALI-831: the human queue - agent-decided rows no human has ratified.
      const filter = params.unratified ? { ...dbFilter, unratified: true } : dbFilter;
      // Filter AFTER shaping (relationFieldsFor needs the row's own id) and slice LAST, so
      // `status: 'active'` excludes superseded rows rather than truncating before they are
      // even checked - `align context sync` relies on this to stop leaking superseded
      // decisions into .align/decisions.md (ALI-1065).
      return db
        .listDecisions(filter)
        .map((row) => {
          const cite = localCitationFor(row.sourceUrl);
          return {
            id: row.id,
            title: row.title,
            summary: row.summary,
            platform: row.platform,
            created_at: row.createdAt,
            // ALI-829: absent when the source did not say, so a consumer sees the shape it
            // saw before (the field's meaning is on the type in gateway-client.ts).
            ...(row.decidedAt ? { decided_at: row.decidedAt } : {}),
            ...(row.sourceUrl ? { source_url: row.sourceUrl } : {}),
            ...(cite ? { cite } : {}),
            ...provenanceOf(row),
            ...relationFieldsFor(row.id),
          };
        })
        .filter((d) => params.status !== 'active' || d.status !== 'superseded')
        .slice(0, limit);
    },

    /**
     * ALI-831: the human act, local half. The TTY guard that makes it a HUMAN act lives in
     * the command (`align ratify`), the way the cloud's 403 lives in its use case: this
     * method trusts its caller's `ratifiedBy` and enforces nothing about who is calling.
     * `commands/ratify.ts` is the only caller allowed to reach this - any future caller
     * (a new MCP tool, a script) that calls it directly inherits none of the human-only
     * guarantee, so route a new caller through the command, not around it.
     * First ratification stands (markRatified is guarded by `ratified_at IS NULL`), and
     * only a real write records an audit row.
     */
    async ratifyDecision(id: string, opts: { ratifiedBy: string }) {
      // Attempt the write FIRST rather than reading the row to decide what to do - a
      // pre-write read is a snapshot that can go stale between the read and the guarded
      // UPDATE below (two `align ratify` processes racing the same on-disk file). Reading
      // ONLY on the failure path, after the write has already been attempted, means the
      // "already ratified" response reflects whatever committed by the time OUR write was
      // evaluated - never an earlier moment (Copilot review, #253).
      const stamp = db.markRatified(id, opts.ratifiedBy);
      if (stamp) {
        db.insertAudit({ decisionId: id, action: 'ratified', actor: opts.ratifiedBy });
        return { alreadyRatified: false, ratifiedBy: opts.ratifiedBy, ratifiedAt: stamp.ratifiedAt };
      }
      // The guarded write matched no row: either the id does not exist, or it is already
      // ratified. A fresh read tells the two apart and, in the ratified case, is the
      // CURRENT stamp rather than a value read before this call started.
      const row = db.getDecisionById(id);
      if (!row) {
        throw new Error(`No decision ${id} in your local graph. \`align decisions list\` shows what is there.`);
      }
      return { alreadyRatified: true, ratifiedBy: row.ratifiedBy, ratifiedAt: row.ratifiedAt };
    },

    /**
     * ALI-1087: `createdBefore`, when given, bounds this query to what the local graph knew
     * as of that instant - the same guarantee `validateCreatedBeforeFlag` now offers instead
     * of refusing local-embedded mode outright. `resolveScope`'s `dbFilter` handles repo
     * scoping; `createdBefore` rides alongside it into `findSimilar` (which excludes any
     * candidate decision whose own `created_at` is at or after the cutoff, via
     * `getAllEmbeddings`) and into `relationFieldsFor` (which separately bounds the LINK and
     * the counterpart decision - see its own doc comment for why both are needed).
     */
    async searchDecisions(
      query: string,
      limit = 10,
      createdBefore?: string,
      scope?: { repo?: string; all?: boolean },
    ): Promise<SearchResults> {
      const { dbFilter, effectiveRepo } = await resolveScope(scope);
      const boundedFilter = { ...dbFilter, createdBefore };
      const embedding = await getEmbedding(query);
      let similar = await findSimilar(embedding, limit, SEARCH_THRESHOLD, undefined, boundedFilter);
      // A natural-language question embeds less densely than its subject does, so on a
      // small graph it can miss a decision that its own content words hit. Retry once,
      // only on an empty result, mirroring the gateway's own keyword-to-semantic
      // fallback (align-stack#1706). The raw query still goes first, so ALI-105 holds
      // and a query that already matched costs exactly one embedding.
      if (!similar.length) {
        const reduced = contentWordQuery(query);
        if (reduced) {
          similar = await findSimilar(await getEmbedding(reduced), limit, SEARCH_THRESHOLD, undefined, boundedFilter);
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
            ...relationFieldsFor(row.id, createdBefore),
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
      // ALI-845: the classifier's own buildUserPrompt is now budget-derived (local-relationship-
      // classifier.ts), so capping the subject at a literal here would be a second writer of the
      // same fact, at a number unrelated to any window. Send the diff uncut.
      const subject = { title: opts.title ?? 'Proposed change', summary: diff };
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

    // `_createdBefore` matches the cloud signature. A local drift check is a pure read and stores
    // no row, so the cutoff has nothing to suppress here (ALI-1438).
    async checkDrift(decisionId: string, content: string, _sourceType?: string, _createdBefore?: string) {
      const decisionEmbedding = db.getEmbedding(decisionId);
      if (!decisionEmbedding) return { decisionId, score: null, drifted: null, note: 'Decision not found or not yet embedded.' };
      // ALI-787: a stored vector tagged with a DIFFERENT model is not comparable to a
      // freshly-embedded one - same length, incompatible space, and cosineSimilarity's
      // length check cannot see that. A null/untagged model (a row from before tagging
      // existed, that the migration somehow missed) is not treated as a mismatch: it is
      // the same "unknown, so compare anyway" default the rest of this file uses for
      // absent provenance, and it is what the pre-ALI-787 tests for this path assume.
      const storedModel = db.getEmbeddingModel(decisionId);
      if (storedModel !== null && storedModel !== EMBEDDING_MODEL_ID) {
        return {
          decisionId, score: null, drifted: null,
          // Names both models (Copilot review, #273): the old one names what has to be
          // re-run, the current one lets a user confirm re-import actually landed rather
          // than guessing whether the graph moved on since this note was printed.
          note: `This decision was embedded with ${storedModel}, not the current model (${EMBEDDING_MODEL_ID}). Re-import it (or run \`align local reset\` and re-import everything) before comparing.`,
        };
      }
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
