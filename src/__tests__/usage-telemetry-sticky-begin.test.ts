/**
 * beginInvocationTelemetry (the preAction every command passes through) makes an env opt-out
 * sticky BEFORE the notice and the install beacon can send, and for hook runs too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

const events: string[] = [];
let consent: string | undefined;
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => consent,
    setTelemetryOffByEnv: (via: string) => { events.push(`store:${via}`); consent = 'off'; },
    getTelemetryNoticeShownAt: () => '2026-10-10T00:00:00.000Z',
    markTelemetryNoticeShown: () => {},
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
    claimFunnelStage: () => true,
    releaseFunnelStage: () => {},
    getEnvironment: () => ({ gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' }),
  }),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: () => 'local' }));
import { beginInvocationTelemetry } from '../lib/usage-telemetry.js';
import { resetHookContextForTests } from '../lib/hook-context.js';

const fetchMock = vi.fn(async () => { events.push('send'); return new Response('{}'); });
beforeEach(() => { events.length = 0; consent = undefined; clearTelemetryEnv(); resetHookContextForTests(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetHookContextForTests(); });

describe('beginInvocationTelemetry and an env opt-out', () => {
  it('stores the opt-out and sends nothing', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    await beginInvocationTelemetry('ask', { hook: false });
    expect(events).toEqual(['store:DO_NOT_TRACK']);
  });
  it('a hook run stores it too', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');
    await beginInvocationTelemetry('check', { hook: true });
    expect(events).toEqual(['store:ALIGN_TELEMETRY']);
  });
  it('an mcp run stores it too', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    await beginInvocationTelemetry('mcp', { hook: false });
    expect(events).toEqual(['store:DO_NOT_TRACK']);
  });
  it('positive control: with no variable it stores nothing and the install beacon still sends', async () => {
    await beginInvocationTelemetry('ask', { hook: false });
    expect(events).toEqual(['send']);
  });
});
