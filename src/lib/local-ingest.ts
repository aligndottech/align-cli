/**
 * The local ingest decisions that do not need the database or the network: whether a
 * re-ingested item would change anything, and which similar decisions to send to the paid
 * classifier. local-gateway-client.ts's ingestOne owns the I/O and calls these.
 */
import type { DecisionRow } from './local-db.js';
import type { EmbeddingMatrix } from './similarity/embedding-matrix.js';

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
  /** L2: the call is a connector import, so a one-item-per-URL item gets a source_key.
   *  Omitted (capture, MCP align_capture, sessions) never keys, whatever the platform. */
  keyed?: boolean;
}

/** State shared by the ingests of ONE run (ingestBatch). `matrix` is the graph's embeddings,
 *  loaded on first use. Absent for a single capture, which then loads its own. */
export interface IngestSession {
  matrix?: EmbeddingMatrix;
  /** db.rowSetEpoch() and db.dataVersion() when `matrix` was built (or last brought current by
   *  this run's own write). Either one moving means the graph changed under the copy. */
  epoch?: number;
  dataVersion?: number;
}

export interface LocalBatchItem {
  source_url?: string; platform?: string; raw_text: string; title?: string; created_at?: string;
}

/** `classify`: see IngestOptions. `deferEnrichment` is the cloud gateway's option and is
 *  accepted only so one call site serves both clients; local ingest ignores it. */
export interface LocalBatchOptions { classify?: boolean; deferEnrichment?: boolean; keyed?: boolean }

/** What `align capture <url>` stores for a URL: the last path segment (or host) as the title and
 *  "Captured from <host>" as the summary. One writer, read by the v7 migration to recognise
 *  rows that are captures and not connector imports. */
export function captureFieldsForUrl(url: URL): { title: string; summary: string } {
  return { title: url.pathname.split('/').filter(Boolean).pop() ?? url.hostname, summary: `Captured from ${url.hostname}` };
}

/** True when a stored row has the exact shape `captureFieldsForUrl` writes. */
export function isCaptureShaped(row: { title: string; summary: string; source_url: string | null }): boolean {
  if (row.source_url === null) return false;
  let url: URL;
  try { url = new URL(row.source_url); } catch { return false; }
  const f = captureFieldsForUrl(url);
  // The title alone is not a signal: a Linear/Jira/GitHub import can be titled by the same
  // segment (ENG-12). It counts only for a row with no summary at all.
  return row.summary === f.summary || (row.summary === '' && row.title === f.title.slice(0, 80));
}

export interface IngestResult {
  id: string; title: string; summary: string; sourceUrl: string | null; platform: string;
  related: Array<{ decisionId: string; score: number }>; created: boolean; changed: boolean;
}

type StoredForSkip = Pick<DecisionRow, 'title' | 'summary' | 'platform' | 'repo' | 'decidedAt'>;
type NextForSkip = { title: string; summary: string; platform: string; repo: string | null; decidedAt: string | null };

/**
 * L1: would the upsert write nothing new? Same title (L2: a source_key upsert retitles the
 * row, so a new title is a change), same summary (the column holds exactly what
 * insertDecision stores, so no hash column is needed), same platform, and no repo or date the
 * row lacks or holds differently.
 */
export function contentUnchanged(stored: StoredForSkip | null, next: NextForSkip): boolean {
  return stored !== null
    && stored.title === next.title
    && stored.summary === next.summary
    && stored.platform === next.platform
    && (next.repo === null || stored.repo === next.repo)
    && (next.decidedAt === null || stored.decidedAt === next.decidedAt);
}

/**
 * L1 unchanged-skip, tightened by L2 (Decision 30). A sync window overlaps the last run, so
 * known items arrive again, and re-embedding and re-linking each one is the whole cost of a
 * refresh. True only when the content is unchanged, the embedding is from the current model,
 * AND `enriched_at` is set - the marker ingestOne writes after its link pass. Without that
 * last condition an ingest that died between storing the embedding and writing the links
 * would be called unchanged forever, and its links never written.
 */
export function isUnchanged(
  stored: StoredForSkip | null,
  next: NextForSkip,
  storedModel: string | null,
  currentModel: string,
  enrichedAt: string | null,
): boolean {
  return ingestStep(stored, next, storedModel, currentModel, enrichedAt) === 'skip';
}

/**
 * What a connector re-ingest of a known row still has to do (Decision 30: only the missing
 * steps). 'skip': nothing. 'relink': the text and a current-model embedding are stored, only
 * the link pass is missing. 'full': anything else - a change, a missing or retired embedding.
 */
export function ingestStep(
  stored: StoredForSkip | null,
  next: NextForSkip,
  storedModel: string | null,
  currentModel: string,
  enrichedAt: string | null,
): 'skip' | 'relink' | 'full' {
  if (!contentUnchanged(stored, next) || storedModel !== currentModel) return 'full';
  return enrichedAt === null ? 'relink' : 'skip';
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
