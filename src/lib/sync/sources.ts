/**
 * L5: how a sync reads one source. The connectors that `align connect` already knows how to read
 * keep their one definition in setup.ts (`buildSources`): this file only adds the two things a
 * sync needs that connect does not, a scope key per source and GitHub's items-only list read.
 * Imported only by the sync command (it pulls setup.ts in); the MCP server never loads it.
 */
import type { CaptureFetchResult } from '../fetchers/capture.js';
import { fetchGitHubItemsOnly } from '../fetchers/github.js';
import { type ResolvedScope, resolveScope, type ScopeDeps } from '../scope.js';
import { realScopeDeps } from '../scope-real.js';
import { fetchWindow, windowExtras } from '../since.js';

/**
 * The scope a run reads a source under (L4: scope.ts decides). `blocked` means do not read at all; `note` is worth saying to the
 * person; `disclosure` is the one-time team-scope line, set only for a foreground run (the sync prints it before the first request).
 */
export type SyncScope = Pick<ResolvedScope, 'scopeKey' | 'scope'> & Partial<Pick<ResolvedScope, 'repo' | 'extras' | 'blocked' | 'note' | 'disclosure' | 'activates'>>;

/** The scope this machine reads a source under, decided before the fetch so its watermark can be found. Chosen scopes, the folder's
 *  repo (GitHub, GitLab) and the "yours" fallbacks are all scope.ts's: the same answer `align connect` and `align_scope` give. */
export async function scopeOf(source: string, o: { trigger: 'cli' | 'background' } = { trigger: 'cli' }, deps: ScopeDeps = realScopeDeps(undefined)): Promise<SyncScope> {
  return resolveScope(source, deps, { foreground: o.trigger === 'cli' });
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
  return def.fetch(tokens, win.since !== undefined ? { since: win.since } : {}, { ...windowExtras(win), ...windowExtras(scope.extras) });
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
