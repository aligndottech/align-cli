import { fetchGitHubDiscussion, GitHubFetcher } from '@aligndottech/connector-core';
import { GITHUB_DISCUSSION_BUDGET } from '../import-defaults.js';
import { type CaptureFetchResult, type WindowedOpts, withCaptureReport } from './capture.js';
import { currentRepoIdentity } from '../repo-identity.js';

/**
 * Read-only personal GitHub import (canonical fetcher in connector-core). `repo` (`owner/repo`)
 * narrows the search to one repo - connector-core >= 0.7.0 (ALI-917); omitted, every repo the
 * token can see, unchanged from before that version.
 *
 * L3: the list is read ITEMS FIRST (`discussion: 'none'`, about 4 search calls per 300 items),
 * then the SDK's own `fetchGitHubDiscussion` reads comments and reviews INLINE, newest first,
 * until `discussionBudget` core requests are spent (GITHUB_DISCUSSION_BUDGET by default). Items
 * the budget did not reach stay `detail_pending` and thin; the report says how many got their
 * discussion. Nothing here promises a later drain - none exists until `align sync` (L5).
 */
export async function fetchGitHubItems(opts: {
  token: string; limit?: number; repo?: string;
  scope?: 'yours' | 'team';
  discussionBudget?: number;
} & WindowedOpts): Promise<CaptureFetchResult> {
  const { discussionBudget = GITHUB_DISCUSSION_BUDGET, ...rest } = opts;
  const first = await withCaptureReport({ ...rest, discussion: 'none' as const }, new GitHubFetcher());
  const pending = first.items.filter((i) => i.detail_pending === true);
  if (pending.length === 0) return first;

  let drained: Awaited<ReturnType<typeof fetchGitHubDiscussion>> = { items: [], skips: [], requests: 0 };
  let failure: { kind: 'error'; count: number; detail: string } | undefined;
  try {
    drained = await fetchGitHubDiscussion(pending, { token: opts.token, maxRequests: discussionBudget });
  } catch {
    failure = { kind: 'error', count: pending.length, detail: 'items whose discussion could not be read (GitHub did not answer); they stay thin' };
  }
  const enriched = new Map(drained.items.map((i) => [i.source_url, i]));
  return {
    items: first.items.map((i) => enriched.get(i.source_url) ?? i),
    report: {
      ...first.report,
      skips: [...first.report.skips, ...drained.skips, ...(failure ? [failure] : [])],
      discussionTotal: pending.length,
      discussionPending: pending.length - enriched.size,
    },
  };
}

const GITHUB_HOST_PREFIX = 'github.com/';

/**
 * ALI-917: which repo to scope GitHub's search to, if any, given CLI overrides that may
 * not exist at every call site - `align setup`'s interactive GitHub source has neither
 * flag, so it calls this with `{}` and gets the same auto-detect `import github` does.
 *
 * `--all` (unscoped - every repo the token can see, this fetcher's only behavior before
 * this ticket) wins outright; `--repo` names one explicitly; otherwise auto-detect from
 * the git remote, and only when that remote is itself a github.com repo -
 * `currentRepoIdentity()` also resolves gitlab.com remotes and bare local paths, neither
 * of which GitHub's `repo:` qualifier can use.
 *
 * Returns `undefined` for "no scope opinion", not an empty string - every caller must be
 * able to OMIT the key entirely for connector-core's default (every repo) to apply,
 * exactly as if this option did not exist yet.
 */
export async function resolveGitHubRepoScope(opts: { repo?: string; all?: boolean }): Promise<string | undefined> {
  if (opts.all) return undefined;
  if (opts.repo) return opts.repo;
  const identity = await currentRepoIdentity();
  return identity?.startsWith(GITHUB_HOST_PREFIX) ? identity.slice(GITHUB_HOST_PREFIX.length) : undefined;
}
