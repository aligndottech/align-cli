import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let consent: 'granted' | 'declined' | 'off' | undefined = 'granted';
// C6: whether the one-time telemetry notice has printed. Unset unless a test says otherwise.
let noticeShownAt: string | undefined;
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => consent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
  }),
}));

import { FUNNEL_STAGES, recordFunnelStage } from '../lib/usage-telemetry.js';

const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
const fetchMock = vi.fn();
const sentBody = (): Record<string, unknown> => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);

beforeEach(() => {

  noticeShownAt = undefined;

  // The CI runner exports CI and GITHUB_ACTIONS; both now turn telemetry off (C6), so both

  // are cleared here rather than inherited, with the two env switches.

  for (const k of ['CI', 'GITHUB_ACTIONS', 'DO_NOT_TRACK', 'ALIGN_TELEMETRY']) vi.stubEnv(k, undefined);
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
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
