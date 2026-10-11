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
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
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

// C6: whether the one-time telemetry notice has printed. Unset unless a test says otherwise.
let noticeShownAt: string | undefined;
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getDefaultEnv: () => 'prod',
    getEnvironment: (name: string) => {
      if (name === 'badhttp') { const e = new Error('api.evil.example must be reached over https'); e.name = 'TransportError'; throw e; }
      return FIXTURE_ENVS[name as keyof typeof FIXTURE_ENVS] as EnvironmentConfig;
    },
    getTelemetryConsent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    getInstallId,
    hasTeamDestination: (n: string) => n === 'badhttp',
    listTeamDestinationNames: () => ['badhttp'],
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));

import { recordInvocationUsage } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('recordInvocationUsage - genuinely local-only user, bare command', () => {
  beforeEach(() => {
    noticeShownAt = undefined;
    // Every CI variable now turns telemetry off (C6), so all of them are cleared - with the env
    // switches, ALIGN_WRAPPED and the ALIGN_* token/env vars - rather than inherited.
    clearTelemetryEnv();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset().mockReturnValue('granted');
    getInstallId.mockReset().mockReturnValue('test-install-id');
    vi.stubEnv('ALIGN_ENV', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('routes a bare command to the anonymous local endpoint, not nowhere', async () => {
    await recordInvocationUsage(undefined, 'search');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${HOSTED_URL}/telemetry/anonymous`);
  });

  // F4 (join review): a stale or mistyped ALIGN_ENV makes resolveEnv throw, and the postAction hook ran AFTER the command had
  // already acted, so a command that worked (even `align telemetry off`) exited 2. Telemetry must never decide an exit code.
  it('an unknown ALIGN_ENV is swallowed by the hook: nothing sent, nothing thrown', async () => {
    vi.stubEnv('ALIGN_ENV', 'bogus');
    await expect(recordInvocationUsage(undefined, 'search')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an unknown --env flag is swallowed the same way', async () => {
    await expect(recordInvocationUsage('bogus', 'search')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a saved destination the transport rule refuses is swallowed with a one-line warning naming it (second review N5)', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(recordInvocationUsage('badhttp', 'logout')).resolves.toBeUndefined();
    const said = err.mock.calls.map((c) => String(c[0])).join('');
    err.mockRestore();
    expect(said.split('\n').filter(Boolean)).toHaveLength(1);
    expect(said).toContain('"badhttp"');
    expect(said).toContain('https');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a real error from the send path is NOT swallowed by that guard (only UnknownEnvError is)', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    // sends are fire-and-forget inside recordCommandUsage; the point is the guard is narrow, so a known env still reaches it
    await recordInvocationUsage(undefined, 'search');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when local consent has not been granted, same as before', async () => {
    getTelemetryConsent.mockReturnValue(undefined);

    await recordInvocationUsage(undefined, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ALI-949: bare `align` is the primary first-run path since ALI-773, and the hook handed
  // it over as '' - so a set-up local user typing the tool's name was never counted.
  it('bare `align` on a set-up local install sends one anonymous ping naming the command', async () => {
    await recordInvocationUsage(undefined, 'align');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ command: 'align' });
  });

  // A non-TTY first run: nothing is set up, no consent exists, and bare `align` only prints
  // what to run instead. Its postAction ping must stay a no-op.
  it('bare `align` with no consent (a fresh, non-interactive install) sends nothing', async () => {
    getTelemetryConsent.mockReturnValue(undefined);

    await recordInvocationUsage(undefined, 'align');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
