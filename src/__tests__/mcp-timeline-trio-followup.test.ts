import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallToolHandler, dispatchTool, instructionsFor, TOOL_SCHEMAS, toolSchemasFor } from '../commands/mcp.js';
import { shapeTopicTimeline, STORY_GATE } from '../lib/mcp-timeline-tools.js';
import type { EnvironmentConfig } from '../lib/config.js';
import { createGatewayClient as createGatewayClientB } from '../lib/gateway-client.js';

/** A fetch double for the round-2 path-segment cases at the bottom of this file. */
const mockFetchB = vi.fn();
vi.stubGlobal('fetch', mockFetchB);
const cloudEnvB = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok_real',
  tenantId: 'tenant-123',
  mode: 'auth' as const,
};
beforeEach(() => mockFetchB.mockReset());

/**
 * ALI-1070 follow-up: the eleven Copilot findings on #296 (6 inline + 5 suppressed), plus
 * three a fresh-context port review found that Copilot did not.
 *
 * #296 merged before any of them were addressed, so this is a follow-up branch off the squash
 * commit rather than a push to the merged branch - a push there succeeds silently, runs no CI
 * and never reaches main.
 *
 * Test List, one entry per finding:
 *  F2  mcp.ts:52   - local agents must not be told to call a tool local mode cannot serve
 *  F3  tools:175   - the superseded clause must be CHAIN-scoped, like the summary line
 *  F4  tools:300   - the full-timeline rules must not demand a decision_url this port omits
 *  F5  tools:378   - an explicitly EMPTY why/still_open is not the same as an absent one
 *  F7  mcp.ts:222  - the rationale tool must return the rationale it promises
 *  F11 tools:170   - the no-results message must still carry the PARTIAL notice
 *  R1  (review)    - a synthetic align:// identity must never be emitted as source_url
 *  R2  (review)    - cite/repository derive from source_url alone, so they belong here
 *  R3  (review)    - the summary cap must match the hosted 280, not 500
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

function rows() {
  return [
    {
      id: 'd1', title: 'Verify webhook signatures with HMAC', summary: 'Reject unsigned.',
      platform: 'github', status: 'superseded', created_at: '2026-01-05T00:00:00Z',
      source_url: 'https://github.com/acme/api/pull/1441',
    },
    {
      id: 'd2', title: 'Reject when no secret is configured', summary: 'Fail closed.',
      platform: 'slack', status: 'active', created_at: '2026-03-05T00:00:00Z',
      source_url: 'https://slack.com/archives/C1/p1',
    },
  ];
}

function shaped(over: Record<string, unknown> = {}) {
  return shapeTopicTimeline(
    { topic: 't', count: 2, superseded_count: 1, decisions: rows(), ...over },
    't',
  ) as Record<string, unknown>;
}

const messageOf = (over: Record<string, unknown> = {}) => shaped(over)['message'] as string;

describe('F2: local mode is not routed at a tool it cannot serve', () => {
  it('names the timeline tool in CLOUD instructions', () => {
    expect(instructionsFor(cloudEnv)).toContain('align_get_topic_timeline');
  });

  it('does NOT name it in LOCAL instructions, because the local client always throws', () => {
    // The local Proxy has no getTopicTimeline, so the call throws every time
    // (mcp-timeline-trio-local.test.ts measures that). Routing an agent there is a
    // guaranteed-fail instruction shipped to users.
    expect(instructionsFor(localEnv)).not.toContain('align_get_topic_timeline');
  });

  it('still fits the 2048 budget in both modes', () => {
    for (const env of [cloudEnv, localEnv]) expect(instructionsFor(env).length).toBeLessThan(2048);
  });

  it('marks the two cloud-only tools in local tool descriptions, so a call that happens anyway is legible', () => {
    // The tools stay REGISTERED - deregistering per mode is a bigger change and the stub is
    // honest. What was missing is any way for an agent reading descriptions to know.
    const local = toolSchemasFor(localEnv);
    for (const name of ['align_get_topic_timeline', 'align_get_decision_timeline']) {
      const t = local.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.description, name).toMatch(/not available in local mode|cloud/i);
    }
    // The rationale tool DOES work locally, so it must NOT carry that marking - a blanket
    // warning on all three would be false about one of them.
    const rationale = local.find((x) => x.name === 'align_get_decision_rationale');
    expect(rationale!.description).not.toMatch(/not available in local mode/i);
  });

  it('leaves cloud descriptions unmarked', () => {
    const cloud = toolSchemasFor(cloudEnv);
    const t = cloud.find((x) => x.name === 'align_get_topic_timeline');
    expect(t!.description).not.toMatch(/not available in local mode/i);
  });
});

describe('F3: the superseded clause is chain-scoped', () => {
  it('counts only superseded decisions in the NARRATED chain', () => {
    // chain is d2 (active); d1 (superseded) is background and is not even listed. Calling it
    // "the history explaining why the current answer is current" names a row the agent cannot
    // see. The later summary line was already chain-scoped; this clause was not.
    const message = messageOf({ chain_ids: ['d2'] });
    expect(message).not.toMatch(/1 of them are superseded/);
  });

  it('still reports them when they ARE in the chain', () => {
    // Second example per rule: a fix that simply deleted the clause would pass the test above.
    const message = messageOf({ chain_ids: ['d1', 'd2'] });
    expect(message).toMatch(/1 of them are superseded or archived/);
  });
});

describe('F4: the full-timeline rules do not demand a field this port omits', () => {
  it('never instructs the agent to cite a decision_url', () => {
    const message = messageOf();
    // The earlier render clause is conditional ("when present, else source_url") and stays.
    // This is about the unconditional closing rule, which demanded both links.
    expect(message).not.toMatch(/Cite decision_url and source_url as different links/);
  });

  it('still tells the agent to link the source', () => {
    // Positive control: the link instruction survives rather than being deleted wholesale.
    expect(messageOf()).toMatch(/source_url/);
  });
});

describe('F5: an explicitly empty why/still_open is not an absent one', () => {
  it('says the gateway looked and found no recorded reasoning, when why is []', () => {
    const message = messageOf({ why: [] });
    // Not the absent-field fallback: calling the rationale tool per decision would find the
    // same nothing the gateway already looked for.
    expect(message).toMatch(/looked for recorded reasoning on this chain and found none/i);
    expect(message).toMatch(/say the reasons are not recorded/i);
    expect(message).not.toMatch(/This payload carries no `why`/);
  });

  it('keeps the absent-field fallback when why is missing entirely', () => {
    const message = messageOf();
    expect(message).toMatch(/This payload carries no `why`/);
  });

  it('does not ask for an open question the chain says it does not have, when still_open is []', () => {
    // The defect Copilot named: still_open: [] took the unavailable path, whose wording asks
    // for "the single sharpest unanswered question" - an invitation to invent one.
    const message = messageOf({ still_open: [] });
    expect(message).toMatch(/states no open questions|no open questions/i);
    expect(message).not.toMatch(/the single sharpest unanswered question/);
  });

  it('keeps the synthesised closing line when still_open is missing entirely', () => {
    expect(messageOf()).toMatch(/the single sharpest unanswered question/);
  });

  it('uses the questions when there are some', () => {
    const message = messageOf({ still_open: [{ id: 'd2', questions: ['who owns rotation?'] }] });
    expect(message).toMatch(/one line per question in `still_open`/);
  });
});

describe('F11: the no-results message still reports degraded retrieval', () => {
  it('carries PARTIAL when semantic retrieval did not run and nothing was found', () => {
    // "No decisions found" plus a silently lexical-only search is the worst combination: the
    // agent concludes the graph has nothing to say about the topic.
    const message = messageOf({ count: 0, decisions: [], retrieval: { lexical: true, semantic: false } });
    expect(message).toMatch(/No decisions found/);
    expect(message).toContain('PARTIAL');
  });

  it('does not cry PARTIAL on an honest empty result', () => {
    const message = messageOf({ count: 0, decisions: [], retrieval: { lexical: true, semantic: true } });
    expect(message).toMatch(/No decisions found/);
    expect(message).not.toContain('PARTIAL');
  });
});

describe('R1: a synthetic align:// identity is never presented as a source', () => {
  it.each([['align://claimed/9f2c'], ['align://unsourced/abcd']])(
    'flags %s as unverified instead of emitting it as source_url',
    (synthetic) => {
      const shape = shaped({
        decisions: [{ ...rows()[0], source_url: synthetic }],
        chain_ids: undefined,
      });
      const d = (shape['decisions'] as Record<string, unknown>[])[0]!;
      // The contract this port carries says "link every decision you name ... else
      // source_url; do not invent links". Handing over an align:// pseudo-URL as the source
      // makes the agent render an unfetchable string as a link, for exactly the decisions
      // whose origin Align could NOT verify.
      expect(d['source_url']).toBeUndefined();
      expect(d['source_unverified']).toBe(true);
    },
  );

  it('passes a real source_url through untouched', () => {
    // Positive control: the guard is a prefix test, not a blanket removal.
    const d = (shaped()['decisions'] as Record<string, unknown>[])[0]!;
    expect(d['source_url']).toBe('https://github.com/acme/api/pull/1441');
    expect(d['source_unverified']).toBeUndefined();
  });
});

describe('R2: cite and repository derive from source_url alone', () => {
  it('emits both for a code source, so the template\'s {cite or id} is satisfiable', () => {
    const d = (shaped()['decisions'] as Record<string, unknown>[])[0]!;
    expect(d['repository']).toBe('acme/api');
    expect(d['cite']).toBe('api#1441');
  });

  it('emits neither for a non-code source, rather than inventing a repository', () => {
    // Second example per rule, and the honest direction: a Slack permalink is not a repo.
    const d = (shaped()['decisions'] as Record<string, unknown>[])[1]!;
    expect(d['repository']).toBeUndefined();
    expect(d['cite']).toBeUndefined();
  });
});

describe('R3: the summary cap matches the hosted connector', () => {
  it('truncates a summary at 280 characters, not 500', () => {
    const long = 'x'.repeat(400);
    const d = (shaped({ decisions: [{ ...rows()[0], summary: long }] })['decisions'] as Record<string, unknown>[])[0]!;
    // Built FROM the boundary rather than from a number that looks comfortably past it.
    expect((d['summary'] as string).length).toBeLessThanOrEqual(280);
    expect((d['summary'] as string).length).toBeGreaterThan(200);
  });

  it('leaves a short summary alone', () => {
    const d = (shaped()['decisions'] as Record<string, unknown>[])[0]!;
    expect(d['summary']).toBe('Reject unsigned.');
  });
});

describe('F7: the rationale tool returns the rationale it promises', () => {
  /**
   * The suppressed finding, and the largest. The tool was `return client.getDecision(id)` raw,
   * and createCallToolHandler's serializer strips `decision_json` - where EVERY field the
   * description promises lives. Measured before the fix: the agent received
   * id/title/summary/status/platform/created_at and no rationale, goals, risks or context.
   *
   * Tested through createCallToolHandler, NOT dispatchTool, because dispatchTool returns the
   * raw object and the stripping happens in the serializer. A dispatch-level test cannot see
   * this defect, which is exactly why the #296 suite certified it.
   */
  const row = {
    id: 'd1',
    title: 'Verify webhook signatures',
    summary: 'Reject unsigned webhooks.',
    status: 'active',
    platform: 'github',
    created_at: '2026-01-05T00:00:00Z',
    decision_json: {
      rationale: 'An unset secret is the default deployment state, not an edge case.',
      goals: ['reject forged webhooks'],
      risks: ['a rotation gap rejects real traffic'],
      context: 'WebhookGuard.verifySignature returns true when no secret is configured.',
      alternatives_considered: ['trust the SDK default'],
      positions_considered: ['skip mode is acceptable for OSS'],
    },
    external_references: [
      { connector: 'jira', external_id: 'ALI-1', external_url: 'https://x/ALI-1', reference_type: 'mentions' },
    ],
  };

  async function served(r: unknown) {
    const client = { getDecision: vi.fn().mockResolvedValue(r) };
    const handler = createCallToolHandler(client as never, cloudEnv);
    const res = await handler({ params: { name: 'align_get_decision_rationale', arguments: { decision_id: 'd1' } } });
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  }

  it('survives serialization with the reasoning intact', async () => {
    const out = await served(row);
    expect(out['rationale']).toBe('An unset secret is the default deployment state, not an edge case.');
    expect(out['goals']).toEqual(['reject forged webhooks']);
    expect(out['risks']).toEqual(['a rotation gap rejects real traffic']);
    expect(out['context']).toMatch(/WebhookGuard/);
    expect(out['alternatives_considered']).toEqual(['trust the SDK default']);
    expect(out['positions_considered']).toEqual(['skip mode is acceptable for OSS']);
  });

  it('never leaks decision_json itself', async () => {
    // The projection exists so the reasoning survives, NOT so the blob does (ALI-498: one
    // 12-row prod component carried 43,327 characters of it).
    const out = await served(row);
    expect(out['decision_json']).toBeUndefined();
  });

  it('reads the ai sub-object, which is where the approve path copies scan reasoning', async () => {
    const out = await served({
      ...row,
      decision_json: { ai: { rationale: 'from the scan', risks: ['r'], alternatives_considered: ['a'] } },
    });
    expect(out['rationale']).toBe('from the scan');
    expect(out['risks']).toEqual(['r']);
    expect(out['alternatives_considered']).toEqual(['a']);
  });

  it('falls back to the summary when no rationale was recorded, rather than an empty string', async () => {
    const out = await served({ ...row, decision_json: {} });
    expect(out['rationale']).toBe('Reject unsigned webhooks.');
  });

  it('carries the mentioned artifacts the gateway already sends', async () => {
    // ALI-582: the Jira keys and implementing PRs are in this exact response body.
    const out = await served(row);
    expect(JSON.stringify(out['mentioned_artifacts'])).toContain('ALI-1');
  });

  it('tolerates a local row with no decision_json at all', async () => {
    // Local mode serves this tool for real, and its rows carry no decision_json. Thinner,
    // not broken - and it must not throw.
    const out = await served({ id: 'd1', title: 'T', summary: 'S', external_references: [] });
    expect(out['rationale']).toBe('S');
    expect(out['goals']).toEqual([]);
  });
});

describe('F8: the module comment describes what the server now does', () => {
  it('no longer claims this server has no per-server lines', async () => {
    // A stale contract description is what makes a future edit delete necessary guidance.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../commands/mcp.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/It has no per-server lines/);
    // Flatten the comment first: the claim spans a line break, and a regex over the raw
    // source would silently match nothing and pass on its own emptiness.
    const flat = src.replace(/\n\s*\/\/ ?/g, ' ');
    const hostedOnlyClaim = /hosted-only tools \(([^)]*)\)/.exec(flat)?.[1] ?? '';
    // Positive control: the claim was found at all, so a failed parse cannot pass this.
    expect(hostedOnlyClaim.length).toBeGreaterThan(0);
    expect(hostedOnlyClaim).not.toContain('get_topic_timeline');
  });
});

describe('the dispatch arms still reach the right client methods', () => {
  it('rationale still reaches getDecision with the RAW id, so local lookup is unaffected', async () => {
    const c = { getDecision: vi.fn().mockResolvedValue({ id: 'x' }) };
    await dispatchTool('align_get_decision_rationale', { decision_id: 'a/b' }, c as never, cloudEnv);
    // Encoding is the HTTP boundary's job; a local DB lookup needs the id as given.
    expect(c.getDecision).toHaveBeenCalledWith('a/b');
  });
});

/**
 * The gaps a fresh-context adversarial test review found by injection (26 injections, each
 * marker-verified, each preceded by a typecheck so "nothing reddened" could not mean "I broke
 * the file"). These are not new behaviour - they are assertions the #296 suite CLAIMED to make
 * and did not, so every fix above could regress silently without them.
 */
describe('the gaps the #296 suite claimed to cover and did not', () => {
  /**
   * T1, and the sharpest of them. Both #296 sweeps were `/align_[a-z_]+/g`, so they were blind
   * to an UNPREFIXED hosted spelling - and the file this module is ported from spells every
   * name unprefixed, which makes that the single most likely way the defect returns. Measured:
   * adding `call get_topic_timeline` to the message passed 172/172.
   *
   * `\b` works because `_` is a word character, so `\bget_topic_timeline\b` does not match
   * inside `align_get_topic_timeline`. Same technique as mcp-instructions-shared.test.ts.
   */
  const HOSTED_SPELLINGS = [
    'get_topic_timeline',
    'get_decision_rationale',
    'get_decision_timeline',
    'get_decision_history',
    'search_decisions',
    'check_proposed_action',
  ] as const;

  it.each(HOSTED_SPELLINGS)('no tool description names the bare hosted spelling %s', (bare) => {
    const offenders = TOOL_SCHEMAS.filter((t) => new RegExp(`\\b${bare}\\b`).test(t.description));
    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  it.each(HOSTED_SPELLINGS)('the rendered message never names the bare spelling %s', (bare) => {
    // Rendered across every branch that names a tool, so a spelling hiding in one arm of the
    // three-state why clause cannot escape.
    for (const over of [{}, { why: [] }, { why: [{ id: 'd2', rationale: 'r' }] }]) {
      expect(messageOf(over), `${bare} in the ${JSON.stringify(over)} branch`).not.toMatch(
        new RegExp(`\\b${bare}\\b`),
      );
    }
  });

  it('positive control: the bare-spelling matcher DOES fire on a bare spelling', () => {
    // Without this the six assertions above are satisfied by a matcher that matches nothing.
    expect(/\bget_topic_timeline\b/.test('please call get_topic_timeline now')).toBe(true);
    expect(/\bget_topic_timeline\b/.test('please call align_get_topic_timeline now')).toBe(false);
  });

  /**
   * T2: all three chain-scope filters were unpinned, because no #296 fixture combined
   * `chain_ids` with the field being scoped - `inChain` degrades to `() => true` when
   * `chain_ids` is absent. Deleting the why, still_open or disagreements filter each passed
   * 172/172. The invariant is documented in the module and had no test.
   */
  it('scopes why, still_open and disagreements to the narrated chain', () => {
    const shape = shaped({
      chain_ids: ['d2'],
      count: 2,
      why: [{ id: 'd1', rationale: 'background reason' }, { id: 'd2', rationale: 'chain reason' }],
      still_open: [{ id: 'd1', questions: ['background q'] }, { id: 'd2', questions: ['chain q'] }],
      disagreements: [
        { relation: 'conflicts_with', from: { id: 'd1' }, to: { id: 'd2' } },
        { relation: 'conflicts_with', from: { id: 'd2' }, to: { id: 'd2' } },
      ],
    });
    const json = JSON.stringify(shape);
    // The surviving half is the positive control: a filter that dropped everything would
    // satisfy the absence assertions on its own.
    expect(json).toContain('chain reason');
    expect(json).toContain('chain q');
    expect(json).not.toContain('background reason');
    expect(json).not.toContain('background q');
    // An edge with a background endpoint cites a title the agent has no row for.
    expect((shape['disagreements'] as unknown[]).length).toBe(1);
  });

  /** T3: STORY_GATE gates the full render on two surfaces and neither pinned it. */
  it('uses one STORY_GATE phrase on both the description and the message', () => {
    // The two toContain assertions below pin DRIFT: a surface that stopped interpolating the
    // constant fails them. They cannot pin the phrase itself, because both surfaces are built
    // FROM the constant - comparing it against them is two equal values, and an injection
    // re-wording the constant passed 123/123 until the literal below was added. So the
    // literal is the half that makes a re-word a deliberate, visible change.
    expect(STORY_GATE).toBe('asked for the story');
    const desc = TOOL_SCHEMAS.find((t) => t.name === 'align_get_topic_timeline')!.description;
    expect(desc).toContain(STORY_GATE);
    expect(messageOf()).toContain(STORY_GATE);
  });

  /**
   * T4: "counted, never enumerated" was asserted key-by-key, so adding
   * `ids: background.map(d => d.id)` passed - an id list being exactly the listable form an
   * agent walks. An exact key set is the only form no added field can satisfy.
   */
  it('lets the background object carry nothing but a count, platforms and a note', () => {
    const bg = shaped({ chain_ids: ['d2'], count: 2 })['background'] as Record<string, unknown>;
    expect(Object.keys(bg).sort()).toEqual(['count', 'note', 'platforms']);
  });

  /**
   * T5: no #296 test read a projected row, so the payload could stop carrying fields the
   * contract tells the agent to print. Dropping `date_basis` from the projection passed
   * 172/172 while the render rules instruct the agent to read it.
   */
  it('projects exactly the allowlisted row fields, in both directions', () => {
    const shape = shapeTopicTimeline(
      {
        topic: 't',
        count: 1,
        decisions: [
          {
            id: 'd1', title: 'T', summary: 'S', platform: 'github', status: 'active',
            created_at: '2026-01-05T00:00:00Z', decided_at: '2026-01-04T00:00:00Z',
            source_created_at: '2026-01-03T00:00:00Z', date_basis: 'decided',
            source_url: 'https://github.com/acme/api/pull/7', matched_by: ['lexical'],
            // Must not survive: an allowlist, not a delete list.
            decision_json: { huge: 'x' }, embedding: [1, 2, 3],
          } as never,
        ],
      },
      't',
    ) as Record<string, unknown>;
    expect((shape['decisions'] as unknown[])[0]).toEqual({
      id: 'd1',
      title: 'T',
      summary: 'S',
      platform: 'github',
      status: 'active',
      created_at: '2026-01-05T00:00:00Z',
      decided_at: '2026-01-04T00:00:00Z',
      source_created_at: '2026-01-03T00:00:00Z',
      date_basis: 'decided',
      source_url: 'https://github.com/acme/api/pull/7',
      repository: 'acme/api',
      cite: 'api#7',
      matched_by: ['lexical'],
    });
  });

  /**
   * T6: #296 set `count: 0` and `decisions: []` together, so keying the empty branch on the
   * gateway count and keying it on the narrated chain were indistinguishable. The mutant
   * answers "No decisions found" for a real topic whose chain lookup came back empty, which is
   * the silently-shorter answer the module says it fails toward avoiding.
   */
  it('still renders a timeline when the chain is empty but decisions were retrieved', () => {
    const message = messageOf({ chain_ids: [], count: 2 });
    expect(message).toContain('**How it got here**');
    expect(message).not.toMatch(/No decisions found/);
  });

  /**
   * T7: no #296 fixture omitted `retrieval`, so `semantic !== false` and `semantic === true`
   * were indistinguishable. The mutant cries PARTIAL at an older gateway that sends no
   * retrieval key at all - the case the shaper explicitly defaults for.
   */
  it('does not claim PARTIAL when the gateway sends no retrieval field at all', () => {
    const shape = shapeTopicTimeline({ topic: 't', count: 2, decisions: rows() }, 't') as Record<string, unknown>;
    expect(shape['message']).not.toContain('PARTIAL');
    expect(shape['retrieval']).toEqual({ lexical: true, semantic: true });
  });

  /**
   * T9: the claim that the trio is appended "so the eight above keep the ranking ALI-139
   * decided" was unpinned beyond index 0 - splicing the trio to index 1 passed 172/172.
   */
  it('keeps the original eight in their decided order, with the trio appended', () => {
    expect(TOOL_SCHEMAS.map((t) => t.name).slice(0, 8)).toEqual([
      'align_check_alignment', 'align_ask', 'align_search', 'align_capture',
      'align_check_drift', 'align_get_impact', 'align_get_conflicts',
      'align_get_related_decisions',
    ]);
  });
});

/**
 * Round 2: the six findings Copilot raised on the follow-up itself (#298), 5 inline + 1
 * suppressed. Two are residual halves of fixes made above, which is the shape worth naming -
 * a fix that closes one site and leaves its twin is how this whole file started.
 */
describe('#298 round 2', () => {
  /**
   * C1, SECURITY and the sharpest. `encodeURIComponent` does NOT escape `.`, so the fix above
   * stopped `../auth/me` only because its SLASH was encoded. A bare `..` is a valid-looking id
   * that survives encoding untouched, and WHATWG normalisation then resolves it out of the
   * route entirely. Measured: `https://api.align.tech/snapshots/..` has pathname `/`.
   */
  it.each([['..'], ['.'], ['%2e%2e'], ['%2E%2E']])('REFUSES the dot-segment id %s rather than sending it', async (id) => {
    // Encoding cannot fix this: `%2E%2E` still resolves to `/`, because the WHATWG URL spec
    // decodes `%2e` when testing a segment for dot-segment-ness. Measured, all three forms.
    // So the contract is refusal, and it must refuse BEFORE the request leaves.
    //
    // The percent-encoded spellings are in this list because the guard decodes ONCE before
    // judging, so `%2e%2e` is a `..` wearing a costume. The first draft of this test had them
    // in the group below, expecting them to be sent - the guard was stricter than predicted,
    // which is the right direction for a control to surprise you in.
    await expect(createGatewayClientB(cloudEnvB).getDecision(id)).rejects.toThrow(
      /Refusing to request a path built from the id/,
    );
    // The load-bearing half: nothing was sent. A throw after the fetch would still have
    // attached the PAT to a request for a route the caller never named.
    expect(mockFetchB).not.toHaveBeenCalled();
  });

  it.each([['../..'], ['..%2f..'], ['%252e%252e']])(
    'encodes the non-dot-segment traversal shape %s and keeps it in the route',
    async (id) => {
      // These are NOT dot segments once encoded, so they are legitimately sent and 404 - the
      // positive control for the refusal above, which would otherwise be satisfied by a client
      // that refused everything.
      mockFetchB.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'x' }) });
      await createGatewayClientB(cloudEnvB).getDecision(id);
      const path = new URL(String(mockFetchB.mock.calls[0]![0])).pathname;
      expect(path.startsWith('/snapshots/')).toBe(true);
      expect(path).not.toBe('/');
    },
  );

  it('still reaches the ordinary endpoint for a normal id', async () => {
    // Second example per rule: encoding the dots must not break a legitimate id that
    // contains one.
    mockFetchB.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'x' }) });
    await createGatewayClientB(cloudEnvB).getDecision('v1.2-abc');
    const path = new URL(String(mockFetchB.mock.calls[0]![0])).pathname;
    expect(decodeURIComponent(path)).toBe('/snapshots/v1.2-abc');
  });

  /**
   * C2. The precedence is the HOSTED one (top-level `rationale` first), and it stays - a port
   * that silently re-ranks its source stops being verifiable against it. What was wrong was
   * the COMMENT, which cited ALI-484 close enough to the precedence to read as a claim about
   * it. ALI-484 is about alternatives_considered / positions_considered, not rationale. This
   * test makes the choice deliberate rather than incidental.
   */
  it('prefers the top-level rationale over the ai one when BOTH are present', async () => {
    const client = {
      getDecision: vi.fn().mockResolvedValue({
        id: 'd1', title: 'T', summary: 'S',
        decision_json: {
          rationale: 'the chosen gloss',
          ai: { rationale: 'the scan reasoning', alternatives_considered: ['alt'] },
        },
        external_references: [],
      }),
    };
    const handler = createCallToolHandler(client as never, cloudEnv);
    const res = await handler({
      params: { name: 'align_get_decision_rationale', arguments: { decision_id: 'd1' } },
    });
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(out['rationale']).toBe('the chosen gloss');
    // And the ALI-484 fields still come from `.ai` when the top level has none, which is what
    // that ticket is actually about.
    expect(out['alternatives_considered']).toEqual(['alt']);
  });

  /**
   * C3. The `whyState === 'empty'` branch correctly says not to call the rationale tool, and
   * the full-timeline render still appended `**Open risks**` asking one line per risk. With no
   * `why` entries there are no risks to line up, so the section invites exactly the fabrication
   * the empty state exists to prevent.
   */
  it('does not demand an Open risks section when why came back empty', () => {
    const message = messageOf({ why: [] });
    expect(message).not.toMatch(/\*\*Open risks\*\* - one short line each/);
    expect(message).toMatch(/no risks were recorded|states no recorded risks/i);
  });

  it('still asks for Open risks when why carries entries', () => {
    const message = messageOf({ why: [{ id: 'd2', rationale: 'r', risks: ['a real risk'] }] });
    expect(message).toMatch(/\*\*Open risks\*\*/);
  });

  /**
   * C4, and the one worth flinching at: the replacement rule I wrote for the decision_url
   * problem RECREATED it. "Link each decision with its source_url" is unconditional, and
   * present() deliberately omits source_url for a synthetic identity and for a row with no
   * source at all - so the model must invent a link or drop a named decision.
   */
  it('makes the link rule conditional, and forbids a link where no source arrived', () => {
    const message = messageOf();
    expect(message).not.toMatch(/Link each decision with its source_url, which is where it was decided - never/);
    expect(message).toMatch(/when.*source_url|if.*source_url/i);
    // The explicit refusal is the half that stops invention.
    expect(message).toMatch(/source_unverified|no link|without one/i);
  });

  /**
   * C5. decision-links.ts already exports SYNTHETIC_SOURCE_PREFIXES, isSyntheticSource,
   * repositoryOf AND citationFor - so the follow-up had duplicated FOUR helpers, not the one
   * Copilot named. Reuse is asserted BEHAVIOURALLY rather than by grepping for an import: the
   * canonical citationFor also cites Linear and Jira ticket keys, which the local copy could
   * not, so a ticket cite is observable proof the shared helper is the one running.
   */
  it('cites a Linear ticket by key, which only the shared helper can do', () => {
    const d = (shaped({
      decisions: [{ ...rows()[0], source_url: 'https://linear.app/align/issue/ALI-346' }],
    })['decisions'] as Record<string, unknown>[])[0]!;
    expect(d['cite']).toBe('ALI-346');
    // repositoryOf must still refuse: a Linear workspace is not an owner.
    expect(d['repository']).toBeUndefined();
  });

  it('cites a Jira ticket by key too', () => {
    const d = (shaped({
      decisions: [{ ...rows()[0], source_url: 'https://acme.atlassian.net/browse/PROJ-12' }],
    })['decisions'] as Record<string, unknown>[])[0]!;
    expect(d['cite']).toBe('PROJ-12');
  });

  /**
   * C6 (suppressed). The stillOpenState fix only reached the full-timeline section; the COMPACT
   * template above it still unconditionally asked for "{the single sharpest open question, one
   * line}". Same defect one level up, and the compact answer is the default path, so this was
   * the more-travelled of the two.
   */
  it('does not ask the compact answer for an open question when still_open came back empty', () => {
    const message = messageOf({ still_open: [] });
    expect(message).not.toMatch(/\{the single sharpest open question, one line\}/);
  });

  it('still asks the compact answer for one when still_open is absent', () => {
    expect(messageOf()).toMatch(/\{the single sharpest open question, one line\}/);
  });
});
