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
  it('should fetch pages using Basic auth when domain is provided', async () => {
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
      expect.stringContaining('https://mycompany.atlassian.net/wiki/rest/api/content/search'),
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
        'https://api.atlassian.com/ex/confluence/a1b2c3d4-e5f6-7890-abcd-ef1234567890/wiki/rest/api/content/search'
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

  it('should throw AuthExpiredError on 403', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const { AuthExpiredError } = await import('../../lib/errors.js');
    await expect(
      fetchConfluenceItems({ token: 'bad_token', cloudId: 'cloud-123' })
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
