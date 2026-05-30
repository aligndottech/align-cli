import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn().mockReturnValue({ whoami: vi.fn() }),
}));

import { createGatewayClient } from '../lib/gateway-client.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

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
});
