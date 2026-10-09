/**
 * The local ingest decisions that do not need the database or the network: whether a
 * re-ingested item would change anything, and which similar decisions to send to the paid
 * classifier. local-gateway-client.ts's ingestOne owns the I/O and calls these.
 */
import type { DecisionRow } from './local-db.js';

/**
 * ALI-1065: the capture-time classification budget. Only the high-confidence tier
 * (score >= SIMILARITY_THRESHOLD) is ever classified - the lower related-only tier stays
 * a plain cosine `relates` edge, because typing a merely-related pair is exactly the
 * manufactured-detection failure ALI-503 removed from the conflict counters.
 *
 * Capped at 3 regardless of how many candidates clear the high-confidence bar, and skipped
 * entirely (0 calls) with no provider configured - see ingestOne. Worst case: 3 classifier
 * calls per capture, each a single LLM round trip. Typical capture (0-1 near-duplicates)
 * costs 0-1 calls.
 */
export const CAPTURE_CLASSIFY_TOP_K = 3;

export interface IngestOptions {
  titleOverride?: string;
  sourceUrlOverride?: string | null;
  createdAt?: string;
  /** L1: false skips the capture-time classifier even with a provider key set, so a
   *  connector import or background sync never spends the user's money. Omitted keeps
   *  today's behaviour (classify when a provider is configured), which explicit human
   *  capture relies on. */
  classify?: boolean;
}

export interface LocalBatchItem {
  source_url?: string; platform?: string; raw_text: string; title?: string; created_at?: string;
}

/** `classify`: see IngestOptions. `deferEnrichment` is the cloud gateway's option and is
 *  accepted only so one call site serves both clients; local ingest ignores it. */
export interface LocalBatchOptions { classify?: boolean; deferEnrichment?: boolean }

export interface IngestResult {
  id: string; title: string; summary: string; sourceUrl: string | null; platform: string;
  related: Array<{ decisionId: string; score: number }>; created: boolean; changed: boolean;
}

/**
 * L1: unchanged-skip. A sync window overlaps the last run, so known items arrive again,
 * and re-embedding and re-linking each one is the whole cost of a refresh. True only when
 * the upsert would write nothing new: same summary (the column holds exactly what
 * insertDecision stores, so no hash column is needed), same platform, no repo or date the
 * row lacks or holds differently, and an embedding from the current model. Anything else
 * falls through to the full path, so a late-arriving date or a model swap still lands.
 */
export function isUnchanged(
  stored: Pick<DecisionRow, 'summary' | 'platform' | 'repo' | 'decidedAt'> | null,
  next: { summary: string; platform: string; repo: string | null; decidedAt: string | null },
  storedModel: string | null,
  currentModel: string,
): boolean {
  return stored !== null
    && stored.summary === next.summary
    && stored.platform === next.platform
    && (next.repo === null || stored.repo === next.repo)
    && (next.decidedAt === null || stored.decidedAt === next.decidedAt)
    && storedModel === currentModel;
}

/**
 * ALI-1065: classify only the high-confidence tier, capped, and only with a provider
 * configured - hasConfiguredProvider is an env-only check, so this costs nothing when
 * no key exists (the common case for a fresh clone). L1: `classify: false` returns none
 * before the provider is even consulted.
 */
export function selectForClassification<C extends { score: number }>(
  candidates: C[],
  opts: { classify?: boolean; threshold: number; hasProvider: () => boolean },
): C[] {
  return opts.classify !== false && opts.hasProvider()
    ? candidates.filter(c => c.score >= opts.threshold).slice(0, CAPTURE_CLASSIFY_TOP_K)
    : [];
}
