/**
 * ALI-795: funnel stages as first-class events. recordFunnelStage is the single emitter -
 * cloud sends eventName cli.funnel.<stage> through the authed /telemetry/ingest, local
 * sends the anonymous payload with a `stage` field. Same consent model as
 * recordCommandUsage, no new consent surface: cloud is opt-out behind a token, local is
 * opt-in behind the stored decision, ALIGN_TELEMETRY=0 beats both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();
const wasFunnelStageRecorded = vi.fn();
const markFunnelStageRecorded = vi.fn();
const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent,
    getInstallId,
    wasFunnelStageRecorded,
    markFunnelStageRecorded,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));

import { recordFunnelStage } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const localEnv: EnvironmentConfig = {
  gatewayUrl: 'http://localhost:8080',
  authToken: null,
  tenantId: null,
  mode: 'local-embedded',
};

const cloudEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'token-1',
  tenantId: 'tenant-1',
  mode: 'auth',
};

function sentTo(): { url: string; body: Record<string, unknown> } {
  const args = mockFetch.mock.calls[0];
  if (!args) throw new Error('fetch was not called');
  const init = args[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error('fetch was called without a body');
  return { url: String(args[0]), body: JSON.parse(init.body) as Record<string, unknown> };
}

describe('recordFunnelStage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset();
    getInstallId.mockReset();
    getInstallId.mockReturnValue(INSTALL_ID);
    wasFunnelStageRecorded.mockReset();
    wasFunnelStageRecorded.mockReturnValue(false);
    markFunnelStageRecorded.mockReset();
    vi.stubEnv('ALIGN_TELEMETRY', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('local + consent granted: one anonymous ping carrying the stage', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordFunnelStage(localEnv, 'import_completed', 'import git');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, body } = sentTo();
    expect(url).toBe(`${HOSTED_URL}/telemetry/anonymous`);
    expect(body).toMatchObject({
      installId: INSTALL_ID,
      command: 'import git',
      stage: 'import_completed',
    });
    expect(body).toHaveProperty('cliVersion');
  });

  it('local without consent: sends nothing', async () => {
    getTelemetryConsent.mockReturnValue(undefined);
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cloud with a token: one ingest event named cli.funnel.<stage>', async () => {
    await recordFunnelStage(cloudEnv, 'mcp_wired', 'mcp');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, body } = sentTo();
    expect(url).toBe(`${cloudEnv.gatewayUrl}/telemetry/ingest`);
    expect(body).toMatchObject({
      eventName: 'cli.funnel.mcp_wired',
      category: 'engagement',
      platform: 'cli',
      properties: { command: 'mcp' },
    });
  });

  it('cloud without a token: sends nothing', async () => {
    await recordFunnelStage({ ...cloudEnv, authToken: null }, 'setup_started', 'setup');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ALIGN_TELEMETRY opt-out wins in both modes', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    getTelemetryConsent.mockReturnValue('granted');

    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    await recordFunnelStage(cloudEnv, 'setup_completed', 'setup');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // first_useful_decision is the activation event: the funnel counts an install once,
  // and the moment fires on every successful ask forever after - so the guard lives in
  // the emitter, the single enforcement point, not in N call sites.
  describe('first_useful_decision fires once per install', () => {
    it('emits and marks on the first call', async () => {
      getTelemetryConsent.mockReturnValue('granted');

      await recordFunnelStage(localEnv, 'first_useful_decision', 'ask');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(markFunnelStageRecorded).toHaveBeenCalledWith('first_useful_decision');
    });

    it('emits nothing once already recorded', async () => {
      getTelemetryConsent.mockReturnValue('granted');
      wasFunnelStageRecorded.mockReturnValue(true);

      await recordFunnelStage(localEnv, 'first_useful_decision', 'ask');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('other stages are not once-guarded', async () => {
      getTelemetryConsent.mockReturnValue('granted');
      wasFunnelStageRecorded.mockReturnValue(true);

      await recordFunnelStage(localEnv, 'import_completed', 'import git');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Copilot on #215: marking before the consent/token check permanently burned the
    // stage for exactly the opt-in cohort - a not-yet-consented user's first real
    // answer marked the install, and consenting later could never emit it.
    it('does NOT mark when local consent is missing, so a later opt-in still emits', async () => {
      getTelemetryConsent.mockReturnValue(undefined);

      await recordFunnelStage(localEnv, 'first_useful_decision', 'ask');

      expect(markFunnelStageRecorded).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does NOT mark when the cloud token is missing, so a later login still emits', async () => {
      await recordFunnelStage({ ...cloudEnv, authToken: null }, 'first_useful_decision', 'ask');

      expect(markFunnelStageRecorded).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // Telemetry must never fail the command it rides on - the same invariant
  // postWithTimeout holds for the network, extended to the config half. A broken
  // (or hand-faked) config store loses one funnel row, never the user's answer.
  it('never throws when the config store does', async () => {
    wasFunnelStageRecorded.mockImplementation(() => {
      throw new Error('store corrupted');
    });

    await expect(
      recordFunnelStage(localEnv, 'first_useful_decision', 'ask'),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Gateway parity (align-stack#1990): a query-taking command sends its top-level word
  // only - a user's one-word query must never ride the command field.
  it('collapses a query-taking command to its top-level word', async () => {
    getTelemetryConsent.mockReturnValue('granted');

    await recordFunnelStage(localEnv, 'first_useful_decision', 'ask something');

    const { body } = sentTo();
    expect(body).toMatchObject({ command: 'ask' });
  });
});
