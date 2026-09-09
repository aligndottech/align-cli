/**
 * ALI-618 D3b: one CLI, two consent semantics (cloud opt-out, local opt-in) is a real user-
 * facing inconsistency unless `align telemetry status` can say WHICH model applies and why.
 * Four distinct outputs are the whole point - a status that cannot tell them apart is the
 * ALI-306 honesty problem restated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { getTelemetryStatus } from '../lib/usage-telemetry.js';

// The environment is an input (tdd.md): a DO_NOT_TRACK exported by whoever runs the suite
// must not decide these tests, so it is cleared here and set only by the tests about it.
beforeEach(() => vi.stubEnv('DO_NOT_TRACK', undefined));
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

  // ALI-954: two anonymous counts (install, setup completed) send by default in local mode,
  // and the status line has to say so wherever usage is off but the beacons are not - a
  // status reading "off" over a beacon that still sends is the ALI-306 honesty problem again.
  describe('the beacon tier (ALI-954)', () => {
    it('DO_NOT_TRACK=1: off, everything, and names the variable', () => {
      vi.stubEnv('DO_NOT_TRACK', '1');
      expect(getTelemetryStatus(localEnv, 'granted')).toEqual({
        enabled: false,
        reason: expect.stringContaining('DO_NOT_TRACK'),
      });
    });

    it('DO_NOT_TRACK=1 wins in cloud mode too', () => {
      vi.stubEnv('DO_NOT_TRACK', '1');
      expect(getTelemetryStatus(cloudEnv, undefined).enabled).toBe(false);
    });

    it('local mode, declined at the prompt: says the two counts still send', () => {
      vi.stubEnv('ALIGN_TELEMETRY', '');
      const status = getTelemetryStatus(localEnv, 'declined');
      expect(status.enabled).toBe(false);
      expect(status.reason).toContain('two anonymous counts');
      expect(status.reason).toContain('align telemetry off');
    });

    it('local mode, never asked: says the two counts still send', () => {
      vi.stubEnv('ALIGN_TELEMETRY', '');
      expect(getTelemetryStatus(localEnv, undefined).reason).toContain('two anonymous counts');
    });

    it('local mode, `align telemetry off`: off, and nothing sends - distinct from a decline', () => {
      vi.stubEnv('ALIGN_TELEMETRY', '');
      const status = getTelemetryStatus(localEnv, 'off');
      expect(status.enabled).toBe(false);
      expect(status.reason).toContain('nothing');
      expect(status.reason).not.toContain('two anonymous counts');
    });
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
