import { describe, expect, it, vi } from 'vitest';
import { withCaptureReport } from '../../lib/fetchers/capture.js';

/**
 * ALI-827 R31b: a fetcher that reports nothing about itself (every connector-core 0.5.0
 * fetcher, and any third-party one) still yields a report - one that says only what the
 * CALLER can honestly say: how many came back, and how many were asked for. Never a reason.
 */
const item = (n: number) => ({ source_url: `u${n}`, platform: 'x', raw_text: `t${n}` });

describe('withCaptureReport (the fallback when the fetcher cannot report)', () => {
  it('with a limit: items pass through untouched, the report is count + request, no skips', async () => {
    const items = [item(1), item(2)];
    const result = await withCaptureReport({ limit: 50 }, { fetch: async () => items });
    expect(result.items).toBe(items);
    expect(result.report).toEqual({ scanned: 2, requested: 50, skips: [] });
  });

  it('without a limit: no requested key at all, never a fabricated one', async () => {
    const result = await withCaptureReport({}, { fetch: async () => [item(1)] });
    expect(result.report).toEqual({ scanned: 1, skips: [] });
    expect('requested' in result.report).toBe(false);
  });

  it('lets the fetcher error through unchanged, so the wrappers keep mapping auth errors', async () => {
    const boom = new Error('401 Bad credentials');
    await expect(withCaptureReport({ limit: 5 }, { fetch: async () => { throw boom; } })).rejects.toBe(boom);
  });
});

/**
 * ALI-829 R31a: connector-core 0.6.0 fetchers report what they could not reach. When the
 * fetcher offers it, its report wins over the fallback - and `fetch` is never called, so
 * one read, not two.
 */
describe('withCaptureReport (the SDK report, when the fetcher has one)', () => {
  it('uses fetchWithReport and carries scanned, requested and every skip through, dropping kind', async () => {
    const items = [item(1)];
    const fetch = vi.fn(async () => items);
    const fetchWithReport = vi.fn(async () => ({
      items,
      report: {
        platform: 'slack',
        scanned: 9,
        requested: 50,
        skips: [
          { kind: 'shape' as const, count: 3, detail: 'threads with no human message (bot or system output only)' },
          { kind: 'error' as const, count: 1, detail: 'channels the token could not read' },
        ],
      },
    }));
    const result = await withCaptureReport({ limit: 50 }, { fetch, fetchWithReport });
    expect(result.items).toBe(items);
    expect(result.report).toEqual({
      scanned: 9,
      requested: 50,
      skips: [
        { count: 3, detail: 'threads with no human message (bot or system output only)' },
        { count: 1, detail: 'channels the token could not read' },
      ],
    });
    expect(fetchWithReport).toHaveBeenCalledWith({ limit: 50 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves requested out when the SDK report has none, and passes an empty skip list as empty', async () => {
    const fetchWithReport = vi.fn(async () => ({
      items: [item(1), item(2)],
      report: { platform: 'zoom', scanned: 2, skips: [] },
    }));
    const result = await withCaptureReport({}, { fetch: async () => [], fetchWithReport });
    expect(result.report).toEqual({ scanned: 2, skips: [] });
    expect('requested' in result.report).toBe(false);
  });
});

