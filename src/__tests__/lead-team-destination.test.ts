import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadState } from '../lib/config.js';
import { type LeadGateInput, leadPromptDecision, leadPromptFor } from '../lib/lead-prompt.js';

/**
 * Join plan C5 (S16): a person who has joined a team is not the audience for Align's email list, and the
 * list is only ever posted to Align's own hosted gateway: never a self-host, never an ALIGN_GATEWAY_URL.
 */
const HOSTED = 'https://api.align.tech';
const person: LeadGateInput = { env: {}, tty: true, hasLogin: false, inCi: false, state: {}, gatewayUrl: HOSTED, hostedGatewayUrl: HOSTED, hasTeamDestination: false };

describe('the decision', () => {
  it('a saved team destination means never asked; with none, the same person is asked', () => {
    expect(leadPromptDecision({ ...person, hasTeamDestination: true })).toBe('has-team-destination');
    expect(leadPromptDecision(person)).toBeNull();
  });
});

function harness(over: { teams?: string[]; cloudGatewayUrl?: string; answer?: string | null } = {}) {
  const h = { asked: 0, outs: [] as string[], marked: 0 };
  const state: LeadState = {};
  const run = () => leadPromptFor({
    store: {
      getLeadState: () => state,
      markLeadPromptShown: () => { h.marked++; },
      setLeadOutcome: () => undefined,
      clearLeadPromptShown: () => undefined,
      listTeamDestinationNames: () => over.teams ?? [],
    },
    cloudGatewayUrl: over.cloudGatewayUrl ?? HOSTED,
    hostedGatewayUrl: HOSTED,
    env: {},
    inCi: false,
    tty: true,
    ask: async (_shown, _q, onShown) => { h.asked++; onShown(); return over.answer === undefined ? 'dev@acme.example' : over.answer; },
    out: (l) => h.outs.push(l),
  })();
  return { h, run };
}

describe('leadPromptFor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never asks, and makes no request, when a team destination is saved', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { h, run } = harness({ teams: ['acme'] });
    expect(await run()).toBe('skipped-by-gate');
    expect(h.asked).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with no team destination, on the hosted gateway, it asks and posts to the hosted URL', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { h, run } = harness();
    expect(await run()).toBe('submitted');
    expect(h.asked).toBe(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`${HOSTED}/leads/team-interest`);
  });

  it('posts to the hosted URL exactly as Align spells it, even when the resolved gateway is a differently written copy of it', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { run } = harness({ cloudGatewayUrl: 'https://API.align.tech/' });
    expect(await run()).toBe('submitted');
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`${HOSTED}/leads/team-interest`);
  });

  it('a self-hosted gateway is never asked and never posted to', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { h, run } = harness({ cloudGatewayUrl: 'https://api.acme.example' });
    expect(await run()).toBe('skipped-by-gate');
    expect(h.asked).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
