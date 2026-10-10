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
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
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
    claimFunnelStage: (s: string) => {
      if (state.stages.includes(s)) return false;
      state.stages.push(s);
      return true;
    },
    releaseFunnelStage: (s: string) => {
      const had = state.stages.includes(s);
      state.stages = state.stages.filter((x) => x !== s);
      return had;
    },
    getEnvironment: () => state.env,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

import { beginInvocationTelemetry, recordCommandUsage, recordFunnelStage } from '../lib/usage-telemetry.js';
import { TELEMETRY_NOTICE } from '../lib/telemetry-consent.js';
import { isHookInvocation, markHookContext, resetHookContextForTests } from '../lib/hook-context.js';

const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

const localEnv: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };

let stderrSpy: ReturnType<typeof vi.spyOn>;

const realTTY = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
};
/** A person at a terminal has both. Set explicitly, never inherited from the runner. */
function setTTY(stdin: boolean, stderr: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: stderr, configurable: true });
}
function restoreTTY(): void {
  for (const [name, desc] of Object.entries(realTTY)) {
    const stream = name === 'stdin' ? process.stdin : process.stderr;
    if (desc) Object.defineProperty(stream, 'isTTY', desc);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
}

/** What cli.ts's preAction does on any run: the notice, then the install beacon. */
async function runCommand(commandPath = 'ask', hook = false): Promise<void> {
  await beginInvocationTelemetry(commandPath, { hook });
}

function noticeWrites(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('anonymous usage counts'));
}

describe('the one-time telemetry notice', () => {
  beforeEach(() => {
    // Every CI variable, the env switches, ALIGN_WRAPPED and the ALIGN_* token/env vars are
    // inputs here, so they are cleared rather than inherited (tdd.md).
    clearTelemetryEnv();
    vi.stubEnv('ALIGN_GATEWAY_URL', undefined);
    state.consent = undefined;
    state.noticeShownAt = undefined;
    state.stages = [];
    state.env = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(null, { status: 201 }));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetHookContextForTests();
    setTTY(true, true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    stderrSpy.mockRestore();
    resetHookContextForTests();
    restoreTTY();
  });

  // P0 (review of e794c6e): the notice is the disclosure every send waits on, so it only counts
  // when a person can read it. With stderr to /dev/null, a pipe, a hook runner, cron, systemd,
  // `docker build` or an agent's Bash tool, printing it and marking it shown made sends begin
  // with nobody told.
  it.each([
    ['stderr is not a terminal', true, false],
    ['stdin is not a terminal', false, true],
    ['neither is a terminal', false, false],
  ])('%s: no notice, nothing marked, nothing sent', async (_label, stdin, stderr) => {
    setTTY(stdin, stderr);
    await runCommand('ask');
    await recordCommandUsage(localEnv, 'ask');
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(noticeWrites()).toHaveLength(0);
    expect(state.noticeShownAt).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays unsent through non-terminal runs, then the first real terminal run shows it and sends', async () => {
    setTTY(false, false);
    await runCommand('ask');
    await runCommand('ask');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.stages).not.toContain('install');

    setTTY(true, true);
    await runCommand('ask');
    expect(noticeWrites()).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.stages).toContain('install');
  });

  // Every command an installed hook runs is hook context: check --hook (pre-commit), check
  // --advisory (every agent's tool hook, agent-rules.ts / user-hooks.ts) and context inject (the
  // Claude Code SessionStart hook, agent-rules.ts's SESSION_INJECT_COMMAND).
  it.each<[string, Record<string, unknown>, boolean]>([
    ['context inject', {}, true],
    ['check', { advisory: true }, true],
    ['check', { hook: true }, true],
    ['check', {}, false],
    ['context', {}, false],
    ['ask', { hook: true }, false],
  ])('isHookInvocation(%s, %o) is %s', (path, opts, expected) => {
    expect(isHookInvocation(path, opts)).toBe(expected);
  });

  it('`align context inject` (the SessionStart hook) sends nothing even on a terminal, and marks nothing', async () => {
    await runCommand('context inject', isHookInvocation('context inject', {}));
    expect(noticeWrites()).toHaveLength(0);
    expect(state.noticeShownAt).toBeUndefined();

    // Even on an install whose notice printed in a terminal earlier, the hook's own ping is refused.
    state.noticeShownAt = '2026-10-10T00:00:00.000Z';
    await recordCommandUsage(localEnv, 'context inject');
    expect(fetchSpy).not.toHaveBeenCalled();
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

  // The privacy page: "If you turned telemetry off earlier, it stays off." A stored No from the
  // old consent question is that, so it now stops the beacons too.
  it('keeps an existing decline as off: no notice, no usage ping, and no beacon', async () => {
    state.consent = 'declined';

    await recordCommandUsage(localEnv, 'ask');
    await runCommand();
    expect(noticeWrites()).toHaveLength(0);
    await expect(recordFunnelStage(localEnv, 'setup_completed', 'setup')).resolves.toBe(false);
    await expect(recordFunnelStage(localEnv, 'setup_started', 'setup')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('a stored decision in cloud mode', () => {
    const cloudEnv: EnvironmentConfig = { gatewayUrl: 'https://gw.example', authToken: 'tok', tenantId: 't1', mode: 'auth' };
    const ingestCalls = () => fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/telemetry/ingest'));

    it('`align telemetry off` stops cloud events too: no POST to /telemetry/ingest', async () => {
      state.consent = 'off';
      await recordCommandUsage(cloudEnv, 'ask');
      await expect(recordFunnelStage(cloudEnv, 'first_useful_decision', 'ask')).resolves.toBe(false);
      expect(ingestCalls()).toHaveLength(0);
    });

    it.each([['granted'], [undefined]] as const)('consent %s: cloud events still send (unchanged)', async (consent) => {
      state.consent = consent;
      await recordCommandUsage(cloudEnv, 'ask');
      await expect(recordFunnelStage(cloudEnv, 'mcp_wired', 'mcp')).resolves.toBe(true);
      expect(ingestCalls()).toHaveLength(2);
    });
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
