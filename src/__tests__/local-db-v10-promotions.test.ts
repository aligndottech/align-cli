import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { getLegacyPromotion, getPromotion, listPromotions, markRetracted, recordPromotion } from '../lib/share/ledger.js';

/**
 * L9 Test List, schema v10 (the promotions ledger):
 * - A fresh graph is at v10 and has `promotions`, with NO foreign key to decisions (a forgotten decision keeps its record).
 * - A v9 file migrates with every row unchanged; a second open and a replay of the step change nothing.
 * - Old `align push` audit rows ('pushed', detail env:cloudId) become 'legacy' ledger rows; a row with no cloud id is skipped.
 * - A graph from a NEWER CLI is refused (the downgrade guard moved with the bump).
 * - The ledger: a recorded share is read back by (local id, env, tenant); another tenant, another env and another id read nothing;
 *   a re-record replaces the hash and clears a retraction; markRetracted stamps only its own row.
 * - On a copy of the real graph (718 decisions): migrate, count, replay.
 */
vi.setConfig({ testTimeout: 60_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-v10-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const version = () => sql<{ user_version: number }>('PRAGMA user_version')[0]!.user_version;

describe('a fresh graph', () => {
  it('is at v10 with a promotions table that has no foreign key', () => {
    createLocalDb(dbPath).close();
    expect(SCHEMA_VERSION).toBe(11);
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql<{ name: string }>('PRAGMA table_info(promotions)').map((c) => c.name)).toEqual(
      ['local_id', 'env', 'tenant_id', 'remote_id', 'content_hash', 'matched', 'client_key', 'sent', 'confirm_pending', 'shared_at', 'retracted_at'],
    );
    expect(sql('PRAGMA foreign_key_list(promotions)')).toHaveLength(0);
  });
});

describe('a v9 graph', () => {
  function makeV9(): void {
    createLocalDb(dbPath).close();
    exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ('a', 'a', 's', 'cli'), ('b', 'b', 's', 'cli')`);
    exec('DROP TABLE promotions; PRAGMA user_version = 9');
  }
  it('migrates with every row unchanged, and a second open or a replay of the step changes nothing', () => {
    makeV9();
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);
    const once = sql('SELECT count(*) AS n FROM sqlite_master')[0];
    createLocalDb(dbPath).close();
    exec('PRAGMA user_version = 9');
    createLocalDb(dbPath).close();
    expect(sql('SELECT count(*) AS n FROM sqlite_master')[0]).toEqual(once);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);
    expect(version()).toBe(SCHEMA_VERSION);
  });
  it('turns old push audit rows into legacy ledger rows, once, and skips a row with no cloud id', () => {
    makeV9();
    exec(`INSERT INTO decision_audit (id, decision_id, action, actor, detail) VALUES
      ('1', 'a', 'pushed', 'tom', 'prod:cloud-a'), ('2', 'b', 'pushed', 'tom', 'prod'), ('3', 'a', 'ratified', 'tom', NULL)`);
    createLocalDb(dbPath).close();
    createLocalDb(dbPath).close();
    exec('PRAGMA user_version = 9');
    createLocalDb(dbPath).close();
    expect(sql('SELECT local_id, env, tenant_id, remote_id, content_hash, matched FROM promotions')).toEqual([
      { local_id: 'a', env: 'prod', tenant_id: 'legacy', remote_id: 'cloud-a', content_hash: '', matched: 0 },
    ]);
  });
});

describe('a graph from a newer CLI', () => {
  it('is refused on open, and left untouched', () => {
    createLocalDb(dbPath).close();
    exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => createLocalDb(dbPath)).toThrow(/written by a newer Align CLI/);
    expect(version()).toBe(SCHEMA_VERSION + 1);
  });
});

describe('the ledger', () => {
  const base = { localId: 'L1', env: 'prod', tenantId: 'T1', remoteId: 'R1', contentHash: 'h1', matched: false, clientKey: 'k1', sent: [], confirmPending: false };
  beforeEach(() => { createLocalDb(dbPath).close(); });

  it('reads back a recorded share by (local id, env, tenant) and nothing for any other key', () => {
    recordPromotion(dbPath, base);
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')).toMatchObject({ remoteId: 'R1', contentHash: 'h1', matched: false, retractedAt: null });
    expect(getPromotion(dbPath, 'L1', 'prod', 'T2')).toBeNull();
    expect(getPromotion(dbPath, 'L1', 'preview', 'T1')).toBeNull();
    expect(getPromotion(dbPath, 'L2', 'prod', 'T1')).toBeNull();
  });
  it('a second record replaces the hash and remote id and clears a retraction', () => {
    recordPromotion(dbPath, base);
    markRetracted(dbPath, 'L1', 'prod', 'T1');
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')!.retractedAt).not.toBeNull();
    recordPromotion(dbPath, { ...base, contentHash: 'h2', remoteId: 'R9', matched: true, clientKey: 'k2', sent: ['a', 'a', 'b'], confirmPending: true });
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')).toMatchObject({ contentHash: 'h2', remoteId: 'R9', matched: true, clientKey: 'k2', sent: ['a', 'b'], confirmPending: true, retractedAt: null });
    expect(sql('SELECT 1 FROM promotions')).toHaveLength(1);
  });
  it('markRetracted stamps only its own row', () => {
    recordPromotion(dbPath, base);
    recordPromotion(dbPath, { ...base, localId: 'L2', remoteId: 'R2' });
    markRetracted(dbPath, 'L1', 'prod', 'T1');
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')!.retractedAt).not.toBeNull();
    expect(getPromotion(dbPath, 'L2', 'prod', 'T1')!.retractedAt).toBeNull();
  });
  it('lists the live shares of one workspace, not a retracted one and not another workspace', () => {
    recordPromotion(dbPath, base);
    recordPromotion(dbPath, { ...base, localId: 'L2', remoteId: 'R2' });
    recordPromotion(dbPath, { ...base, localId: 'L3', remoteId: 'R3', tenantId: 'T2' });
    markRetracted(dbPath, 'L2', 'prod', 'T1');
    expect([...listPromotions(dbPath, 'prod', 'T1').keys()]).toEqual(['L1']);
  });
  it('finds a legacy row by (local id, env) only', () => {
    exec(`INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES ('L7', 'prod', 'legacy', 'old', '')`);
    expect(getLegacyPromotion(dbPath, 'L7', 'prod')).toMatchObject({ remoteId: 'old' });
    expect(getLegacyPromotion(dbPath, 'L7', 'preview')).toBeNull();
    expect(getPromotion(dbPath, 'L7', 'prod', 'T1')).toBeNull();
  });
  it('a reader never creates a missing graph, and a pre-v10 file reads as nothing shared', () => {
    expect(getPromotion(path.join(dir, 'nope.db'), 'L1', 'prod', 'T1')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'nope.db'))).toBe(false);
    exec('DROP TABLE promotions');
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')).toBeNull();
  });
});

const REAL = '/tmp/claude-1000/-home-thomas-aligndottech-align-stack/7915f407-23ef-4e7b-9338-df7deb537dd6/scratchpad/l2real/before/local.db';
describe('a copy of the real graph', () => {
  it.skipIf(!fs.existsSync(REAL))('migrates to v10 with all 718 decisions unchanged, and replays', () => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(REAL + suffix)) fs.copyFileSync(REAL + suffix, dbPath + suffix);
    const titlesBefore = sql<{ t: string }>('SELECT group_concat(id || title, char(10)) AS t FROM (SELECT id, title FROM decisions ORDER BY id)')[0]!.t;
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n).toBe(718);
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM promotions')[0]!.n).toBe(0);
    exec('PRAGMA user_version = 9');
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    // `id,title` rows are the same set after migration and replay: nothing merged, nothing lost.
    const titlesAfter = sql<{ t: string }>('SELECT group_concat(id || title, char(10)) AS t FROM (SELECT id, title FROM decisions ORDER BY id)')[0]!.t;
    expect(titlesAfter).toBe(titlesBefore);
  });
});

/**
 * L9 second review, item 4: a graph an EARLIER build of this branch stamped v10 (promotions without client_key, sent,
 * confirm_pending) is repaired at open; the repair is idempotent, keeps rows, and a share refuses before any request
 * if the ledger is still not in the expected shape.
 */
describe('a graph already at v10 with the first-build promotions table', () => {
  const OLD = `CREATE TABLE promotions (local_id TEXT NOT NULL, env TEXT NOT NULL, tenant_id TEXT NOT NULL, remote_id TEXT NOT NULL,
    content_hash TEXT NOT NULL, matched INTEGER NOT NULL DEFAULT 0, shared_at TEXT NOT NULL DEFAULT (datetime('now')), retracted_at TEXT,
    PRIMARY KEY (local_id, env, tenant_id))`;
  const makeOld = () => {
    createLocalDb(dbPath).close();
    exec(`DROP TABLE promotions; ${OLD}; INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash, matched) VALUES ('L1', 'prod', 'T1', 'R1', 'h', 0); PRAGMA user_version = 10`);
  };
  it('gains the three columns on open, keeps its row, and a second open and a third change nothing', () => {
    makeOld();
    createLocalDb(dbPath).close();
    expect(sql<{ name: string }>('PRAGMA table_info(promotions)').map((c) => c.name)).toEqual(expect.arrayContaining(['client_key', 'sent', 'confirm_pending']));
    expect(sql('SELECT local_id, remote_id, client_key, sent, confirm_pending FROM promotions')).toEqual([{ local_id: 'L1', remote_id: 'R1', client_key: '', sent: '[]', confirm_pending: 0 }]);
    const once = sql('SELECT count(*) AS n FROM sqlite_master')[0];
    createLocalDb(dbPath).close(); createLocalDb(dbPath).close();
    expect(sql('SELECT count(*) AS n FROM sqlite_master')[0]).toEqual(once);
    expect(getPromotion(dbPath, 'L1', 'prod', 'T1')).toMatchObject({ remoteId: 'R1', clientKey: '', sent: [], confirmPending: false });
    expect(version()).toBe(SCHEMA_VERSION);
  });
  it('the real old-shape file from the review (16 decisions) opens, repairs and replays', () => {
    const FX = '/tmp/align-work/l9r2/fxold/local.db';
    if (!fs.existsSync(FX)) return;
    fs.copyFileSync(FX, dbPath);
    createLocalDb(dbPath).close(); createLocalDb(dbPath).close();
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n).toBe(16);
    expect(sql<{ name: string }>('PRAGMA table_info(promotions)').map((c) => c.name)).toContain('client_key');
  });
  it('a share refuses before any request when the ledger cannot be made usable', async () => {
    const { prepare, ShareError } = await import('../lib/share/run.js');
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 't', summary: 's', sourceUrl: 'https://e/1', platform: 'cli' }); db.markRatified(id, 'me'); db.close();
    exec('DROP TABLE promotions');
    let posts = 0;
    const client = { whoami: async () => ({ user: { email: 'a@b.c' }, tenant: { id: 'T', name: 'W' } }), shareBatch: async () => { posts++; return {}; }, getDecision: async () => ({}), archiveDecision: async () => undefined };
    await expect(prepare({ dbPath, envName: 'prod', client, judge: { judgeId: 'j', judgeLabel: null }, salt: 's', gatewayUrl: 'https://x', defaultGatewayUrl: 'https://x' }, [id])).rejects.toBeInstanceOf(ShareError);
    expect(posts).toBe(0);
  });
});
