import { describe, expect, it } from 'vitest';
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
    const result = await withCaptureReport({ limit: 50 }, async () => items);
    expect(result.items).toBe(items);
    expect(result.report).toEqual({ scanned: 2, requested: 50, skips: [] });
  });

  it('without a limit: no requested key at all, never a fabricated one', async () => {
    const result = await withCaptureReport({}, async () => [item(1)]);
    expect(result.report).toEqual({ scanned: 1, skips: [] });
    expect('requested' in result.report).toBe(false);
  });

  it('lets the fetcher error through unchanged, so the wrappers keep mapping auth errors', async () => {
    const boom = new Error('401 Bad credentials');
    await expect(withCaptureReport({ limit: 5 }, async () => { throw boom; })).rejects.toBe(boom);
  });
});

