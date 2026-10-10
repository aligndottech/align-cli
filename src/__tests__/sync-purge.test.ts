import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { forgetSourceData } from '../lib/sync/forget.js';
import { isPurgeable, purgePlatform, purgePreview } from '../lib/sync/purge.js';
import { beginRun, readRows, recordActivity } from '../lib/sync/sync-state.js';

/**
 * L5 Test List (forget --purge). A purge deletes ONLY rows a connector import wrote and nobody has handled:
 * - connector-keyed rows (source_key) of a CONNECTOR source are deleted, with their links, refs, embeddings and sync-item state, and counted.
 * - kept: ratified, confirmed, any audit act (capture_seen counts: somebody captured it by hand), a local judgement either side,
 *   a promotion (promotions.local_id), and any row with no source_key (a hand capture of a PR URL, a plain-text capture).
 * - names that are not connector sources (cli, git, docs, sessions, a typo, empty) refuse and delete nothing.
 * - every deleted row is copied to the *_purged_backup tables first, in the same transaction.
 * - one transaction: a failure leaves rows, sync state and everything else as it was. A newer-schema file is refused.
 */
vi.setConfig({ testTimeout: 30_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-purge-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
function exec(q: string): void { const x = new DatabaseSync(dbPath); try { x.exec(q); } finally { x.close(); } }
const titles = (platform: string) => sql<{ title: string }>(`SELECT title FROM decisions WHERE platform = '${platform}' ORDER BY title`).map((r) => r.title);
const url = (n: number) => `https://slack.com/archives/C1/p17000000000000${String(10 + n)}`;

function seed(): Record<string, string> {
  const db = createLocalDb(dbPath);
  const ids: Record<string, string> = {};
  let n = 0;
  for (const name of ['plain1', 'plain2', 'ratified', 'confirmed', 'audited', 'seen', 'noted', 'judged', 'counterpart']) {
    ids[name] = db.insertDecision({ title: name, summary: `s ${name}`, sourceUrl: url(n++), platform: 'slack', keyed: true });
    db.setEmbedding(ids[name]!, new Float32Array([1, 0, 0]), 'm');
  }
  // a hand capture of a Slack thread: same platform, same shape, but NOT written by a connector import, so no source_key
  ids['hand'] = db.insertDecision({ title: 'hand', summary: 'Captured from slack.com', sourceUrl: url(n++), platform: 'slack' });
  ids['gh'] = db.insertDecision({ title: 'gh', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github', keyed: true });
  ids['note'] = db.insertDecision({ title: 'a plain note', summary: 'we use postgres', sourceUrl: null, platform: 'cli' });
  ids['commit'] = db.insertDecision({ title: 'a commit', summary: 's', sourceUrl: 'https://github.com/o/r/commit/abcdef1', platform: 'git', keyed: true });
  db.insertLink({ sourceId: ids['plain1']!, targetId: ids['gh']!, relation: 'relates', confidence: 0.9 });
  db.replaceRefs(ids['plain1']!, [{ ref: 'ALI-1', platform: 'linear' }]);
  db.markRatified(ids['ratified']!, 'me');
  db.markConfirmed(ids['confirmed']!, 'me');
  db.insertAudit({ decisionId: ids['audited']!, action: 'pushed', actor: 'me' });
  db.insertAudit({ decisionId: ids['seen']!, action: 'capture_seen', actor: null });
  for (const a of ['text_revision_pending', 'sync_classified']) db.insertAudit({ decisionId: ids['noted']!, action: a, actor: null });
  db.close();
  exec(`INSERT INTO local_judgements (id, decision_id, counterpart_id, kind, value, judge_id, via, judged_at) VALUES ('j1', '${ids['judged']}', '${ids['counterpart']}', 'conflict_verdict', 'false', 'me', 'cli', '2026-10-01')`);
  recordActivity(dbPath, 'yours', [{ decisionId: ids['plain1']!, platform: 'slack', updatedAt: '2026-10-01T00:00:00.000Z' }]);
  return ids;
}

describe('purgePlatform', () => {
  it('deletes the unhandled connector rows (plain1, plain2, noted), keeps every handled one, and counts both', () => {
    const ids = seed();
    // 9 keyed slack rows + 1 hand capture: 3 deletable, 7 kept
    expect(purgePlatform(dbPath, 'slack')).toEqual({ deleted: 3, kept: 7 });
    expect(titles('slack')).toEqual(['audited', 'confirmed', 'counterpart', 'hand', 'judged', 'ratified', 'seen']);
    expect(sql(`SELECT 1 FROM decision_links WHERE source_id = '${ids['plain1']}'`)).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_refs WHERE decision_id = '${ids['plain1']}'`)).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_embeddings WHERE decision_id IN ('${ids['plain1']}', '${ids['plain2']}', '${ids['noted']}')`)).toHaveLength(0);
    expect(sql('SELECT 1 FROM sync_item_state')).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_embeddings WHERE decision_id = '${ids['ratified']}'`)).toHaveLength(1);
  });

  it('a hand capture and a plain-text capture are never purged, even on their own platform (the reviewer\'s repro)', () => {
    seed();
    purgePlatform(dbPath, 'slack');
    expect(titles('slack')).toContain('hand');
    expect(titles('cli')).toEqual(['a plain note']);
    expect(titles('git')).toEqual(['a commit']);
  });

  it('a capture_seen note is a person\'s act: the row is kept (the audit rule counts it)', () => {
    seed();
    purgePlatform(dbPath, 'slack');
    expect(titles('slack')).toContain('seen');
  });

  it('copies every deleted row, its vector and its refs to the backup tables, in the same transaction', () => {
    const ids = seed();
    purgePlatform(dbPath, 'slack');
    expect(sql<{ title: string }>('SELECT title FROM decisions_purged_backup ORDER BY title').map((r) => r.title)).toEqual(['noted', 'plain1', 'plain2']);
    expect(sql(`SELECT 1 FROM decision_embeddings_purged_backup WHERE decision_id = '${ids['plain1']}'`)).toHaveLength(1);
    expect(sql(`SELECT 1 FROM decision_refs_purged_backup WHERE decision_id = '${ids['plain1']}'`)).toHaveLength(1);
  });

  it('a local judgement on EITHER side protects a row', () => {
    const ids = seed();
    purgePlatform(dbPath, 'slack');
    expect(sql(`SELECT 1 FROM decisions WHERE id IN ('${ids['counterpart']}', '${ids['judged']}')`)).toHaveLength(2);
  });

  it('a promotion protects its row, by the shape its owner defines: promotions.local_id', () => {
    const ids = seed();
    exec(`CREATE TABLE promotions (local_id TEXT NOT NULL, env TEXT NOT NULL, tenant_id TEXT NOT NULL, remote_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, shared_at TEXT NOT NULL DEFAULT (datetime('now')), retracted_at TEXT, PRIMARY KEY (local_id, env, tenant_id));
      INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES ('${ids['plain2']}', 'prod', 't1', 'r1', 'h');`);
    expect(purgePlatform(dbPath, 'slack').deleted).toBe(2);
    expect(titles('slack')).toContain('plain2');
  });

  it('preview reports the same split and deletes nothing', () => {
    seed();
    expect(purgePreview(dbPath, 'slack')).toEqual({ deleted: 3, kept: 7 });
    expect(titles('slack')).toHaveLength(10);
    expect(sql('SELECT 1 FROM decisions_purged_backup')).toHaveLength(0);
  });
});

describe('names that are not connector sources', () => {
  it.each(['cli', 'git', 'docs', 'sessions', 'agent-session', 'gitub', '', 'all', '*'])('%j: refused, and nothing is deleted', (name) => {
    seed();
    const before = sql('SELECT count(*) AS n FROM decisions')[0];
    expect(isPurgeable(name)).toBe(false);
    expect(() => purgePlatform(dbPath, name)).toThrow(/not a connector source/);
    expect(() => forgetSourceData(dbPath, name, { purge: true })).toThrow(/not a connector source/);
    expect(sql('SELECT count(*) AS n FROM decisions')[0]).toEqual(before);
    expect(sql('SELECT 1 FROM decisions_purged_backup')).toHaveLength(0);
  });

  it('every connector source is accepted, including zoom', () => {
    for (const s of ['github', 'gitlab', 'jira', 'confluence', 'slack', 'teams', 'linear', 'notion', 'zoom']) expect(isPurgeable(s)).toBe(true);
  });
});

describe('forgetSourceData is one transaction', () => {
  it('a failure part-way (the backup table is gone) leaves every row, the sync rows and the item state as they were', () => {
    seed();
    beginRun(dbPath, { source: 'slack', scopeKey: 'yours', scope: 'yours' }, null, '2026-10-10T00:00:00.000Z');
    exec('DROP TABLE decision_refs_purged_backup');
    expect(() => forgetSourceData(dbPath, 'slack', { purge: true })).toThrow();
    expect(titles('slack')).toHaveLength(10);
    expect(readRows(dbPath, 'slack')).toHaveLength(1);
    expect(sql('SELECT 1 FROM sync_item_state')).toHaveLength(1);
    expect(sql('SELECT 1 FROM decisions_purged_backup')).toHaveLength(0);
  });

  it('without --purge it removes the sync rows AND the platform\'s item state, and reports how many items stay', () => {
    seed();
    beginRun(dbPath, { source: 'slack', scopeKey: 'yours', scope: 'yours' }, null, '2026-10-10T00:00:00.000Z');
    const r = forgetSourceData(dbPath, 'slack', { purge: false });
    expect(r).toMatchObject({ syncRowsRemoved: 1, staying: 10 });
    expect(sql('SELECT 1 FROM sync_item_state')).toHaveLength(0);
    expect(titles('slack')).toHaveLength(10);
  });

  it('with --purge it removes the sync rows, the item state and the unhandled rows together', () => {
    seed();
    beginRun(dbPath, { source: 'slack', scopeKey: 'yours', scope: 'yours' }, null, '2026-10-10T00:00:00.000Z');
    expect(forgetSourceData(dbPath, 'slack', { purge: true })).toMatchObject({ syncRowsRemoved: 1, purged: { deleted: 3, kept: 7 } });
    expect(readRows(dbPath, 'slack')).toEqual([]);
  });
});

describe('a graph written by a newer CLI', () => {
  it('is refused by purge, preview and forget before anything is read or deleted', () => {
    seed();
    exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    for (const f of [() => purgePlatform(dbPath, 'slack'), () => purgePreview(dbPath, 'slack'), () => forgetSourceData(dbPath, 'slack', { purge: true })]) {
      expect(f).toThrow(/written by a newer Align CLI/);
    }
    expect(titles('slack')).toHaveLength(10);
  });
});

describe('the reviewer\'s seeded graph (a v7 file with 203 github rows, 229 git commits, docs and linear)', () => {
  const SEEDED = path.join('/tmp/claude-1000/-home-thomas-aligndottech-align-stack/7915f407-23ef-4e7b-9338-df7deb537dd6/scratchpad/l5', 'seeded-base.db');
  const have = fs.existsSync(SEEDED);
  it.skipIf(!have)('purging github deletes only keyed rows; git, docs, cli and a typo refuse; the file migrates to the current schema', () => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(SEEDED + suffix)) fs.copyFileSync(SEEDED + suffix, dbPath + suffix);
    const by = () => Object.fromEntries(sql<{ platform: string; n: number }>('SELECT platform, count(*) AS n FROM decisions GROUP BY platform').map((r) => [r.platform, r.n]));
    const before = (() => { createLocalDb(dbPath).close(); return by(); })();
    expect(sql<{ user_version: number }>('PRAGMA user_version')[0]!.user_version).toBe(SCHEMA_VERSION);
    for (const bad of ['git', 'docs', 'cli', 'githb']) expect(() => forgetSourceData(dbPath, bad, { purge: true })).toThrow();
    expect(by()).toEqual(before);
    const unkeyed = sql<{ n: number }>(`SELECT count(*) AS n FROM decisions WHERE platform = 'github' AND source_key IS NULL`)[0]!.n;
    const r = forgetSourceData(dbPath, 'github', { purge: true });
    expect(r.purged!.deleted + r.purged!.kept).toBe(before['github']);
    expect(r.purged!.kept).toBeGreaterThanOrEqual(unkeyed);
    expect(by()).toEqual({ ...before, github: r.purged!.kept });
    expect(sql(`SELECT 1 FROM decisions WHERE platform = 'github' AND source_key IS NULL`)).toHaveLength(unkeyed);
  });
});
