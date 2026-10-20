import type { createGatewayClient } from './gateway-client.js';

type Client = Pick<ReturnType<typeof createGatewayClient>, 'listSuggestions' | 'bulkApproveSuggestions'>;

export type ApproveAllResult =
  | { kind: 'sync'; listed: number; approved: number }
  | { kind: 'async'; listed: number; jobId: string; streamUrl?: string };

/**
 * Approve every pending suggestion of the given jobs (ALI-1585). Lists each job in full
 * (the client pages), de-duplicates ids, and sends them in one bulk call. The sync gateway
 * answers `updated` (a count) and `created_decisions` (an array, though the client types it
 * as a number), so the approved count is read from whichever is a usable number.
 */
export async function approveAllSuggestions(client: Client, jobIds: string[]): Promise<ApproveAllResult> {
  const lists = await Promise.all(jobIds.map(id => client.listSuggestions(id)));
  const ids = [...new Set(lists.flat().map(s => s.id))];
  const result = await client.bulkApproveSuggestions(ids);
  if (result.async) {
    return { kind: 'async', listed: ids.length, jobId: result.job_id, streamUrl: result.stream_url };
  }
  const raw = result as unknown as { updated?: unknown; created_decisions?: unknown };
  const approved =
    typeof raw.updated === 'number' ? raw.updated
    : Array.isArray(raw.created_decisions) ? raw.created_decisions.length
    : typeof raw.created_decisions === 'number' ? raw.created_decisions
    : 0;
  return { kind: 'sync', listed: ids.length, approved };
}
