import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWindow, type WindowCacheStore } from '../lib/context-budget.js';

afterEach(() => {
  delete process.env['ALIGN_ANTHROPIC_CONTEXT_TOKENS'];
  vi.restoreAllMocks();
});

// In-memory double satisfying WindowCacheStore structurally - no `conf`, no filesystem.
// Exercises the same TTL logic config.ts's real getResolvedWindow/setResolvedWindow will run
// through, without paying for either side's real persistence.
function memoryStore(): WindowCacheStore {
  const map = new Map<string, { maxInputTokens: number; maxOutputTokens: number; resolvedAt: number }>();
  return {
    getResolvedWindow: (key) => map.get(key),
    setResolvedWindow: (key, value) => void map.set(key, value),
  };
}

function stubFetchOnce(maxInputTokens: number, maxOutputTokens: number) {
  // A fresh Response per call - a Response body can only be read once, so reusing one
  // instance across two calls (mockResolvedValue) would make the SECOND .json() throw and
  // silently fall through to the table, masking exactly the "fetched a second time" case
  // this test exists to prove.
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ max_input_tokens: maxInputTokens, max_output_tokens: maxOutputTokens }), { status: 200 }),
  );
}

// Rule 4 - the cache serves the second call and expires at 24h.
describe('rule 4 - 24h TTL cache', () => {
  it('A: the second call within the TTL is served from the cache; the Models API is fetched only once', async () => {
    const store = memoryStore();
    const fetchSpy = stubFetchOnce(500_000, 50_000);
    const now = 1_000_000;

    const first = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', {
      apiKey: 'sk-test', store, now: () => now, warn: () => {},
    });
    expect(first.source).toBe('models_api');

    const second = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', {
      apiKey: 'sk-test', store, now: () => now, warn: () => {},
    });
    expect(second).toEqual({ maxInputTokens: 500_000, maxOutputTokens: 50_000, source: 'cache' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('B: past 24h + 1ms the cache is expired and the Models API is fetched a second time', async () => {
    const store = memoryStore();
    const fetchSpy = stubFetchOnce(500_000, 50_000);
    let now = 1_000_000;

    await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', store, now: () => now, warn: () => {} });
    now += 24 * 60 * 60 * 1000 + 1;
    const second = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', { apiKey: 'sk-test', store, now: () => now, warn: () => {} });

    expect(second.source).toBe('models_api');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('B2: a resolvedAt in the FUTURE (a backwards clock jump) is treated as expired, not fresh forever', async () => {
    const store = memoryStore();
    const fetchSpy = stubFetchOnce(500_000, 50_000);
    const now = 1_000_000;
    store.setResolvedWindow('anthropic:claude-haiku-4-5-20251001', {
      maxInputTokens: 999_999, maxOutputTokens: 99_999, resolvedAt: now + 10 * 60 * 1000,
    });

    const result = await resolveWindow('anthropic', 'claude-haiku-4-5-20251001', {
      apiKey: 'sk-test', store, now: () => now, warn: () => {},
    });

    expect(result.source).toBe('models_api');
    expect(result.maxInputTokens).toBe(500_000); // the live value, not the future-dated cache entry
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
