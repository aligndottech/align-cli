import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWaitForCallback = vi.hoisted(() => vi.fn());
const mockWhoami = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/cli-oauth.js', () => ({
  CLI_CALLBACK_PORTS: [1],
  waitForCallback: mockWaitForCallback,
}));
// Keep the real GatewayError (so statusCode-based branching is exercised); stub only createGatewayClient.
import type * as GatewayClientModule from '../lib/gateway-client.js';
vi.mock('../lib/gateway-client.js', async (importActual) => {
  const actual = await importActual<typeof GatewayClientModule>();
  return { ...actual, createGatewayClient: vi.fn(() => ({ whoami: mockWhoami })) };
});

import { loginInteractive } from '../lib/login-flow.js';
import { GatewayError } from '../lib/gateway-client.js';
import type { EnvironmentConfig } from '../lib/config.js';

const env: EnvironmentConfig = { gatewayUrl: 'https://gw', authToken: null, tenantId: null, mode: 'auth' };

function fakeConfig() {
  return { setAuthToken: vi.fn(), setTenantId: vi.fn() };
}
type ConfigArg = Parameters<typeof loginInteractive>[2];
const cast = (c: ReturnType<typeof fakeConfig>) => c as unknown as ConfigArg;

describe('loginInteractive', () => {
  beforeEach(() => { mockWaitForCallback.mockReset(); mockWhoami.mockReset(); });

  it('persists token + tenant id and returns true on success', async () => {
    mockWaitForCallback.mockResolvedValue({ data: { token: 'tok' }, port: 1 });
    mockWhoami.mockResolvedValue({ user: { email: 'a@b.com' }, tenant: { id: 't1', name: 'Acme' } });
    const config = fakeConfig();
    const ok = await loginInteractive(env, 'prod', cast(config));
    expect(ok).toBe(true);
    expect(config.setAuthToken).toHaveBeenCalledWith('prod', 'tok');
    expect(config.setTenantId).toHaveBeenCalledWith('prod', 't1');
  });

  it('returns false and saves nothing when no token comes back', async () => {
    mockWaitForCallback.mockResolvedValue({ data: {}, port: 1 });
    const config = fakeConfig();
    const ok = await loginInteractive(env, 'prod', cast(config));
    expect(ok).toBe(false);
    expect(config.setAuthToken).not.toHaveBeenCalled();
  });

  it('returns false when the callback fails (timeout / cancel)', async () => {
    mockWaitForCallback.mockRejectedValue(new Error('timeout'));
    const config = fakeConfig();
    const ok = await loginInteractive(env, 'prod', cast(config));
    expect(ok).toBe(false);
    expect(config.setAuthToken).not.toHaveBeenCalled();
  });

  it('fails OPEN on a network error (gateway unreachable): saves the token, returns true', async () => {
    mockWaitForCallback.mockResolvedValue({ data: { token: 'tok' }, port: 1 });
    mockWhoami.mockRejectedValue(new GatewayError('Cannot reach gateway', 0));
    const config = fakeConfig();
    const ok = await loginInteractive(env, 'prod', cast(config));
    expect(ok).toBe(true);
    expect(config.setAuthToken).toHaveBeenCalledWith('prod', 'tok');
  });

  // Behaviour fix: a 401/403 means the token was REJECTED, not that the gateway is
  // unreachable. Persisting it would leave the user "logged in" but 401-ing on every
  // later command. Do not save it; report failure.
  it('does NOT persist a rejected token (401) and returns false', async () => {
    mockWaitForCallback.mockResolvedValue({ data: { token: 'bad' }, port: 1 });
    mockWhoami.mockRejectedValue(new GatewayError('Gateway returned 401 for /auth/me', 401));
    const config = fakeConfig();
    const ok = await loginInteractive(env, 'prod', cast(config));
    expect(ok).toBe(false);
    expect(config.setAuthToken).not.toHaveBeenCalled();
  });
});
