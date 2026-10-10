/**
 * L7: the `source_synced` funnel stage. One anonymous ping per source per completed sync, with a
 * count and four closed enums and nothing else. The gateway (align-stack #3082,
 * telemetryAnonymousRoutes.ts) refuses any other field and any value outside its lists, so a body
 * that strays is a silent 400: these tests pin both the allowed shape and every boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

let consent: 'granted' | 'declined' | 'off' | undefined = 'granted';
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

import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';
import { FUNNEL_STAGES, recordFunnelStage, type SyncMeasurement } from '../lib/usage-telemetry.js';

const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
const cloud = { gatewayUrl: 'http://x', authToken: 't', tenantId: 'tn', mode: 'auth' as const };
const fetchMock = vi.fn();
const sentBody = (): Record<string, unknown> => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
const M: SyncMeasurement = { count: 412, source: 'github', outcome: 'partial', scope: 'team', trigger: 'background' };

beforeEach(() => {
  noticeShownAt = '2026-10-10T00:00:00.000Z';
  clearTelemetryEnv();
  resetHookContextForTests();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  consent = undefined;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetHookContextForTests(); });

describe('the source_synced stage', () => {
  it('is a funnel stage', () => {
    expect(FUNNEL_STAGES as readonly string[]).toContain('source_synced');
  });

  it('default-on after the notice: exactly one ping with exactly the allowed fields', async () => {
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({
      installId: '11111111-1111-4111-8111-111111111111',
      command: 'sync',
      cliVersion: expect.any(String),
      stage: 'source_synced',
      count: 412, source: 'github', outcome: 'partial', scope: 'team', trigger: 'background',
    });
  });

  it('granted consent sends too, even before the notice', async () => {
    consent = 'granted';
    noticeShownAt = undefined;
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(true);
  });

  it('a notice that has not printed and no consent sends nothing', async () => {
    noticeShownAt = undefined;
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['declined', 'off'] as const)('stored %s sends nothing', async (c) => {
    consent = c;
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['DO_NOT_TRACK', 'ALIGN_TELEMETRY'] as const)('%s sends nothing, over a granted consent', async (name) => {
    consent = 'granted';
    vi.stubEnv(name, name === 'DO_NOT_TRACK' ? '1' : '0');
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CI sends nothing', async () => {
    vi.stubEnv('CI', 'true');
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an agent hook sends nothing', async () => {
    markHookContext();
    expect(await recordFunnelStage(local, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is local-only: a cloud env sends nothing (the gateway endpoint is the anonymous one)', async () => {
    expect(await recordFunnelStage(cloud, 'source_synced', 'sync', M)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing without a measurement (the gateway requires all five fields)', async () => {
    expect(await recordFunnelStage(local, 'source_synced', 'sync')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['source', 'myspace'], ['outcome', 'locked'], ['scope', 'repo:acme/secret'], ['trigger', 'mcp'],
  ] as const)('a %s outside the closed list is dropped, not sent', async (field, value) => {
    expect(await recordFunnelStage(local, 'source_synced', 'sync', { ...M, [field]: value } as unknown as SyncMeasurement)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, 100_001])('a count of %s is not sent as-is', async (count) => {
    const sent = await recordFunnelStage(local, 'source_synced', 'sync', { ...M, count });
    if (sent) {
      const c = sentCount();
      expect(Number.isInteger(c) && c >= 0 && c <= 100_000).toBe(true);
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('never carries a field outside the whitelist, whatever the caller hands in', async () => {
    const canary = 'CANARY-title-repo-org-https://example.com/acme/secret';
    const dirty = { ...M, title: canary, repo: canary, org: canary, url: canary, id: canary, agent: 'claude-code' } as unknown as SyncMeasurement;
    expect(await recordFunnelStage(local, 'source_synced', 'sync', dirty)).toBe(true);
    expect(Object.keys(sentBody()).sort()).toEqual(['cliVersion', 'command', 'count', 'installId', 'outcome', 'scope', 'source', 'stage', 'trigger']);
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('CANARY');
  });

  it('the measurement is dropped on every other stage (the gateway would 400 the whole ping)', async () => {
    await recordFunnelStage(local, 'mcp_wired', 'mcp', M as unknown as { count: number; agent: string });
    const body = sentBody();
    for (const k of ['count', 'source', 'outcome', 'scope', 'trigger']) expect(body).not.toHaveProperty(k);
  });
});

function sentCount(): number {
  return sentBody()['count'] as number;
}
