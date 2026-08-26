/**
 * The postAction hook used to resolve the DEFAULT env, so `align ask --env local` on a
 * machine that was also logged in for cloud phoned home about a session whose whole point
 * is staying on the machine (the PR #77 consent boundary, previously enforced only for the
 * three-member `local` command group). recordInvocationUsage resolves the env the command
 * actually addressed - flag, then ALIGN_ENV, then the default - and hands THAT to the gate.
 *
 * The config store is faked so the real resolveEnv runs against controlled environments.
 * The two envs deliberately differ in every field the gate reads, so "sent" and "suppressed"
 * cannot both be produced by the same resolution (tdd.md: two sources, distinct values).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const FIXTURE_ENVS = vi.hoisted(() => ({
  prod: {
    gatewayUrl: 'https://api.align.tech',
    authToken: 'jwt-token',
    tenantId: 'tenant-123',
    mode: 'auth',
  },
  local: {
    gatewayUrl: 'http://localhost:8080',
    authToken: null,
    tenantId: null,
    mode: 'local-embedded',
  },
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getDefaultEnv: () => 'prod',
    getEnvironment: (name: string) =>
      FIXTURE_ENVS[name as keyof typeof FIXTURE_ENVS] as EnvironmentConfig,
  }),
}));

import { recordInvocationUsage } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('recordInvocationUsage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    // Preconditions stated, not inherited from the runner's shell.
    vi.stubEnv('ALIGN_TELEMETRY', '');
    vi.stubEnv('ALIGN_ENV', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('posts to the default env when the command carried no --env flag', async () => {
    await recordInvocationUsage(undefined, 'import');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The URL proves WHICH env was resolved, not merely that something sent.
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.align.tech/telemetry/ingest');
  });

  it('sends nothing for `--env local` even though the default env holds a cloud token', async () => {
    await recordInvocationUsage('local', 'ask');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Second route to the same state: the env var, which outranks the default but not the flag.
  it('sends nothing under ALIGN_ENV=local even though the default env holds a cloud token', async () => {
    vi.stubEnv('ALIGN_ENV', 'local');

    await recordInvocationUsage(undefined, 'ask');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
