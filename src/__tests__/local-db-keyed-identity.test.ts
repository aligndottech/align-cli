// L2 review finding 1: only a CONNECTOR IMPORT carries a source_key. `align capture <url>` and
// MCP align_capture stamp the same platform (github, jira...) from the URL and title the row
// with the URL's last path segment, so keying on platform let a capture of a PR merge with, and
// overwrite, the imported item. The key comes from an explicit `keyed` flag at write time and
// from the shape of the stored row in the migration - never from the platform alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { createV6Graph } from './helpers/v6-graph.js';

vi.setConfig({ testTimeout: 30_000 });

const PR = 'https://github.com/o/r/pull/5';
const COMMIT = 'https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-keyed-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rows(sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all() as Array<Record<string, unknown>>; } finally { db.close(); }
}

describe('runtime: a capture never merges with an imported item', () => {
  it('a captured comment permalink on an imported PR is its own row; the import is untouched', () => {
    const db = createLocalDb(dbPath);
    try {
      const a = db.insertDecision({ title: 'Adopt Postgres', summary: 'rich body', sourceUrl: PR, platform: 'github', keyed: true });
      const b = db.insertDecision({ title: '5', summary: 'Captured from github.com', sourceUrl: `${PR}#issuecomment-99`, platform: 'github' });
      expect(b).not.toBe(a);
      expect(db.getDecisionById(a)).toMatchObject({ title: 'Adopt Postgres', summary: 'rich body' });
    } finally { db.close(); }
  });

  it('a keyed git import and a keyed github row for the same commit URL are two items', () => {
    const db = createLocalDb(dbPath);
    try {
      const a = db.insertDecision({ title: 'feat: WAL', summary: 'commit body', sourceUrl: COMMIT, platform: 'git', keyed: true });
      const b = db.insertDecision({ title: 'GitHub commit', summary: 'api body', sourceUrl: COMMIT, platform: 'github', keyed: true });
      expect(b).not.toBe(a);
      expect(db.getDecisionById(a)).toMatchObject({ title: 'feat: WAL', summary: 'commit body' });
    } finally { db.close(); }
  });

  it('without keyed, a one-item-per-URL platform keeps the (source_url, title) identity', () => {
    const db = createLocalDb(dbPath);
    try {
      db.insertDecision({ title: 'Old', summary: 's', sourceUrl: PR, platform: 'github' });
      db.insertDecision({ title: 'New', summary: 's', sourceUrl: PR, platform: 'github' });
      expect(db.listDecisions()).toHaveLength(2);
    } finally { db.close(); }
  });
});

describe('captureDecision of a URL whose item is already imported', () => {
  it('rewrites nothing: same id back, no new row, the imported title and summary stand', async () => {
    const client = createLocalGatewayClient(dbPath);
    try {
      await client.ingestBatch([{ source_url: PR, platform: 'github', title: 'Adopt Postgres', raw_text: 'rich body' }], { classify: false, keyed: true });
      const before = rows('SELECT id, title, summary FROM decisions');
      expect(before).toHaveLength(1); // control: the import landed
      const r = await client.captureDecision(PR, 'github');
      expect(r.id).toBe(before[0]!.id);
      expect(rows('SELECT id, title, summary FROM decisions')).toEqual(before);
    } finally { client.close(); }
  });
});

describe('migration: only connector-import rows are keyed and merged', () => {
  it('an imported PR row and a later capture of the same URL both survive', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'imported', title: 'Adopt Postgres for the job queue', summary: 'Long PR body with the rationale', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'captured', title: '5', summary: 'Captured from github.com', sourceUrl: PR, platform: 'github' });
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows('SELECT id, title, summary, source_key FROM decisions ORDER BY id')).toEqual([
      { id: 'captured', title: '5', summary: 'Captured from github.com', source_key: null },
      { id: 'imported', title: 'Adopt Postgres for the job queue', summary: 'Long PR body with the rationale', source_key: `github|${PR}` },
    ]);
  });

  it('a git commit row and a github row of the same URL are not merged', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'g', title: 'feat: WAL', summary: 'commit body', sourceUrl: COMMIT, platform: 'git' });
    v6.insertDecision({ id: 'h', title: 'GitHub commit title', summary: 'api body', sourceUrl: COMMIT, platform: 'github' });
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows('SELECT id FROM decisions ORDER BY id')).toEqual([{ id: 'g' }, { id: 'h' }]);
  });

  it('a capture row titled by the hostname is also left unkeyed', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'c', title: 'github.com', summary: 'Captured from github.com', sourceUrl: PR, platform: 'github' });
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows('SELECT source_key FROM decisions')).toEqual([{ source_key: null }]);
  });
});

describe('a keyless twin written by an older binary beside the keyed row (review finding 3)', () => {
  const U = 'https://github.com/o/r/pull/7';
  function legacyInsert(id: string, title: string, summary: string): void {
    // v6's INSERT: no source_key written.
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`INSERT INTO decisions (id,title,summary,source_url,platform) VALUES (?,?,?,?,'github')`).run(id, title, summary, U);
    raw.close();
  }

  it('a keyed import of the keyless row\'s (url, title) adopts that row instead of throwing', () => {
    const db = createLocalDb(dbPath);
    try {
      legacyInsert('legacy', 'Same title', 's1');
      const id = db.insertDecision({ title: 'Same title', summary: 's2', sourceUrl: U, platform: 'github', keyed: true });
      expect(id).toBe('legacy');
      expect(rows('SELECT id, summary, source_key FROM decisions')).toEqual([{ id: 'legacy', summary: 's2', source_key: `github|${U}` }]);
    } finally { db.close(); }
  });

  it('with a keyed row already present, the keyless twin at the new title is absorbed, not a UNIQUE failure', () => {
    const db = createLocalDb(dbPath);
    try {
      const keyed = db.insertDecision({ title: 'Old title', summary: 's1', sourceUrl: U, platform: 'github', keyed: true });
      legacyInsert('legacy', 'New title', 's2');
      let id = '';
      expect(() => { id = db.insertDecision({ title: 'New title', summary: 's3', sourceUrl: U, platform: 'github', keyed: true }); }).not.toThrow();
      expect(id).toBe(keyed);
      expect(rows('SELECT id, title, summary FROM decisions')).toEqual([{ id: keyed, title: 'New title', summary: 's3' }]);
      expect(rows(`SELECT id FROM decisions_merged_backup`)).toEqual([{ id: 'legacy' }]); // the absorbed row is recoverable
    } finally { db.close(); }
  });
});

describe('a ratified or confirmed row keeps its text through a re-import (review finding 4)', () => {
  it.each([
    ['ratified', `UPDATE decisions SET ratified_by = 'tom', ratified_at = '2026-01-01T00:00:00Z'`],
    ['confirmed', `UPDATE decisions SET confirmed_by = 'tom', confirmed_at = '2026-01-01T00:00:00Z'`],
  ])('%s: a retitled, rewritten upstream item leaves title and summary alone, refreshes the date, and notes the new text', async (_n, sql) => {
    const client = createLocalGatewayClient(dbPath);
    try {
      const item = { source_url: PR, platform: 'github', title: 'Use Postgres', raw_text: 'attested text' };
      await client.ingestBatch([item], { classify: false, keyed: true });
      const raw = new DatabaseSync(dbPath);
      raw.exec(sql);
      raw.close();
      await client.ingestBatch([{ ...item, title: 'Revert Postgres', raw_text: 'opposite text', created_at: '2026-05-05T00:00:00Z' }], { classify: false, keyed: true });
      expect(rows('SELECT title, summary, decided_at FROM decisions')).toEqual([
        { title: 'Use Postgres', summary: 'attested text', decided_at: '2026-05-05T00:00:00.000Z' },
      ]);
      const notes = rows(`SELECT detail FROM decision_audit WHERE action = 'text_revision_pending'`);
      expect(notes.map(n => JSON.parse(n.detail as string))).toEqual([{ title: 'Revert Postgres', summary: 'opposite text' }]);
      // A second sync of the same upstream text does not stack another note.
      await client.ingestBatch([{ ...item, title: 'Revert Postgres', raw_text: 'opposite text' }], { classify: false, keyed: true });
      expect(rows(`SELECT count(*) AS n FROM decision_audit WHERE action = 'text_revision_pending'`)).toEqual([{ n: 1 }]);
    } finally { client.close(); }
  });

  it('an unratified row still takes the new text (control: the guard is not a blanket freeze)', async () => {
    const client = createLocalGatewayClient(dbPath);
    try {
      const item = { source_url: PR, platform: 'github', title: 'Use Postgres', raw_text: 'v1' };
      await client.ingestBatch([item], { classify: false, keyed: true });
      await client.ingestBatch([{ ...item, title: 'Use Postgres, again', raw_text: 'v2' }], { classify: false, keyed: true });
      expect(rows('SELECT title, summary FROM decisions')).toEqual([{ title: 'Use Postgres, again', summary: 'v2' }]);
    } finally { client.close(); }
  });
});

describe('re-review: attested keyless twin, ratification conflicts, note growth (N5, N1, N4, N6)', () => {
  const U = 'https://github.com/o/r/pull/8';

  it('N5: a keyless RATIFIED row beside an unattested keyed holder survives with its ratification and text', () => {
    const db = createLocalDb(dbPath);
    try {
      db.insertDecision({ title: 'Old', summary: 's1', sourceUrl: U, platform: 'github', keyed: true });
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`INSERT INTO decisions (id,title,summary,source_url,platform,ratified_by,ratified_at) VALUES ('legacy','New','human-ratified text',?,'github','tom','2026-10-01T00:00:00Z')`).run(U);
      raw.close();
      const id = db.insertDecision({ title: 'New', summary: 'upstream text', sourceUrl: U, platform: 'github', keyed: true });
      expect(id).toBe('legacy');
      expect(rows('SELECT id, summary, ratified_by AS r, source_key FROM decisions')).toEqual([
        { id: 'legacy', summary: 'human-ratified text', r: 'tom', source_key: `github|${U}` },
      ]);
      expect(rows(`SELECT actor FROM decision_audit WHERE action = 'merged'`)).toEqual([{ actor: 'sync' }]);
    } finally { db.close(); }
  });

  it('N5: the fold is one transaction: a failure part-way leaves both rows and no backup row', () => {
    const db = createLocalDb(dbPath);
    try {
      db.insertDecision({ title: 'Old', summary: 's1', sourceUrl: U, platform: 'github', keyed: true });
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`INSERT INTO decisions (id,title,summary,source_url,platform) VALUES ('legacy','New','s2',?,'github')`).run(U);
      raw.exec(`CREATE TRIGGER boom BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'boom'); END`);
      raw.close();
      expect(() => db.insertDecision({ title: 'New', summary: 's3', sourceUrl: U, platform: 'github', keyed: true })).toThrow(/boom/);
      expect(rows('SELECT count(*) AS n FROM decisions')).toEqual([{ n: 2 }]);
      expect(rows('SELECT count(*) AS n FROM decisions_merged_backup')).toEqual([{ n: 0 }]);
    } finally { db.close(); }
  });

  it('N1: two ratified twins with different text: the earliest wins and the other ratification stays visible in a live table', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'a', title: 'Use Postgres', summary: 'ratified A', sourceUrl: PR, platform: 'github' });
    v6.raw.prepare(`UPDATE decisions SET ratified_by = 'tom', ratified_at = '2026-01-01T00:00:00Z' WHERE id = 'a'`).run();
    v6.insertDecision({ id: 'b', title: 'Do not use Postgres', summary: 'ratified B', sourceUrl: PR, platform: 'github' });
    v6.raw.prepare(`UPDATE decisions SET ratified_by = 'dan', ratified_at = '2026-02-01T00:00:00Z' WHERE id = 'b'`).run();
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows('SELECT id, summary, ratified_by AS r FROM decisions')).toEqual([{ id: 'a', summary: 'ratified A', r: 'tom' }]);
    const c = rows(`SELECT detail FROM decision_audit WHERE decision_id = 'a' AND action = 'ratification_conflict'`);
    expect(c.map(x => JSON.parse(x.detail as string))).toEqual([
      { by: 'dan', at: '2026-02-01T00:00:00Z', title: 'Do not use Postgres', summary: 'ratified B' },
    ]);
  });

  it('N4: pending-revision notes dedupe by content and keep only the 5 newest', () => {
    const db = createLocalDb(dbPath);
    try {
      const id = db.insertDecision({ title: 'T', summary: 'v0', sourceUrl: PR, platform: 'github', keyed: true });
      db.markRatified(id, 'tom');
      for (let i = 1; i <= 50; i++) db.keepProtectedText(id, 'T', `v0 ${i}`);
      for (let i = 0; i < 50; i++) db.keepProtectedText(id, 'T', 'v0 50');
      const notes = rows(`SELECT detail FROM decision_audit WHERE action = 'text_revision_pending' ORDER BY rowid`);
      expect(notes.map(n => JSON.parse(n.detail as string).summary)).toEqual(['v0 46', 'v0 47', 'v0 48', 'v0 49', 'v0 50']);
    } finally { db.close(); }
  });

  it('capture_seen is written once per decision per day', async () => {
    const client = createLocalGatewayClient(dbPath);
    try {
      await client.ingestBatch([{ source_url: PR, platform: 'github', title: 'Adopt', raw_text: 'body' }], { classify: false, keyed: true });
      for (let i = 0; i < 3; i++) await client.captureDecision(PR, 'github');
      expect(rows(`SELECT count(*) AS n FROM decision_audit WHERE action = 'capture_seen'`)).toEqual([{ n: 1 }]);
    } finally { client.close(); }
  });

  it('N6: an imported Linear row whose title equals the URL segment is keyed (its summary is not "Captured from")', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'z1', title: 'ENG-12', summary: 'linear body', sourceUrl: 'https://linear.app/a/issue/ENG-12', platform: 'linear' });
    v6.insertDecision({ id: 'z2', title: 'ENG-12 retitled', summary: 'linear body 2', sourceUrl: 'https://linear.app/a/issue/ENG-12', platform: 'linear' });
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows('SELECT id FROM decisions')).toEqual([{ id: 'z2' }]);
  });
});
