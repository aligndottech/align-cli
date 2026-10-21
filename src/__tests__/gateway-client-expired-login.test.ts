import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { createGatewayClient, type GatewayError } from '../lib/gateway-client.js';

/**
 * ALI-1836: a login that has expired reached the user as
 * `Gateway returned 401 for /auth/me: unauthorized`, which names nothing they can act on.
 *
 * The gateway's authMiddleware answers `{ error: 'unauthorized', message: <text> }`. The three
 * messages that say "expired" are the API-token, session/OIDC and OAuth-access-token rejections.
 * The gateway does NOT separate an expired token from an unknown one in those answers (same
 * text for both), so the CLI message says "expired or no longer valid". Revoked, deactivated and
 * missing-credential 401s carry different text and must keep their old shape.
 *
 * Test List:
 *  1. each "Invalid or expired ..." 401 tells the user to run `align login`, status stays 401
 *  2. a 401 that is not expiry ("Token has been revoked") is unchanged
 *  3. a non-401 whose text says "expired" is unchanged (positive control for the status gate)
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cloudEnv = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok_real',
  tenantId: 'tenant-123',
  mode: 'auth' as const,
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function whoamiError(status: number, body: unknown): Promise<GatewayError> {
  mockFetch.mockResolvedValueOnce(reply(status, body));
  try {
    await createGatewayClient(cloudEnv).whoami();
  } catch (err) {
    return err as GatewayError;
  }
  throw new Error('whoami did not throw');
}

describe('expired login message (ALI-1836)', () => {
  beforeEach(() => mockFetch.mockReset());

  it.each(['Invalid or expired API token', 'Invalid or expired token', 'Invalid or expired access token'])(
    'a 401 saying "%s" tells the user to run align login',
    async (message) => {
      const err = await whoamiError(401, { error: 'unauthorized', message });
      expect(err.message).toBe('Your login has expired or is no longer valid. Run: align login');
      expect(err.statusCode).toBe(401);
    },
  );

  it('leaves a revoked-token 401 as it was', async () => {
    const err = await whoamiError(401, { error: 'unauthorized', message: 'Token has been revoked' });
    expect(err.message).toBe('Gateway returned 401 for /auth/me: unauthorized');
  });

  it('leaves a 403 whose text says expired as it was', async () => {
    const err = await whoamiError(403, { error: 'forbidden', message: 'Invite expired' });
    expect(err.message).toBe('Gateway returned 403 for /auth/me: forbidden');
  });
});
