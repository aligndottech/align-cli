/**
 * ALI-954: `align telemetry off` stops ALL of it - the default-on beacons included - which is
 * a stronger decision than declining the consent prompt (that only declines usage). So the
 * command stores 'off', not 'declined', and `on` clears it back to 'granted'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { Command } from 'commander';

const setTelemetryConsent = vi.fn();
const getTelemetryConsent = vi.fn();
// C6: whether the one-time telemetry notice has printed. Unset unless a test says otherwise.
let noticeShownAt: string | undefined;
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    setTelemetryConsent,
    getTelemetryConsent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    getEnvironment: () => ({ gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' }),
  }),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('local') }));

import { registerTelemetryCommand } from '../commands/telemetry.js';

function program(): Command {
  const p = new Command().exitOverride();
  registerTelemetryCommand(p);
  return p;
}

describe('align telemetry', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    noticeShownAt = undefined;
    // Every CI variable now turns telemetry off (C6), so all of them are cleared - with the env
    // switches, ALIGN_WRAPPED and the ALIGN_* token/env vars - rather than inherited.
    clearTelemetryEnv();
    setTelemetryConsent.mockReset();
    getTelemetryConsent.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('off stores "off" - both tiers stop, the beacons included', async () => {
    await program().parseAsync(['node', 'align', 'telemetry', 'off']);
    expect(setTelemetryConsent).toHaveBeenCalledWith('off');
  });

  it('on stores "granted"', async () => {
    await program().parseAsync(['node', 'align', 'telemetry', 'on']);
    expect(setTelemetryConsent).toHaveBeenCalledWith('granted');
  });

  it('off says that nothing is sent, so the user knows the beacons stopped too', async () => {
    const log = vi.mocked(console.log);
    await program().parseAsync(['node', 'align', 'telemetry', 'off']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/nothing is sent/i);
  });
});
