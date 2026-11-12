/**
 * Hook and MCP use inside a coding agent is counted, once the install has seen the notice.
 *
 * Test list:
 *  1. after the notice, a hook event and an MCP event each send exactly the fixed key set.
 *  2. they send from hook context and inside a launched agent (ALIGN_WRAPPED): that is the point.
 *  3. nothing sends before the notice, under DO_NOT_TRACK, ALIGN_TELEMETRY=0, CI, a stored off or
 *     declined, or in cloud mode. `telemetry on` (granted) sends without the notice.
 *  4. at most one event per via+tool per window; a different tool, or a later window, sends.
 *  5. a tool or verdict outside the closed lists is dropped, never sent.
 *  6. a dead gateway, a throwing store and a hung request never throw or run past the cap.
 *  7. the MCP verdict class comes from status or result count only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import type { EnvironmentConfig, TelemetryConsent } from '../lib/config.js';

const state = vi.hoisted(() => ({
  consent: undefined as TelemetryConsent | undefined,
  noticeShownAt: undefined as string | undefined,
  sentAt: {} as Record<string, number>,
  throws: false,
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => {
    if (state.throws) throw new Error('store unreadable');
    return {
      getTelemetryConsent: () => state.consent,
      getTelemetryNoticeShownAt: () => state.noticeShownAt,
      getInstallId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      getAgentUseSentAt: (k: string) => state.sentAt[k],
      setAgentUseSentAt: (k: string, at: number) => { state.sentAt[k] = at; },
    };
  },
  ALIGN_HOSTED_GATEWAY_URL: 'https://api.align.tech',
}));

import { AGENT_USE_WINDOW_MS, mcpVerdictClass, recordAgentUse, type AgentUse } from '../lib/agent-use-telemetry.js';
import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';

const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

const local: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
const cloud: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't1', mode: 'auth' };
const HOOK: AgentUse = { via: 'hook', tool: 'check_advisory', verdict: 'conflicting' };
const MCP: AgentUse = { via: 'mcp', tool: 'align_ask', verdict: 'related' };
const NOTICE_SHOWN = '2026-11-12T00:00:00.000Z';

const bodies = (): Record<string, unknown>[] => fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body as string));

describe('recordAgentUse', () => {
  beforeEach(() => {
    clearTelemetryEnv();
    state.consent = undefined;
    state.noticeShownAt = NOTICE_SHOWN;
    state.sentAt = {};
    state.throws = false;
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(null, { status: 201 }));
    resetHookContextForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetHookContextForTests();
  });

  it('sends one hook event with exactly the fixed key set', async () => {
    expect(await recordAgentUse(local, HOOK)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toMatch(/\/telemetry\/anonymous$/);
    const body = bodies()[0]!;
    expect(Object.keys(body).sort()).toEqual(['cliVersion', 'command', 'installId', 'os', 'stage', 'tool', 'verdict', 'via']);
    expect(body).toMatchObject({
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', command: 'check', stage: 'agent_use',
      via: 'hook', tool: 'check_advisory', verdict: 'conflicting', os: process.platform,
    });
    expect(body['cliVersion']).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('sends one MCP event under command mcp', async () => {
    expect(await recordAgentUse(local, MCP)).toBe(true);
    expect(bodies()[0]).toMatchObject({ command: 'mcp', via: 'mcp', tool: 'align_ask', verdict: 'related' });
  });

  it('sends from hook context and from inside a launched agent: those are the runs it counts', async () => {
    markHookContext();
    vi.stubEnv('ALIGN_WRAPPED', '1');
    expect(await recordAgentUse(local, HOOK)).toBe(true);
    expect(await recordAgentUse(local, MCP)).toBe(true);
  });

  it('sends after `align telemetry on` even if no notice printed', async () => {
    state.noticeShownAt = undefined;
    state.consent = 'granted';
    expect(await recordAgentUse(local, HOOK)).toBe(true);
  });

  describe('sends nothing', () => {
    it('before the notice has been shown', async () => {
      state.noticeShownAt = undefined;
      expect(await recordAgentUse(local, HOOK)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(state.sentAt).toEqual({});
    });
    it.each([['DO_NOT_TRACK', '1'], ['ALIGN_TELEMETRY', '0'], ['CI', 'true'], ['GITHUB_ACTIONS', 'true']])('under %s=%s', async (name, value) => {
      vi.stubEnv(name, value);
      expect(await recordAgentUse(local, HOOK)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
    it.each([['off'], ['declined']] as const)('after a stored %s, even with the notice shown', async (consent) => {
      state.consent = consent;
      expect(await recordAgentUse(local, HOOK)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
    it('in cloud mode, which has its own server-side events', async () => {
      expect(await recordAgentUse(cloud, MCP)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('rate limit: one event per via+tool per window', () => {
    it('drops a repeat inside the window, sends a different tool, then sends the first again after the window', async () => {
      const t0 = 1_000_000;
      expect(await recordAgentUse(local, HOOK, { now: t0 })).toBe(true);
      expect(await recordAgentUse(local, HOOK, { now: t0 + AGENT_USE_WINDOW_MS - 1 })).toBe(false);
      expect(await recordAgentUse(local, MCP, { now: t0 + 1 })).toBe(true);
      expect(await recordAgentUse(local, { ...MCP, tool: 'align_search' }, { now: t0 + 2 })).toBe(true);
      expect(await recordAgentUse(local, HOOK, { now: t0 + AGENT_USE_WINDOW_MS })).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
    it('a hook and an MCP call to the same-named key do not share a window', async () => {
      expect(await recordAgentUse(local, HOOK, { now: 5 })).toBe(true);
      expect(await recordAgentUse(local, { via: 'mcp', tool: 'check_advisory', verdict: 'unknown' }, { now: 6 })).toBe(true);
    });
  });

  describe('closed lists', () => {
    it.each([
      [{ ...HOOK, tool: 'src/secret.ts' }], [{ ...HOOK, tool: 'align_made_up' }], [{ ...HOOK, verdict: 'passed' }], [{ ...HOOK, via: 'agent' }],
    ])('drops %j instead of sending it', async (bad) => {
      expect(await recordAgentUse(local, bad as unknown as AgentUse)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('never blocks or fails the caller', () => {
    it('a dead gateway resolves', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(recordAgentUse(local, HOOK)).resolves.toBe(true);
    });
    it('an unreadable store resolves false', async () => {
      state.throws = true;
      await expect(recordAgentUse(local, HOOK)).resolves.toBe(false);
    });
    it('a hung request gives up at the cap', async () => {
      fetchSpy.mockImplementation(() => new Promise(() => {}));
      const started = Date.now();
      await recordAgentUse(local, HOOK, { capMs: 50 });
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});

describe('mcpVerdictClass', () => {
  it.each([
    ['align_check_alignment', { status: 'aligned' }, 'aligned'],
    ['align_check_alignment', { status: 'conflicting' }, 'conflicting'],
    ['align_check_alignment', { status: 'retrieved' }, 'related'],
    ['align_check_alignment', { status: 'no-context' }, 'no_context'],
    ['align_check_alignment', { status: 'unknown' }, 'unknown'],
    ['align_check_alignment', undefined, 'unknown'],
    ['align_ask', { results: [{ title: 'secret decision text' }] }, 'related'],
    ['align_search', { results: [] }, 'no_context'],
    ['align_capture', { id: 'x' }, 'not_applicable'],
    ['align_get_impact', {}, 'not_applicable'],
  ])('%s %j -> %s', (tool, result, expected) => {
    expect(mcpVerdictClass(tool, result)).toBe(expected);
  });
});
