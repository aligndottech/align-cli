/**
 * ALI-829: when a decision was MADE, from the source's own timestamp, as distinct from
 * `created_at`, the minute this CLI imported it. Every one of the 684 rows in the 2026-09-02
 * measurement carried the ingest minute and nothing else, so "what changed since March" was
 * unanswerable offline. Test List R23-R26 from the plan, two examples per rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb, normaliseDecidedAt, SCHEMA_VERSION } from '../lib/local-db.js';

// Every test here opens a real SQLite file, and the migration tests open two (a hand-built
// v3 file, then the migration chain over it). On the Windows runner one open runs about a
// second - local-gateway-client.test.ts measured 23s for 27 such tests there - so the two
// migration cases timed out at vitest's 5s default on main's 18d1a89 run while passing on
// the same code one run earlier. A timing floor, not a behaviour: 30s per test, this file only.
vi.setConfig({ testTimeout: 30_000 });
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity } from '../lib/local-embeddings.js';

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali829-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open() {
  const db = createLocalDb(dbPath);
  opened.push(db);
  return db;
}

describe('normaliseDecidedAt', () => {
  it('keeps an ISO instant, converting an offset to Z', () => {
    expect(normaliseDecidedAt('2026-03-01T09:00:00.000Z')).toBe('2026-03-01T09:00:00.000Z');
    expect(normaliseDecidedAt('2026-01-11T08:30:00+01:00')).toBe('2026-01-11T07:30:00.000Z');
  });

  it('turns anything it cannot parse into null, never into now', () => {
    // NaN compares false in both directions, so an unchecked bad date would silently vacate
    // any later filter that reads it (verification.md). Null says "unknown".
    expect(normaliseDecidedAt('yesterday')).toBeNull();
    expect(normaliseDecidedAt('')).toBeNull();
    expect(normaliseDecidedAt(undefined)).toBeNull();
  });

  it('refuses what Date.parse would happily misread as a date', () => {
    // '12' is December 2001 and '2026' is New Year's Day to Date.parse: plausible, wrong,
    // and indistinguishable from a measurement downstream. Year 0000 is a negative instant
    // Postgres rejects. A bare ISO date is fine: it names a day.
    expect(normaliseDecidedAt('12')).toBeNull();
    expect(normaliseDecidedAt('2026')).toBeNull();
    expect(normaliseDecidedAt('0000-01-01T00:00:00Z')).toBeNull();
    expect(normaliseDecidedAt('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('treats the epoch itself as unknown, and the instant after it as a date (Copilot on #242)', () => {
    // Epoch zero is what an unset numeric timestamp renders as, so it is rejected on
    // purpose, matching connector-core's toIsoOrUndefined. One second later is a date.
    expect(normaliseDecidedAt('1970-01-01T00:00:00Z')).toBeNull();
    expect(normaliseDecidedAt('1970-01-01T00:00:01Z')).toBe('1970-01-01T00:00:01.000Z');
  });
});

describe('the decided_at column', () => {
  // R26b
  it('is on a fresh database, at schema version 4 or later, with no duplicate-column error', () => {
    // At least, not exactly: ALI-831 added step 5, and a literal here is the pin the
    // SCHEMA_VERSION docstring warns about - it has to be edited by every later migration
    // rather than passing or failing on its own merits.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    const db = open();
    expect(db.listDecisions()).toEqual([]);
    const inspect = new DatabaseSync(dbPath);
    const cols = (inspect.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
    const version = (inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    inspect.close();
    expect(cols).toContain('decided_at');
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('is stored by insertDecision and read back by listDecisions and getDecisionById', () => {
    const db = open();
    const dated = db.insertDecision({ title: 'Dated', summary: 's', sourceUrl: 'https://x/1', platform: 'jira', decidedAt: '2026-03-01T09:00:00.000Z' });
    const undated = db.insertDecision({ title: 'Undated', summary: 's', sourceUrl: 'https://x/2', platform: 'cli' });
    expect(db.getDecisionById(dated)?.decidedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(db.getDecisionById(undated)?.decidedAt).toBeNull();
    const byId = Object.fromEntries(db.listDecisions().map((r) => [r.id, r.decidedAt]));
    expect(byId).toEqual({ [dated]: '2026-03-01T09:00:00.000Z', [undated]: null });
  });

  // R25a
  it('survives a re-import that resolved no date', () => {
    const db = open();
    const id = db.insertDecision({ title: 'T', summary: 's', sourceUrl: 'https://x/1', platform: 'jira', decidedAt: '2026-03-01T09:00:00.000Z' });
    const again = db.insertDecision({ title: 'T', summary: 's2', sourceUrl: 'https://x/1', platform: 'jira' });
    expect(again).toBe(id);
    expect(db.getDecisionById(id)?.decidedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(db.getDecisionById(id)?.summary).toBe('s2'); // the refresh still happened
  });

  it('treats an empty string like no date at the column, so it can never blank a stored one', () => {
    const db = open();
    const id = db.insertDecision({ title: 'T', summary: 's', sourceUrl: 'https://x/1', platform: 'jira', decidedAt: '2026-03-01T09:00:00.000Z' });
    db.insertDecision({ title: 'T', summary: 's', sourceUrl: 'https://x/1', platform: 'jira', decidedAt: '' });
    expect(db.getDecisionById(id)?.decidedAt).toBe('2026-03-01T09:00:00.000Z');
  });

  // R25b
  it('is filled in by a re-import that brought a date to a row that had none', () => {
    const db = open();
    const id = db.insertDecision({ title: 'T', summary: 's', sourceUrl: 'https://x/1', platform: 'jira' });
    db.insertDecision({ title: 'T', summary: 's', sourceUrl: 'https://x/1', platform: 'jira', decidedAt: '2026-03-01T09:00:00.000Z' });
    expect(db.getDecisionById(id)?.decidedAt).toBe('2026-03-01T09:00:00.000Z');
  });
});

/**
 * R26a. A version-3 database, built by hand in the v3 shape (no decided_at column) rather
 * than through createLocalDb, so the migration under test is the only thing that could add
 * the column. Three rows: the Slack tombstone the 0.6.0 fetcher retitles (dropped), a human
 * Slack thread (kept) and a git commit (kept), each with an embedding, refs on two, and links
 * from both Slack rows to the git one. The kept rows are the negative control: the DELETE
 * must be aimed at exactly the tombstone and its dependents.
 */
describe('the v3 -> v4 migration', () => {
  const V3_SCHEMA = `
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
      platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now')), repo TEXT
    );
    CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
    CREATE TABLE decision_links (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE decision_refs (decision_id TEXT NOT NULL, ref TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
    CREATE UNIQUE INDEX decisions_source_title_unique ON decisions(source_url, title);
    CREATE UNIQUE INDEX decision_links_triple_unique ON decision_links(source_id, target_id, relation);
  `;

  function buildV3() {
    const raw = new DatabaseSync(dbPath);
    raw.exec(V3_SCHEMA);
    const ins = raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)');
    ins.run('tomb', 'This message was deleted.', '[#general] Thread:\nThis message was deleted.\nConversation Analysis: 1 decision', 'https://slack.com/archives/C1/p1', 'slack');
    ins.run('human', 'we are going with Postgres', '[#eng] Thread:\nwe are going with Postgres', 'https://slack.com/archives/C1/p2', 'slack');
    ins.run('git1', 'Adopt Postgres for the decision store', 'Adopt Postgres\n\nBecause pgvector.', 'https://github.com/acme/api/commit/abc', 'git');
    // Same words, different platform: a commit subject that happens to read like the
    // tombstone is not one, and the sweep's platform predicate is what protects it.
    ins.run('gitdel', 'This message was deleted.', 'A commit that says so.', 'https://github.com/acme/api/commit/def', 'git');
    const emb = raw.prepare('INSERT INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)');
    for (const id of ['tomb', 'human', 'git1', 'gitdel']) emb.run(id, Buffer.from(new Float32Array(4).fill(0.5).buffer));
    const ref = raw.prepare('INSERT INTO decision_refs (decision_id, ref, platform) VALUES (?, ?, ?)');
    ref.run('tomb', 'ALI-1', 'jira');
    ref.run('human', 'ALI-2', 'jira');
    const link = raw.prepare('INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)');
    link.run('l1', 'tomb', 'git1', 'relates', 0.7);
    link.run('l2', 'human', 'git1', 'relates', 0.8);
    // The tombstone as a link TARGET, so the sweep's `OR target_id` half is pinned too.
    link.run('l3', 'git1', 'tomb', 'relates', 0.6);
    raw.exec('PRAGMA user_version = 3');
    raw.close();
  }

  it('adds the column, stamps the current version, and every surviving row reads decided_at NULL with its text intact', () => {
    buildV3();
    const db = open();
    const human = db.getDecisionById('human');
    const git = db.getDecisionById('git1');
    expect(human).toMatchObject({ title: 'we are going with Postgres', summary: '[#eng] Thread:\nwe are going with Postgres', decidedAt: null });
    expect(git).toMatchObject({ title: 'Adopt Postgres for the decision store', summary: 'Adopt Postgres\n\nBecause pgvector.', decidedAt: null });
    const inspect = new DatabaseSync(dbPath);
    // The open runs every later step too, so the stamp is the current version, not 4.
    expect((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    inspect.close();
  });

  it('drops the tombstone-titled Slack row with its embedding, refs and links, and nothing else', () => {
    buildV3();
    const db = open();
    // The positive assertion first: the row IS gone. Then every dependent, by table.
    expect(db.getDecisionById('tomb')).toBeNull();
    expect(db.getEmbedding('tomb')).toBeNull();
    expect(db.getRefs('tomb')).toEqual([]);
    expect(db.listLinks({ decisionId: 'tomb' })).toEqual([]);
    // The negative control: the human Slack row, the git row and the git row that merely
    // shares the tombstone's words keep everything; only the edges touching `tomb` go.
    expect(db.listDecisions().map((r) => r.id).sort()).toEqual(['git1', 'gitdel', 'human']);
    expect(db.getEmbedding('human')).not.toBeNull();
    expect(db.getEmbedding('git1')).not.toBeNull();
    expect(db.getEmbedding('gitdel')).not.toBeNull();
    expect(db.getRefs('human')).toEqual([{ ref: 'ALI-2', platform: 'jira' }]);
    expect(db.listLinks({ decisionId: 'git1' }).map((l) => l.id)).toEqual(['l2']);
  });

  it('does not run twice: reopening a v4 database leaves a human-titled Slack row alone', () => {
    buildV3();
    open().close();
    opened.pop();
    // A row with the tombstone title inserted AFTER the migration is the user's problem to
    // re-import, not the migration's to delete on every open - the version guard is what
    // makes the sweep a one-time event.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)')
      .run('late', 'This message was deleted.', 's', 'https://slack.com/archives/C1/p9', 'slack');
    raw.close();
    const db = open();
    expect(db.getDecisionById('late')).not.toBeNull();
  });
});

/**
 * The gap the migration cannot close: a tombstone written AFTER the v4 stamp (a 0.5.0
 * fetcher, still titling from the deleted root) meets its retitled twin at the next
 * 0.6.0 import of the same thread. The write path reconciles it there.
 */
describe('a Slack thread arriving under a real title replaces its tombstone twin', () => {
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(() => {
    client = createLocalGatewayClient(dbPath);
    opened.push(client);
  });

  it('removes the tombstone row for the SAME source_url, with its embedding', async () => {
    const seed = open();
    const tombId = seed.insertDecision({ title: 'This message was deleted.', summary: 'bot only', sourceUrl: 'https://slack.com/archives/C1/p1', platform: 'slack' });
    seed.setEmbedding(tombId, new Float32Array(4).fill(0.5));
    await client.ingestBatch([{ source_url: 'https://slack.com/archives/C1/p1', platform: 'slack', raw_text: 'we are going with Postgres', title: 'we are going with Postgres' }]);
    const db = open();
    const rows = db.listDecisions().filter((r) => r.sourceUrl === 'https://slack.com/archives/C1/p1');
    expect(rows.map((r) => r.title)).toEqual(['we are going with Postgres']);
    expect(db.getEmbedding(tombId)).toBeNull();
  });

  it('leaves a tombstone for a DIFFERENT thread alone, and never touches a non-Slack row', async () => {
    const seed = open();
    const otherTomb = seed.insertDecision({ title: 'This message was deleted.', summary: 'bot only', sourceUrl: 'https://slack.com/archives/C1/p2', platform: 'slack' });
    const gitRow = seed.insertDecision({ title: 'This message was deleted.', summary: 'a commit', sourceUrl: 'https://slack.com/archives/C1/p1', platform: 'git' });
    await client.ingestBatch([{ source_url: 'https://slack.com/archives/C1/p1', platform: 'slack', raw_text: 'real', title: 'real' }]);
    const db = open();
    expect(db.getDecisionById(otherTomb)).not.toBeNull();
    expect(db.getDecisionById(gitRow)).not.toBeNull();
  });
});

/**
 * R23, R24: the ingest path. `created_at` on an item is the source's date; it lands as
 * decided_at, normalised once, and a bad value drops the FIELD, never the item.
 */
describe('ingestBatch carries created_at into decided_at', () => {
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(() => {
    client = createLocalGatewayClient(dbPath);
    opened.push(client);
  });

  const item = (n: number, extra: Record<string, unknown> = {}) => ({
    source_url: `https://x/${n}`, platform: 'jira', raw_text: `text ${n}`, title: `T${n}`, ...extra,
  });

  it('R23a: stores the item date as decided_at, and R23b: NULL when the item has none', async () => {
    const { snapshots } = await client.ingestBatch([
      item(1, { created_at: '2026-03-01T09:00:00.000Z' }),
      item(2),
    ]);
    const db = open();
    expect(db.getDecisionById(snapshots[0].id)?.decidedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(db.getDecisionById(snapshots[1].id)?.decidedAt).toBeNull();
  });

  it('R24a/b: an unparseable or empty date drops the field and keeps the item', async () => {
    const { snapshots } = await client.ingestBatch([
      item(1, { created_at: 'yesterday' }),
      item(2, { created_at: '' }),
    ]);
    expect(snapshots).toHaveLength(2);
    const db = open();
    expect(db.getDecisionById(snapshots[0].id)).toMatchObject({ title: 'T1', decidedAt: null });
    expect(db.getDecisionById(snapshots[1].id)).toMatchObject({ title: 'T2', decidedAt: null });
  });
});

/**
 * Phase 10: the client returns decided_at ALONGSIDE created_at on every read path, never
 * instead of it - two fields, two meanings. Absent (not null, not '') when the row has none,
 * so a cloud-shaped consumer sees exactly what it saw before.
 */
describe('the local client surfaces decided_at', () => {
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(async () => {
    client = createLocalGatewayClient(dbPath);
    opened.push(client);
    await client.ingestBatch([
      { source_url: 'https://x/1', platform: 'jira', raw_text: 'dated', title: 'Dated', created_at: '2026-03-01T09:00:00.000Z' },
      { source_url: 'https://x/2', platform: 'jira', raw_text: 'undated', title: 'Undated' },
    ]);
  });

  it('listDecisions: decided_at on the dated row, absent on the other, created_at on both', async () => {
    const rows = await client.listDecisions({ all: true });
    const dated = rows.find((r) => r.title === 'Dated') as Record<string, unknown>;
    const undated = rows.find((r) => r.title === 'Undated') as Record<string, unknown>;
    expect(dated.decided_at).toBe('2026-03-01T09:00:00.000Z');
    expect(typeof dated.created_at).toBe('string');
    expect('decided_at' in undated).toBe(false);
    expect(typeof undated.created_at).toBe('string');
  });

  it('searchDecisions: the same two fields on a hit', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.9);
    const { results } = await client.searchDecisions('dated', 10, { all: true });
    const dated = results.find((r) => r.title === 'Dated') as Record<string, unknown>;
    const undated = results.find((r) => r.title === 'Undated') as Record<string, unknown>;
    expect(dated.decided_at).toBe('2026-03-01T09:00:00.000Z');
    expect(typeof dated.created_at).toBe('string');
    expect('decided_at' in undated).toBe(false);
  });

  it('getDecision: decided_at when present, absent when not', async () => {
    const rows = await client.listDecisions({ all: true });
    const datedId = rows.find((r) => r.title === 'Dated')!.id;
    const undatedId = rows.find((r) => r.title === 'Undated')!.id;
    expect((await client.getDecision(datedId) as Record<string, unknown>).decided_at).toBe('2026-03-01T09:00:00.000Z');
    expect('decided_at' in (await client.getDecision(undatedId) as Record<string, unknown>)).toBe(false);
  });
});
