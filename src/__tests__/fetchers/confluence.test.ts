import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConfluenceItems } from '../../lib/fetchers/confluence.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeConfluencePage(title: string) {
  return {
    title,
    body: { storage: { value: '<p>Some page content</p>' } },
    _links: { webui: '/pages/123' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchConfluenceItems - Basic auth mode (email + token + domain)', () => {
  it('should fetch pages via the v2 API using Basic auth when domain is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [makeConfluencePage('Architecture Decision Records')] }),
    });

    const result = await fetchConfluenceItems({
      email: 'user@example.com',
      token: 'api_token_123',
      domain: 'mycompany.atlassian.net',
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://mycompany.atlassian.net/wiki/api/v2/pages'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Architecture Decision Records');
  });
});

describe('fetchConfluenceItems - OAuth mode (cloudId + access token)', () => {
  it('should fetch pages using Bearer auth when cloudId is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [makeConfluencePage('Design Docs')] }),
    });

    const result = await fetchConfluenceItems({
      token: 'atlassian_oauth_access_token',
      cloudId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.atlassian.com/ex/confluence/a1b2c3d4-e5f6-7890-abcd-ef1234567890/wiki/api/v2/pages'
      ),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer atlassian_oauth_access_token',
        }),
      })
    );
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe('confluence');
  });

  it('should throw AuthExpiredError on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const { AuthExpiredError } = await import('../../lib/errors.js');
    await expect(
      fetchConfluenceItems({ token: 'bad_token', cloudId: 'cloud-123' })
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws a clear non-retryable error on 403 (no Confluence access / missing scopes), not AuthExpired', async () => {
    // 403 means the token lacks Confluence scopes or the site has no Confluence -
    // re-auth cannot fix it, so it must NOT be an AuthExpiredError (which would
    // send setup into a pointless reconnect loop). See ALI-111.
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });

    const { AuthExpiredError } = await import('../../lib/errors.js');
    const err = await fetchConfluenceItems({ token: 'tok', cloudId: 'cloud-123' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AuthExpiredError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/403|access|scope|permission/i);
  });
});
