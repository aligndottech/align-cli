/**
 * ALI-954: the install beacon. Opt-in telemetry had no denominator - a stranger who installs,
 * runs `align`, and answers No to the consent prompt was invisible, so a 10% consent rate was
 * indistinguishable from 90%. `cli.funnel.install` is sent ON BY DEFAULT, once per install id,
 * on the very first run, before any prompt: the CLI version, the OS, and the install id.
 * Nothing about the repo, the graph, or the user - and no command name either (the endpoint
 * requires one, so the beacon sends the literal `align`, which carries no information).
 *
 * `DO_NOT_TRACK=1` / `ALIGN_TELEMETRY=0` set before the first run means it is never sent, and
 * "never" is by construction: the first run is the only run that can be the first, so the
 * install is marked recorded whether or not the beacon went out. Cloud mode is unchanged - a
 * run that already holds a cloud token skips the beacon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();
const wasFunnelStageRecorded = vi.fn();
const markFunnelStageRecorded = vi.fn();
const getEnvironment = vi.fn();
const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent,
    getInstallId,
    wasFunnelStageRecorded,
    markFunnelStageRecorded,
    getEnvironment,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

import { recordInstallBeacon } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** A fresh install: the cloud default env with no token, no local mode configured yet. */
const freshEnv: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };

function sentTo(): { url: string; body: Record<string, unknown> } {
  const args = mockFetch.mock.calls[0];
  if (!args) throw new Error('fetch was not called');
  const init = args[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error('fetch was called without a body');
  return { url: String(args[0]), body: JSON.parse(init.body) as Record<string, unknown> };
}

describe('recordInstallBeacon', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset().mockReturnValue(undefined);
    getInstallId.mockReset().mockReturnValue(INSTALL_ID);
    wasFunnelStageRecorded.mockReset().mockReturnValue(false);
    markFunnelStageRecorded.mockReset();
    getEnvironment.mockReset().mockReturnValue(freshEnv);
    vi.stubEnv('ALIGN_TELEMETRY', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('first ever run, no env vars, no consent yet: exactly one beacon, and the install is marked', async () => {
    await expect(recordInstallBeacon('align')).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, body } = sentTo();
    expect(url).toBe(`${HOSTED_URL}/telemetry/anonymous`);
    expect(body).toMatchObject({ installId: INSTALL_ID, stage: 'install' });
    expect(markFunnelStageRecorded).toHaveBeenCalledWith('install');
  });

  // The snapshot the docs page is checked against (telemetry-docs-parity.test.ts): every
  // field, by equality, so a field added here fails until it is documented too.
  it('payload is exactly installId, cliVersion, os, stage and the literal command "align"', async () => {
    await recordInstallBeacon('ask');

    const { body } = sentTo();
    expect(Object.keys(body).sort()).toEqual(['cliVersion', 'command', 'installId', 'os', 'stage']);
    expect(body).toMatchObject({ installId: INSTALL_ID, command: 'align', stage: 'install', os: process.platform });
    expect(typeof body['cliVersion']).toBe('string');
    expect((body['cliVersion'] as string).length).toBeGreaterThan(0);
  });

  it('carries no Authorization header and no tenant', async () => {
    await recordInstallBeacon('align');
    const init = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.['Authorization']).toBeUndefined();
    expect(init?.headers?.['x-tenant-id']).toBeUndefined();
  });

  it('second run: the install is already recorded, nothing is sent', async () => {
    wasFunnelStageRecorded.mockReturnValue(true);

    await expect(recordInstallBeacon('align')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).not.toHaveBeenCalled();
  });

  it('DO_NOT_TRACK=1 before the first run: nothing sent, and the install is marked so it is NEVER sent later', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');

    await expect(recordInstallBeacon('align')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).toHaveBeenCalledWith('install');
  });

  it('ALIGN_TELEMETRY=0 before the first run: same - nothing sent, install marked', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');

    await expect(recordInstallBeacon('align')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).toHaveBeenCalledWith('install');
  });

  // `align telemetry off` is the stored equivalent of the env vars: it stops both tiers.
  it('a stored "off" decision (align telemetry off): nothing sent', async () => {
    getTelemetryConsent.mockReturnValue('off');

    await expect(recordInstallBeacon('align')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // A prompt-declined consent is about USAGE; the beacons are the documented default.
  it('a "declined" consent does not stop the beacon', async () => {
    getTelemetryConsent.mockReturnValue('declined');

    await expect(recordInstallBeacon('align')).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cloud mode unchanged: a run that already holds a cloud token sends no anonymous beacon', async () => {
    getEnvironment.mockReturnValue({ ...freshEnv, authToken: 'tok', tenantId: 't1' });

    await expect(recordInstallBeacon('ask')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The user's first command is the off switch itself: the beacon must not race ahead of it.
  // Not marked either - the install has not "run" yet in any sense the user chose.
  it('`align telemetry ...` as the very first command: nothing sent, nothing marked', async () => {
    await expect(recordInstallBeacon('telemetry off')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).not.toHaveBeenCalled();
  });

  it('never throws when the config store does', async () => {
    wasFunnelStageRecorded.mockImplementation(() => {
      throw new Error('store corrupted');
    });

    await expect(recordInstallBeacon('align')).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves true even when the gateway rejects - one lost row, never a re-send', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(recordInstallBeacon('align')).resolves.toBe(true);
  });
});
