import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit-test the CLI wrappers' job: delegate to the connector-core fetcher and
// map the auth error. core's HTTP behaviour is covered by core's own suite, so
// we stub the core module here (and the git I/O the git wrapper injects).
vi.mock('@aligndottech/connector-core', () => {
  class FetcherAuthError extends Error {
    constructor(public readonly connector: string) {
      super(connector);
      this.name = 'FetcherAuthError';
    }
  }
  const arrayFetcher = (platform: string) =>
    class {
      async fetch() {
        return [{ source_url: 'u', platform, raw_text: 'x' }];
      }
    };
  const atlassianFetcher = (connector: string, platform: string) =>
    class {
      async fetch(o: { token: string }) {
        if (o.token === 'bad') throw new FetcherAuthError(connector);
        return [{ source_url: 'u', platform, raw_text: 'x' }];
      }
    };
  return {
    FetcherAuthError,
    GitHubFetcher: arrayFetcher('github'),
    GitLabFetcher: arrayFetcher('gitlab'),
    SlackFetcher: arrayFetcher('slack'),
    TeamsFetcher: arrayFetcher('teams'),
    ZoomFetcher: arrayFetcher('zoom'),
    LinearFetcher: arrayFetcher('linear'),
    NotionFetcher: arrayFetcher('notion'),
    JiraFetcher: atlassianFetcher('Jira', 'jira'),
    ConfluenceFetcher: atlassianFetcher('Confluence', 'confluence'),
    GitFetcher: class {
      constructor(public src: { getCommitHistory: (o: { limit: number }) => Promise<Array<{ sha: string; subject: string; author?: string }>>; getRemoteUrl: () => Promise<string | null> }) {}
      async fetch(o: { limit: number }) {
        const commits = await this.src.getCommitHistory({ limit: o.limit });
        await this.src.getRemoteUrl();
        return commits.map((c) => ({ source_url: `git://${c.sha}`, platform: 'git', raw_text: c.subject, ...(c.author ? { author: { name: c.author } } : {}) }));
      }
    },
  };
});
vi.mock('../../lib/git.js', () => ({
  getCommitHistory: vi.fn(async () => [{ sha: 'abc', subject: 'Adopt hexagonal arch', author: 'Ada' }]),
  getRemoteUrl: vi.fn(async () => 'git@github.com:org/repo.git'),
}));

import { fetchGitHubItems } from '../../lib/fetchers/github.js';
import { fetchGitLabItems } from '../../lib/fetchers/gitlab.js';
import { fetchJiraItems } from '../../lib/fetchers/jira.js';
import { fetchConfluenceItems } from '../../lib/fetchers/confluence.js';
import { fetchSlackItems } from '../../lib/fetchers/slack.js';
import { fetchTeamsItems } from '../../lib/fetchers/teams.js';
import { fetchZoomItems } from '../../lib/fetchers/zoom.js';
import { fetchLinearItems } from '../../lib/fetchers/linear.js';
import { fetchNotionItems } from '../../lib/fetchers/notion.js';
import { fetchGitItems } from '../../lib/fetchers/git.js';
import { getCommitHistory } from '../../lib/git.js';
import { AuthExpiredError } from '../../lib/errors.js';

describe('CLI fetcher wrappers delegate to connector-core', () => {
  beforeEach(() => vi.clearAllMocks());

  it('every token-based wrapper returns the core fetcher result', async () => {
    const results = await Promise.all([
      fetchGitHubItems({ token: 't' }),
      fetchGitLabItems({ token: 't' }),
      fetchJiraItems({ token: 't', cloudId: 'c' }),
      fetchConfluenceItems({ token: 't', cloudId: 'c' }),
      fetchSlackItems({ token: 't' }),
      fetchTeamsItems({ token: 't' }),
      fetchZoomItems({ token: 't' }),
      fetchLinearItems({ token: 't' }),
      fetchNotionItems({ token: 't' }),
    ]);
    expect(results.map((r) => r[0].platform)).toEqual([
      'github', 'gitlab', 'jira', 'confluence', 'slack', 'teams', 'zoom', 'linear', 'notion',
    ]);
  });

  it('git wrapper injects the CLI git I/O', async () => {
    const items = await fetchGitItems({ limit: 10 });
    expect(getCommitHistory).toHaveBeenCalledWith({ limit: 10 });
    expect(items[0]).toMatchObject({ platform: 'git', author: { name: 'Ada' } });
  });

  it('jira/confluence map a FetcherAuthError to AuthExpiredError (reconnect flow)', async () => {
    await expect(fetchJiraItems({ token: 'bad', cloudId: 'c' })).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(fetchConfluenceItems({ token: 'bad', cloudId: 'c' })).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
