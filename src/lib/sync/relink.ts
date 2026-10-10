/**
 * L5, Decision 30: the re-link queue. Every row's `enriched_at` is NULL after the v7 upgrade (and
 * after an ingest that died mid-way), because nothing on disk tells a finished ingest from an
 * unfinished one. Each sync takes those rows, oldest first, and runs only the step each one is
 * missing: the link pass alone when the embedding is stored (no embed call), a full re-ingest when
 * it is not. After the first sync the queue is empty and this does no work.
 *
 * Local and free: no network, no LLM. It runs in the background child like the rest of the sync.
 */
import { EMBEDDING_MODEL_ID } from '../local-embeddings.js';
import type { createLocalGatewayClient } from '../local-gateway-client.js';
import { unfinishedRows } from './sync-state.js';

export interface RelinkResult { linked: number; embedded: number; skipped: number }

const BATCH = 1_000;

export async function relinkAll(
  dbPath: string,
  client: Pick<ReturnType<typeof createLocalGatewayClient>, 'relinkUnfinished'>,
  o: { deadlineAt?: number; now?: () => number; batch?: number } = {},
): Promise<RelinkResult & { timedOut: boolean }> {
  const now = o.now ?? Date.now;
  const total = { linked: 0, embedded: 0, skipped: 0, timedOut: false };
  const seen = new Set<string>();
  for (;;) {
    if (o.deadlineAt !== undefined && now() >= o.deadlineAt) { total.timedOut = true; break; }
    // Ask for enough to step over what was already handed over, or a long run of handled-but-unstamped rows
    // at the head of the queue would end it early with rows still waiting behind them.
    const rows = unfinishedRows(dbPath, EMBEDDING_MODEL_ID, (o.batch ?? BATCH) + seen.size).filter((r) => !seen.has(r.id)).slice(0, o.batch ?? BATCH);
    if (rows.length === 0) break;
    for (const r of rows) seen.add(r.id);
    const r = await client.relinkUnfinished(rows);
    total.linked += r.linked;
    total.embedded += r.embedded;
    total.skipped += r.skipped;
  }
  return total;
}
