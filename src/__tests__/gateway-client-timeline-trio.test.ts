import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { createGatewayClient } from '../lib/gateway-client.js';

/**
 * ALI-1070 follow-up: FETCH-LEVEL coverage for the timeline trio's client methods, and the
 * path-traversal fix on the method the trio newly exposed.
 *
 * Copilot on #296 (inline at gateway-client.ts:612/616, and twice more in the suppressed
 * block): the new methods were only ever exercised through a MOCKED `getTopicTimeline` /
 * `getDecisionTimeline` in the dispatch tests, so a wrong path, a wrong HTTP method or a
 * wrong body would pass the whole suite. The stdio smoke check proves registration and says
 * nothing about the wire format. These tests assert the request the client actually builds.
 *
 * Test List:
 *  1. SECURITY: getDecision encodes its path segment, so an agent-controlled id cannot
 *     traverse out of /snapshots/ with the user's PAT attached
 *  2. it still reaches the ordinary endpoint for an ordinary id
 *  3. getTopicTimeline POSTs to /decisions/topic-timeline
 *  4. it defaults the limit to 50 (one writer of the default, in the client)
 *  5. it honours an explicit limit
 *  6. getDecisionTimeline GETs /decisions/:id/history with the segment encoded
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cloudEnv = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok_real',
  tenantId: 'tenant-123',
  mode: 'auth' as const,
};

/** The URL string the client handed to fetch, asserted non-empty so a missed call cannot pass. */
function sentUrl(call = 0): string {
  const args = mockFetch.mock.calls[call];
  if (!args) throw new Error(`fetch was not called ${call + 1} time(s)`);
  return String(args[0]);
}

function sentInit(call = 0): { method?: string; body?: string } {
  const args = mockFetch.mock.calls[call];
  if (!args) throw new Error(`fetch was not called ${call + 1} time(s)`);
  return (args[1] ?? {}) as { method?: string; body?: string };
}

function ok(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
}

beforeEach(() => mockFetch.mockReset());

describe('ALI-1070 follow-up: getDecision must not let an id escape its path segment', () => {
  /**
   * The rationale tool routes an AGENT-CONTROLLED `decision_id` into getDecision, and this
   * method interpolated it raw while its three neighbours in the same file (ratify at :507,
   * adjudicate at :522, the new history method) all encode. `..%2Fauth%2Fme` is inert;
   * `../auth/me` is a different GET endpoint reached with the caller's PAT attached, because
   * URL parsing resolves the dot segments before the request leaves.
   *
   * The assertion is on the URL the client BUILT and on its resolved pathname, not on whether
   * the call resolved - a mocked fetch resolves whatever it is handed, so "it did not throw"
   * is exactly the green a traversal would also produce.
   */
  it('encodes the id, so a traversal cannot reach another endpoint', async () => {
    ok({ id: 'x' });
    await createGatewayClient(cloudEnv).getDecision('../auth/me');
    const url = sentUrl();
    // Positive control: the call happened and named this endpoint at all.
    expect(url).toContain('/snapshots/');
    // The load-bearing assertion. Resolve the URL the way the platform does: if the dot
    // segments survive unencoded, pathname collapses to /auth/me and this fails.
    expect(new URL(url).pathname).toBe('/snapshots/..%2Fauth%2Fme');
    expect(new URL(url).pathname).not.toBe('/auth/me');
  });

  it('still reaches the ordinary endpoint for an ordinary id', async () => {
    // The second example per rule: an encode-everything fix that broke normal ids would pass
    // the test above on its own.
    ok({ id: 'd1' });
    await createGatewayClient(cloudEnv).getDecision('d1');
    expect(new URL(sentUrl()).pathname).toBe('/snapshots/d1');
  });
});

describe('ALI-1070 follow-up: the trio methods build the requests they claim to', () => {
  it('getTopicTimeline POSTs the topic to /decisions/topic-timeline', async () => {
    ok({ topic: 't', count: 0, decisions: [] });
    await createGatewayClient(cloudEnv).getTopicTimeline('connection pooling');
    expect(new URL(sentUrl()).pathname).toBe('/decisions/topic-timeline');
    expect(sentInit().method).toBe('POST');
    expect(JSON.parse(sentInit().body!)).toMatchObject({ topic: 'connection pooling' });
  });

  it('defaults the limit to 50 rather than sending none', async () => {
    // The default lives in the client so there is ONE writer of it. A dispatch arm that
    // passed undefined through must still produce a bounded request.
    ok({ topic: 't', count: 0, decisions: [] });
    await createGatewayClient(cloudEnv).getTopicTimeline('auth');
    expect(JSON.parse(sentInit().body!)).toEqual({ topic: 'auth', limit: 50 });
  });

  it('honours an explicit limit', async () => {
    ok({ topic: 't', count: 0, decisions: [] });
    await createGatewayClient(cloudEnv).getTopicTimeline('auth', 12);
    expect(JSON.parse(sentInit().body!)).toEqual({ topic: 'auth', limit: 12 });
  });

  it('getDecisionTimeline GETs the encoded history path', async () => {
    ok({ decision_id: 'd1', events: [] });
    await createGatewayClient(cloudEnv).getDecisionTimeline('a/b');
    expect(new URL(sentUrl()).pathname).toBe('/decisions/a%2Fb/history');
    // GET is the absence of an explicit method on this client, so assert that rather than
    // a literal 'GET' the code never writes.
    expect(sentInit().method).toBeUndefined();
  });
});
