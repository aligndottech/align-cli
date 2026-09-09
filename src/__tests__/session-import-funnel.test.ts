/**
 * ALI-835: the summary line a human reads, and the hook guard on the funnel emitter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked at the module boundary: recordFunnelStage resolves the config store dynamically, and
// the real one reads a machine's stored consent - which would make "does the guard fire" depend
// on whoever ran the suite. `granted` is the state in which a session stage may send, so it is
// the only state where a hook guard has anything to refuse.
// PARTIAL mock, via importOriginal: config.js also exports ALIGN_HOSTED_GATEWAY_URL, which
// postAnonymous reads to build the target. Replacing the whole module made every send throw
// inside the emitter's own catch, which returns false - so the guard test failed for a reason
// that had nothing to do with the guard, and looked exactly like the guard working.
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getInstallId: () => '11111111-1111-4111-8111-111111111111',
    getTelemetryConsent: () => 'granted',
    wasFunnelStageRecorded: () => false,
    markFunnelStageRecorded: () => {},
  }),
}));

import { renderImportSummary } from '../lib/sessions/import-summary.js';
import { inHookContext, markHookContext, resetHookContextForTests } from '../lib/hook-context.js';
import { FUNNEL_STAGES, recordFunnelStage, SESSION_IMPORT_STAGES } from '../lib/usage-telemetry.js';

describe('the session-import stages', () => {
  it('are all four, and all four are real funnel stages', () => {
    // A list of four names is four claims. Pinned as a set, and cross-checked against
    // FUNNEL_STAGES so a stage cannot be measured here while the emitter refuses to send it.
    expect([...SESSION_IMPORT_STAGES]).toEqual([
      'sessions_scanned', 'candidates_found', 'candidates_confirmed', 'decisions_ratified',
    ]);
    for (const stage of SESSION_IMPORT_STAGES) {
      expect(FUNNEL_STAGES as readonly string[]).toContain(stage);
    }
  });
});

describe('renderImportSummary', () => {
  it('renders the demo line with real counts', () => {
    expect(renderImportSummary({
      sessionsScanned: 12, candidatesFound: 41, candidatesConfirmed: 41, ratified: 0,
    })).toBe('Found 41 decisions across 12 sessions. 41 were made by an agent. 0 have been ratified.');
  });

  it('renders honestly at zero, and says how much it read', () => {
    // The ticket's own distinction: "Found 0 decisions in 3 sessions" is a different sentence
    // from a crash, and a different sentence from one that does not say what was scanned.
    expect(renderImportSummary({
      sessionsScanned: 3, candidatesFound: 0, candidatesConfirmed: 0, ratified: 0,
    })).toBe('Found 0 decisions in 3 sessions.');
  });

  it('renders zero sessions without pretending otherwise', () => {
    expect(renderImportSummary({
      sessionsScanned: 0, candidatesFound: 0, candidatesConfirmed: 0, ratified: 0,
    })).toBe('Found 0 decisions in 0 sessions.');
  });

  it.each([
    [{ sessionsScanned: 1, candidatesFound: 1, candidatesConfirmed: 1, ratified: 1 },
      'Found 1 decision across 1 session. 1 was made by an agent. 1 has been ratified.'],
    [{ sessionsScanned: 2, candidatesFound: 2, candidatesConfirmed: 2, ratified: 2 },
      'Found 2 decisions across 2 sessions. 2 were made by an agent. 2 have been ratified.'],
  ])('agrees with itself on singular and plural', (counts, expected) => {
    // Two examples per rule: one drives the singular branch, the other forces it to generalise.
    // "1 sessions" in a live demo costs more attention than the whole line earns.
    expect(renderImportSummary(counts)).toBe(expected);
  });

  it('names the confirmed count only when it differs from the found count', () => {
    const all = renderImportSummary({ sessionsScanned: 4, candidatesFound: 9, candidatesConfirmed: 9, ratified: 0 });
    const some = renderImportSummary({ sessionsScanned: 4, candidatesFound: 9, candidatesConfirmed: 3, ratified: 0 });
    expect(all).not.toContain('confirmed this run');
    // The positive control for the negative assertion above: the clause is reachable, so its
    // absence in the first case is a decision rather than a clause that never renders.
    expect(some).toContain('3 confirmed this run.');
  });
});

describe('hook context', () => {
  beforeEach(() => resetHookContextForTests());
  afterEach(() => resetHookContextForTests());

  it('is off by default', () => {
    // The precondition stated rather than inherited: module state outlives a test file, so
    // without the reset one marking case would silently mark every case after it.
    expect(inHookContext()).toBe(false);
  });

  it('is on once marked', () => {
    markHookContext();
    expect(inHookContext()).toBe(true);
  });
});

describe('recordFunnelStage refuses to send from a hook', () => {
  /**
   * Both sides, driven through the REAL emitter rather than a stub of it, because the guard is
   * the subject. A refusal-only test passes against an emitter that sends nothing, and a
   * send-only test against one that sends from everywhere.
   *
   * `fetch` is stubbed so the sending case has somewhere to send: the emitter's boolean is the
   * assertion, and the stub also lets the payload be read, which is how the count and agent
   * reach the ping at all.
   */
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    resetHookContextForTests();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    // Stated, not inherited: a runner that exported either switch would turn every send off and
    // the "sends outside a hook" case would pass for the wrong reason.
    vi.stubEnv('ALIGN_TELEMETRY', '1');
    vi.stubEnv('DO_NOT_TRACK', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetHookContextForTests();
  });

  const LOCAL_ENV = { mode: 'local-embedded' } as never;

  it('sends outside a hook, and carries the count and agent', async () => {
    const sent = await recordFunnelStage(LOCAL_ENV, 'sessions_scanned', 'import sessions', { count: 12, agent: 'claude-code' });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Assert the request, not just that one happened: a payload missing the measurement is the
    // failure this stage exists to avoid, and it would otherwise look identical to a success.
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
    expect(body.stage).toBe('sessions_scanned');
    expect(body.count).toBe(12);
    expect(body.agent).toBe('claude-code');
  });

  it('refuses inside a hook, and never reaches the network', async () => {
    markHookContext();
    const sent = await recordFunnelStage(LOCAL_ENV, 'sessions_scanned', 'import sessions', { count: 12, agent: 'claude-code' });
    expect(sent).toBe(false);
    // Fails closed before the network, so a hook cannot even attempt a send.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a measurement passed with a stage the gateway refuses one on', async () => {
    // Copilot on #286. The boundary is two-sided and only this half is new: a measurement on
    // `mcp_wired` must not reach the wire, because the gateway's schema is `.strict()` with a
    // superRefine refusing `count` and `agent` there - it would 400 the whole ping, and the
    // emitter's catch swallows a 400, so the stage would go silently missing. Dropping the two
    // fields keeps the stage. The other half - a measurement on a session stage DOES travel -
    // is the first case in this block, so neither direction is asserted alone.
    const sent = await recordFunnelStage(LOCAL_ENV, 'mcp_wired', 'setup', { count: 99, agent: 'codex' });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
    // Positive control for the two absences: the ping really was built and really carries the
    // stage, so `count` being absent means dropped rather than never-sent.
    expect(body.stage).toBe('mcp_wired');
    expect('count' in body).toBe(false);
    expect('agent' in body).toBe(false);
  });

  it('drops it on the cloud path too, not only the local one', async () => {
    // Two payload sites are built separately in the emitter, so one enforcement point is a
    // claim about both. Asserted per path rather than in a lump: gating only the local spread
    // would leave this red while every other case here stayed green.
    const CLOUD_ENV = { mode: 'cloud', gatewayUrl: 'https://example.invalid', authToken: 't', tenantId: 'tn' } as never;
    const sent = await recordFunnelStage(CLOUD_ENV, 'mcp_wired', 'setup', { count: 99, agent: 'codex' });
    expect(sent).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
    expect(body.properties.command).toBe('setup');
    expect('count' in body.properties).toBe(false);
    expect('agent' in body.properties).toBe(false);
  });

  it('omits count and agent entirely when there is no measurement', async () => {
    // The gateway schema is `.strict()` and refuses both fields on non-session stages, so an
    // explicit `undefined` key would 400. Absent means absent.
    const sent = await recordFunnelStage(LOCAL_ENV, 'decisions_ratified', 'ratify');
    expect(sent).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
    expect('count' in body).toBe(false);
    expect('agent' in body).toBe(false);
  });
});
