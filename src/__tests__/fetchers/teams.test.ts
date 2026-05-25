import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTeamsItems } from '../../lib/fetchers/teams.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeOk(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe('fetchTeamsItems', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns items for each channel with messages', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({ value: [{ id: 'team1', displayName: 'Eng' }] }))
      .mockResolvedValueOnce(makeOk({ value: [{ id: 'chan1', displayName: 'general' }] }))
      .mockResolvedValueOnce(makeOk({
        value: [{
          id: 'msg1',
          subject: 'Decision about auth',
          body: { content: '<p>We chose JWT</p>', contentType: 'html' },
          webUrl: 'https://teams.microsoft.com/l/message/msg1',
          replies: [{ body: { content: 'Agreed', contentType: 'text' } }],
        }],
      }));

    const items = await fetchTeamsItems({ token: 'graph-token' });
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe('teams');
    expect(items[0].raw_text).toContain('We chose JWT');
    expect(items[0].source_url).toBe('https://teams.microsoft.com/l/message/msg1');
  });

  it('strips HTML from message body', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({ value: [{ id: 't1', displayName: 'Eng' }] }))
      .mockResolvedValueOnce(makeOk({ value: [{ id: 'c1', displayName: 'general' }] }))
      .mockResolvedValueOnce(makeOk({
        value: [{ id: 'm1', body: { content: '<b>Bold text</b> with <em>emphasis</em>', contentType: 'html' }, replies: [] }],
      }));

    const items = await fetchTeamsItems({ token: 'tok' });
    expect(items[0].raw_text).not.toContain('<b>');
    expect(items[0].raw_text).toContain('Bold text');
  });

  it('throws helpful error on admin consent failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }),
    } as unknown as Response);

    await expect(fetchTeamsItems({ token: 'graph-token' }))
      .rejects.toThrow('admin consent');
  });

  it('skips inaccessible channels silently', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({ value: [{ id: 't1', displayName: 'Eng' }] }))
      .mockResolvedValueOnce(makeOk({ value: [{ id: 'c1', displayName: 'restricted' }] }))
      .mockRejectedValueOnce(new Error('network error'));

    const items = await fetchTeamsItems({ token: 'tok' });
    expect(items).toHaveLength(0);
  });

  it('respects limit', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      body: { content: `Message ${i}`, contentType: 'text' },
      replies: [],
    }));
    mockFetch
      .mockResolvedValueOnce(makeOk({ value: [{ id: 't1', displayName: 'Eng' }] }))
      .mockResolvedValueOnce(makeOk({ value: [{ id: 'c1', displayName: 'general' }, { id: 'c2', displayName: 'dev' }] }))
      .mockResolvedValueOnce(makeOk({ value: messages }))
      .mockResolvedValueOnce(makeOk({ value: messages }));

    const items = await fetchTeamsItems({ token: 'tok', limit: 5 });
    expect(items.length).toBeLessThanOrEqual(5);
  });
});
