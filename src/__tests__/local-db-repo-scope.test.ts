/**
 * The repo dimension on the local graph's own storage layer - the column, the
 * upsert semantics, the migration backfill, and the scoping primitives `listDecisions`/
 * `getAllEmbeddings` give the layer above (local-gateway-client.ts) to build the actual
 * "current repo, or all" retrieval rule on top of.
 *
 * Test List:
 * 1. a fresh database carries the repo column; SCHEMA_VERSION is 3
 * 2. insertDecision stores repo; listDecisions({repo}) returns it and excludes another repo
 * 3. listDecisions({repo, includeUnattributed:true}) returns that repo's rows AND
 *    unattributed rows, but not a different repo's (two examples: attributed table.ts's own
 *    filter arm, not just presence)
 * 4. upsert COALESCEs: a re-import with repo:null never erases an existing attribution,
 *    and a re-import that DOES resolve a repo can fill one in that was missing
 * 5. migrating a v2 graph backfills repo from source_url for hosted rows and leaves a
 *    remoteless git://commit row unattributed (the documented asymmetry)
 * 6. getAllEmbeddings({repo}) scopes the same way as listDecisions
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let dir: string;
let dbPath: string;
let db: ReturnType<typeof createLocalDb> | undefined;

beforeEach(() => {
  db = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-db-'));
  dbPath = path.join(dir, 'graph.db');
});

afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the repo column', () => {
  it('is on a fresh database, and the schema is at least the version that added it (3)', () => {
    // The repo column arrived at 3. Later steps (decided_at at 4) keep it, so this
    // pins a floor rather than the current number - the exact literal is one fact with
    // migrate() and is derived, not asserted, in local-db-dedup.test.ts.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    db = createLocalDb(dbPath);
    // A throwaway inline `new DatabaseSync(dbPath)` is never closed, so its handle survives
    // this test and races afterEach's `fs.rmSync` - harmless on Linux/macOS, EBUSY on
    // Windows (the same reason `raw` below gets its own `.close()`).
    const inspect = new DatabaseSync(dbPath);
    const cols = inspect.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
    inspect.close();
    expect(cols.some((c) => c.name === 'repo')).toBe(true);
  });

  it('is stored by insertDecision and returned by listDecisions scoped to it', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'A decision', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    db.insertDecision({ title: 'Another repo entirely', summary: 's', sourceUrl: 'https://github.com/acme/web/pull/1', platform: 'github', repo: 'github.com/acme/web' });

    const scoped = db.listDecisions({ repo: 'github.com/acme/api' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe('A decision');
    expect(scoped[0].repo).toBe('github.com/acme/api');
  });

  it('with includeUnattributed also returns rows with no repo, but not a different repo (two members of the OR)', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'From api', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    db.insertDecision({ title: 'A Jira ticket', summary: 's', sourceUrl: 'https://acme.atlassian.net/browse/X-1', platform: 'jira', repo: null });
    db.insertDecision({ title: 'From web', summary: 's', sourceUrl: 'https://github.com/acme/web/pull/1', platform: 'github', repo: 'github.com/acme/web' });

    const rows = db.listDecisions({ repo: 'github.com/acme/api', includeUnattributed: true });
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['A Jira ticket', 'From api']);
  });
});

describe('upsert never erases an attribution, and can add one', () => {
  it('a re-import with no resolvable repo keeps the one already stored', () => {
    db = createLocalDb(dbPath);
    const url = 'https://github.com/acme/api/pull/1';
    db.insertDecision({ title: 'T', summary: 'v1', sourceUrl: url, platform: 'github', repo: 'github.com/acme/api' });
    db.insertDecision({ title: 'T', summary: 'v2 refreshed', sourceUrl: url, platform: 'github', repo: null });

    const row = db.listDecisions({ repo: 'github.com/acme/api' })[0];
    expect(row.summary).toBe('v2 refreshed');
    expect(row.repo).toBe('github.com/acme/api');
  });

  it('a re-import that DOES resolve a repo fills in one that was previously missing', () => {
    db = createLocalDb(dbPath);
    const url = 'https://github.com/acme/api/pull/1';
    db.insertDecision({ title: 'T', summary: 'v1', sourceUrl: url, platform: 'github', repo: null });
    db.insertDecision({ title: 'T', summary: 'v2', sourceUrl: url, platform: 'github', repo: 'github.com/acme/api' });

    expect(db.listDecisions({ repo: 'github.com/acme/api' })).toHaveLength(1);
  });
});

describe('migrating a v2 graph backfills repo from source_url', () => {
  it('attributes hosted rows and leaves a remoteless git commit unattributed', () => {
    // Simulate a graph that predates repo scoping: create the v2 shape by hand (no repo column, no
    // migrate()), the way createLocalDb would have left it before this ticket.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
        platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE decision_refs (decision_id TEXT NOT NULL, ref TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
      CREATE UNIQUE INDEX decisions_source_title_unique ON decisions(source_url, title);
      CREATE UNIQUE INDEX decision_links_triple_unique ON decision_links(source_id, target_id, relation);
      PRAGMA user_version = 2;
    `);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)')
      .run('d1', 'Hosted commit', 's', 'https://github.com/acme/api/commit/abc1234', 'git');
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)')
      .run('d2', 'Remoteless commit', 's', 'git://commit/def5678', 'git');
    raw.close();

    // Opening through createLocalDb runs migrate() and must backfill exactly d1.
    db = createLocalDb(dbPath);
    const hosted = db.getDecisionById('d1');
    const remoteless = db.getDecisionById('d2');
    expect(hosted?.repo).toBe('github.com/acme/api');
    expect(remoteless?.repo).toBeNull();

    // And the version is now stamped 3, so re-opening does not re-run the backfill.
    // Same throwaway-handle leak as the first test in this file - close it before the
    // directory removal in afterEach, or Windows EBUSYs on the unlink.
    const versionCheck = new DatabaseSync(dbPath);
    const version = (versionCheck.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    versionCheck.close();
    expect(version).toBe(SCHEMA_VERSION);
  });
});

describe('getAllEmbeddings scopes by repo the same way listDecisions does', () => {
  it('returns only the scoped repo plus unattributed embeddings', async () => {
    db = createLocalDb(dbPath);
    const idA = db.insertDecision({ title: 'A', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    const idB = db.insertDecision({ title: 'B', summary: 's', sourceUrl: 'https://github.com/acme/web/pull/1', platform: 'github', repo: 'github.com/acme/web' });
    const idC = db.insertDecision({ title: 'C', summary: 's', sourceUrl: null, platform: 'cli', repo: null });
    for (const id of [idA, idB, idC]) db.setEmbedding(id, new Float32Array([1, 0, 0]));

    const scoped = db.getAllEmbeddings({ repo: 'github.com/acme/api', includeUnattributed: true });
    expect(scoped.map((e) => e.decisionId).sort()).toEqual([idA, idC].sort());

    const unscoped = db.getAllEmbeddings();
    expect(unscoped).toHaveLength(3);
  });
});

// code-conductor's rules were shown in an unrelated repo because a docs row (a /blob/ URL) was stored with no repo.
describe('docs rows are tied to their repo', () => {
  const docsUrl = (repo: string, file: string) => `https://github.com/${repo}/blob/main/${file}`;

  it('an imported docs row is stamped with its repo, so another repo does not list it', async () => {
    const c = createLocalGatewayClient(dbPath);
    try {
      await c.ingestBatch([{ source_url: docsUrl('acme/api', 'docs/adr/1.md'), platform: 'docs', title: 'Use Postgres', raw_text: '# Use Postgres\n\nWe chose it for the JSON support.' }] as never, { classify: false, keyed: true });
    } finally { c.close(); }
    db = createLocalDb(dbPath);
    expect(db.listDecisions({ repo: 'github.com/acme/api', includeUnattributed: true }).map((r) => r.title)).toEqual(['Use Postgres']);
    expect(db.listDecisions({ repo: 'github.com/someone/other', includeUnattributed: true })).toEqual([]);
  });

  it('opening a graph that already holds unattributed docs rows fills their repo in, once, and leaves other rows alone', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'A rule', summary: 's', sourceUrl: docsUrl('acme/api', 'CLAUDE.md#a-rule'), platform: 'docs', keyed: true });
    db.insertDecision({ title: 'No remote rule', summary: 's', sourceUrl: 'git://blob/main/CLAUDE.md#no-remote', platform: 'docs', keyed: true });
    db.insertDecision({ title: 'A ticket', summary: 's', sourceUrl: 'https://acme.atlassian.net/browse/P-1', platform: 'jira', keyed: true });
    db.close();
    db = undefined;
    const raw = new DatabaseSync(dbPath);
    const repos = () => Object.fromEntries((raw.prepare('SELECT title, repo FROM decisions').all() as Array<{ title: string; repo: string | null }>).map((r) => [r.title, r.repo]));
    expect(repos()).toEqual({ 'A rule': null, 'No remote rule': null, 'A ticket': null });
    raw.close();
    db = createLocalDb(dbPath);
    db.close();
    db = undefined;
    const after = new DatabaseSync(dbPath);
    try {
      expect(Object.fromEntries((after.prepare('SELECT title, repo FROM decisions').all() as Array<{ title: string; repo: string | null }>).map((r) => [r.title, r.repo]))).toEqual({
        'A rule': 'github.com/acme/api',
        // No repository name in the URL: stays unattributed, which is "not known", not "wrong".
        'No remote rule': null,
        // Not a docs row: the backfill is for docs only.
        'A ticket': null,
      });
    } finally { after.close(); }
  });
});

