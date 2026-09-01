/**
 * ALI-618: local-only users have no tenant, so recordCommandUsage's local-embedded branch does
 * not go through /telemetry/ingest - it sends a smaller, anonymous payload to
 * /telemetry/anonymous, gated on a machine-local consent decision (config.ts) rather than a
 * token. usage-telemetry.test.ts covers the cloud path and stays unmodified; this file is the
 * local-embedded sibling, same split as usage-telemetry-invocation.test.ts vs the base file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();
const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({ getTelemetryConsent, getInstallId }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));

import { recordCommandUsage, TELEMETRY_TIMEOUT_MS } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Deliberately NOT the hosted URL: local-embedded mode makes no HTTP call for its own work, so
// this env's gatewayUrl is vestigial (config.ts's comment on ALIGN_HOSTED_GATEWAY_URL). If the
// send target ever regresses to reading env.gatewayUrl, these tests must catch it - so the
// fixture uses the REAL 'local' default (localhost:8080), not a copy of the hosted URL.
const localEnv: EnvironmentConfig = {
  gatewayUrl: 'http://localhost:8080',
  authToken: null,
  tenantId: null,
  mode: 'local-embedded',
};

/** Body of the single fetch call, asserted non-empty so a missed call cannot pass vacuously. */
function sentBody(): Record<string, unknown> {
  const args = mockFetch.mock.calls[0];
  if (!args) throw new Error('fetch was not called');
  const init = args[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error('fetch was called without a body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('recordCommandUsage - local-embedded anonymous ping', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset();
    getInstallId.mockReset();
    getInstallId.mockReturnValue(INSTALL_ID);
    vi.stubEnv('ALIGN_TELEMETRY', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('sends nothing when consent has never been granted', async () => {
    getTelemetryConsent.mockReturnValue(undefined);

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends nothing when consent was declined', async () => {
    getTelemetryConsent.mockReturnValue('declined');

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // test 3
  it('sends exactly one ping when consent is granted', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${HOSTED_URL}/telemetry/anonymous`);
  });

  // The regression this pins: an earlier version sent to env.gatewayUrl, silently discarded
  // for every user without a local dev gateway running (fresh-context review finding).
  it('never targets env.gatewayUrl, which is vestigial in local-embedded mode', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch.mock.calls[0]?.[0]).not.toContain('localhost:8080');
  });

  // Second example for the same rule: a different command name is read, not hardcoded.
  it('names a different command correctly', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'context');

    expect(sentBody()).toMatchObject({ command: 'context' });
  });

  // ALI-795: the gateway accepts a two-word command path now (align-stack#1990), so the
  // ping carries "import git" whole - truncating to "import" made activation-by-source
  // unreadable, which was the whole point of the ticket. Anything past two words is
  // still cut: the postAction hook never builds more, so a third word would be a bug's
  // output, not a command path.
  it('sends the full two-word command path (no longer truncating to the top level)', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'decisions list');

    expect(sentBody()).toMatchObject({ command: 'decisions list' });
  });

  it('caps at two words - arguments can never ride the command field', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'import git --deep');

    expect(sentBody()).toMatchObject({ command: 'import git' });
  });

  // test 0 (local half) / 4: the global off switch wins over a granted local consent.
  it('ALIGN_TELEMETRY=0 beats a granted local consent', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Second example: the off switch also wins when consent was never asked - not a
  // consent-specific check, ALIGN_TELEMETRY short-circuits before consent is even read.
  it('ALIGN_TELEMETRY=0 also beats an unset consent decision', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    getTelemetryConsent.mockReturnValue(undefined);

    await recordCommandUsage(localEnv, 'search');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(getTelemetryConsent).not.toHaveBeenCalled();
  });

  // test 7
  it('carries no tenant and no Authorization header', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'search');

    const init = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.['Authorization']).toBeUndefined();
    expect(init?.headers?.['x-tenant-id']).toBeUndefined();
  });

  // test 8: equality against the whole payload, not `not.toContain` of a feared value.
  it('payload contains only installId, command and cliVersion - nothing else', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordCommandUsage(localEnv, 'search');

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(['cliVersion', 'command', 'installId']);
    expect(body).toMatchObject({ installId: INSTALL_ID, command: 'search' });
    expect(typeof body['cliVersion']).toBe('string');
    expect((body['cliVersion'] as string).length).toBeGreaterThan(0);
  });

  // test 6
  it('resolves when the gateway rejects, so telemetry can never fail a command', async () => {
    getTelemetryConsent.mockReturnValue('granted');
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(recordCommandUsage(localEnv, 'search')).resolves.toBeUndefined();
  });

  it('resolves even on a gateway 500', async () => {
    getTelemetryConsent.mockReturnValue('granted');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    await expect(recordCommandUsage(localEnv, 'search')).resolves.toBeUndefined();
  });

  it('gives up rather than hanging when the gateway never answers', async () => {
    getTelemetryConsent.mockReturnValue('granted');
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce(() => new Promise(() => {}));

      const pending = recordCommandUsage(localEnv, 'search');
      await vi.advanceTimersByTimeAsync(TELEMETRY_TIMEOUT_MS);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
