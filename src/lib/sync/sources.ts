/**
 * L5: how a sync reads one source. The connectors that `align connect` already knows how to read
 * keep their one definition in setup.ts (`buildSources`): this file only adds the two things a
 * sync needs that connect does not, a scope key per source and GitHub's items-only list read.
 * Imported only by the sync command (it pulls setup.ts in); the MCP server never loads it.
 */
import type { CaptureFetchResult } from '../fetchers/capture.js';
import { fetchGitHubItemsOnly, resolveGitHubRepoScope } from '../fetchers/github.js';
import { fetchWindow, windowExtras } from '../since.js';

export interface SyncScope {
  scopeKey: string;
  scope: 'yours' | 'team';
  /** GitHub only: the repo a team-scope read is narrowed to. */
  repo?: string;
}

/** The scope this machine reads a source under, decided before the fetch so its watermark can be found.
 *  GitHub inside a repo reads everyone's items in it (Decision 7), exactly as `align connect` does;
 *  everywhere else it is the caller's own. L4 adds picked projects, teams and spaces. */
export async function scopeOf(source: string): Promise<SyncScope> {
  if (source === 'github') {
    const repo = await resolveGitHubRepoScope({});
    if (repo) return { scopeKey: `repo:${repo}`, scope: 'team', repo };
  }
  return { scopeKey: 'yours', scope: 'yours' };
}

export interface SourceWindow { since?: string; until?: string; hotThreads?: Array<{ channel: string; ts: string }> }

export async function fetchSource(source: string, tokens: Record<string, string>, win: SourceWindow, scope: SyncScope): Promise<CaptureFetchResult> {
  if (source === 'github') {
    return fetchGitHubItemsOnly({
      token: tokens['token']!, ...fetchWindow('github', win.since !== undefined ? { since: win.since } : {}), ...windowExtras(win),
      ...(scope.repo ? { repo: scope.repo, scope: scope.scope } : {}),
    });
  }
  const { buildSources } = await import('../../commands/setup.js');
  const def = buildSources(false).find((s) => s.id === source);
  if (!def) throw new Error(`align sync does not know how to read "${source}".`);
  return def.fetch(tokens, win.since !== undefined ? { since: win.since } : {}, windowExtras(win));
}

/**
 * Re-read one stored thread whole, for merging a partial Slack re-read without guessing which lines are new.
 * The URL comes from a stored row, never from a person or an agent; Slack's fetchOne also holds it to a slack.com host.
 */
export async function fetchWhole(source: string, tokens: Record<string, string>, url: string): Promise<CaptureFetchResult['items'][number] | undefined> {
  if (source !== 'slack') return undefined;
  const { SlackFetcher } = await import('@aligndottech/connector-core');
  const r = await new SlackFetcher().fetchOne(url, { token: tokens['token']! });
  // A skip (429, 404, a channel it cannot see, time) is a reason the caller counts, never a silent "no".
  if (!r.item) throw new Error(r.skip?.detail ?? 'the thread could not be read');
  return r.item;
}
