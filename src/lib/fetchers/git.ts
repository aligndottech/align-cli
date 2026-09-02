import { GitFetcher } from '@aligndottech/connector-core';
import { getCommitHistoryDetailed, getRemoteUrl } from '../git.js';
import { MECHANICAL_SUBJECT_PREFIXES } from '../commit-shape.js';
import type { CaptureFetchReport, CaptureFetchResult, CaptureSkip } from './capture.js';

/**
 * ALI-827: git's two drop reasons, kept apart. A commit whose SUBJECT is mechanical
 * (isDecisionCommit: a prefix from MECHANICAL_SUBJECT_PREFIXES, or too short) never
 * reaches the rationale gate at all, so folding it into "stated no reason" overstates
 * what that gate did (Copilot review, PR #223). `scanned - kept - rejectedByRationale`
 * is exactly the subject-shape count, because getCommitHistoryDetailed counts every
 * scanned commit into one of those three buckets and nothing else.
 */
export function gitCaptureSkips(counts: { scanned: number; kept: number; rejectedByRationale: number }): CaptureSkip[] {
  const mechanical = counts.scanned - counts.kept - counts.rejectedByRationale;
  return [
    ...(counts.rejectedByRationale > 0
      ? [{ count: counts.rejectedByRationale, detail: 'commits stated no reason beyond the subject' }]
      : []),
    ...(mechanical > 0
      ? [{
          count: mechanical,
          // The list is the one the predicate is built from, so the line cannot name a
          // different set than the one that did the rejecting.
          detail: `commits with a mechanical or too-short subject (${MECHANICAL_SUBJECT_PREFIXES.join(', ')})`,
        }]
      : []),
  ];
}

/**
 * The whole git report, one writer for `align setup` and `align import git`. `--limit`
 * bounds what `git log` SCANS, not what comes back, so the cap is echoed only when the
 * scan reached it: on a 40-commit repo "12 commits of up to 500 requested" would be
 * printed on every run and says nothing, while on a 2,000-commit repo it is the one
 * line that tells the user a bigger --limit reaches further back.
 */
export function gitCaptureReport(counts: {
  scanned: number; kept: number; rejectedByRationale: number; limit: number;
}): CaptureFetchReport {
  return {
    scanned: counts.scanned,
    ...(counts.scanned >= counts.limit ? { requested: counts.limit } : {}),
    skips: gitCaptureSkips(counts),
  };
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
    report: gitCaptureReport({ scanned, kept: commits.length, rejectedByRationale, limit: opts.limit }),
  };
}
