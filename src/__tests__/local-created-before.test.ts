/**
 * ALI-1087: local-embedded mode used to reject `--created-before` outright ("there is no
 * cutoff concept locally"), which described the day's implementation rather than a real
 * limit - the local SQLite graph stores a real `created_at` on every decision and edge.
 * This suite mirrors the cloud test shape (align-stack#2447): seed a decision and a LATER
 * edge, query as of a cutoff between them, assert the later one is invisible, then the
 * positive control that makes that assertion mean anything - move the cutoff past it and
 * assert it reappears. Two examples per rule (tdd.md), so neither pass can be a coincidence
 * of one fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Fixed high score: every capture "matches" every query regardless of content, so the
  // only thing that can exclude a decision from a result set is the createdBefore bound
  // under test, not a similarity accident.
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali1087-'));
  dbPath = path.join(dir, 'graph.db');
});

afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** No API sets `created_at` to an arbitrary value (it is a SQLite-default insert-time
 *  column), so the fixture writes it directly - the same pattern decided-at.test.ts and
 *  its migration suite already use for schema-level setup. */
function setCreatedAt(table: 'decisions' | 'decision_links', id: string, iso: string): void {
  const raw = new DatabaseSync(dbPath);
  raw.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(iso, id);
  raw.close();
}

describe('searchDecisions bounds decisions by their own created_at (ALI-1087)', () => {
  it('excludes a decision created at or after the cutoff', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const early = await client.captureDecision('Use Postgres for storage', 'cli');
    const late = await client.captureDecision('Use SQLite for storage', 'cli');
    setCreatedAt('decisions', early.id, '2026-01-01T00:00:00.000Z');
    setCreatedAt('decisions', late.id, '2026-06-01T00:00:00.000Z');

    const asOf = await client.searchDecisions('storage', 10, '2026-03-01T00:00:00.000Z', { all: true });
    const ids = asOf.results.map((r) => r.id);
    expect(ids).toContain(early.id);
    expect(ids).not.toContain(late.id);
  });

  // Positive control for the same rule: moving the cutoff past the later decision's own
  // created_at makes it reappear, which is what proves the exclusion above is the bound
  // rather than a broken query that could never have returned it.
  it('reincludes that same decision once the cutoff moves past its created_at', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const early = await client.captureDecision('Use Postgres for storage', 'cli');
    const late = await client.captureDecision('Use SQLite for storage', 'cli');
    setCreatedAt('decisions', early.id, '2026-01-01T00:00:00.000Z');
    setCreatedAt('decisions', late.id, '2026-06-01T00:00:00.000Z');

    const after = await client.searchDecisions('storage', 10, '2026-12-01T00:00:00.000Z', { all: true });
    expect(after.results.map((r) => r.id)).toContain(late.id);
  });

  // Control: with no --created-before at all, both decisions are visible - the bound is
  // opt-in, not a change to the default unbounded query.
  it('shows both decisions when no cutoff is given', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const early = await client.captureDecision('Use Postgres for storage', 'cli');
    const late = await client.captureDecision('Use SQLite for storage', 'cli');

    const unbounded = await client.searchDecisions('storage', 10, undefined, { all: true });
    const ids = unbounded.results.map((r) => r.id);
    expect(ids).toContain(early.id);
    expect(ids).toContain(late.id);
  });
});

describe('searchDecisions bounds relation edges by BOTH the edge and the counterpart decision (ALI-1087)', () => {
  /** Seeds two decisions (both dated well before any cutoff used below) linked by a
   *  `conflicts_with` edge dated `edgeCreatedAt`, mirroring align-stack#2447's dual bound:
   *  the decisions and the edge asserting a relation between them can predate a cutoff by
   *  different amounts, and both have to be checked. */
  async function seedConflictPair(edgeCreatedAt: string) {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);
    const db = createLocalDb(dbPath);
    opened.push(db);

    const a = await client.captureDecision('Use Postgres for the primary store', 'cli');
    const b = await client.captureDecision('Use MongoDB for the primary store', 'cli');
    setCreatedAt('decisions', a.id, '2026-01-01T00:00:00.000Z');
    setCreatedAt('decisions', b.id, '2026-01-02T00:00:00.000Z');

    db.insertLink({ sourceId: a.id, targetId: b.id, relation: 'conflicts_with', confidence: 0.9 });
    const link = db.listLinks({ decisionId: a.id }).find((l) => l.relation === 'conflicts_with');
    if (!link) throw new Error('seedConflictPair: the conflicts_with edge it just inserted is missing');
    setCreatedAt('decision_links', link.id, edgeCreatedAt);

    return { client, a, b };
  }

  it('hides the conflict when the edge was recorded at or after the cutoff, even though both decisions predate it', async () => {
    const { client, a } = await seedConflictPair('2026-03-01T00:00:00.000Z');

    const asOf = await client.searchDecisions('primary store', 10, '2026-02-01T00:00:00.000Z', { all: true });
    const row = asOf.results.find((r) => r.id === a.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('conflicts_with');
  });

  // Positive control: moving the cutoff past the edge's own created_at surfaces the same
  // conflict, proving the earlier absence was the bound and not a broken join or a typo'd
  // relation name.
  it('surfaces the same conflict once the cutoff moves past the edge created_at', async () => {
    const { client, a, b } = await seedConflictPair('2026-03-01T00:00:00.000Z');

    const after = await client.searchDecisions('primary store', 10, '2026-04-01T00:00:00.000Z', { all: true });
    const row = after.results.find((r) => r.id === a.id);
    expect(row).toMatchObject({ status: 'conflicted' });
    expect(row?.conflicts_with).toMatchObject({ id: b.id });
  });

  // The other half of the dual bound: the edge predates the cutoff, but the COUNTERPART
  // decision does not. A conflict with a decision that did not exist yet as of the cutoff
  // is not one the as-of answer may report.
  it('hides the conflict when the counterpart decision postdates the cutoff, even though the edge predates it', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);
    const db = createLocalDb(dbPath);
    opened.push(db);

    const a = await client.captureDecision('Use Postgres for the primary store', 'cli');
    const b = await client.captureDecision('Use MongoDB for the primary store', 'cli');
    setCreatedAt('decisions', a.id, '2026-01-01T00:00:00.000Z');
    setCreatedAt('decisions', b.id, '2026-05-01T00:00:00.000Z'); // b postdates the cutoff below

    db.insertLink({ sourceId: a.id, targetId: b.id, relation: 'conflicts_with', confidence: 0.9 });
    const link = db.listLinks({ decisionId: a.id }).find((l) => l.relation === 'conflicts_with');
    if (!link) throw new Error('the conflicts_with edge it just inserted is missing');
    setCreatedAt('decision_links', link.id, '2026-01-03T00:00:00.000Z'); // edge predates the cutoff

    const asOf = await client.searchDecisions('primary store', 10, '2026-02-01T00:00:00.000Z', { all: true });
    const row = asOf.results.find((r) => r.id === a.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('conflicts_with');
  });
});
