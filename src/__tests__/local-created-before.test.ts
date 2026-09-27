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

/**
 * Copilot (#320): every test above writes an ISO-8601 string into `created_at` directly,
 * which is NOT what SQLite's own `datetime('now')` default actually produces there -
 * 'YYYY-MM-DD HH:MM:SS', a space, no offset. Because every fixture in this file used the
 * same (wrong) format on both sides of the comparison, none of them could have caught a
 * mismatch between the two. This converts an ISO instant into the real stored shape, so
 * the tests below reproduce what the column actually contains.
 */
function sqliteFormat(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '');
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

/**
 * Copilot (#320): `d.created_at < ?` compared SQLite's real stored format directly against
 * an ISO cutoff as TEXT. On any date the two share, ' ' (0x20) sorts before 'T' (0x54)
 * regardless of the actual clock time, so a decision captured LATER on the cutoff's own
 * calendar day still compared as "before" it. The tests above never caught this because
 * their fixtures wrote ISO strings on both sides - this block uses `sqliteFormat` to write
 * what the column really holds.
 */
describe('the SQLite-format vs ISO-cutoff comparison, same calendar day (ALI-1087, Copilot #320)', () => {
  it('excludes a decision created LATER the same day as the cutoff', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const early = await client.captureDecision('Use Postgres for storage', 'cli');
    const late = await client.captureDecision('Use SQLite for storage', 'cli');
    setCreatedAt('decisions', early.id, sqliteFormat('2026-03-01T06:00:00.000Z'));
    setCreatedAt('decisions', late.id, sqliteFormat('2026-03-01T23:00:00.000Z'));

    const asOf = await client.searchDecisions('storage', 10, '2026-03-01T12:00:00.000Z', { all: true });
    const ids = asOf.results.map((r) => r.id);
    expect(ids).toContain(early.id);
    expect(ids).not.toContain(late.id);
  });

  // Positive control: a decision created EARLIER the same day is still included - proves
  // the exclusion above is about time-of-day, not about the calendar date matching.
  it('still includes a decision created EARLIER the same day as the cutoff', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);

    const early = await client.captureDecision('Use Postgres for storage', 'cli');
    setCreatedAt('decisions', early.id, sqliteFormat('2026-03-01T06:00:00.000Z'));

    const asOf = await client.searchDecisions('storage', 10, '2026-03-01T12:00:00.000Z', { all: true });
    expect(asOf.results.map((r) => r.id)).toContain(early.id);
  });

  it('excludes a conflict whose edge was recorded LATER the same day as the cutoff', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);
    const db = createLocalDb(dbPath);
    opened.push(db);

    const a = await client.captureDecision('Use Postgres for the primary store', 'cli');
    const b = await client.captureDecision('Use MongoDB for the primary store', 'cli');
    setCreatedAt('decisions', a.id, sqliteFormat('2026-01-01T00:00:00.000Z'));
    setCreatedAt('decisions', b.id, sqliteFormat('2026-01-02T00:00:00.000Z'));

    db.insertLink({ sourceId: a.id, targetId: b.id, relation: 'conflicts_with', confidence: 0.9 });
    const link = db.listLinks({ decisionId: a.id }).find((l) => l.relation === 'conflicts_with');
    if (!link) throw new Error('the conflicts_with edge it just inserted is missing');
    setCreatedAt('decision_links', link.id, sqliteFormat('2026-03-01T23:00:00.000Z'));

    const asOf = await client.searchDecisions('primary store', 10, '2026-03-01T12:00:00.000Z', { all: true });
    const row = asOf.results.find((r) => r.id === a.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('conflicts_with');
  });
});

/**
 * Copilot (#320): `relationFieldsFor` used to stop at the FIRST supersession edge
 * `links.find(...)` returned. If that candidate's successor postdated the cutoff, the whole
 * lookup returned `{}` - hiding an EARLIER, genuinely valid successor sitting right next to
 * it. This seeds two supersession edges targeting one decision, with the invalid one
 * inserted first so a naive first-match lookup hits it before the valid one.
 */
describe('relationFieldsFor tries every supersession candidate, not just the first found (ALI-1087, Copilot #320)', () => {
  it('reports an earlier valid successor when the first-found candidate fails the cutoff bound', async () => {
    const client = createLocalGatewayClient(dbPath);
    opened.push(client);
    const db = createLocalDb(dbPath);
    opened.push(db);

    const target = await client.captureDecision('Old decision needing a successor', 'cli');
    const invalidSuccessor = await client.captureDecision('Successor that postdates the cutoff', 'cli');
    const validSuccessor = await client.captureDecision('Successor that predates the cutoff', 'cli');
    setCreatedAt('decisions', target.id, '2026-01-01T00:00:00.000Z');
    setCreatedAt('decisions', invalidSuccessor.id, '2026-06-01T00:00:00.000Z');
    setCreatedAt('decisions', validSuccessor.id, '2026-01-15T00:00:00.000Z');

    // Insert the edge to the INVALID successor first, so a naive first-match `.find()`
    // (no fallback to the next candidate) hits it before the valid one.
    db.insertLink({ sourceId: invalidSuccessor.id, targetId: target.id, relation: 'supersedes', confidence: 1 });
    db.insertLink({ sourceId: validSuccessor.id, targetId: target.id, relation: 'supersedes', confidence: 1 });
    for (const l of db.listLinks({ decisionId: target.id })) {
      setCreatedAt('decision_links', l.id, '2026-01-20T00:00:00.000Z'); // both edges predate the cutoff
    }

    const asOf = await client.searchDecisions('Old decision needing a successor', 10, '2026-03-01T00:00:00.000Z', { all: true });
    const row = asOf.results.find((r) => r.id === target.id);
    expect(row).toMatchObject({ status: 'superseded' });
    expect(row?.successor).toMatchObject({ id: validSuccessor.id });
  });
});
