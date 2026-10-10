import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import {
  advanceHighWater, beginRun, clearNeedsReauth, deleteSource, markNeedsReauth, pendingDetailCount,
  readRows, recordActivity, saveRun, threadRows, unfinishedCount,
} from '../lib/sync/sync-state.js';

/**
 * L5 Test List (source_sync access, against a real v7 file):
 * - beginRun creates a row with a CONCRETE window (a NULL window on an existing row means "all"), stamps last_started_at, and never touches an existing row's window or watermark.
 * - saveRun stores status, watermark, pending, count and the skips as JSON; an error run leaves last_success_at alone.
 * - advanceHighWater only goes forward and ignores an unreadable stamp.
 * - markNeedsReauth marks EVERY scope of the source (and creates a row when there is none); clearNeedsReauth undoes only that status.
 * - Activity: the newest stamp per platform; thread rows join it; an item with no record reads null.
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-state-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const KEY = { source: 'github', scopeKey: 'yours', scope: 'yours' as const };
const NOW = '2026-10-10T12:00:00.000Z';
const NOW_D = new Date(NOW);
function sql<T = Record<string, unknown>>(q: string, ...args: Array<string | number>): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(q).all(...args) as T[]; } finally { db.close(); }
}
function exec(q: string): void { const db = new DatabaseSync(dbPath); try { db.exec(q); } finally { db.close(); } }

describe('beginRun', () => {
  it('creates a row with a concrete window and stamps the start', () => {
    const row = beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    expect(row).toMatchObject({ source_id: 'github', scope_key: 'yours', scope: 'yours', window_since: '2026-04-13T12:00:00.000Z', high_water: null, last_started_at: NOW });
  });

  it('an existing row keeps its window and watermark (two examples: a user window, a watermark)', () => {
    exec(`INSERT INTO source_sync (source_id, scope_key, scope, window_since, high_water) VALUES ('github', 'yours', 'yours', '2025-10-10T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`);
    const row = beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    expect(row).toMatchObject({ window_since: '2025-10-10T00:00:00.000Z', high_water: '2026-10-01T00:00:00.000Z', last_started_at: NOW });
    exec(`UPDATE source_sync SET window_since = NULL`);
    expect(beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW).window_since).toBeNull(); // "all" stays all
  });
});

describe('saveRun', () => {
  it('stores the outcome, the count and the skips as JSON', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    saveRun(dbPath, KEY, { attemptAt: '2026-10-10T12:00:00.000Z', status: 'partial', high_water: null, pending_until: '2026-08-01T00:00:00.000Z', items: 120, skips: [{ kind: 'page_cap', count: 3, detail: 'cap' }], successAt: NOW });
    const [row] = readRows(dbPath, 'github');
    expect(row).toMatchObject({ status: 'partial', pending_until: '2026-08-01T00:00:00.000Z', items_last_run: 120, last_success_at: NOW });
    expect(JSON.parse(row!.skips_last_run!)).toEqual([{ kind: 'page_cap', count: 3, detail: 'cap' }]);
  });

  it('every run stamps last_attempt_at; only a run given successAt moves last_success_at', () => {
    beginRun(dbPath, KEY, null, NOW);
    saveRun(dbPath, KEY, { attemptAt: '2026-10-09T00:00:00.000Z', status: 'ok', high_water: null, pending_until: null, items: 1, skips: [], successAt: '2026-10-09T00:00:00.000Z' });
    saveRun(dbPath, KEY, { attemptAt: '2026-10-10T00:00:00.000Z', status: 'partial', high_water: null, pending_until: null, cycle_top: '2026-10-08T00:00:00.000Z', items: 1, skips: [] });
    expect(readRows(dbPath, 'github')[0]).toMatchObject({ last_attempt_at: '2026-10-10T00:00:00.000Z', last_success_at: '2026-10-09T00:00:00.000Z', cycle_top: '2026-10-08T00:00:00.000Z' });
  });

  it('a run with no successAt (an error) keeps the earlier last_success_at', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    saveRun(dbPath, KEY, { attemptAt: '2026-10-10T12:00:00.000Z', status: 'ok', high_water: null, pending_until: null, items: 1, skips: [], successAt: '2026-10-09T00:00:00.000Z' });
    saveRun(dbPath, KEY, { attemptAt: '2026-10-10T12:00:00.000Z', status: 'error', high_water: null, pending_until: null, items: 0, skips: [] });
    expect(readRows(dbPath, 'github')[0]).toMatchObject({ status: 'error', last_success_at: '2026-10-09T00:00:00.000Z' });
  });
});

describe('the schema guard', () => {
  it('every sync-state function refuses a graph written by a newer CLI, before touching it', () => {
    exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const msg = /written by a newer Align CLI/;
    expect(() => beginRun(dbPath, KEY, null, NOW)).toThrow(msg);
    expect(() => saveRun(dbPath, KEY, { attemptAt: NOW, status: 'ok', high_water: null, pending_until: null, items: 0, skips: [] })).toThrow(msg);
    expect(() => advanceHighWater(dbPath, KEY, '2026-10-01T00:00:00.000Z', NOW_D)).toThrow(msg);
    expect(() => markNeedsReauth(dbPath, KEY, null, NOW)).toThrow(msg);
    expect(() => clearNeedsReauth(dbPath, 'github')).toThrow(msg);
    expect(() => deleteSource(dbPath, 'github')).toThrow(msg);
    expect(() => recordActivity(dbPath, 'yours', [{ decisionId: 'a', platform: 'slack', updatedAt: NOW }])).toThrow(msg);
    expect(() => readRows(dbPath)).toThrow(msg);
    expect(sql('SELECT * FROM source_sync')).toEqual([]);
  });
});

describe('advanceHighWater', () => {
  it('refuses a stamp more than a day ahead of now, and accepts one within a day (clock skew)', () => {
    beginRun(dbPath, KEY, null, NOW);
    advanceHighWater(dbPath, KEY, '2099-01-01T00:00:00.000Z', NOW_D);
    expect(readRows(dbPath, 'github')[0]!.high_water).toBeNull();
    advanceHighWater(dbPath, KEY, '2026-10-11T00:00:00.000Z', NOW_D);
    expect(readRows(dbPath, 'github')[0]!.high_water).toBe('2026-10-11T00:00:00.000Z');
  });

  it('moves forward, never back, and ignores a stamp it cannot read', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    advanceHighWater(dbPath, KEY, '2026-10-01T00:00:00.000Z', NOW_D);
    expect(readRows(dbPath, 'github')[0]!.high_water).toBe('2026-10-01T00:00:00.000Z');
    advanceHighWater(dbPath, KEY, '2026-09-01T00:00:00.000Z', NOW_D);
    advanceHighWater(dbPath, KEY, 'garbage', NOW_D);
    expect(readRows(dbPath, 'github')[0]!.high_water).toBe('2026-10-01T00:00:00.000Z');
    advanceHighWater(dbPath, KEY, '2026-10-05T00:00:00.000Z', NOW_D);
    expect(readRows(dbPath, 'github')[0]!.high_water).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('needs_reauth', () => {
  it('marks every scope of the source and no other source', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    beginRun(dbPath, { source: 'github', scopeKey: 'repo:o/r', scope: 'team' }, '2026-04-13T12:00:00.000Z', NOW);
    beginRun(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, '2026-04-13T12:00:00.000Z', NOW);
    markNeedsReauth(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    expect(readRows(dbPath).map((r) => [r.source_id, r.scope_key, r.status])).toEqual([
      ['github', 'repo:o/r', 'needs_reauth'], ['github', 'yours', 'needs_reauth'], ['jira', 'yours', 'ok'],
    ]);
  });

  it('a source with no row gets one, with a concrete window', () => {
    markNeedsReauth(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    expect(readRows(dbPath, 'github')[0]).toMatchObject({ status: 'needs_reauth', window_since: '2026-04-13T12:00:00.000Z' });
  });

  it('clearNeedsReauth resets only that status on that source', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    beginRun(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, '2026-04-13T12:00:00.000Z', NOW);
    markNeedsReauth(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    markNeedsReauth(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, '2026-04-13T12:00:00.000Z', NOW);
    exec(`UPDATE source_sync SET status = 'partial' WHERE source_id = 'jira'`);
    clearNeedsReauth(dbPath, 'github');
    expect(readRows(dbPath).map((r) => [r.source_id, r.status])).toEqual([['github', 'ok'], ['jira', 'partial']]);
  });

  it('a file with no source_sync table (never migrated) reads as empty and clears nothing', () => {
    const bare = path.join(dir, 'bare.db');
    new DatabaseSync(bare).close();
    expect(readRows(bare)).toEqual([]);
    expect(() => clearNeedsReauth(bare, 'github')).not.toThrow();
    expect(deleteSource(bare, 'github')).toBe(0);
  });
});

describe('deleteSource', () => {
  it('removes that source\'s rows and reports how many', () => {
    beginRun(dbPath, KEY, '2026-04-13T12:00:00.000Z', NOW);
    beginRun(dbPath, { source: 'github', scopeKey: 'repo:o/r', scope: 'team' }, '2026-04-13T12:00:00.000Z', NOW);
    beginRun(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, '2026-04-13T12:00:00.000Z', NOW);
    expect(deleteSource(dbPath, 'github')).toBe(2);
    expect(readRows(dbPath).map((r) => r.source_id)).toEqual(['jira']);
  });
});

describe('activity', () => {
  function seedDecision(id: string, platform: string, url: string): void {
    exec(`INSERT INTO decisions (id, title, summary, source_url, platform) VALUES ('${id}', 't${id}', 's', '${url}', '${platform}')`);
  }

  it('recording again replaces the stamp for that scope (a thread got a newer reply); another scope keeps its own', () => {
    recordActivity(dbPath, 'yours', [{ decisionId: 'a', platform: 'slack', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    recordActivity(dbPath, 'yours', [{ decisionId: 'a', platform: 'slack', updatedAt: '2026-10-08T00:00:00.000Z' }]);
    recordActivity(dbPath, 'repo:o/r', [{ decisionId: 'a', platform: 'slack', updatedAt: '2026-09-01T00:00:00.000Z' }]);
    expect(sql('SELECT scope_key, updated_at FROM sync_item_state ORDER BY scope_key')).toEqual([
      { scope_key: 'repo:o/r', updated_at: '2026-09-01T00:00:00.000Z' }, { scope_key: 'yours', updated_at: '2026-10-08T00:00:00.000Z' },
    ]);
  });

  it('threadRows joins stored items to their activity; an item nobody recorded reads null', () => {
    seedDecision('a', 'slack', 'https://slack.com/archives/C1/p1700000001000001');
    seedDecision('b', 'slack', 'https://slack.com/archives/C1/p1700000002000001');
    seedDecision('c', 'github', 'https://github.com/o/r/pull/1');
    recordActivity(dbPath, 'yours', [{ decisionId: 'a', platform: 'slack', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    expect(threadRows(dbPath, 'slack').sort((x, y) => (x.source_url < y.source_url ? -1 : 1))).toEqual([
      { source_url: 'https://slack.com/archives/C1/p1700000001000001', last_activity: '2026-10-01T00:00:00.000Z' },
      { source_url: 'https://slack.com/archives/C1/p1700000002000001', last_activity: null },
    ]);
  });
});

describe('counts', () => {
  it('pendingDetailCount counts the platform\'s flagged rows; unfinishedCount counts the rows a re-link can finish', () => {
    exec(`INSERT INTO decisions (id, title, summary, platform, detail_pending, enriched_at) VALUES
      ('a', 'a', 's', 'github', 1, NULL), ('b', 'b', 's', 'github', 1, '2026-10-01'), ('c', 'c', 's', 'github', 0, NULL), ('d', 'd', 's', 'jira', 1, '2026-10-01')`);
    expect(pendingDetailCount(dbPath, 'github')).toBe(2);
    expect(pendingDetailCount(dbPath, 'jira')).toBe(1);
    expect(pendingDetailCount(dbPath, 'slack')).toBe(0);
    // 'a' and 'c' are unfinished, but a re-link can only finish a row that has a URL or a current-model embedding
    expect(unfinishedCount(dbPath, 'm')).toBe(0);
    exec(`UPDATE decisions SET source_url = 'https://github.com/o/r/pull/9' WHERE id = 'c'`);
    expect(unfinishedCount(dbPath, 'm')).toBe(1);
    exec(`INSERT INTO decision_embeddings (decision_id, embedding, model) VALUES ('a', x'00', 'm')`);
    expect(unfinishedCount(dbPath, 'm')).toBe(2);
    expect(unfinishedCount(dbPath, 'other-model')).toBe(1); // a retired model's vector does not count; the URL row still does
  });
});
