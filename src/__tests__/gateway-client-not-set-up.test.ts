import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localSearch = vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'local' });
vi.mock('../lib/local-gateway-client.js', () => ({
  createLocalGatewayClient: vi.fn(() => ({ searchDecisions: localSearch })),
}));

import { createGatewayClient } from '../lib/gateway-client.js';
import { createConfigStore, type EnvironmentConfig } from '../lib/config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const PROD: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };
const PREVIEW: EnvironmentConfig = { gatewayUrl: 'https://api.preview.align.tech', authToken: null, tenantId: null, mode: 'auth' };

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  mockFetch.mockReset();
  localSearch.mockClear();
});

describe('a built-in cloud env with no credential says align is not set up', () => {
  it.each([
    ['prod', PROD, 'align'],
    ['preview', PREVIEW, 'align login --env preview'],
  ])('%s: names the command, one line, and never calls the gateway', async (_n, env, command) => {
    const err = await createGatewayClient(env).searchDecisions('q', 5).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('not set up');
    expect(message).toContain(`\`${command}\``);
    expect(message).not.toContain('\n');
    expect(message).not.toMatch(/401|Gateway returned/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('covers every request path, not just search (check)', async () => {
    await expect(createGatewayClient(PROD).checkAlignment('diff', 'main')).rejects.toThrow(/not set up/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a saved token that the gateway rejects still reports the 401', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
    await expect(createGatewayClient({ ...PROD, authToken: 'stale' }).searchDecisions('q', 5)).rejects.toThrow(
      'Gateway returned 401 for /decisions/smart-search: unauthorized',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a second token shape (preview) with a saved token also reaches the gateway', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
    await expect(createGatewayClient({ ...PREVIEW, authToken: 'x' }).whoami()).rejects.toThrow(/Gateway returned 401/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('an ALIGN_TOKEN-only credential counts as set up (config folds it into authToken)', async () => {
    vi.stubEnv('ALIGN_TOKEN', 'ci-token');
    vi.stubEnv('XDG_CONFIG_HOME', `/tmp/ali1777/xdg-${process.pid}`);
    const env = createConfigStore().getEnvironment('prod');
    expect(env.authToken).toBe('ci-token');
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [], count: 0 }) });
    await createGatewayClient(env).searchDecisions('q', 5);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('an ALIGN_GATEWAY_URL override to the default URL is still "not set up"; to another URL it is left alone', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', `/tmp/ali1777/xdg-${process.pid}-b`);
    vi.stubEnv('ALIGN_GATEWAY_URL', 'https://api.align.tech');
    await expect(createGatewayClient(createConfigStore().getEnvironment('prod')).whoami()).rejects.toThrow(/not set up/);
    vi.stubEnv('ALIGN_GATEWAY_URL', 'https://align.corp.example');
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await createGatewayClient(createConfigStore().getEnvironment('prod')).whoami();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a tenant with no token keeps its own, earlier refusal', async () => {
    await expect(createGatewayClient({ ...PROD, tenantId: 't1' }).whoami()).rejects.toThrow(/tenant is configured/);
  });

  it('a self-hosted gateway URL is left alone: no token there is a real request, not "not set up"', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [], count: 0 }) });
    await createGatewayClient({ ...PROD, gatewayUrl: 'https://align.corp.example' }).searchDecisions('q', 5);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a local graph is untouched: local-embedded never reaches the HTTP client', async () => {
    await createGatewayClient({ gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/x.db' }).searchDecisions('q', 5);
    expect(localSearch).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
