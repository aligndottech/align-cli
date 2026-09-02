import { GitFetcher } from '@aligndottech/connector-core';
import { getCommitHistoryDetailed, getRemoteUrl } from '../git.js';
import type { CaptureSkip } from '../capture-report.js';
import type { CaptureFetchResult } from './capture.js';

/**
 * ALI-827: git's two drop reasons, kept apart. A commit whose SUBJECT is mechanical
 * (chore/wip/merge/bump, or too short - isDecisionCommit) never reaches the rationale
 * gate at all, so folding it into "stated no reason" overstates what that gate did
 * (Copilot review, PR #223). `scanned - kept - rejectedByRationale` is exactly the
 * subject-shape count, because getCommitHistoryDetailed counts every scanned commit into
 * one of those three buckets and nothing else. One writer for both `align setup` and
 * `align import git`.
 */
export function gitCaptureSkips(counts: { scanned: number; kept: number; rejectedByRationale: number }): CaptureSkip[] {
  const mechanical = counts.scanned - counts.kept - counts.rejectedByRationale;
  return [
    ...(counts.rejectedByRationale > 0
      ? [{ count: counts.rejectedByRationale, detail: 'commits stated no reason beyond the subject' }]
      : []),
    ...(mechanical > 0
      ? [{ count: mechanical, detail: 'commits with a mechanical subject (chore, wip, merge, bump, or too short)' }]
      : []),
  ];
}

/** Read-only local-git import. The canonical GitFetcher in connector-core is
 *  pure; the CLI injects the actual git I/O (log/remote) here. */
export async function fetchGitItems(opts: { limit: number }): Promise<CaptureFetchResult> {
  // Read ONCE and hand the commits to the pure GitFetcher, rather than letting it call
  // git again: two reads of a moving history are two different answers, and the scanned
  // and rejected counts have to describe the same read the items came from.
  const { commits, scanned, rejectedByRationale } = await getCommitHistoryDetailed({ limit: opts.limit });
  const items = await new GitFetcher({ getCommitHistory: async () => commits, getRemoteUrl })
    .fetch({ token: '', limit: opts.limit });
  return {
    items,
    report: {
      scanned,
      requested: opts.limit,
      skips: gitCaptureSkips({ scanned, kept: commits.length, rejectedByRationale }),
    },
  };
}
