/**
 * The redaction notice is printed by cli.ts's postAction hook, so it is tested through the real
 * command tree. `align sync` with no graph returns early and touches no network (see
 * usage-telemetry-sync-wiring.test.ts, whose mocks this copies).
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
import { noteRedacted, takeRedactionNotice } from '../lib/redaction-notice.js';

const fetchMock = vi.fn();

beforeEach(() => {
  clearTelemetryEnv();
  resetHookContextForTests();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetHookContextForTests(); });

describe('the once-per-run redaction notice, printed by the real program after the command', () => {
  it('prints the count once, to stderr, after a command that redacted something', async () => {
    takeRedactionNotice();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    noteRedacted(2);
    noteRedacted(1);
    await buildProgram({ exitOverride: true }).parseAsync(['node', 'align', 'sync']);
    const notices = err.mock.calls.map((c) => String(c[0])).filter((l) => /secrets? \(keys/.test(l));
    expect(notices).toEqual([expect.stringMatching(/^Align replaced 3 secrets /)]);
    expect(takeRedactionNotice()).toBeNull();
  });
  it('prints nothing when nothing was redacted', async () => {
    takeRedactionNotice();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildProgram({ exitOverride: true }).parseAsync(['node', 'align', 'sync']);
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => /secret/.test(l))).toEqual([]);
  });
});
