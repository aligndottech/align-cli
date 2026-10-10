import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { purgePlatform, purgePreview } from '../lib/sync/purge.js';
import { recordActivity } from '../lib/sync/sync-state.js';

/**
 * L5 Test List (forget --purge):
 * - Slack rows with no ratification, no audit act and no local judgement are deleted, with their links, refs and embeddings; the counts are returned.
 * - A ratified row, a confirmed row, a row with a human audit act, and a row a local judgement names (either side) are KEPT.
 * - System notes (capture_seen, text_revision_pending, sync_classified) are not acts.
 * - Another platform's rows are never touched. Preview reports the same split without deleting.
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

function seed(): Record<string, string> {
  const db = createLocalDb(dbPath);
  const ids: Record<string, string> = {};
  for (const name of ['plain1', 'plain2', 'ratified', 'confirmed', 'audited', 'noted', 'judged', 'counterpart']) {
    ids[name] = db.insertDecision({ title: name, summary: `s ${name}`, sourceUrl: `https://slack.com/archives/C1/p${1700000000000000 + Object.keys(ids).length}`, platform: 'slack' });
    db.setEmbedding(ids[name]!, new Float32Array([1, 0, 0]), 'm');
  }
  ids['gh'] = db.insertDecision({ title: 'gh', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
  db.insertLink({ sourceId: ids['plain1']!, targetId: ids['gh']!, relation: 'relates', confidence: 0.9 });
  db.replaceRefs(ids['plain1']!, [{ ref: 'ALI-1', platform: 'linear' }]);
  db.markRatified(ids['ratified']!, 'me');
  db.markConfirmed(ids['confirmed']!, 'me');
  db.insertAudit({ decisionId: ids['audited']!, action: 'pushed', actor: 'me' });
  for (const a of ['capture_seen', 'text_revision_pending', 'sync_classified']) db.insertAudit({ decisionId: ids['noted']!, action: a, actor: null });
  db.close();
  exec(`INSERT INTO local_judgements (id, decision_id, counterpart_id, kind, value, judge_id, via, judged_at) VALUES ('j1', '${ids['judged']}', '${ids['counterpart']}', 'conflict_verdict', 'false', 'me', 'cli', '2026-10-01')`);
  recordActivity(dbPath, [{ decisionId: ids['plain1']!, platform: 'slack', updatedAt: '2026-10-01T00:00:00.000Z' }]);
  return ids;
}

describe('purgePlatform', () => {
  it('deletes the unvouched rows and everything hanging off them, keeps the vouched ones, and counts both', () => {
    const ids = seed();
    expect(purgePlatform(dbPath, 'slack')).toEqual({ deleted: 3, kept: 5 });
    expect(titles('slack')).toEqual(['audited', 'confirmed', 'counterpart', 'judged', 'ratified']);
    expect(sql(`SELECT 1 FROM decision_links WHERE source_id = '${ids['plain1']}'`)).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_refs WHERE decision_id = '${ids['plain1']}'`)).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_embeddings WHERE decision_id IN ('${ids['plain1']}', '${ids['plain2']}', '${ids['noted']}')`)).toHaveLength(0);
    expect(sql(`SELECT 1 FROM decision_audit WHERE decision_id = '${ids['noted']}'`)).toHaveLength(0);
    expect(sql('SELECT 1 FROM sync_item_state')).toHaveLength(0);
    // the kept ones keep their embeddings
    expect(sql(`SELECT 1 FROM decision_embeddings WHERE decision_id = '${ids['ratified']}'`)).toHaveLength(1);
  });

  it('another platform is never touched', () => {
    seed();
    purgePlatform(dbPath, 'slack');
    expect(titles('github')).toEqual(['gh']);
    expect(purgePlatform(dbPath, 'github')).toEqual({ deleted: 1, kept: 0 });
  });

  it('a platform with nothing to purge: 0 deleted, the rest kept', () => {
    seed();
    expect(purgePlatform(dbPath, 'jira')).toEqual({ deleted: 0, kept: 0 });
  });

  it('a local judgement on EITHER side protects a row (the counterpart is kept too)', () => {
    const ids = seed();
    purgePlatform(dbPath, 'slack');
    expect(sql(`SELECT 1 FROM decisions WHERE id = '${ids['counterpart']}'`)).toHaveLength(1);
    expect(sql(`SELECT 1 FROM decisions WHERE id = '${ids['judged']}'`)).toHaveLength(1);
  });

  it('a graph with no local_judgements table (a v6 file) still purges by ratification and audit', () => {
    seed();
    exec('DROP TABLE local_judgements');
    expect(purgePlatform(dbPath, 'slack')).toEqual({ deleted: 5, kept: 3 });
  });

  it('a promotion record protects its row', () => {
    const ids = seed();
    exec(`CREATE TABLE promotions (decision_id TEXT NOT NULL); INSERT INTO promotions VALUES ('${ids['plain2']}')`);
    expect(purgePlatform(dbPath, 'slack').deleted).toBe(2);
    expect(titles('slack')).toContain('plain2');
  });
});

describe('purgePreview', () => {
  it('reports the same split and deletes nothing', () => {
    seed();
    expect(purgePreview(dbPath, 'slack')).toEqual({ deleted: 3, kept: 5 });
    expect(titles('slack')).toHaveLength(8);
  });
});
