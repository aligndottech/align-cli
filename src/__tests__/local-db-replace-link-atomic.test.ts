// Review F8: replaceLink's delete and insert are one unit. A failure between them (here the
// insert violates NOT NULL) must leave the pair's old edge in place, not an unlinked pair.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-replace-atomic-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`INSERT INTO decisions (id, title, summary) VALUES ('a', 'A', 's'), ('b', 'B', 's')`);
  raw.exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('old', 'a', 'b', 'supersedes', 0.9)`);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const rows = () => { const x = new DatabaseSync(dbPath); try { return x.prepare('SELECT id, relation FROM decision_links').all(); } finally { x.close(); } };

describe('replaceLink is atomic', () => {
  it('a failing insert leaves the old edge in place', () => {
    const db = createLocalDb(dbPath);
    try {
      expect(() => db.replaceLink({ sourceId: 'a', targetId: 'b', relation: null as unknown as string, confidence: 1 })).toThrow();
    } finally { db.close(); }
    expect(rows()).toEqual([{ id: 'old', relation: 'supersedes' }]);
  });

  it('a successful replace swaps the edge', () => {
    const db = createLocalDb(dbPath);
    try { db.replaceLink({ sourceId: 'a', targetId: 'b', relation: 'relates', confidence: 1 }); } finally { db.close(); }
    expect(rows()).toEqual([expect.objectContaining({ relation: 'relates' })]);
  });
});
