import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { connectorItemKey } from '../lib/source-key.js';

/**
 * ALI-1527 Test List, schema v11 (re-key zoom rows after the connector-core meeting_id fix):
 * - connector-core 0.10.1 keys a Discover recording URL by its meeting_id and gives the Zoom chat URL no key.
 * - A v10 graph whose zoom row holds the old collapsed key is re-keyed in place: same id, same judgements,
 *   same promotion, same ratification, nothing duplicated or lost.
 * - When the correct key is already held by another row (a twin), the two fold through the v7 fold:
 *   the ratified row survives and everything that named the loser is re-pointed.
 * - Rows that are not affected (other platforms, zoom rows with a current key) are byte-identical.
 * - A replay (user_version put back to 10) changes nothing. A fresh graph is v11.
 */
const OLD_KEY = 'zoom|https://zoom.us/recording/detail';
const keyOf = (m: string) => `zoom|https://zoom.us/recording/detail?meeting_id=${m}`;
const urlOf = (m: string) => `https://zoom.us/recording/detail?meeting_id=${m}`;

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-v11-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const version = () => sql<{ user_version: number }>('PRAGMA user_version')[0]!.user_version;
const keys = () => sql<{ id: string; source_key: string | null }>('SELECT id, source_key FROM decisions ORDER BY id');

function makeV10(rows: string): void {
  createLocalDb(dbPath).close();
  exec(`INSERT INTO decisions (id, title, summary, platform, source_url, source_key, ratified_by, ratified_at) VALUES ${rows}`);
  exec('PRAGMA user_version = 10');
}

describe('connectorItemKey after the connector-core zoom fix', () => {
  it('keys a Discover recording by its meeting, so two meetings are two keys', () => {
    expect(connectorItemKey('zoom', urlOf('AbC'))).toBe(keyOf('AbC'));
    expect(connectorItemKey('zoom', urlOf('xyz'))).toBe(keyOf('xyz'));
    // A real meeting uuid carries / + =, which the gateway sends percent-encoded and the key re-encodes.
    expect(connectorItemKey('zoom', urlOf(encodeURIComponent('a/b+c==')))).toBe(keyOf('a%2Fb%2Bc%3D%3D'));
  });
  it('keeps the uuid-path recording key the CLI import writes, and gives the chat URL no key', () => {
    expect(connectorItemKey('zoom', 'https://zoom.us/recording/abc')).toBe('zoom|https://zoom.us/recording/abc');
    expect(connectorItemKey('zoom', 'https://zoom.us/chat')).toBeUndefined();
  });
});

describe('a fresh graph', () => {
  it('is at v11', () => {
    createLocalDb(dbPath).close();
    expect(SCHEMA_VERSION).toBe(11);
    expect(version()).toBe(11);
  });
});

describe('a v10 graph holding the old collapsed zoom key', () => {
  it('re-keys the row in place and leaves every record that names it alone', () => {
    makeV10(`('z1', 'Standup', 's', 'zoom', '${urlOf('M1')}', '${OLD_KEY}', 'tom', '2026-10-01')`);
    exec(`INSERT INTO local_judgements (id, decision_id, kind, value, judge_id, via, judged_at) VALUES ('j1', 'z1', 'not_a_decision', NULL, 'tom', 'cli', '2026-10-02')`);
    exec(`INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES ('z1', 'prod', 'T1', 'R1', 'h')`);
    createLocalDb(dbPath).close();
    expect(version()).toBe(11);
    expect(keys()).toEqual([{ id: 'z1', source_key: keyOf('M1') }]);
    expect(sql('SELECT ratified_by FROM decisions WHERE id = \'z1\'')).toEqual([{ ratified_by: 'tom' }]);
    expect(sql('SELECT decision_id FROM local_judgements')).toEqual([{ decision_id: 'z1' }]);
    expect(sql('SELECT local_id FROM promotions')).toEqual([{ local_id: 'z1' }]);
    expect(sql('SELECT count(*) AS n FROM decisions_merged_backup')).toEqual([{ n: 0 }]);
  });

  it('folds into a twin that already holds the right key: the ratified row survives, judgements and the promotion follow it', () => {
    makeV10(`('old', 'Standup', 's', 'zoom', '${urlOf('M1')}', '${OLD_KEY}', 'tom', '2026-10-01'),
             ('new', 'Standup (edited)', 's2', 'zoom', '${urlOf('M1')}', '${keyOf('M1')}', NULL, NULL)`);
    exec(`INSERT INTO local_judgements (id, decision_id, kind, value, judge_id, via, judged_at) VALUES ('j1', 'old', 'not_a_decision', NULL, 'tom', 'cli', '2026-10-02')`);
    exec(`INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES ('old', 'prod', 'T1', 'R1', 'h')`);
    createLocalDb(dbPath).close();
    expect(keys()).toEqual([{ id: 'old', source_key: keyOf('M1') }]);
    expect(sql('SELECT decision_id FROM local_judgements')).toEqual([{ decision_id: 'old' }]);
    expect(sql('SELECT local_id FROM promotions')).toEqual([{ local_id: 'old' }]);
    expect(sql('SELECT id FROM decisions_merged_backup')).toEqual([{ id: 'new' }]);
  });

  it('sets the key to NULL when the URL no longer names one item', () => {
    makeV10(`('z1', 'Chat', 's', 'zoom', 'https://zoom.us/chat', 'zoom|https://zoom.us/chat', NULL, NULL)`);
    createLocalDb(dbPath).close();
    expect(keys()).toEqual([{ id: 'z1', source_key: null }]);
  });

  it('leaves unaffected rows alone: a current zoom key, a uuid-path recording, another platform', () => {
    makeV10(`('a', 'A', 's', 'zoom', '${urlOf('M2')}', '${keyOf('M2')}', NULL, NULL),
             ('b', 'B', 's', 'zoom', 'https://zoom.us/recording/abc', 'zoom|https://zoom.us/recording/abc', NULL, NULL),
             ('c', 'C', 's', 'github', 'https://github.com/o/r/pull/1', 'github|https://github.com/o/r/pull/1', NULL, NULL),
             ('d', 'D', 's', 'zoom', 'https://zoom.us/recording/x', NULL, NULL, NULL)`);
    const before = sql('SELECT * FROM decisions ORDER BY id');
    createLocalDb(dbPath).close();
    expect(sql('SELECT * FROM decisions ORDER BY id')).toEqual(before);
  });

  it('is replay-safe: opening again, or re-running the step, changes nothing', () => {
    makeV10(`('z1', 'S', 's', 'zoom', '${urlOf('M1')}', '${OLD_KEY}', NULL, NULL)`);
    createLocalDb(dbPath).close();
    const once = sql('SELECT * FROM decisions');
    createLocalDb(dbPath).close();
    exec('PRAGMA user_version = 10');
    createLocalDb(dbPath).close();
    expect(sql('SELECT * FROM decisions')).toEqual(once);
    expect(version()).toBe(11);
  });
});
