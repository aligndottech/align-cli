/**
 * Real raw_text shapes for a GitHub item, produced by the SDK's OWN fetcher against a mocked
 * network (undici's MockAgent), never typed by hand: the header lines ("Status:", "Repo:"), the
 * "## Comments" section markers and the ordering are the SDK's, so a test that stores and
 * re-imports these exercises the text the product really sees.
 */
import { fetchGitHubDiscussion, GitHubFetcher } from '@aligndottech/connector-core';
import type { FetcherItem } from '@aligndottech/connector-core';
import { MockAgent, setGlobalDispatcher } from 'undici';

export interface PrState {
  number?: number;
  title: string;
  body?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  comments?: Array<{ who: string; text: string }>;
}

export const PR_URL = (n = 1): string => `https://github.com/o/r/pull/${n}`;

/** Both versions of an item as the product gets them: thin (items first) and full (after the drain). */
export async function realShapes(pr: PrState): Promise<{ thin: FetcherItem; full: FetcherItem }> {
  const n = pr.number ?? 1;
  const agent = new MockAgent();
  agent.disableNetConnect();
  const api = agent.get('https://api.github.com');
  const row = {
    number: n, title: pr.title, body: pr.body ?? 'Use a queue', state: pr.state ?? 'open',
    html_url: PR_URL(n), repository_url: 'https://api.github.com/repos/o/r',
    pull_request: { merged_at: pr.merged ? '2026-09-02T00:00:00Z' : null },
    user: { login: 'me', html_url: 'https://github.com/me' },
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
  };
  const json = { headers: { 'content-type': 'application/json' } };
  api.intercept({ path: '/user' }).reply(200, { login: 'me' }, json).persist();
  api.intercept({ path: (p) => p.startsWith('/search/issues') && decodeURIComponent(p).includes('type:pr') })
    .reply(200, { total_count: 1, items: [row] }, json).persist();
  api.intercept({ path: (p) => p.startsWith('/search/issues') }).reply(200, { total_count: 0, items: [] }, json).persist();
  api.intercept({ path: (p) => p.startsWith(`/repos/o/r/issues/${n}/comments`) })
    .reply(200, (pr.comments ?? []).map((c) => ({ user: { login: c.who }, created_at: '2026-09-02T01:00:00Z', body: c.text })), json).persist();
  api.intercept({ path: (p) => p.startsWith(`/repos/o/r/pulls/${n}/`) }).reply(200, [], json).persist();
  setGlobalDispatcher(agent);
  try {
    const first = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team', discussion: 'none', limit: 5 });
    const thin = first.items[0];
    if (!thin) throw new Error('the mocked search returned no item: the fixture is wrong, not the product');
    const drained = await fetchGitHubDiscussion([thin], { token: 't', maxRequests: 50 });
    const full = drained.items[0];
    if (!full) throw new Error('the mocked discussion returned no item');
    return { thin, full };
  } finally {
    await agent.close();
  }
}
