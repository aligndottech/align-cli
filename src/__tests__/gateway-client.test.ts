import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { createGatewayClient } from '../lib/gateway-client.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import pkg from '../../package.json' with { type: 'json' };

const pkgVersion = pkg.version;

/** Headers of the Nth fetch call, asserted non-empty so a missed call cannot pass vacuously. */
function sentHeaders(call = 0): Record<string, string> {
  const args = mockFetch.mock.calls[call];
  if (!args) throw new Error(`fetch was not called ${call + 1} time(s)`);
  const headers = (args[1] as { headers?: Record<string, string> } | undefined)?.headers;
  if (!headers) throw new Error('fetch was called without headers');
  return headers;
}

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const localEnv = {
  gatewayUrl: 'http://localhost:8080',
  authToken: null,
  tenantId: 'tenant-123',
  mode: 'demo' as const,
};

describe('gateway client', () => {
  beforeEach(() => mockFetch.mockReset());

  it('includes x-tenant-id header on all requests', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ all: [], enabled: [] }) });
    await createGatewayClient(localEnv).listConnectors();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tenant-id': 'tenant-123' }),
      }),
    );
  });

  it('includes Authorization header when authToken is set', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ all: [], enabled: [] }) });
    await createGatewayClient({ ...localEnv, authToken: 'jwt-token' }).listConnectors();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    );
  });

  it('throws readable error when gateway unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(createGatewayClient(localEnv).listConnectors())
      .rejects.toThrow('Cannot reach gateway at http://localhost:8080');
  });

  it('captureDecision calls POST /ingest with source_url', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'snap-1', title: 'Test', summary: 'Summary', platform: 'slack' }),
    });
    const result = await createGatewayClient(localEnv).captureDecision(
      'https://slack.com/archives/C123/p456',
      'slack',
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/ingest',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.id).toBe('snap-1');
  });

  it('captureDecision sends platform in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'snap-2', title: 'GitHub PR', summary: '', platform: 'github' }),
    });
    await createGatewayClient(localEnv).captureDecision(
      'https://github.com/org/repo/pull/42',
      'github',
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as Parameters<typeof fetch>[1]).body as string);
    expect(body.platform).toBe('github');
    expect(body.source_url).toBe('https://github.com/org/repo/pull/42');
  });

  it('checkAlignment calls POST /alignment/check', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'aligned', confidence: 0.9, relevant_decisions: [], message: 'ok' }),
    });
    const result = await createGatewayClient(localEnv).checkAlignment('diff content', 'main');
    expect(result.status).toBe('aligned');
  });

  // The gateway adjudicates on `new_decision.title`, and derived from a diff that is a file
  // header and three `+` lines. A caller that knows the real title should send it.
  // (align-stack#1652 added the optional field; an older gateway strips the unknown key.)
  it('checkAlignment sends the title when one is supplied', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'aligned', confidence: 0.9, relevant_decisions: [], message: 'ok' }),
    });

    await createGatewayClient(localEnv).checkAlignment('diff content', 'main', {
      title: 'Raise the gateway Postgres pool to 30 connections',
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as Parameters<typeof fetch>[1]).body as string);
    expect(body.title).toBe('Raise the gateway Postgres pool to 30 connections');
  });

  // Second example: the key is ABSENT, not present-and-undefined. The gateway's schema caps
  // title length and rejects an empty string, so sending the key with nothing in it would turn
  // a titleless caller into a 400.
  it('checkAlignment omits the title key entirely when none is supplied', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'aligned', confidence: 0.9, relevant_decisions: [], message: 'ok' }),
    });

    await createGatewayClient(localEnv).checkAlignment('diff content', 'main');

    const body = JSON.parse((mockFetch.mock.calls[0][1] as Parameters<typeof fetch>[1]).body as string);
    // Positive control: the request really was built, so `not toHaveProperty` is not passing
    // against an empty object.
    expect(body.content).toBe('diff content');
    expect(body).not.toHaveProperty('title');
  });

  it('returns unhealthy when connector returns 503', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const health = await createGatewayClient(localEnv).getConnectorHealth('slack');
    expect(health.status).toBe('unhealthy');
  });

  it('searchDecisions posts to /decisions/smart-search', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], count: 0, strategy: 'semantic' }),
    });
    await createGatewayClient(localEnv).searchDecisions('auth tokens');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/decisions/smart-search',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('ingestBatch posts to /ingest/batch with decisions array', async () => {
    const snapshots = [{ id: 'snap-1', title: 'Add auth', summary: 'Added JWT auth' }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshots }) });

    const items = [{ source_url: 'git://commit/abc', platform: 'git', raw_text: 'Add JWT auth\n\nAuthor: Tom', title: 'Add JWT auth' }];
    const result = await createGatewayClient(localEnv).ingestBatch(items);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/ingest/batch',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as Parameters<typeof fetch>[1]).body as string);
    expect(body.decisions).toEqual(items);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].id).toBe('snap-1');
  });

  it('ingestBatch passes auth headers', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshots: [] }) });
    await createGatewayClient({ ...localEnv, authToken: 'algt_abc123' }).ingestBatch([]);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer algt_abc123' }),
      }),
    );
  });

  it('dispatches to local client when mode is local-embedded', () => {
    const env = {
      gatewayUrl: 'local-embedded',
      mode: 'local-embedded' as const,
      authToken: null,
      tenantId: null,
      localDbPath: '/tmp/phase4-test.db',
    };
    createGatewayClient(env);
    expect(createLocalGatewayClient).toHaveBeenCalledWith('/tmp/phase4-test.db');
  });

  it('local-embedded client throws a clear error for cloud-only methods instead of TypeError', () => {
    const env = {
      gatewayUrl: 'local-embedded',
      mode: 'local-embedded' as const,
      authToken: null,
      tenantId: null,
      localDbPath: '/tmp/phase4-test.db',
    };
    // Mocked local client only implements whoami; listDecisions is cloud-only
    const client = createGatewayClient(env) as unknown as { listDecisions: () => unknown };
    expect(() => client.listDecisions()).toThrow(/local mode/i);
  });

  it('ingestBatch captures relatedDecisions from the gateway response', async () => {
    const snapshots = [{
      id: 'snap-1',
      title: 'Auth decision',
      summary: 'We chose JWT',
      analysis: {
        relatedDecisions: [
          { id: 'snap-2', title: 'Session design', relationship: 'relates', confidence: 0.8 },
        ],
      },
    }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshots }) });
    const result = await createGatewayClient(localEnv).ingestBatch([
      { source_url: 'https://slack.com/x', platform: 'slack', raw_text: 'auth discussion' },
    ]);
    expect(result.snapshots[0].analysis?.relatedDecisions).toHaveLength(1);
    expect(result.snapshots[0].analysis?.relatedDecisions[0].relationship).toBe('relates');
    expect(result.snapshots[0].analysis?.relatedDecisions[0].confidence).toBe(0.8);
  });

  // ALI-403: without these the CLI is anonymous to the gateway - a CLI request is
  // byte-identical in its identifying headers to one from the web app, so cloud-mode CLI
  // usage cannot be counted server-side at all.
  describe('client identity', () => {
    async function headersOf(): Promise<Record<string, string>> {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ all: [], enabled: [] }) });
      await createGatewayClient(localEnv).listConnectors();
      return sentHeaders();
    }

    it('names itself as the cli on every request', async () => {
      expect(await headersOf()).toMatchObject({ 'x-align-client': 'cli' });
    });

    it('sends its own package version, not a hardcoded one', async () => {
      expect((await headersOf())['x-align-client-version']).toBe(pkgVersion);
    });

    it('sends a User-Agent naming the package and version', async () => {
      expect((await headersOf())['User-Agent']).toBe(`@aligndottech/cli/${pkgVersion}`);
    });

    // buildHeaders() is spread FIRST, so a caller-supplied headers object silently wins.
    // Identity must survive that or it is only present on the calls nobody customises.
    it('keeps the identity headers when a caller supplies its own headers', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
      await createGatewayClient(localEnv).ingestBatch([
        { source_url: 'https://x', platform: 'slack', raw_text: 'x' },
      ]);
      expect(sentHeaders()).toMatchObject({
        'x-align-client': 'cli',
        'x-align-client-version': pkgVersion,
      });
    });
  });

  describe('getConflicts honest totals (ALI-587)', () => {
    // Until this change the client fetched one 50-row page and its consumer (the MCP tool)
    // served it to agents as the complete conflict set. The gateway's total_count is
    // computed over the WHOLE matching set on every paginated call (its count query
    // excludes the cursor), so one page already carries the exact total - the fix is to
    // read it, not to fetch wider.
    const mkLink = (n: number) => ({
      id: `link-${n}`,
      from_snapshot: `d-a-${n}`,
      to_snapshot: `d-b-${n}`,
      relation: 'conflicts_with',
      confidence: 0.9,
    });
    const pageResponse = (links: unknown[], pagination?: Record<string, unknown>) => ({
      ok: true,
      json: async () => ({ links, ...(pagination ? { pagination } : {}) }),
    });

    it('makes one request at the render width and reports the exact whole-set total', async () => {
      mockFetch.mockResolvedValueOnce(
        pageResponse(Array.from({ length: 50 }, (_, n) => mkLink(n)), {
          next_cursor: 'ts|a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          has_more: true,
          total_count: 1400,
          conflicts_count: 900,
        }),
      );

      const result = await createGatewayClient(localEnv).getConflicts();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0]);
      expect(url).toContain('limit=50');
      expect(result.links).toHaveLength(50);
      expect(result.conflict_count).toBe(1400);
      expect(result.showing).toBe(50);
      expect(result.message).toContain('first 50 of 1400');
      // The page envelope is passed through verbatim, so has_more/next_cursor genuinely
      // describe the returned links and a consumer paging on from here skips nothing.
      expect(result.pagination?.['has_more']).toBe(true);
    });

    it('omits the partial-set markers when the page holds the whole set', async () => {
      mockFetch.mockResolvedValueOnce(
        pageResponse([mkLink(1), mkLink(2)], { next_cursor: null, has_more: false, total_count: 2 }),
      );

      const result = await createGatewayClient(localEnv).getConflicts();

      expect(result.conflict_count).toBe(2);
      expect(result.links).toHaveLength(2);
      // Pinned as absent: a spurious showing/message on a complete set would tell an
      // agent the set is partial when it is not.
      expect('showing' in result).toBe(false);
      expect('message' in result).toBe(false);
    });

    it('falls back to the delivered length when the envelope carries no total_count', async () => {
      mockFetch.mockResolvedValueOnce(pageResponse([mkLink(1)], { next_cursor: null, has_more: false }));

      const result = await createGatewayClient(localEnv).getConflicts();

      expect(result.conflict_count).toBe(1);
    });

    it('throws loudly on a response shape it does not understand, instead of a confident zero', async () => {
      // A gateway (or proxy) answering with the legacy bare array must not degrade to
      // { links: [], conflict_count: 0 } - an affirmative "no conflicts" is the most
      // dangerous possible misreading for this tool.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [mkLink(1), mkLink(2)] });

      await expect(createGatewayClient(localEnv).getConflicts()).rejects.toThrow(
        /unexpected \/decision-links response shape/,
      );
    });
  });
});
