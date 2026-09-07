import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALI-786: Linear's newer scoped personal-API-key dialog
 * (linear.app/settings/account/security/api-keys/new) lets a user create a key restricted
 * to Write/Create-only permissions. This fetcher's query is read-only (viewer's assigned +
 * created issues), so a key with no Read scope gets refused by Linear with a plain 400 -
 * connector-core's `providerError` already surfaces Linear's own words for that (see
 * fetchers/errors.js: 401 gets a token hint, 400 gets none). Verified via Linear's own docs
 * (2026-09-07): scoped keys still carry the classic `lin_api_` prefix, so this is a
 * permissions gap, not the Bearer-vs-bare header issue SDK 0.6.2 already fixed.
 *
 * A 400 from ANY cause is ambiguous (complexity limit, malformed input, or a missing scope),
 * so the added text is phrased as "if you created this key with limited permissions" rather
 * than asserting the cause - never a claim the wrapper cannot verify.
 */
vi.mock('@aligndottech/connector-core', () => {
  class FetcherAuthError extends Error {
    constructor(public readonly connector: string) {
      super(`${connector} authentication failed (401): invalid token.`);
      this.name = 'FetcherAuthError';
    }
  }
  return {
    FetcherAuthError,
    LinearFetcher: class {
      async fetch(): Promise<never> {
        throw (globalThis as { __linearFetchError?: Error }).__linearFetchError;
      }
    },
  };
});

import { fetchLinearItems } from '../../lib/fetchers/linear.js';

function setThrown(err: Error): void {
  (globalThis as { __linearFetchError?: Error }).__linearFetchError = err;
}

describe('fetchLinearItems: a 400 gets a scope hint, nothing else does', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends the scope hint to a Linear 400, keeping the provider detail', async () => {
    setThrown(new Error('Linear API failed (400): Argument Validation Error'));

    await expect(fetchLinearItems({ token: 'lin_api_x' })).rejects.toThrow(
      /Linear API failed \(400\): Argument Validation Error/,
    );
    await expect(fetchLinearItems({ token: 'lin_api_x' })).rejects.toThrow(/Read/);
    await expect(fetchLinearItems({ token: 'lin_api_x' })).rejects.toThrow(
      /linear\.app\/settings\/account\/security\/api-keys/,
    );
  });

  it('leaves a 401 (FetcherAuthError) message unchanged - a new key would fix that, not a scope', async () => {
    const { FetcherAuthError } = await import('@aligndottech/connector-core') as unknown as {
      FetcherAuthError: new (c: string) => Error;
    };
    setThrown(new FetcherAuthError('Linear'));

    await expect(fetchLinearItems({ token: 'bad' })).rejects.toThrow(
      /^Linear authentication failed \(401\): invalid token\.$/,
    );
  });

  it('leaves an unrelated error unchanged - the hint only fires on the Linear 400 shape', async () => {
    setThrown(new Error('fetch failed: ECONNREFUSED'));

    await expect(fetchLinearItems({ token: 't' })).rejects.toThrow(/^fetch failed: ECONNREFUSED$/);
  });

  // Copilot review, PR #272: mutate and rethrow the SAME error instance rather than
  // wrapping in `new Error(...)`, which would discard the stack connector-core recorded
  // at the real failing request and any error subclass identity a future fetcher throws.
  it('rethrows the SAME error instance on a 400, not a new one', async () => {
    const original = new Error('Linear API failed (400): Argument Validation Error');
    setThrown(original);

    let caught: unknown;
    try {
      await fetchLinearItems({ token: 'lin_api_x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect((caught as Error).message).toContain('Read');
  });
});
