// L2: one schema bump adds per-source sync state, the source_key identity, the deferred-detail
// flag, the enrichment marker and the local judgements table. These tests open a v6 file (what
// every installed CLI has on disk) and check what the bump adds, and that opening it again
// changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { columnsOf, count, createV6Graph } from './helpers/v6-graph.js';

// Real SQLite files; the Windows runner opens one in about a second (see decided-at.test.ts).
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-sync-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedV6(n: number): void {
  const v6 = createV6Graph(dbPath);
  for (let i = 0; i < n; i++) {
    v6.insertDecision({ id: `d${i}`, title: `T${i}`, summary: `S${i}`, sourceUrl: `https://github.com/o/r/pull/${i + 1}`, platform: 'github' });
  }
  v6.close();
}

function tables(): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name);
  } finally { db.close(); }
}

function userVersion(): number {
  return count(dbPath, 'SELECT user_version AS n FROM pragma_user_version');
}

describe('L2 schema bump on a v6 file', () => {
  it('adds the tables and columns and stamps the new version', () => {
    seedV6(3);
    // Control on the fixture: it really is v6, so everything below is ADDED, not found.
    expect(userVersion()).toBe(6);
    expect(columnsOf(dbPath, 'decisions')).not.toContain('enriched_at');
    expect(tables()).not.toContain('source_sync');

    createLocalDb(dbPath).close();

    expect(tables()).toEqual(expect.arrayContaining(['source_sync', 'local_judgements', 'decisions_merged_backup']));
    expect(columnsOf(dbPath, 'decisions')).toEqual(expect.arrayContaining(['source_key', 'detail_pending', 'enriched_at']));
    expect(SCHEMA_VERSION).toBe(7);
    expect(userVersion()).toBe(SCHEMA_VERSION);
  });

  it('a second open changes nothing', () => {
    seedV6(3);
    createLocalDb(dbPath).close();
    const schemaOnce = count(dbPath, `SELECT count(*) AS n FROM sqlite_master`);
    const rowsOnce = count(dbPath, `SELECT count(*) AS n FROM decisions`);

    createLocalDb(dbPath).close();

    expect(count(dbPath, `SELECT count(*) AS n FROM sqlite_master`)).toBe(schemaOnce);
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions`)).toBe(rowsOnce);
    expect(rowsOnce).toBe(3);
  });

  it('replaying the step (user_version reset to 6) is a no-op', () => {
    seedV6(3);
    createLocalDb(dbPath).close();
    const before = count(dbPath, `SELECT count(*) AS n FROM decisions WHERE source_key IS NOT NULL`);
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 6');
    raw.close();

    createLocalDb(dbPath).close();

    expect(userVersion()).toBe(SCHEMA_VERSION);
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions`)).toBe(3);
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions WHERE source_key IS NOT NULL`)).toBe(before);
    expect(before).toBe(3);
  });

  it('every pre-existing row is not enriched, so the next sync re-links it once (Decision 30)', () => {
    seedV6(3);
    createLocalDb(dbPath).close();
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions`)).toBe(3);
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions WHERE enriched_at IS NULL`)).toBe(3);
    expect(count(dbPath, `SELECT count(*) AS n FROM decisions WHERE detail_pending = 0`)).toBe(3);
  });

  it('computes source_key for one-item-per-URL rows and leaves session rows keyless', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'pr', title: 'PR', summary: 's', sourceUrl: 'https://github.com/o/r/pull/9/', platform: 'github' });
    v6.insertDecision({ id: 'ses', title: 'Use WAL', summary: 's', sourceUrl: 'file:///t/session.jsonl', platform: 'agent-session' });
    v6.close();

    createLocalDb(dbPath).close();

    const db = new DatabaseSync(dbPath);
    try {
      const keys = Object.fromEntries((db.prepare('SELECT id, source_key FROM decisions').all() as Array<{ id: string; source_key: string | null }>)
        .map(r => [r.id, r.source_key]));
      expect(keys).toEqual({ pr: 'https://github.com/o/r/pull/9', ses: null });
    } finally { db.close(); }
  });
});

describe('source_sync', () => {
  function open(): DatabaseSync {
    createLocalDb(dbPath).close();
    return new DatabaseSync(dbPath);
  }

  it('holds one row per (source, scope), and a widened scope is a new row', () => {
    const db = open();
    try {
      const ins = db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope) VALUES (?, ?, ?)`);
      ins.run('github', 'yours', 'yours');
      ins.run('github', 'repo:o/r', 'team');
      expect(() => ins.run('github', 'yours', 'yours')).toThrow(/UNIQUE|PRIMARY/);
      expect((db.prepare(`SELECT status FROM source_sync WHERE scope_key = 'yours'`).get() as { status: string }).status).toBe('ok');
    } finally { db.close(); }
  });

  it('rejects an unknown scope, status or changed_via', () => {
    const db = open();
    try {
      expect(() => db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope) VALUES ('a', 'b', 'org')`).run()).toThrow(/CHECK/);
      expect(() => db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, status) VALUES ('a', 'b', 'yours', 'stale')`).run()).toThrow(/CHECK/);
      expect(() => db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, changed_via) VALUES ('a', 'b', 'yours', 'web')`).run()).toThrow(/CHECK/);
      db.prepare(`INSERT INTO source_sync (source_id, scope_key, scope, status, changed_via, changed_by_agent) VALUES ('a', 'b', 'team', 'needs_reauth', 'mcp', 'claude-code')`).run();
    } finally { db.close(); }
  });
});
