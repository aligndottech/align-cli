/**
 * L7: the real command tree, parsed. `align sync` pings once when a person runs it, and
 * `align sync --background` (the detached refresh child) pings nothing. Driven through
 * buildProgram so the postAction wiring in cli.ts is what is tested, not a stand-in.
 * No graph exists in this test, so the sync itself returns early and touches no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

const localEnv = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => undefined,
    getTelemetryNoticeShownAt: () => '2026-10-10T00:00:00.000Z',
    wasFunnelStageRecorded: () => true,
    markFunnelStageRecorded: () => {},
    claimFunnelStage: () => false,
    getEnvironment: () => localEnv,
    recordWrittenConfig: () => {},
    getWrittenConfigs: () => ({}),
    getConnectorFields: () => undefined,
  }),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: () => 'local' }));
vi.mock('../lib/sync/real-env.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  localGraphPath: () => undefined,
}));

import { buildProgram } from '../cli.js';
import { resetHookContextForTests } from '../lib/hook-context.js';

const fetchMock = vi.fn();
const commandsSent = (): unknown[] => fetchMock.mock.calls.map((c) => (JSON.parse((c[1] as { body: string }).body) as { command: string }).command);

beforeEach(() => {
  clearTelemetryEnv();
  resetHookContextForTests();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetHookContextForTests(); });

describe('sync usage wiring in the real program', () => {
  it('a foreground `align sync` sends one cli.command named sync', async () => {
    await buildProgram({ exitOverride: true }).parseAsync(['node', 'align', 'sync']);
    expect(commandsSent()).toEqual(['sync']);
  });

  it('`align sync --background --delay 0` (the detached child) sends nothing', async () => {
    await buildProgram({ exitOverride: true }).parseAsync(['node', 'align', 'sync', '--background', '--delay', '0']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
