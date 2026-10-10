import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { copyRowsToBackup, sharedColumns } from '../lib/backup-copy.js';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { forgetSourceData } from '../lib/sync/forget.js';

/**
 * Backup tables are copied to by column NAME. Two guards:
 * - PARITY: a backup table has every column of the table it backs up. This fails the build the day a migration adds a
 *   column to `decisions` (or its embeddings, or its refs) and forgets the backup tables, which is the only way a
 *   backup can silently stop being a backup.
 * - SURVIVAL: with an extra column on the source (the day after such a migration), a purge and a twin fold still work,
 *   instead of failing on every ingest with "table has N columns but M values were supplied".
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-backup-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const cols = (t: string) => sql<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name).sort();

const PAIRS: Array<[string, string]> = [
  ['decisions', 'decisions_merged_backup'], ['decision_embeddings', 'decision_embeddings_merged_backup'], ['decision_refs', 'decision_refs_merged_backup'],
  ['decisions', 'decisions_purged_backup'], ['decision_embeddings', 'decision_embeddings_purged_backup'], ['decision_refs', 'decision_refs_purged_backup'],
];

describe('parity: a backup table has every column of its source', () => {
  it.each(PAIRS)('%s -> %s', (source, backup) => {
    createLocalDb(dbPath).close();
    expect(cols(backup)).toEqual(cols(source));
  });

  it('the guard itself works: a column added to decisions and not to its backup is reported by sharedColumns', () => {
    createLocalDb(dbPath).close();
    exec('ALTER TABLE decisions ADD COLUMN tomorrow TEXT');
    expect(cols('decisions')).not.toEqual(cols('decisions_purged_backup'));
    const db = new DatabaseSync(dbPath);
    try { expect(sharedColumns(db, 'decisions', 'decisions_purged_backup')).not.toContain('tomorrow'); } finally { db.close(); }
  });
});

describe('survival: the day after a migration added a column to decisions', () => {
  it('a purge still works and backs up every column the backup has', () => {
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 't', summary: 's', sourceUrl: 'https://slack.com/archives/C1/p1700000000000001', platform: 'slack', keyed: true });
    db.close();
    exec('ALTER TABLE decisions ADD COLUMN tomorrow TEXT');
    exec(`UPDATE decisions SET tomorrow = 'x' WHERE id = '${id}'`);
    expect(forgetSourceData(dbPath, 'slack', { purge: true }).purged).toEqual({ deleted: 1, kept: 0 });
    expect(sql<{ title: string }>('SELECT title FROM decisions_purged_backup')).toEqual([{ title: 't' }]);
  });

  it('a twin fold during ingest still works (it used to throw on EVERY ingest that folded a twin)', async () => {
    const c = createLocalGatewayClient(dbPath);
    const url = 'https://github.com/o/r/pull/1';
    await c.ingestBatch([{ source_url: url, platform: 'github', title: 'first title', raw_text: 'body' }], { classify: false, keyed: true });
    c.close();
    exec(`INSERT INTO decisions (id, title, summary, platform, source_url) VALUES ('twin', 'second title', 'body', 'github', '${url}')`);
    exec('ALTER TABLE decisions ADD COLUMN tomorrow TEXT');
    const c2 = createLocalGatewayClient(dbPath);
    await c2.ingestBatch([{ source_url: url, platform: 'github', title: 'second title', raw_text: 'body' }], { classify: false, keyed: true });
    c2.close();
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(1);
    expect(sql('SELECT 1 FROM decisions_merged_backup')).toHaveLength(1);
  });

  it('copyRowsToBackup copies by name even when the backup\'s columns are in another order', () => {
    const x = new DatabaseSync(':memory:');
    x.exec('CREATE TABLE src (a TEXT, b TEXT, k TEXT); CREATE TABLE bak (b TEXT, k TEXT, a TEXT)');
    x.exec(`INSERT INTO src VALUES ('A', 'B', 'key')`);
    copyRowsToBackup(x, 'src', 'bak', 'k', 'key');
    expect(x.prepare('SELECT a, b, k FROM bak').get()).toEqual({ a: 'A', b: 'B', k: 'key' });
    x.close();
  });
});
