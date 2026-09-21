import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { createGatewayClient } from '../lib/gateway-client.js';

/**
 * `align ratify --env prod` returned 400 Bad Request for every id, including valid ones.
 *
 * The cause was not the id and not the route. `buildHeaders()` sets
 * `Content-Type: application/json` on EVERY request, and `ratifyDecision` is the only
 * mutating method that sends no body. Fastify rejects that combination with
 * FST_ERR_CTP_EMPTY_JSON_BODY -> 400, BEFORE the route handler runs, which is why the status
 * is 400 and not one of the 403/404/409 the handler can actually produce.
 *
 * So the human act the claims model depends on - a person standing behind an agent's
 * decision - could not be performed against the cloud at all. The LOCAL client's
 * ratifyDecision works, which is why the existing suite is green: it covers the half that
 * is not broken.
 *
 * The fix is in the shared helper rather than at the one call site: do not claim to be
 * sending JSON when no body is being sent. That is correct for every bodyless request and
 * cannot be reintroduced by a future method that forgets a body.
 *
 * Test List:
 *  1. RED: a bodyless POST must not carry a JSON content-type
 *  2. a POST WITH a body still carries it (the positive control - a fix that stripped the
 *     header everywhere would break every real write and still pass test 1)
 *  3. ratify still POSTs to the right path with the segment encoded
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cloudEnv = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok_real',
  tenantId: 'tenant-123',
  mode: 'auth' as const,
};

function sentInit(call = 0): { method?: string; body?: string; headers?: Record<string, string> } {
  const args = mockFetch.mock.calls[call];
  if (!args) throw new Error(`fetch was not called ${call + 1} time(s)`);
  return (args[1] ?? {}) as { method?: string; body?: string; headers?: Record<string, string> };
}

function contentType(call = 0): string | undefined {
  const h = sentInit(call).headers ?? {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === 'content-type');
  return key ? h[key] : undefined;
}

function ok(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
}

beforeEach(() => mockFetch.mockReset());

describe('a bodyless request must not claim to be sending JSON', () => {
  it('ratifyDecision sends no JSON content-type, so Fastify does not 400 on an empty body', async () => {
    ok({ already_ratified: false, ratified_by: 'tom@align.tech', ratified_at: '2026-09-21T09:00:00Z' });
    const client = createGatewayClient(cloudEnv as never);
    await client.ratifyDecision('a5556eb0-f25f-429e-bd67-314f64d13356', { ratifiedBy: 'tom@align.tech' });

    expect(sentInit().body).toBeUndefined();
    expect(contentType()).toBeUndefined();
  });

  it('POSITIVE CONTROL: a request WITH a body still sends the JSON content-type', async () => {
    ok({ decisions: [], count: 0 });
    const client = createGatewayClient(cloudEnv as never);
    await client.getTopicTimeline('Align Decision Gate');

    expect(sentInit().body).toBeDefined();
    expect(contentType()).toBe('application/json');
  });

  it('still POSTs to the encoded ratify path', async () => {
    ok({ already_ratified: false, ratified_by: null, ratified_at: null });
    const client = createGatewayClient(cloudEnv as never);
    await client.ratifyDecision('a5556eb0-f25f-429e-bd67-314f64d13356', { ratifiedBy: 'x' });

    expect(String(mockFetch.mock.calls[0][0]))
      .toBe('https://api.align.tech/decisions/a5556eb0-f25f-429e-bd67-314f64d13356/ratify');
    expect(sentInit().method).toBe('POST');
  });
});
