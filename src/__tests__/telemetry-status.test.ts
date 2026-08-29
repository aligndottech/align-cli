/**
 * ALI-618 D3b: one CLI, two consent semantics (cloud opt-out, local opt-in) is a real user-
 * facing inconsistency unless `align telemetry status` can say WHICH model applies and why.
 * Four distinct outputs are the whole point - a status that cannot tell them apart is the
 * ALI-306 honesty problem restated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { getTelemetryStatus } from '../lib/usage-telemetry.js';

afterEach(() => vi.unstubAllEnvs());

const cloudEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'jwt-token',
  tenantId: 'tenant-123',
  mode: 'auth',
};

const localEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: null,
  tenantId: null,
  mode: 'local-embedded',
};

describe('getTelemetryStatus', () => {
  it('cloud mode: on, opt-out default', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '');
    expect(getTelemetryStatus(cloudEnv, undefined)).toEqual({
      enabled: true,
      reason: expect.stringContaining('cloud'),
    });
  });

  it('local mode, consent granted: on', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '');
    expect(getTelemetryStatus(localEnv, 'granted')).toEqual({
      enabled: true,
      reason: expect.stringContaining('opted in'),
    });
  });

  it('local mode, consent declined: off', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '');
    expect(getTelemetryStatus(localEnv, 'declined')).toEqual({
      enabled: false,
      reason: expect.stringContaining('declined'),
    });
  });

  it('local mode, never asked: off, and says so distinctly from a decline', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '');
    const status = getTelemetryStatus(localEnv, undefined);
    expect(status.enabled).toBe(false);
    expect(status.reason).not.toContain('declined');
  });

  it('ALIGN_TELEMETRY=0: off, and wins over a granted local consent', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    expect(getTelemetryStatus(localEnv, 'granted')).toEqual({
      enabled: false,
      reason: expect.stringContaining('ALIGN_TELEMETRY'),
    });
  });

  it('ALIGN_TELEMETRY=0: off, and wins over the cloud opt-out default too', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    expect(getTelemetryStatus(cloudEnv, undefined).enabled).toBe(false);
  });

  it('all four required states are textually distinct', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '');
    const cloudOptOut = getTelemetryStatus(cloudEnv, undefined).reason;
    const localGranted = getTelemetryStatus(localEnv, 'granted').reason;
    const localDeclined = getTelemetryStatus(localEnv, 'declined').reason;
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    const globalOff = getTelemetryStatus(localEnv, 'granted').reason;

    const reasons = [cloudOptOut, localGranted, localDeclined, globalOff];
    expect(new Set(reasons).size).toBe(4);
  });
});
