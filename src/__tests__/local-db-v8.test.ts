import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';

/**
 * Schema v8 (L5 review): the sync's state lives in the migration system, not in lazily created tables.
 * - source_sync gains cycle_top and last_attempt_at; sync_item_state is keyed (decision_id, scope_key);
 *   the purge backups exist.
 * - A v7 file migrates with every row unchanged; opening twice, or replaying the step, changes nothing.
 * - The unreleased pre-scope shape of sync_item_state (created outside the migrations) is replaced.
 * - A file from a NEWER CLI is refused.
 * - On a copy of REAL data (the founder's graph before L2, 718 decisions): migrate, count, replay.
 */
vi.setConfig({ testTimeout: 60_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-v8-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const cols = (t: string) => sql<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
const tables = () => sql<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name);
const version = () => sql<{ user_version: number }>('PRAGMA user_version')[0]!.user_version;

describe('a fresh graph', () => {
  it('is at the current version with the v8 columns and tables', () => {
    createLocalDb(dbPath).close();
    expect(SCHEMA_VERSION).toBe(11);
    expect(version()).toBe(SCHEMA_VERSION);
    expect(cols('source_sync')).toEqual(expect.arrayContaining(['hole_sig', 'hole_streak']));
    expect(cols('source_sync')).toEqual(expect.arrayContaining(['cycle_top', 'last_attempt_at']));
    expect(cols('sync_item_state')).toEqual(['decision_id', 'scope_key', 'platform', 'updated_at']);
    expect(tables()).toEqual(expect.arrayContaining(['decisions_purged_backup', 'decision_embeddings_purged_backup', 'decision_refs_purged_backup']));
  });
});

describe('a v7 graph', () => {
  function makeV7(): void {
    createLocalDb(dbPath).close();
    exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ('a', 'a', 's', 'cli'), ('b', 'b', 's', 'cli')`);
    exec(`INSERT INTO source_sync (source_id, scope_key, scope, window_since, high_water) VALUES ('github', 'yours', 'yours', '2026-04-01', '2026-10-01')`);
    exec('ALTER TABLE source_sync DROP COLUMN cycle_top; ALTER TABLE source_sync DROP COLUMN last_attempt_at; ALTER TABLE source_sync DROP COLUMN hole_sig; ALTER TABLE source_sync DROP COLUMN hole_streak');
    exec('DROP TABLE sync_item_state; DROP TABLE decisions_purged_backup; DROP TABLE decision_embeddings_purged_backup; DROP TABLE decision_refs_purged_backup');
    exec('PRAGMA user_version = 7');
  }

  it('migrates with every row and every sync value unchanged', () => {
    makeV7();
    expect(version()).toBe(7);
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);
    expect(sql('SELECT source_id, window_since, high_water, cycle_top, last_attempt_at FROM source_sync')).toEqual([
      { source_id: 'github', window_since: '2026-04-01', high_water: '2026-10-01', cycle_top: null, last_attempt_at: null },
    ]);
  });

  it('a second open, and a replay of the step (version reset to 7), change nothing', () => {
    makeV7();
    createLocalDb(dbPath).close();
    const schemaOnce = sql('SELECT count(*) AS n FROM sqlite_master')[0];
    createLocalDb(dbPath).close();
    exec('PRAGMA user_version = 7');
    createLocalDb(dbPath).close();
    expect(sql('SELECT count(*) AS n FROM sqlite_master')[0]).toEqual(schemaOnce);
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(2);
  });

  it('the earlier, unscoped sync_item_state (created outside the migrations) is replaced by the keyed one', () => {
    makeV7();
    exec(`CREATE TABLE sync_item_state (decision_id TEXT PRIMARY KEY, platform TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO sync_item_state VALUES ('a', 'slack', '2026-10-01T00:00:00.000Z'), ('b', 'slack', '2026-10-02T00:00:00.000Z')`);
    createLocalDb(dbPath).close();
    expect(cols('sync_item_state')).toEqual(['decision_id', 'scope_key', 'platform', 'updated_at']);
    // the unreleased shape's rows are CARRIED ACROSS as scope 'yours', not dropped
    expect(sql('SELECT decision_id, scope_key, platform, updated_at FROM sync_item_state ORDER BY decision_id')).toEqual([
      { decision_id: 'a', scope_key: 'yours', platform: 'slack', updated_at: '2026-10-01T00:00:00.000Z' },
      { decision_id: 'b', scope_key: 'yours', platform: 'slack', updated_at: '2026-10-02T00:00:00.000Z' },
    ]);
    expect(tables()).not.toContain('sync_item_state_unscoped');
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

const REAL = '/tmp/claude-1000/-home-thomas-aligndottech-align-stack/7915f407-23ef-4e7b-9338-df7deb537dd6/scratchpad/l2real/before/local.db';
describe('a copy of the real graph', () => {
  it.skipIf(!fs.existsSync(REAL))('migrates to the current schema with every decision still there, and replays', () => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(REAL + suffix)) fs.copyFileSync(REAL + suffix, dbPath + suffix);
    const before = sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n;
    expect(before).toBe(718);
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    const after = sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n;
    expect(after).toBe(718); // no twin in this graph: nothing merged, nothing lost
    expect(sql('SELECT 1 FROM decisions_merged_backup')).toHaveLength(0);
    exec('PRAGMA user_version = 7');
    createLocalDb(dbPath).close();
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n).toBe(after);
    expect(version()).toBe(SCHEMA_VERSION);
  });
});

const OLDSTATE = '/tmp/claude-1000/-home-thomas-aligndottech-align-stack/7915f407-23ef-4e7b-9338-df7deb537dd6/scratchpad/l5/v7-oldstate.db';
describe('a v7 graph that ran the unreleased L5 commit (718 decisions, 40 rows of unscoped sync_item_state)', () => {
  it.skipIf(!fs.existsSync(OLDSTATE))('keeps all 40 activity rows, as scope yours, and every decision', () => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(OLDSTATE + suffix)) fs.copyFileSync(OLDSTATE + suffix, dbPath + suffix);
    const before = sql<{ n: number }>('SELECT count(*) AS n FROM sync_item_state')[0]!.n;
    expect(before).toBe(40);
    createLocalDb(dbPath).close();
    expect(version()).toBe(SCHEMA_VERSION);
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM sync_item_state')[0]!.n).toBe(40);
    expect(sql<{ n: number }>(`SELECT count(*) AS n FROM sync_item_state WHERE scope_key = 'yours'`)[0]!.n).toBe(40);
    expect(sql<{ n: number }>('SELECT count(*) AS n FROM decisions')[0]!.n).toBe(718);
  });
});
