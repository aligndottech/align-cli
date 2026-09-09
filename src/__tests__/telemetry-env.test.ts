/**
 * ALI-954: the two environment variables that turn ALL telemetry off - both tiers, the
 * default-on beacons included. `ALIGN_TELEMETRY` is ours (set and not recognisably ON means
 * OFF, ALI-618). `DO_NOT_TRACK` is the cross-tool convention (consoledonottrack.com): set to
 * anything that is not recognisably OFF means "do not track". The two read in opposite
 * directions on purpose - each errs toward sending nothing.
 *
 * Lives in its own module so the consent prompt can ask the same question without importing
 * the emitter (setup.test.ts mocks usage-telemetry.js down to one function).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telemetryDisabledByEnv } from '../lib/telemetry-env.js';

afterEach(() => vi.unstubAllEnvs());

describe('telemetryDisabledByEnv', () => {
  it('neither variable set: not disabled', () => {
    vi.stubEnv('ALIGN_TELEMETRY', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    expect(telemetryDisabledByEnv()).toBeUndefined();
  });

  it('DO_NOT_TRACK=1 names DO_NOT_TRACK', () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(telemetryDisabledByEnv()).toBe('DO_NOT_TRACK');
  });

  // Second example: the convention says "1", and a user who types "true" means the same thing.
  it('DO_NOT_TRACK=true also disables', () => {
    vi.stubEnv('DO_NOT_TRACK', 'true');
    expect(telemetryDisabledByEnv()).toBe('DO_NOT_TRACK');
  });

  it.each(['0', 'false', 'no', 'off', '', '  '])('DO_NOT_TRACK=%j is not a request to stop', (v) => {
    vi.stubEnv('DO_NOT_TRACK', v);
    expect(telemetryDisabledByEnv()).toBeUndefined();
  });

  it('ALIGN_TELEMETRY=0 names ALIGN_TELEMETRY', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    expect(telemetryDisabledByEnv()).toBe('ALIGN_TELEMETRY');
  });

  // The ALI-618 reading is preserved: any value that is not recognisably ON is OFF.
  it('ALIGN_TELEMETRY=disabled is OFF (set and not recognisably on)', () => {
    vi.stubEnv('ALIGN_TELEMETRY', 'disabled');
    expect(telemetryDisabledByEnv()).toBe('ALIGN_TELEMETRY');
  });

  it.each(['1', 'true', 'yes', 'on', ''])('ALIGN_TELEMETRY=%j leaves telemetry on', (v) => {
    vi.stubEnv('ALIGN_TELEMETRY', v);
    expect(telemetryDisabledByEnv()).toBeUndefined();
  });

  it('both set: ALIGN_TELEMETRY=1 does not override DO_NOT_TRACK=1', () => {
    vi.stubEnv('ALIGN_TELEMETRY', '1');
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(telemetryDisabledByEnv()).toBe('DO_NOT_TRACK');
  });
});
