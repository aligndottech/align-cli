import { describe, expect, it, vi } from 'vitest';

import { dispatchTool, instructionsFor, TOOL_SCHEMAS } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

/**
 * ALI-1070 slice 1: the timeline trio reaches a customer's agent.
 *
 * `align mcp` is the server `align mcp --setup` wires into every customer's agent, and it
 * registered 8 tools against the hosted endpoint's 24. The three ported here are the
 * measured lever on AlignBench's weakest split (`reversed`), and they are a TRIO on purpose:
 * get_topic_timeline's own runtime message names the rationale tool, and its description
 * names the other two. Shipping the timeline alone hands the agent a rendering contract
 * instructing it to call tools this server does not have - the defect align-stack's
 * ALIGN_MCP_INSTRUCTIONS_READ_ONLY exists to prevent on the hosted side.
 *
 * THE MESSAGE IS THE PRODUCT. The gateway already returns the whole story structure; what
 * the hosted connector adds is a projection plus a rendering contract, and the contract is
 * where the measured behaviour lives. Rows without the contract give a customer the data and
 * not the ability to tell a supersession from a correction, which is the `reversed` split.
 * So the clause assertions below are the load-bearing half of this file, not decoration.
 *
 * Test List:
 *  - dispatch: each of the three reaches the right client method with the right arguments
 *  - dispatch: each required argument is enforced (derived from inputSchema.required)
 *  - surface: 11 tools, exact name set, write set still exactly two
 *  - surface: no tool description or message names a tool this server does not register
 *  - contract: PARTIAL notice, both directions (semantic false / true)
 *  - contract: the ALI-1010 corrected-vs-superseded clause, both directions
 *  - contract: a corrected row is excluded from the superseded count
 *  - contract: the ALI-590 background clause, both directions (chain_ids present / absent)
 *  - contract: background is COUNTED, never enumerated
 *  - contract: the chain-scoped summary count, not the retrieval count
 *  - contract: the `why` clause points at the rationale tool only when `why` is absent
 *  - projection: decision_json never reaches the agent
 */

const cloudEnv = {
  mode: 'auth',
  gatewayUrl: 'https://api.align.tech',
  authToken: 't',
} as unknown as EnvironmentConfig;

const localEnv = {
  mode: 'local-embedded',
  gatewayUrl: '',
  localDbPath: '/tmp/x.db',
} as unknown as EnvironmentConfig;

type Client = Parameters<typeof dispatchTool>[2];

/**
 * A gateway topic-timeline payload.
 *
 * Every fixture derives its rows from here rather than restating them, so a row's status and
 * the counts computed over it cannot disagree - the "two writers of one fact" shape, inside a
 * fixture.
 */
function payload(over: Record<string, unknown> = {}) {
  return {
    topic: 'webhook signature verification',
    count: 3,
    superseded_count: 1,
    platforms: ['slack', 'github'],
    spans_platforms: true,
    retrieval: { lexical: true, semantic: true },
    decisions: [
      {
        id: 'd1',
        title: 'Verify webhook signatures with HMAC',
        summary: 'Reject unsigned webhooks.',
        platform: 'github',
        status: 'superseded',
        created_at: '2026-01-05T00:00:00Z',
        decided_at: '2026-01-04T00:00:00Z',
        date_basis: 'decided',
        source_url: 'https://github.com/a/b/pull/1',
        matched_by: ['lexical'],
      },
      {
        id: 'd2',
        title: 'Reject when no secret is configured',
        summary: 'Fail closed instead of skip mode.',
        platform: 'slack',
        status: 'active',
        created_at: '2026-03-05T00:00:00Z',
        source_url: 'https://slack.com/archives/C1/p1',
        matched_by: ['semantic'],
      },
    ],
    ...over,
  };
}

function timelineClient(result: Record<string, unknown>) {
  const c = { getTopicTimeline: vi.fn().mockResolvedValue(result) };
  return { c, cast: c as unknown as Client };
}

/** The rendered payload of one align_get_topic_timeline call. */
async function shaped(result: Record<string, unknown>) {
  const { cast } = timelineClient(result);
  return (await dispatchTool(
    'align_get_topic_timeline',
    { topic: 'webhook signature verification' },
    cast,
    cloudEnv,
  )) as Record<string, unknown>;
}

/** The message of one call - the surface this whole slice exists to deliver. */
async function messageOf(result: Record<string, unknown>): Promise<string> {
  return (await shaped(result))['message'] as string;
}

describe('ALI-1070: the timeline trio is dispatched', () => {
  it('align_get_topic_timeline reaches getTopicTimeline with the topic', async () => {
    const { c, cast } = timelineClient(payload());
    await dispatchTool('align_get_topic_timeline', { topic: 'auth' }, cast, cloudEnv);
    expect(c.getTopicTimeline).toHaveBeenCalledWith('auth', undefined);
  });

  it('align_get_topic_timeline passes an explicit limit through', async () => {
    const { c, cast } = timelineClient(payload());
    await dispatchTool('align_get_topic_timeline', { topic: 'auth', limit: 12 }, cast, cloudEnv);
    expect(c.getTopicTimeline).toHaveBeenCalledWith('auth', 12);
  });

  it('align_get_decision_rationale reaches getDecision - no new client method (ALI-1070)', async () => {
    // The hosted connector's getDecisionRationale is GET /snapshots/:id, which this client
    // already has as getDecision. A second method for one endpoint would be two writers of
    // one call, and it would also lose the local implementation this reuse gets for free.
    const c = { getDecision: vi.fn().mockResolvedValue({ id: 'd1', title: 'T', summary: 'S' }) };
    await dispatchTool(
      'align_get_decision_rationale',
      { decision_id: 'd1' },
      c as unknown as Client,
      cloudEnv,
    );
    expect(c.getDecision).toHaveBeenCalledWith('d1');
  });

  it('align_get_decision_timeline reaches getDecisionTimeline', async () => {
    const c = { getDecisionTimeline: vi.fn().mockResolvedValue({ decision_id: 'd1', events: [] }) };
    await dispatchTool(
      'align_get_decision_timeline',
      { decision_id: 'd1' },
      c as unknown as Client,
      cloudEnv,
    );
    expect(c.getDecisionTimeline).toHaveBeenCalledWith('d1');
  });

  // Required-argument validation derives from inputSchema.required, so these are free - but
  // free only if the schema actually declares them, which is what this pins.
  it.each([
    ['align_get_topic_timeline', {}, 'topic'],
    ['align_get_decision_rationale', {}, 'decision_id'],
    ['align_get_decision_timeline', {}, 'decision_id'],
  ])('%s refuses a call missing its required argument, naming it', async (name, args, missing) => {
    await expect(
      dispatchTool(name, args as Record<string, unknown>, {} as unknown as Client, cloudEnv),
    ).rejects.toThrow(new RegExp(`"${missing}"`));
  });
});

describe('ALI-1070: the published surface', () => {
  it('registers 11 tools, the 8 that existed plus the trio', () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(
      [
        'align_ask',
        'align_capture',
        'align_check_alignment',
        'align_check_drift',
        'align_get_conflicts',
        'align_get_decision_rationale',
        'align_get_decision_timeline',
        'align_get_impact',
        'align_get_related_decisions',
        'align_get_topic_timeline',
        'align_search',
      ].sort(),
    );
  });

  it('keeps the write set at exactly two: all three new tools are READS', () => {
    const writes = TOOL_SCHEMAS.filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writes).toEqual(['align_capture', 'align_check_drift']);
  });

  /**
   * The cross-repo defect this trio exists to avoid, made machine-checkable.
   *
   * The hosted message hardcodes `get_decision_rationale`; this server's name for that tool
   * is `align_get_decision_rationale`. Porting the text verbatim would instruct a customer's
   * agent to call a tool that is not on this server - an instruction naming an absent tool,
   * which is exactly what align-stack derives ALIGN_MCP_INSTRUCTIONS_READ_ONLY to prevent.
   *
   * Scoped to align_-prefixed references on purpose: an unprefixed word like "search" is
   * ordinary prose here, and matching it would make this assertion fire on English.
   */
  it('names no align_ tool it does not register, in any description', () => {
    const registered = new Set(TOOL_SCHEMAS.map((t) => t.name));
    // Positive control: the sweep finds real references, so an empty set cannot pass.
    const all = TOOL_SCHEMAS.flatMap((t) => t.description.match(/align_[a-z_]+/g) ?? []);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((n) => !registered.has(n))).toEqual([]);
  });

  it('names no align_ tool it does not register, in the timeline message', async () => {
    const registered = new Set(TOOL_SCHEMAS.map((t) => t.name));
    const message = await messageOf(payload());
    const referenced = message.match(/align_[a-z_]+/g) ?? [];
    // Positive control: the message really does name a tool, so a message that named none
    // (or an empty string) cannot pass this vacuously.
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((n) => !registered.has(n))).toEqual([]);
  });

  /**
   * CORRECTED in the ALI-1070 follow-up (Copilot on #296, inline at mcp.ts:52). This used to
   * assert the guidance line in BOTH modes, which is what shipped a guaranteed-fail
   * instruction to every local user: local mode has no getTopicTimeline and the Proxy throws
   * on every call. Cloud gets the line; local does not; both stay inside the budget. The
   * both-directions form is in mcp-timeline-trio-followup.test.ts.
   */
  it('points a CLOUD agent at the timeline tool, inside the 2048 budget', () => {
    const text = instructionsFor(cloudEnv);
    expect(text).toContain('align_get_topic_timeline');
    expect(text.length).toBeLessThan(2048);
  });

  it('does NOT point a LOCAL agent at it, and stays inside the budget', () => {
    const text = instructionsFor(localEnv);
    expect(text).not.toContain('align_get_topic_timeline');
    expect(text.length).toBeLessThan(2048);
    // Positive control: the local text is the real instructions, not an empty string.
    expect(text).toContain('align_check_alignment');
  });
});

describe('ALI-1070: the rendering contract travelled, not just the endpoint', () => {
  it('flags PARTIAL when semantic retrieval did not run', async () => {
    const message = await messageOf(payload({ retrieval: { lexical: true, semantic: false } }));
    expect(message).toContain('PARTIAL');
    expect(message).toMatch(/lexical matches only/);
  });

  it('does not flag PARTIAL when both halves ran', async () => {
    // The second example per rule. A one-sided test passes against a message that always
    // says PARTIAL, which would teach every answer to hedge.
    const message = await messageOf(payload({ retrieval: { lexical: true, semantic: true } }));
    expect(message).not.toContain('PARTIAL');
  });

  /**
   * ALI-1010, and the single clause most responsible for the `reversed` split.
   *
   * A corrected decision was NEVER TRUE; a superseded one was true and was overtaken.
   * Everything else in this message pushes toward the supersession vocabulary - the compact
   * template asks for "the biggest reversal" and the full-timeline rules say "name which
   * decision replaced them" - so a model handed a status it has never seen reaches for the
   * words it already has. The clause has to NAME the wrong rendering to stop that.
   */
  it('distinguishes corrected from superseded, and forbids the reversal vocabulary', async () => {
    const message = await messageOf(
      payload({
        decisions: [
          ...payload().decisions,
          {
            id: 'd3',
            title: 'Signing key rotated quarterly',
            platform: 'github',
            status: 'corrected',
            created_at: '2026-04-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(message).toContain('NEVER TRUE');
    expect(message).toContain('corrected');
    // The forbidden words, each asserted rather than in a lump: three claims, three checks,
    // so a clause that dropped one of them cannot pass on the other two.
    for (const banned of ['replaced', 'reversed', 'superseded']) {
      expect(message, `the clause must forbid "${banned}"`).toMatch(
        new RegExp(`never[^.]*${banned}`, 'i'),
      );
    }
  });

  it('says nothing about corrections when the chain holds none', async () => {
    const message = await messageOf(payload());
    expect(message).not.toContain('NEVER TRUE');
  });

  it('excludes a corrected decision from the superseded count', async () => {
    // The two counts must not double-count: a corrected row is not part of the history
    // explaining why the current answer is current. One row is superseded and one corrected,
    // so a message that folded them together would say 2.
    const message = await messageOf(
      payload({
        decisions: [
          ...payload().decisions,
          { id: 'd3', title: 'C', platform: 'github', status: 'corrected', created_at: '2026-04-01T00:00:00Z' },
        ],
      }),
    );
    expect(message).toMatch(/1 superseded or archived/);
    expect(message).not.toMatch(/2 superseded or archived/);
  });

  /**
   * ALI-590. Without this an agent reads every row it is handed, and on a mature graph most
   * rows are adjacent-but-unrelated - a webhook-security topic pulls legal, DPA and pricing
   * tickets over the similarity floor. Naming the count and forbidding the enumeration is
   * what turns 50 rows into a story.
   */
  it('counts background decisions and forbids enumerating them', async () => {
    const shape = await shaped(payload({ chain_ids: ['d2'], count: 2 }));
    const message = shape['message'] as string;
    expect(message).toMatch(/1 further decision\(s\) matched this topic loosely/);
    expect(message).toContain('NOT listed');
    // Counted, never enumerated: handing the tail back in listable form reintroduces the
    // very defect the clause fixes.
    const background = shape['background'] as Record<string, unknown>;
    expect(background['count']).toBe(1);
    expect(Array.isArray(background['decisions'])).toBe(false);
    expect(JSON.stringify(background)).not.toContain('Verify webhook signatures');
  });

  it('narrates every row when the gateway sends no chain_ids', async () => {
    // An older gateway sends no chain_ids, and falling back to "narrate everything" is the
    // right direction to fail: a shorter answer that silently dropped history is the one
    // nobody could detect.
    const shape = await shaped(payload());
    expect((shape['decisions'] as unknown[]).length).toBe(2);
    expect(shape['background']).toBeUndefined();
    expect(shape['message']).not.toContain('NOT listed');
  });

  it('summarises the CHAIN, not everything retrieved', async () => {
    // The gateway's count covers what it RETRIEVED; the narrated chain here is one decision.
    // Interpolating the retrieval-wide number would overstate the chain by the background
    // count, citing decisions the agent has no rows for.
    const message = await messageOf(payload({ chain_ids: ['d2'], count: 2 }));
    expect(message).toMatch(/1 decision\(s\) across slack got it here/);
  });

  it('carries the worked render template, not adjectives about clarity', async () => {
    const message = await messageOf(payload());
    // A template fixes ordering, length and where the status goes; "be concise" fixes nothing.
    expect(message).toContain('**Now:**');
    expect(message).toContain('**How it got here**');
    expect(message).toMatch(/max 15 words/);
    expect(message).toMatch(/ONE LINE PER DECISION/);
    expect(message).toMatch(/NEVER omit the platform/);
  });

  it('points at the rationale tool only when the payload carries no why', async () => {
    const without = await messageOf(payload());
    expect(without).toContain('align_get_decision_rationale');

    const with_ = await messageOf(
      payload({ why: [{ id: 'd2', rationale: 'Fail closed', risks: ['unset secret'] }] }),
    );
    expect(with_).toMatch(/do NOT call align_get_decision_rationale/);
  });

  it('says so when there are no decisions, instead of rendering a template', async () => {
    const message = await messageOf(payload({ count: 0, decisions: [], superseded_count: 0 }));
    expect(message).toMatch(/No decisions found/);
    expect(message).not.toContain('**How it got here**');
  });

  it('never lets decision_json reach the agent', async () => {
    // ALI-498: one 12-row prod component carried 43,327 characters of it. The projection is
    // an allowlist, not a delete, so a new gateway field cannot leak by being unrecognised.
    const shape = await shaped(
      payload({
        decisions: [{ ...payload().decisions[0], decision_json: { huge: 'x'.repeat(5000) } }],
      }),
    );
    expect(JSON.stringify(shape)).not.toContain('huge');
  });
});
