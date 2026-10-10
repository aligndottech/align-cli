import { fetchGitHubDiscussion, GitHubFetcher } from '@aligndottech/connector-core';
import { GITHUB_DISCUSSION_BUDGET, SYNC_TIME_BUDGET_MS } from '../import-defaults.js';
import { type CaptureFetchResult, type CaptureSkip, type WindowedOpts, withCaptureReport } from './capture.js';
import type { FetcherItem } from '@aligndottech/connector-core';
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
  const startedAt = Date.now();
  const { discussionBudget = GITHUB_DISCUSSION_BUDGET, ...rest } = opts;
  const first = await withCaptureReport({ ...rest, discussion: 'none' as const }, new GitHubFetcher());
  // Said only when the SDK actually read team scope (it ignores `scope: 'team'` without a repo).
  const scopeNote = first.report.scope === 'team' && opts.repo !== undefined
    ? { scopeNote: `everyone's PRs and issues in ${opts.repo}, as far as your token can see` }
    : {};
  const pending = first.items.filter((i) => i.detail_pending === true);
  if (pending.length === 0) return { items: first.items, report: { ...first.report, ...scopeNote } };

  const drain = await drainDiscussion(pending, {
    token: opts.token,
    budget: discussionBudget,
    // What is left of the time budget once the list is read, never under 30 s.
    deadlineMs: Math.max(30_000, (opts.timeBudgetMs ?? SYNC_TIME_BUDGET_MS) - (Date.now() - startedAt)),
  });
  const enriched = new Map(drain.items.map((i) => [i.source_url, i]));
  return {
    items: first.items.map((i) => enriched.get(i.source_url) ?? i),
    report: {
      ...first.report,
      ...scopeNote,
      skips: [...first.report.skips, ...drain.skips],
      discussionTotal: pending.length,
      discussionPending: pending.length - enriched.size,
    },
  };
}

/**
 * The discussion pass, in chunks, because the SDK's drain takes no deadline or cancel and keeps
 * going after a refusal. One item first as a probe, then ten at a time, newest first (the SDK
 * orders only within what it is given). It stops, leaving the rest pending, when: the request
 * budget is spent; the time allowed has run out (checked between chunks); or a chunk made NO
 * progress and reported a failure - that is GitHub refusing or rate-limiting (a revoked token,
 * a 403 with no quota left, a 429), so a dead token costs about one request, not the whole budget.
 * It never sleeps on a Retry-After: stopping is the honest answer for a one-shot import.
 */
async function drainDiscussion(
  pending: FetcherItem[],
  o: { token: string; budget: number; deadlineMs: number },
): Promise<{ items: FetcherItem[]; skips: CaptureSkip[] }> {
  const byNewest = [...pending].sort((a, b) => ((a.updated_at ?? '') < (b.updated_at ?? '') ? 1 : (a.updated_at ?? '') > (b.updated_at ?? '') ? -1 : 0));
  const started = Date.now();
  const items: FetcherItem[] = [];
  const skips: CaptureSkip[] = [];
  let remaining = o.budget;
  let failedItems = 0;
  let failedDetail: string | undefined;
  let stop: 'budget' | 'time' | 'refused' | undefined;
  for (let at = 0; at < byNewest.length;) {
    if (remaining <= 0) { stop = 'budget'; break; }
    if (Date.now() - started >= o.deadlineMs) { stop = 'time'; break; }
    const chunk = byNewest.slice(at, at + (at === 0 ? 1 : 10));
    let r: Awaited<ReturnType<typeof fetchGitHubDiscussion>>;
    try {
      r = await fetchGitHubDiscussion(chunk, { token: o.token, maxRequests: remaining });
    } catch {
      failedItems += byNewest.length - at;
      failedDetail = 'items whose discussion could not be read (GitHub did not answer); they stay thin';
      stop = 'refused';
      break;
    }
    items.push(...r.items);
    remaining -= r.requests;
    at += chunk.length;
    const errors = r.skips.filter((k) => k.kind === 'error');
    for (const k of errors) { failedItems += k.count; failedDetail ??= k.detail; }
    // A chunk that read nothing and failed is a refusal; one that read nothing for want of budget is the budget.
    if (r.items.length === 0 && errors.length > 0) { stop = 'refused'; break; }
    if (r.items.length === 0) { stop = 'budget'; break; }
  }
  const unreached = pending.length - items.length;
  if (failedItems > 0 && stop !== 'refused') skips.push({ kind: 'error', count: failedItems, detail: failedDetail ?? 'items whose discussion GitHub failed to return; they stay thin' });
  if (stop === 'refused') {
    skips.push({ kind: 'error', count: unreached, detail: `discussion stopped after GitHub refused or rate-limited a request (a revoked token, or no quota left); ${unreached} items stay thin${failedDetail && failedItems !== unreached ? `: ${failedDetail}` : ''}` });
  } else if (stop === 'time') {
    skips.push({ kind: 'time_budget', count: unreached, detail: `discussion stopped when its ${Math.round(o.deadlineMs / 1000)} s time budget ran out; ${unreached} items stay thin` });
  } else if (unreached > 0) {
    skips.push({ kind: 'page_cap', count: unreached, detail: `items whose discussion was not read: the request budget of ${o.budget} ran out` });
  }
  return { items, skips };
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
