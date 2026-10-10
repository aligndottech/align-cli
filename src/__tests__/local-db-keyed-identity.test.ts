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
