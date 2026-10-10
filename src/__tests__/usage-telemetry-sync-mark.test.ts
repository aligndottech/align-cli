/**
 * L7: `sync` and `mark` as command names, now that the gateway's closed list has them
 * (align-stack #3082). Command name only, never arguments, and never from the background child
 * or an agent hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

let consent: 'granted' | 'declined' | 'off' | undefined;
let noticeShownAt: string | undefined;
const env = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => consent,
    getTelemetryNoticeShownAt: () => noticeShownAt,
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
    getEnvironment: () => env,
  }),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: () => 'local' }));

import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';
import { recordCommandUsage, recordInvocationUsage } from '../lib/usage-telemetry.js';

const fetchMock = vi.fn();
const sentBody = (): Record<string, unknown> => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);

beforeEach(() => {
  consent = undefined;
  noticeShownAt = '2026-10-10T00:00:00.000Z';
  clearTelemetryEnv();
  resetHookContextForTests();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetHookContextForTests(); });

describe('sync and mark usage pings', () => {
  it.each(['sync', 'mark'])('a foreground `%s` sends one cli.command with the bare command name', async (cmd) => {
    await recordInvocationUsage(undefined, cmd);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({ installId: '11111111-1111-4111-8111-111111111111', command: cmd, cliVersion: expect.any(String) });
  });

  it('a background sync (the detached child) sends no usage ping', async () => {
    await recordInvocationUsage(undefined, 'sync', { background: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a foreground sync with background explicitly false still sends', async () => {
    await recordInvocationUsage(undefined, 'sync', { background: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['sync github --status', 'mark conflict CANARY-id-1 CANARY-id-2 real', 'mark CANARY-id note CANARY-text'])('never carries arguments: %s', async (full) => {
    await recordCommandUsage(env, full);
    const body = sentBody();
    expect(body['command']).toBe(full.split(' ')[0]);
    expect(JSON.stringify(body)).not.toContain('CANARY');
  });

  it.each([
    ['off', () => { consent = 'off'; }],
    ['declined', () => { consent = 'declined'; }],
    ['DO_NOT_TRACK', () => { vi.stubEnv('DO_NOT_TRACK', '1'); }],
    ['CI', () => { vi.stubEnv('CI', 'true'); }],
    ['a hook', () => { markHookContext(); }],
    ['no notice shown', () => { noticeShownAt = undefined; }],
  ])('%s: neither sync nor mark sends', async (_name, arrange) => {
    arrange();
    await recordCommandUsage(env, 'sync');
    await recordCommandUsage(env, 'mark');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
