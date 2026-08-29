/**
 * ALI-618: the audience this ticket exists to count is a user who has NEVER logged in to
 * cloud and never types `--env local` - exactly `resolveEnv`'s own `preferLocalEmbedded`
 * redirect case (used by `resolveImportEnv`, ALI-675), and exactly what
 * `recordInvocationUsage`'s own docstring predicted: "if that token check is ever relaxed to
 * count tokenless users, pass the preference here as well." Without it, every bare command
 * from this audience resolves to the tokenless cloud default and recordCommandUsage's
 * `if (!env.authToken || !env.tenantId) return` silently drops it - neither cloud nor local
 * ever fires, so the feature never counts the users it was built for.
 *
 * Separate file from usage-telemetry-invocation.test.ts because that file's fixtures
 * deliberately keep a token on the `local` env (to prove the MODE gate, not the token gate) -
 * this file needs the opposite: no token anywhere, which is what "never logged in" means.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();

const FIXTURE_ENVS = vi.hoisted(() => ({
  prod: {
    gatewayUrl: 'https://api.align.tech',
    authToken: null,
    tenantId: null,
    mode: 'auth',
  },
  local: {
    gatewayUrl: 'http://localhost:8080',
    authToken: null,
    tenantId: null,
    mode: 'local-embedded',
  },
}));

const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getDefaultEnv: () => 'prod',
    getEnvironment: (name: string) =>
      FIXTURE_ENVS[name as keyof typeof FIXTURE_ENVS] as EnvironmentConfig,
    getTelemetryConsent,
    getInstallId,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));

import { recordInvocationUsage } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('recordInvocationUsage - genuinely local-only user, bare command', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset().mockReturnValue('granted');
    getInstallId.mockReset().mockReturnValue('test-install-id');
    vi.stubEnv('ALIGN_TELEMETRY', '');
    vi.stubEnv('ALIGN_ENV', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('routes a bare command to the anonymous local endpoint, not nowhere', async () => {
    await recordInvocationUsage(undefined, 'search');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${HOSTED_URL}/telemetry/anonymous`);
  });

  it('sends nothing when local consent has not been granted, same as before', async () => {
    getTelemetryConsent.mockReturnValue(undefined);

    await recordInvocationUsage(undefined, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
