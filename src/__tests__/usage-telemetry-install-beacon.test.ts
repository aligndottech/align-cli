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
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();
const wasFunnelStageRecorded = vi.fn();
const markFunnelStageRecorded = vi.fn();
const getEnvironment = vi.fn();
const releaseFunnelStage = vi.fn();
const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

// C6: whether the one-time telemetry notice has printed. Unset unless a test says otherwise.
let noticeShownAt: string | undefined;
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    getInstallId,
    wasFunnelStageRecorded,
    markFunnelStageRecorded,
    claimFunnelStage: (s: string) => {
      if (wasFunnelStageRecorded(s)) return false;
      markFunnelStageRecorded(s);
      return true;
    },
    releaseFunnelStage,
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
    // C6: the beacon follows the one-time notice (cli.ts prints it first), so this suite's
    // default is "the notice has printed"; the one test about the notice's absence unsets it.
    noticeShownAt = '2026-10-10T00:00:00.000Z';
    // Every CI variable now turns telemetry off (C6), so all of them are cleared - with the env
    // switches, ALIGN_WRAPPED and the ALIGN_* token/env vars - rather than inherited.
    clearTelemetryEnv();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset().mockReturnValue(undefined);
    getInstallId.mockReset().mockReturnValue(INSTALL_ID);
    wasFunnelStageRecorded.mockReset().mockReturnValue(false);
    markFunnelStageRecorded.mockReset();
    releaseFunnelStage.mockReset();
    getEnvironment.mockReset().mockReturnValue(freshEnv);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('C6: no notice and no stored decision: no beacon (the notice is the disclosure it waits on)', async () => {
    noticeShownAt = undefined;
    await expect(recordInstallBeacon('align')).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('C6: the first run is not consumed while the notice has not printed (no terminal yet)', async () => {
    noticeShownAt = undefined;
    await recordInstallBeacon('align');
    expect(markFunnelStageRecorded).not.toHaveBeenCalled();
  });

  it('C6: in CI the first run is not consumed - no beacon, and the install is NOT marked', async () => {
    vi.stubEnv('CI', 'true');
    await expect(recordInstallBeacon('align')).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).not.toHaveBeenCalled();
  });

  it('first ever run after the notice, no env vars, no consent yet: exactly one beacon, and the install is marked', async () => {
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
  // Review of e794c6e: a stored No from the old consent question is "off", and the privacy page
  // says off stays off - so it stops the beacon, and consumes the first run like an env switch.
  it('a "declined" consent stops the beacon and consumes the first run', async () => {
    getTelemetryConsent.mockReturnValue('declined');

    await expect(recordInstallBeacon('align')).resolves.toBe(false);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(markFunnelStageRecorded).toHaveBeenCalledWith('install');
  });

  it('marks the install before the send, so a second run started meanwhile does not send again', async () => {
    const order: string[] = [];
    markFunnelStageRecorded.mockImplementation(() => { order.push('mark'); });
    mockFetch.mockImplementation(async () => { order.push('send'); return { ok: true }; });
    await recordInstallBeacon('align');
    expect(order).toEqual(['mark', 'send']);
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

  // The first-run beacon is awaited (usage-telemetry-install-delivery.test.ts): a send that
  // never arrived releases the stage so the next run retries, rather than losing the install.
  it('a refused connection resolves false and releases the stage for the next run', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(recordInstallBeacon('align')).resolves.toBe(false);
    expect(releaseFunnelStage).toHaveBeenCalledWith('install');
  });

  it('a gateway that answers with an error status received it: true, and the stage is kept (never a re-send)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(recordInstallBeacon('align')).resolves.toBe(true);
    expect(releaseFunnelStage).not.toHaveBeenCalled();
  });
});
