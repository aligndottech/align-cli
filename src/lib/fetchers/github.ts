import { GitHubFetcher } from '@aligndottech/connector-core';
import { type CaptureFetchResult, withCaptureReport } from './capture.js';
import { currentRepoIdentity } from '../repo-identity.js';

/** Read-only personal GitHub import (canonical fetcher in connector-core). `repo`
 *  (`owner/repo`) narrows the search to one repo - connector-core >= 0.7.0 (ALI-917);
 *  omitted, every repo the token can see, unchanged from before that version. */
export async function fetchGitHubItems(opts: { token: string; limit?: number; repo?: string }): Promise<CaptureFetchResult> {
  return withCaptureReport(opts, new GitHubFetcher());
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
