/**
 * L5, Decision 27: the GitHub discussion drain. The first import reads items only (title, body,
 * author, dates); their comments and reviews are read here, for the rows `detail_pending` marks,
 * newest first, under a per-run request budget (GITHUB_DISCUSSION_BUDGET).
 *
 * Reuses the L3 drain (`drainDiscussion` in fetchers/github.ts: the chunking, the refusal and
 * time-budget stops) rather than a second copy. What is new is only the source of the items: the
 * stored rows, rebuilt as the SDK's own `FetcherItem` shape. The stored `summary` IS the item's
 * raw_text (ingestOne stores `summary = raw_text`), which is what the SDK appends the discussion to.
 * An enriched item is re-ingested through the same path as any import, so its changed text
 * re-embeds and re-links; then, and only for the rows it enriched, the flag is cleared. A row the
 * budget did not reach stays pending for the next run; Review addendum 4: a pending item is a
 * whole item awaiting its discussion, never an incomplete one.
 */
import type { FetcherItem } from '@aligndottech/connector-core';
import { GITHUB_DISCUSSION_BUDGET, SYNC_TIME_BUDGET_MS } from '../import-defaults.js';
import type { CaptureSkip } from '../fetchers/capture.js';
import { drainDiscussion } from '../fetchers/github.js';
import type { createLocalGatewayClient } from '../local-gateway-client.js';
import { clearDetailPending, pendingRows } from './sync-state.js';

export interface DrainResult { enriched: number; remaining: number; skips: CaptureSkip[] }

export interface DrainDeps {
  /** Seam for tests: the chunked SDK drain. */
  drain?: typeof drainDiscussion;
  budget?: number;
  deadlineMs?: number;
}

export async function drainGitHub(
  dbPath: string,
  client: Pick<ReturnType<typeof createLocalGatewayClient>, 'ingestBatch'>,
  token: string,
  deps: DrainDeps = {},
): Promise<DrainResult> {
  const rows = pendingRows(dbPath, 'github');
  if (rows.length === 0) return { enriched: 0, remaining: 0, skips: [] };
  const byUrl = new Map(rows.map((r) => [r.source_url, r]));
  const items: FetcherItem[] = rows.map((r) => ({
    source_url: r.source_url, platform: 'github', raw_text: r.summary, title: r.title,
    ...(r.decided_at !== null ? { created_at: r.decided_at, updated_at: r.decided_at } : {}),
    detail_pending: true,
  }));
  const run = deps.drain ?? drainDiscussion;
  const { items: done, skips } = await run(items, {
    token, budget: deps.budget ?? GITHUB_DISCUSSION_BUDGET, deadlineMs: deps.deadlineMs ?? SYNC_TIME_BUDGET_MS,
  });
  const enriched = done.filter((i) => byUrl.has(i.source_url));
  if (enriched.length > 0) {
    const { snapshots } = await client.ingestBatch(enriched.map((i) => {
      const stored = byUrl.get(i.source_url)!;
      return {
        source_url: i.source_url, platform: 'github', title: stored.title, raw_text: i.raw_text,
        ...(stored.decided_at !== null ? { created_at: stored.decided_at } : {}), detail_pending: false,
      };
    }), { classify: false, keyed: true });
    // An attested row keeps its text (the new text is recorded for review), so its flag would
    // stay set and the row would be read again every run. Its discussion HAS been read.
    clearDetailPending(dbPath, snapshots.map((s) => s.id));
  }
  return { enriched: enriched.length, remaining: rows.length - enriched.length, skips };
}
