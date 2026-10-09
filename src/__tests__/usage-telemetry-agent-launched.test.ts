import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let consent: 'granted' | 'declined' | 'off' | undefined = 'granted';
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => consent,
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
  }),
}));

import { FUNNEL_STAGES, recordFunnelStage } from '../lib/usage-telemetry.js';

const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
const fetchMock = vi.fn();
const sentBody = (): Record<string, unknown> => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('DO_NOT_TRACK', undefined);
  vi.stubEnv('ALIGN_TELEMETRY', undefined);
  consent = 'granted';
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the agent_launched stage', () => {
  it('is a funnel stage', () => {
    expect(FUNNEL_STAGES as readonly string[]).toContain('agent_launched');
  });
  it('sends the agent name and no count, under granted consent', async () => {
    expect(await recordFunnelStage(local, 'agent_launched', 'align', { agent: 'claude-code' })).toBe(true);
    const body = sentBody();
    expect(body).toMatchObject({ stage: 'agent_launched', agent: 'claude-code', command: 'align' });
    expect(body).not.toHaveProperty('count');
  });
  it.each([undefined, 'declined', 'off'] as const)('sends nothing when consent is %s', async (c) => {
    consent = c;
    expect(await recordFunnelStage(local, 'agent_launched', 'align', { agent: 'claude-code' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sends nothing under DO_NOT_TRACK=1', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(await recordFunnelStage(local, 'agent_launched', 'align', { agent: 'claude-code' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('still drops the agent field on a stage that may not carry one', async () => {
    await recordFunnelStage(local, 'mcp_wired', 'align', { agent: 'claude-code' });
    expect(sentBody()).not.toHaveProperty('agent');
  });
});
