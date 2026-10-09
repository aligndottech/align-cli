/**
 * C6: local-mode telemetry is opt-out, disclosed by a one-time notice on stderr that prints
 * BEFORE anything is sent. The notice is the disclosure, so nothing that depends on it can send
 * until it has been shown - and it is skipped (and not marked) wherever nobody is reading:
 * CI, an agent hook, the `mcp` server, a run already inside a launched agent (ALIGN_WRAPPED),
 * and under an env switch that turns everything off anyway.
 *
 * The config store is a stateful fake: marking the notice or a stage is visible to the next
 * call, the way the real Conf store is, without touching ~/.config/align-cli.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig, TelemetryConsent } from '../lib/config.js';

const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');
const state = vi.hoisted(() => ({
  consent: undefined as TelemetryConsent | undefined,
  noticeShownAt: undefined as string | undefined,
  stages: [] as string[],
  env: { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' } as EnvironmentConfig,
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent: () => state.consent,
    setTelemetryConsent: (v: TelemetryConsent) => { state.consent = v; },
    getTelemetryNoticeShownAt: () => state.noticeShownAt,
    markTelemetryNoticeShown: () => { state.noticeShownAt = '2026-10-10T00:00:00.000Z'; },
    getInstallId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    wasFunnelStageRecorded: (s: string) => state.stages.includes(s),
    markFunnelStageRecorded: (s: string) => { if (!state.stages.includes(s)) state.stages.push(s); },
    getEnvironment: () => state.env,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

import { beginInvocationTelemetry, recordCommandUsage, recordFunnelStage } from '../lib/usage-telemetry.js';
import { TELEMETRY_NOTICE } from '../lib/telemetry-consent.js';
import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';

const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

const localEnv: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };

let stderrSpy: ReturnType<typeof vi.spyOn>;

/** What cli.ts's preAction does on any run: the notice, then the install beacon. */
async function runCommand(commandPath = 'ask', hook = false): Promise<void> {
  const { beaconSent } = await beginInvocationTelemetry(commandPath, { hook });
  await beaconSent;
}

function noticeWrites(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('anonymous usage counts'));
}

describe('the one-time telemetry notice', () => {
  beforeEach(() => {
    // The CI runner sets CI=true and GITHUB_ACTIONS=true. Both are inputs here, so both are
    // cleared, and the two env switches with them, rather than inherited (tdd.md).
    for (const k of ['CI', 'GITHUB_ACTIONS', 'DO_NOT_TRACK', 'ALIGN_TELEMETRY', 'ALIGN_WRAPPED', 'ALIGN_GATEWAY_URL']) {
      vi.stubEnv(k, undefined);
    }
    state.consent = undefined;
    state.noticeShownAt = undefined;
    state.stages = [];
    state.env = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(null, { status: 201 }));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetHookContextForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stderrSpy.mockRestore();
    resetHookContextForTests();
  });

  it('the copy is the founder-approved wording, word for word', () => {
    expect(TELEMETRY_NOTICE).toBe(
      'Align sends anonymous usage counts: which commands and coding agent you use,\n' +
        'which tools you connect and how many items, the CLI version, and your OS.\n' +
        'Never code, decision text, or file, repo or org names.\n' +
        'Turn it off: align telemetry off (or DO_NOT_TRACK=1). Details: align.tech/privacy#cli',
    );
  });

  it('shows the notice before the first send, then sends the install beacon', async () => {
    const order: string[] = [];
    stderrSpy.mockImplementation((s) => { order.push(`notice:${String(s).slice(0, 12)}`); return true; });
    fetchSpy.mockImplementation(async () => { order.push('send'); return new Response(null, { status: 201 }); });

    await runCommand();

    expect(order[0]).toMatch(/^notice:/);
    expect(order).toContain('send');
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain(TELEMETRY_NOTICE);
    expect(state.noticeShownAt).toBeDefined();
    expect(state.stages).toContain('install');
  });

  it('shows the notice once: a second run prints nothing and sends no second install', async () => {
    await runCommand();
    expect(noticeWrites()).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await runCommand();
    expect(noticeWrites()).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('after the notice, with no consent decision, a cli.command ping sends', async () => {
    await runCommand();
    fetchSpy.mockClear();

    await recordCommandUsage(localEnv, 'ask');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ command: 'ask' });
  });

  it('before the notice, with no consent decision, a cli.command ping does not send', async () => {
    await recordCommandUsage(localEnv, 'ask');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps an existing decline: no usage ping, no notice, and the beacons still send', async () => {
    state.consent = 'declined';

    await recordCommandUsage(localEnv, 'ask');
    expect(fetchSpy).not.toHaveBeenCalled();

    await runCommand();
    expect(noticeWrites()).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the install beacon, as before C6
    await expect(recordFunnelStage(localEnv, 'setup_completed', 'setup')).resolves.toBe(true);
    await expect(recordFunnelStage(localEnv, 'setup_started', 'setup')).resolves.toBe(false);
  });

  it('`align telemetry off` (stored off) sends nothing and shows no notice', async () => {
    state.consent = 'off';
    await runCommand();
    await recordCommandUsage(localEnv, 'ask');
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(noticeWrites()).toHaveLength(0);
  });

  it('`align telemetry on` still sends usage without the notice (granted is unchanged)', async () => {
    state.consent = 'granted';
    await recordCommandUsage(localEnv, 'ask');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([['DO_NOT_TRACK', '1'], ['ALIGN_TELEMETRY', '0']])('under %s=%s: no notice and nothing sends', async (k, v) => {
    vi.stubEnv(k, v);
    await runCommand();
    state.noticeShownAt = '2026-10-10T00:00:00.000Z'; // even with the notice already shown
    await recordCommandUsage(localEnv, 'ask');
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(noticeWrites()).toHaveLength(0);
  });

  it.each([['CI', 'true'], ['GITHUB_ACTIONS', 'true']])('under %s=%s alone: no notice, no send, and nothing is marked', async (k, v) => {
    vi.stubEnv(k, v);
    await runCommand();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(noticeWrites()).toHaveLength(0);
    expect(state.stages).not.toContain('install');
    expect(state.noticeShownAt).toBeUndefined();

    // Even a user who granted consent on their laptop sends nothing from CI.
    state.consent = 'granted';
    await recordCommandUsage(localEnv, 'ask');
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('in hook context: no notice, nothing marked, and no cli.command ping even after the notice', async () => {
    await runCommand('check', true);
    expect(noticeWrites()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.noticeShownAt).toBeUndefined();
    expect(state.stages).not.toContain('install');

    state.noticeShownAt = '2026-10-10T00:00:00.000Z';
    markHookContext();
    await recordCommandUsage(localEnv, 'check');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('`align mcp` as the first-ever command: no notice, no send, and the first run is not consumed', async () => {
    await runCommand('mcp');
    expect(noticeWrites()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.noticeShownAt).toBeUndefined();
    expect(state.stages).not.toContain('install');
  });

  it('inside a launched agent (ALIGN_WRAPPED): no notice, no send, nothing marked', async () => {
    vi.stubEnv('ALIGN_WRAPPED', '1');
    await runCommand('ask');
    expect(noticeWrites()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.noticeShownAt).toBeUndefined();
  });

  it('`align telemetry ...` as the first command: no notice (the off switch is not raced by it)', async () => {
    await runCommand('telemetry off');
    expect(noticeWrites()).toHaveLength(0);
    expect(state.noticeShownAt).toBeUndefined();
  });

  it('a run already holding a cloud token: no notice (cloud mode has its own, authenticated events)', async () => {
    state.env = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't1', mode: 'auth' };
    await runCommand('ask');
    expect(noticeWrites()).toHaveLength(0);
    expect(state.noticeShownAt).toBeUndefined();
  });
});
