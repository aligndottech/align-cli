import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJiraItems } from '../../lib/fetchers/jira.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeJiraIssue(key: string, summary: string) {
  return {
    key,
    fields: {
      summary,
      description: { content: [{ content: [{ text: `Description of ${key}` }] }] },
      status: { name: 'In Progress' },
      comment: { comments: [] },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchJiraItems - Basic auth mode (email + token + domain)', () => {
  it('should fetch issues using Basic auth when domain is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [makeJiraIssue('PROJ-1', 'Fix auth bug')] }),
    });

    const result = await fetchJiraItems({
      email: 'user@example.com',
      token: 'api_token_123',
      domain: 'mycompany.atlassian.net',
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://mycompany.atlassian.net/rest/api/3/search'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('PROJ-1');
  });
});

describe('fetchJiraItems - author capture (ALI-118)', () => {
  it('captures the issue reporter as the decision author', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        issues: [{
          key: 'PROJ-9',
          fields: {
            summary: 'Use Postgres',
            description: { content: [] },
            status: { name: 'Done' },
            reporter: { displayName: 'Sarah Lee', emailAddress: 'sarah@co.com', accountId: 'acc-1' },
          },
        }],
      }),
    });

    const result = await fetchJiraItems({ token: 'tok', cloudId: 'cloud-1', limit: 10 });
    expect(result[0].author).toEqual({ name: 'Sarah Lee', email: 'sarah@co.com' });
  });

  it('omits author when the issue has no reporter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [makeJiraIssue('PROJ-10', 'No reporter')] }),
    });
    const result = await fetchJiraItems({ token: 'tok', cloudId: 'cloud-1', limit: 10 });
    expect(result[0].author).toBeUndefined();
  });
});

describe('fetchJiraItems - OAuth mode (cloudId + access token)', () => {
  it('should fetch issues using Bearer auth when cloudId is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [makeJiraIssue('PROJ-2', 'Add OAuth support')] }),
    });

    const result = await fetchJiraItems({
      token: 'atlassian_oauth_access_token',
      cloudId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.atlassian.com/ex/jira/a1b2c3d4-e5f6-7890-abcd-ef1234567890/rest/api/3/search'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer atlassian_oauth_access_token',
        }),
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe('jira');
  });

  it('should include correct source_url using api.atlassian.com path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [makeJiraIssue('TICKET-42', 'Some issue')] }),
    });

    const result = await fetchJiraItems({
      token: 'tok',
      cloudId: 'cloud-123',
    });

    expect(result[0].source_url).toContain('TICKET-42');
  });

  it('should throw AuthExpiredError on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const { AuthExpiredError } = await import('../../lib/errors.js');
    await expect(fetchJiraItems({ token: 'bad_token', cloudId: 'cloud-123' })).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws a clear non-retryable error on 403 (no access / missing scopes), not AuthExpired', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });

    const { AuthExpiredError } = await import('../../lib/errors.js');
    const err = await fetchJiraItems({ token: 'tok', cloudId: 'cloud-123' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AuthExpiredError);
    expect((err as Error).message).toMatch(/403|access|scope|permission/i);
  });
});
