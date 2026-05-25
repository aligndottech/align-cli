import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchZoomItems } from '../../lib/fetchers/zoom.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeOk(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function makeVttOk(vtt: string): Response {
  return { ok: true, text: async () => vtt } as unknown as Response;
}

const SAMPLE_VTT = [
  'WEBVTT',
  '',
  '1',
  '00:00:01.000 --> 00:00:04.000',
  'We should use Postgres for this.',
  '',
  '2',
  '00:00:05.000 --> 00:00:08.000',
  'Agreed, it handles our scale.',
].join('\n');

describe('fetchZoomItems', () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it('returns items from recording VTT transcripts', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({
        meetings: [{
          id: 'mtg1',
          uuid: 'abc123',
          topic: 'Architecture review',
          start_time: '2025-01-15T10:00:00Z',
          recording_files: [{
            file_type: 'TRANSCRIPT',
            download_url: 'https://zoom.us/recordings/download/abc.vtt',
            status: 'completed',
          }],
        }],
      }))
      .mockResolvedValueOnce(makeVttOk(SAMPLE_VTT));

    const items = await fetchZoomItems({ token: 'zoom-token' });
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe('zoom');
    expect(items[0].raw_text).toContain('We should use Postgres for this.');
    expect(items[0].raw_text).toContain('Agreed, it handles our scale.');
    expect(items[0].title).toContain('Architecture review');
    expect(items[0].title).toContain('2025-01-15');
  });

  it('skips recordings with no transcript file', async () => {
    mockFetch.mockResolvedValueOnce(makeOk({
      meetings: [{
        id: 'mtg1',
        uuid: 'abc123',
        topic: 'No transcript',
        start_time: '2025-01-15T10:00:00Z',
        recording_files: [{ file_type: 'MP4', status: 'completed' }],
      }],
    }));

    const items = await fetchZoomItems({ token: 'zoom-token' });
    expect(items).toHaveLength(0);
  });

  it('skips recordings where transcript download fails', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({
        meetings: [{
          id: 'mtg1',
          uuid: 'abc123',
          topic: 'Broken transcript',
          start_time: '2025-01-15T10:00:00Z',
          recording_files: [{
            file_type: 'TRANSCRIPT',
            download_url: 'https://zoom.us/recordings/download/broken.vtt',
            status: 'completed',
          }],
        }],
      }))
      .mockResolvedValueOnce({ ok: false } as unknown as Response);

    const items = await fetchZoomItems({ token: 'zoom-token' });
    expect(items).toHaveLength(0);
  });

  it('handles double-slash meeting UUIDs by double-encoding', async () => {
    mockFetch.mockResolvedValueOnce(makeOk({ meetings: [] }));

    await fetchZoomItems({ token: 'zoom-token' });
    const [call] = mockFetch.mock.calls;
    // Standard /users/me/recordings path used when no uuid given
    expect(call[0]).toContain('/users/me/recordings');
  });

  it('double-encodes UUIDs containing // when uuid option provided', async () => {
    mockFetch.mockResolvedValueOnce(makeOk({ meetings: [] }));

    await fetchZoomItems({ token: 'tok', uuid: '//double-slash-uuid' });
    const [call] = mockFetch.mock.calls;
    // Should not have raw // in URL
    const url = call[0] as string;
    const pathPart = url.replace('https://api.zoom.us/v2', '');
    expect(pathPart).not.toContain('//');
  });

  it('strips WEBVTT header and timestamps from transcript', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOk({
        meetings: [{
          id: 'm1',
          uuid: 'u1',
          topic: 'Meeting',
          start_time: '2025-01-01T00:00:00Z',
          recording_files: [{
            file_type: 'TRANSCRIPT',
            download_url: 'https://zoom.us/dl/x.vtt',
            status: 'completed',
          }],
        }],
      }))
      .mockResolvedValueOnce(makeVttOk(SAMPLE_VTT));

    const items = await fetchZoomItems({ token: 'tok' });
    expect(items[0].raw_text).not.toContain('WEBVTT');
    expect(items[0].raw_text).not.toContain('-->');
  });
});
