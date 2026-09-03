/**
 * ALI-831: the local client carries decider provenance in every decision payload, so an
 * agent reading the local MCP server (and `align context sync`, which reads listDecisions)
 * can tell a claim from a rule. Fields in wire spelling: `decider_kind`, `ratified`
 * (boolean), `ratified_at`, `ratified_by`.
 *
 * Test List:
 * 1. ingest derives decider_kind from the platform: agent-session -> agent, git -> human
 * 2. listDecisions carries the fields for an agent row (unratified, then ratified), a human
 *    row, and a pre-column row (unknown) - one fixture per value the field can take
 * 3. listDecisions({ unratified: true }) reaches the db filter
 * 4. searchDecisions, getDecision and checkAlignment (retrieval depth) carry the same fields
 * 5. ratifyDecision writes the stamp and an audit row; a second call reports the first;
 *    a missing id throws a message naming the id
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Above every retrieval floor, so search and check both surface every row.
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali831-client-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  const c = createLocalGatewayClient(dbPath);
  opened.push(c);
  return c;
}

async function seed(c: ReturnType<typeof client>) {
  const { snapshots } = await c.ingestBatch([
    { source_url: 'claude-session://s1/m1', platform: 'agent-session', raw_text: 'Agent picked sqlite for the cache', title: 'Agent picked sqlite for the cache' },
    { source_url: 'https://github.com/acme/api/commit/abc1234', platform: 'git', raw_text: 'Human chose postgres', title: 'Human chose postgres' },
  ]);
  const agentId = snapshots[0]!.id;
  const humanId = snapshots[1]!.id;
  // A row from before the column existed: written straight to the db with no kind.
  const raw = createLocalDb(dbPath);
  opened.push(raw);
  const legacyId = raw.insertDecision({ title: 'Legacy row', summary: 'from before', sourceUrl: null, platform: 'cli' });
  return { agentId, humanId, legacyId };
}

describe('ingest derives decider_kind from the platform', () => {
  it('agent-session rows are agent, git rows are human', async () => {
    const c = client();
    const { agentId, humanId } = await seed(c);
    const db = createLocalDb(dbPath);
    opened.push(db);
    expect(db.getDecisionById(agentId)?.deciderKind).toBe('agent');
    expect(db.getDecisionById(humanId)?.deciderKind).toBe('human');
  });
});

describe('listDecisions carries provenance', () => {
  it('agent unratified, human, and unknown each read as themselves', async () => {
    const c = client();
    const { agentId, humanId, legacyId } = await seed(c);
    const rows = await c.listDecisions({ all: true });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[agentId]).toMatchObject({ decider_kind: 'agent', ratified: false });
    expect(byId[agentId]).not.toHaveProperty('ratified_at');
    expect(byId[humanId]).toMatchObject({ decider_kind: 'human', ratified: false });
    expect(byId[legacyId]).toMatchObject({ decider_kind: 'unknown', ratified: false });
  });

  it('after ratification the agent row reads ratified, with who and when', async () => {
    const c = client();
    const { agentId } = await seed(c);
    await c.ratifyDecision(agentId, { ratifiedBy: 'tom@align.tech' });
    const row = (await c.listDecisions({ all: true })).find((r) => r.id === agentId);
    expect(row).toMatchObject({ decider_kind: 'agent', ratified: true, ratified_by: 'tom@align.tech' });
    expect(row?.ratified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('{ unratified: true } returns only the agent claim', async () => {
    const c = client();
    const { agentId } = await seed(c);
    const rows = await c.listDecisions({ all: true, unratified: true });
    expect(rows.map((r) => r.id)).toEqual([agentId]);
  });
});

describe('the other payloads carry the same fields', () => {
  it('captureDecision, for an agent-session capture', async () => {
    const c = client();
    const captured = await c.captureDecision('align picked the schema-first approach', 'agent-session');
    expect(captured).toMatchObject({ decider_kind: 'agent', ratified: false });
  });

  it('searchDecisions', async () => {
    const c = client();
    const { agentId, humanId } = await seed(c);
    const { results } = await c.searchDecisions('sqlite', 10, { all: true });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[agentId]).toMatchObject({ decider_kind: 'agent', ratified: false });
    expect(byId[humanId]).toMatchObject({ decider_kind: 'human', ratified: false });
  });

  it('getDecision', async () => {
    const c = client();
    const { agentId } = await seed(c);
    await c.ratifyDecision(agentId, { ratifiedBy: 'tom@align.tech' });
    expect(await c.getDecision(agentId)).toMatchObject({ decider_kind: 'agent', ratified: true, ratified_by: 'tom@align.tech' });
  });

  it('checkAlignment relevant_decisions, at retrieval depth', async () => {
    const c = client();
    const { agentId, humanId } = await seed(c);
    const res = await c.checkAlignment('use sqlite for the cache', undefined, { depth: 'related' });
    const byId = Object.fromEntries(res.relevant_decisions.map((r) => [r.id, r]));
    expect(byId[agentId]).toMatchObject({ decider_kind: 'agent', ratified: false });
    expect(byId[humanId]).toMatchObject({ decider_kind: 'human', ratified: false });
  });
});

describe('ratifyDecision', () => {
  it('writes the stamp, records an audit row, and reports it was not already ratified', async () => {
    const c = client();
    const { agentId } = await seed(c);
    const res = await c.ratifyDecision(agentId, { ratifiedBy: 'tom@align.tech' });
    expect(res).toMatchObject({ alreadyRatified: false, ratifiedBy: 'tom@align.tech' });
    expect(res.ratifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const db = createLocalDb(dbPath);
    opened.push(db);
    expect(db.listAudit(agentId).map((a) => [a.action, a.actor])).toEqual([['ratified', 'tom@align.tech']]);
  });

  it('a second call reports the first ratification and writes no second audit row', async () => {
    const c = client();
    const { agentId } = await seed(c);
    const first = await c.ratifyDecision(agentId, { ratifiedBy: 'tom@align.tech' });
    const second = await c.ratifyDecision(agentId, { ratifiedBy: 'someone-else' });
    expect(second).toEqual({ alreadyRatified: true, ratifiedBy: 'tom@align.tech', ratifiedAt: first.ratifiedAt });
    const db = createLocalDb(dbPath);
    opened.push(db);
    expect(db.listAudit(agentId)).toHaveLength(1);
  });

  it('throws naming the id when the graph does not hold it', async () => {
    const c = client();
    await c.ingestBatch([]);
    await expect(c.ratifyDecision('no-such-id', { ratifiedBy: 'tom@align.tech' })).rejects.toThrow(/no-such-id/);
  });
});
