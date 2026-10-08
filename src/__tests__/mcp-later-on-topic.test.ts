/**
 * ALI-1412, CLI half. The cloud gateway (align-stack db/laterOnTopic.ts) attaches
 * `later_on_topic` to each smart-search row: up to 3 LATER decisions on the same topic, linked
 * or merely similar. AlignBench v7's `reversed` split (57%) is the agent answering from a
 * decision a later, unlinked one reversed; this field is what tells it something newer exists.
 *
 * Pass-through already carries it (serializeMcpResult is a denylist), so what these tests pin is
 * the same contract decision-relations.ts gives `successor`/`conflicts_with`: it reaches the
 * agent through the real handler, and garbage never does. A null inside an entry reads as a
 * checked fact ("status: null" = "has no status"), an entry with no id names a decision the
 * agent cannot go and read, and an empty list or a null where the list should be reads as
 * "checked, nothing newer" - a claim the gateway never made.
 *
 * Every assertion runs through createCallToolHandler and reads the SERIALIZED text, for the
 * reason mcp-relation-fields.test.ts gives.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createCallToolHandler, type dispatchTool } from '../commands/mcp.js';

type Client = Parameters<typeof dispatchTool>[2];

const cloud: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: 'x', mode: 'auth' };

/** The entry shape the gateway sends. */
const LINKED = {
  id: 'd-1569',
  title: 'Run the check on every PR',
  source_url: 'https://github.com/aligndottech/align-stack/pull/1569',
  status: 'active',
  date: '2026-08-10T00:00:00.000Z',
  date_basis: 'recorded',
  relation: 'supersedes',
  direction: 'later_to_this',
};
const SIMILAR = {
  id: 'd-2',
  title: 'Move sessions to Postgres',
  source_url: 'https://acme.atlassian.net/browse/OPS-9',
  date: '2026-08-04T00:00:00.000Z',
  date_basis: 'decided',
  similarity: 0.7,
};

function clientReturning(results: unknown[]): Client {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results, count: results.length, strategy: 'semantic' }),
  } as unknown as Client;
}

async function callAsk(c: Client, name = 'align_ask') {
  const handler = createCallToolHandler(c, cloud);
  const out = await handler({ params: { name, arguments: { question: 'is the check on?', query: 'is the check on?' } } });
  const text = out.content[0]!.text;
  const payload = JSON.parse(text) as { results?: Array<Record<string, unknown>> };
  expect(Array.isArray(payload.results)).toBe(true);
  return { text, rows: payload.results! };
}

const row = (later_on_topic: unknown) => ({
  id: 'd-1529', title: 'Disable the check in preview', summary: 's', status: 'active', later_on_topic,
});

describe('MCP align_ask later_on_topic (ALI-1412)', () => {
  it('delivers a linked later decision to the agent, every field intact', async () => {
    const { rows } = await callAsk(clientReturning([row([LINKED])]));
    expect(rows[0]!['later_on_topic']).toEqual([LINKED]);
  });

  it('delivers an unlinked one with its similarity, through the align_search alias too', async () => {
    const { rows } = await callAsk(clientReturning([row([SIMILAR])]), 'align_search');
    expect(rows[0]!['later_on_topic']).toEqual([SIMILAR]);
  });

  it('drops a null field inside an entry rather than emitting it', async () => {
    const { text, rows } = await callAsk(clientReturning([row([{ ...LINKED, status: null, source_url: null }])]));
    const [entry] = rows[0]!['later_on_topic'] as Array<Record<string, unknown>>;
    expect(entry).not.toHaveProperty('status');
    expect(entry).not.toHaveProperty('source_url');
    expect(entry!['id']).toBe('d-1569');
    expect(text).not.toMatch(/"status":null/);
  });

  it('drops an entry the agent cannot follow (no id), keeping the followable one', async () => {
    const { rows } = await callAsk(clientReturning([row([{ ...LINKED, id: '' }, SIMILAR, null, 'junk'])]));
    expect(rows[0]!['later_on_topic']).toEqual([SIMILAR]);
  });

  it('drops the key entirely when nothing followable is left, or the gateway sent null or an empty list', async () => {
    const { text, rows } = await callAsk(clientReturning([
      row([{ title: 'no id' }]),
      row(null),
      row([]),
      row({ id: 'not-a-list' }),
    ]));
    for (const r of rows) expect(r).not.toHaveProperty('later_on_topic');
    expect(text).not.toMatch(/"later_on_topic"/);
  });

  it('leaves a row the gateway sent no later_on_topic for untouched', async () => {
    const plain = { id: 'd-9', title: 't', summary: 's', status: 'active' };
    const { rows } = await callAsk(clientReturning([plain]));
    expect(rows[0]).toEqual(plain);
  });
});

describe('server instructions point the agent at later_on_topic (ALI-1412)', () => {
  it('tells the agent to check newer decisions on the topic before answering, naming the field', async () => {
    const { ALIGN_MCP_INSTRUCTIONS } = await import('../commands/mcp.js');
    const line = ALIGN_MCP_INSTRUCTIONS.split('\n').find((l: string) => l.includes('later_on_topic'));
    expect(line).toBeDefined();
    expect(line).toMatch(/before answering/);
    expect(line).toMatch(/\balign_ask\b/); // rendered with the CLI's tool name
  });
});

// ALI-1426 (AlignBench v13, teams item 1/5): the gateway attaches implemented_by to a ticket hit,
// the merged PRs that shipped it, and nothing told an agent what that field is. With #1401 (the
// clientState guard) listed beside #1405 (the JWT route), 4 of 5 answers named only #1405.
describe('server instructions explain implemented_by', () => {
  it('names the field, says what it lists, and asks for every listed PR to be covered', async () => {
    const { ALIGN_MCP_INSTRUCTIONS } = await import('../commands/mcp.js');
    const line = ALIGN_MCP_INSTRUCTIONS.split('\n').find((l: string) => l.includes('implemented_by'));
    expect(line).toBeDefined();
    expect(line).toMatch(/merged PRs/);
    expect(line).toMatch(/\bevery\b|\beach\b/);
    expect(line).toMatch(/\balign_ask\b/);
  });
});
