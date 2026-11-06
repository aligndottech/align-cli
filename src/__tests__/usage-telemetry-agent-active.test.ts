/**
 * ALI-2076: `agent_active`, the once-a-day signal that an agent used Align through its MCP tools.
 * `align mcp` sends one `cli.command mcp` when the SERVER starts, so an agent that keeps one server
 * running for a week (an editor window left open) was invisible after day 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

let consent: 'granted' | 'declined' | 'off' | undefined;
let noticeShownAt: string | undefined;
let lastDay: string | undefined;
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => consent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
    getAgentActiveDay: () => lastDay,
    setAgentActiveDay: (d: string) => { lastDay = d; },
  }),
}));

import { FUNNEL_STAGES, recordFunnelStage } from '../lib/usage-telemetry.js';

const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
const cloud = { gatewayUrl: 'http://x', authToken: 'tok', tenantId: 't1', mode: 'cloud' as const };
const fetchMock = vi.fn();
const bodies = (): Array<Record<string, unknown>> => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

beforeEach(() => {
  clearTelemetryEnv();
  consent = undefined;
  noticeShownAt = '2026-11-01T00:00:00.000Z';
  lastDay = undefined;
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T09:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the agent_active stage', () => {
  it('is a funnel stage', () => {
    expect(FUNNEL_STAGES as readonly string[]).toContain('agent_active');
  });

  it('sends install id, command mcp, version and the stage, and nothing else', async () => {
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(true);
    const [body] = bodies();
    expect(Object.keys(body!).sort()).toEqual(['cliVersion', 'command', 'installId', 'stage']);
    expect(body).toMatchObject({ stage: 'agent_active', command: 'mcp' });
  });

  it('sends once per UTC day: a second call the same day sends nothing, the next day sends again', async () => {
    await recordFunnelStage(local, 'agent_active', 'mcp');
    vi.setSystemTime(new Date('2026-11-02T23:59:00Z'));
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-03T00:01:00Z'));
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for the notice in local mode, like every local event', async () => {
    noticeShownAt = undefined;
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastDay).toBeUndefined();
  });

  it.each(['declined', 'off'] as const)('sends nothing after a stored %s', async (c) => {
    consent = c;
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['DO_NOT_TRACK', 'ALIGN_TELEMETRY'] as const)('sends nothing under %s', async (name) => {
    vi.stubEnv(name, name === 'DO_NOT_TRACK' ? '1' : '0');
    expect(await recordFunnelStage(local, 'agent_active', 'mcp')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is local-mode only: cloud records mcp.tool_invoked on the server already', async () => {
    expect(await recordFunnelStage(cloud, 'agent_active', 'mcp')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a measurement: no count, no agent', async () => {
    await recordFunnelStage(local, 'agent_active', 'mcp', { count: 3, agent: 'claude-code' });
    const [body] = bodies();
    expect(body).not.toHaveProperty('count');
    expect(body).not.toHaveProperty('agent');
  });
});
