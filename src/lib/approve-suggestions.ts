import type { createGatewayClient } from './gateway-client.js';

type Client = Pick<ReturnType<typeof createGatewayClient>, 'listSuggestions' | 'bulkApproveSuggestions'>;

/** The gateway's bulk-async cap on ids per request. */
const MAX_IDS_PER_REQUEST = 5000;

export type ApproveAllResult =
  | { kind: 'none'; listed: 0 }
  | { kind: 'sync'; listed: number; approved: number; errors: string[] }
  | { kind: 'async'; listed: number; jobIds: string[]; streamUrl?: string };

/**
 * Approve every pending suggestion of the given jobs (ALI-1585). Lists each job in full
 * (the client pages), de-duplicates ids, and sends them in bulk. The sync gateway answers
 * `updated` (a count), `created_decisions` (an array, though the client types it as a
 * number) and `errors` (strings for rows it skipped, e.g. already settled or not owned).
 * An unrecognised sync reply throws rather than counting as zero approved.
 */
export async function approveAllSuggestions(client: Client, jobIds: string[]): Promise<ApproveAllResult> {
  const lists = await Promise.all(jobIds.map(id => client.listSuggestions(id)));
  const ids = [...new Set(lists.flat().map(s => s.id))];
  if (ids.length === 0) return { kind: 'none', listed: 0 };

  if (ids.length > 100) {
    const asyncJobs: string[] = [];
    let streamUrl: string | undefined;
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
      const r = await client.bulkApproveSuggestions(ids.slice(i, i + MAX_IDS_PER_REQUEST));
      if (!r.async) throw new Error('unexpected synchronous reply to a bulk-async approve');
      asyncJobs.push(r.job_id);
      streamUrl ??= r.stream_url;
    }
    return { kind: 'async', listed: ids.length, jobIds: asyncJobs, streamUrl };
  }

  const result = await client.bulkApproveSuggestions(ids);
  if (result.async) throw new Error('unexpected async reply to a synchronous bulk approve');
  const raw = result as unknown as { updated?: unknown; created_decisions?: unknown; errors?: unknown };
  const approved =
    typeof raw.updated === 'number' ? raw.updated
    : Array.isArray(raw.created_decisions) ? raw.created_decisions.length
    : undefined;
  if (approved === undefined) throw new Error('unrecognised bulk approve reply: no `updated` count');
  const errors = Array.isArray(raw.errors) ? raw.errors.map(String) : [];
  return { kind: 'sync', listed: ids.length, approved, errors };
}
