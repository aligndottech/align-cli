import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';

/**
 * P3 (shared detector) Test List, the detector_version column (review F7: an ADDITIVE step):
 * - A v11 graph gains the column and every existing link reads detector_version = 'v0'.
 * - user_version stays 11, so a 0.50.0 CLI (which refuses anything above 11) still opens it, and
 *   a link that CLI writes (no detector_version in its INSERT) reads 'v0'.
 * - 0 links migrates cleanly; 50 links keeps all 50 (counted before and after).
 * - Re-opening is a no-op.
 * - Nothing is re-typed: relation and confidence are byte-identical after the migration.
 * - New links default to v0; a link the v1 detector writes is stamped v1.
 * - A v0 conflicts_with and a v0 contradicts link are still read as conflicts after migration.
 */
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-v12-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const version = () => sql<{ user_version: number }>('PRAGMA user_version')[0]!.user_version;
const linkCount = () => sql<{ n: number }>('SELECT COUNT(*) AS n FROM decision_links')[0]!.n;
const versions = () => sql<{ v: string }>('SELECT DISTINCT detector_version AS v FROM decision_links ORDER BY v').map((r) => r.v);
const hasColumn = () => sql<{ name: string }>('PRAGMA table_info(decision_links)').some((c) => c.name === 'detector_version');
const linkRows = () => sql('SELECT id, source_id, target_id, relation, confidence FROM decision_links ORDER BY id');

/** A real v11 file: the current schema with the additive column removed. */
function makeV11(links: number): void {
  createLocalDb(dbPath).close();
  const values: string[] = [];
  for (let i = 0; i <= links; i++) values.push(`('d${i}', 'Decision ${i}', 's', 'cli')`);
  exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ${values.join(', ')}`);
  const rel = ['relates', 'conflicts_with', 'contradicts', 'supersedes', 'refines'];
  for (let i = 1; i <= links; i++) {
    exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('l${String(i).padStart(3, '0')}', 'd${i}', 'd0', '${rel[i % rel.length]}', ${(i % 10) / 10})`);
  }
  exec('ALTER TABLE decision_links DROP COLUMN detector_version');
  exec('PRAGMA user_version = 11');
}

/** 0.50.0's open check, copied from align-cli origin/main 526f63b src/lib/local-db-migrate.ts
 *  (assertSchemaSupported with SCHEMA_VERSION = 11): it throws above 11 and opens anything else. */
function opens050(userVersion: number): boolean {
  const supported = 11;
  return !(userVersion > supported);
}

describe('a fresh graph', () => {
  it('has the column and stays at the compatibility version 11', () => {
    createLocalDb(dbPath).close();
    expect(SCHEMA_VERSION).toBe(11);
    expect(version()).toBe(11);
    expect(hasColumn()).toBe(true);
  });
});

describe('F7: an older CLI keeps reading the graph', () => {
  it('a v11 graph opened by this CLI is still accepted by 0.50.0\'s version check', () => {
    makeV11(3);
    createLocalDb(dbPath).close();
    expect(hasColumn()).toBe(true);
    expect(opens050(version())).toBe(true);
  });

  it('control: the check really refuses a newer version (so the pass above means something)', () => {
    expect(opens050(12)).toBe(false);
  });

  it('a link written the 0.50.0 way (no detector_version in the INSERT) reads v0', () => {
    makeV11(1);
    createLocalDb(dbPath).close();
    exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('old-cli', 'd1', 'd0', 'refines', 0.5)`);
    expect(sql<{ v: string }>(`SELECT detector_version AS v FROM decision_links WHERE id = 'old-cli'`)[0]!.v).toBe('v0');
  });
});

describe('adding the column to a v11 graph', () => {
  it('keeps all 50 links, re-types none, and stamps every one v0', () => {
    makeV11(50);
    expect(hasColumn()).toBe(false);
    expect(linkCount()).toBe(50);
    const before = linkRows();
    createLocalDb(dbPath).close();
    expect(version()).toBe(11);
    expect(linkCount()).toBe(50);
    expect(linkRows()).toEqual(before);
    expect(versions()).toEqual(['v0']);
  });

  it('migrates a graph with 0 links cleanly', () => {
    makeV11(0);
    createLocalDb(dbPath).close();
    expect(version()).toBe(11);
    expect(hasColumn()).toBe(true);
    expect(linkCount()).toBe(0);
  });

  it('an older CLI dropping back the column is not possible, but a file missing it gains it on the next open', () => {
    makeV11(5);
    createLocalDb(dbPath).close();
    exec(`UPDATE decision_links SET detector_version = 'v1' WHERE id = 'l001'`);
    createLocalDb(dbPath).close();
    expect(sql<{ v: string }>(`SELECT detector_version AS v FROM decision_links WHERE id = 'l001'`)[0]!.v).toBe('v1');
    expect(linkCount()).toBe(5);
  });

  it('re-opening is a no-op', () => {
    makeV11(3);
    createLocalDb(dbPath).close();
    const before = sql('SELECT * FROM decision_links ORDER BY id');
    createLocalDb(dbPath).close();
    expect(sql('SELECT * FROM decision_links ORDER BY id')).toEqual(before);
  });

  it('v0 conflicts_with and contradicts links are still read as conflicts', () => {
    makeV11(5);
    const db = createLocalDb(dbPath);
    try {
      expect(db.listLinks({ relation: 'conflicts_with' }).map((l) => l.id)).toEqual(['l001']);
      expect(db.listLinks({ relation: 'contradicts' }).map((l) => l.id)).toEqual(['l002']);
    } finally { db.close(); }
  });
});

describe('writing links once the column exists', () => {
  it('insertLink and replaceLink default to v0, and stamp v1 when the v1 detector writes', () => {
    makeV11(0);
    const db = createLocalDb(dbPath);
    try {
      db.insertLink({ sourceId: 'd0', targetId: 'd0', relation: 'relates', confidence: 0.5 });
      exec(`INSERT INTO decisions (id, title, summary) VALUES ('a', 'A', 's'), ('b', 'B', 's'), ('c', 'C', 's')`);
      db.replaceLink({ sourceId: 'a', targetId: 'b', relation: 'supersedes', confidence: 0.9, detectorVersion: 'v1' });
      db.insertLink({ sourceId: 'a', targetId: 'c', relation: 'relates', confidence: 0.7, detectorVersion: 'v1' });
      db.replaceLink({ sourceId: 'b', targetId: 'c', relation: 'refines', confidence: 0.6 });
    } finally { db.close(); }
    expect(sql(`SELECT source_id, target_id, relation, detector_version FROM decision_links ORDER BY source_id, target_id`)).toEqual([
      { source_id: 'a', target_id: 'b', relation: 'supersedes', detector_version: 'v1' },
      { source_id: 'a', target_id: 'c', relation: 'relates', detector_version: 'v1' },
      { source_id: 'b', target_id: 'c', relation: 'refines', detector_version: 'v0' },
      { source_id: 'd0', target_id: 'd0', relation: 'relates', detector_version: 'v0' },
    ]);
  });
});
