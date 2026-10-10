// LB review: a copy of the graph's embeddings (ingestBatch's matrix) is only safe if it can
// tell, by construction, that the row set moved under it. `rowSetEpoch` is that signal: it
// goes up on EVERY path that deletes or re-ids a decision or deletes/replaces an embedding,
// so a holder compares one number instead of knowing which paths exist.
// One test per path, so a path that stops bumping fails by name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { SLACK_TOMBSTONE_TITLE } from '../lib/local-db-migrate.js';
import { connectorItemKey } from '../lib/source-key.js';
import { createV6Graph } from './helpers/v6-graph.js';

vi.setConfig({ testTimeout: 30_000 });

const PR = 'https://github.com/o/r/pull/9';
const vec = (x: number) => Float32Array.from([x, 1, 2]);

describe('rowSetEpoch', () => {
  let dir: string;
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-epoch-')); dbPath = path.join(dir, 'g.db'); });
  afterEach(() => { db?.close(); db = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  it('is 0 on a fresh graph, and inserting a decision or a first embedding does not move it', () => {
    db = createLocalDb(dbPath);
    expect(db.rowSetEpoch()).toBe(0);
    const id = db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://x.test/1', platform: 'github' });
    db.setEmbedding(id, vec(1), 'm');
    expect(db.rowSetEpoch()).toBe(0);
  });

  it('moves when an embedding is REPLACED', () => {
    db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'a', summary: 'a', sourceUrl: 'https://x.test/1', platform: 'github' });
    db.setEmbedding(id, vec(1), 'm');
    db.setEmbedding(id, vec(2), 'm');
    expect(db.rowSetEpoch()).toBe(1);
  });

  it('moves when a Slack tombstone twin is deleted, and not when there is none', () => {
    db = createLocalDb(dbPath);
    db.deleteSlackTombstoneTwin('https://slack.test/t/1');
    expect(db.rowSetEpoch()).toBe(0);
    db.insertDecision({ title: SLACK_TOMBSTONE_TITLE, summary: 't', sourceUrl: 'https://slack.test/t/1', platform: 'slack' });
    db.deleteSlackTombstoneTwin('https://slack.test/t/1');
    expect(db.rowSetEpoch()).toBe(1);
  });

  function seedTwinAndHolder(): void {
    const seed = createLocalDb(dbPath);
    const twin = seed.insertDecision({ title: 'New title', summary: 'twin', sourceUrl: PR, platform: 'github' });
    seed.setEmbedding(twin, vec(3), 'm');
    seed.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform, source_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run('holder', 'Old title', 'holder', PR, 'github', connectorItemKey('github', PR)!);
    raw.close();
  }

  it('moves when a keyless twin is folded into its keyed holder, and not when it is merely adopted', () => {
    seedTwinAndHolder();
    db = createLocalDb(dbPath);
    expect(db.rowSetEpoch()).toBe(0);
    db.foldPendingTwin(PR, 'New title', 'github', true);
    expect(db.rowSetEpoch()).toBe(1);
    expect(db.getDecisionById('holder')).not.toBeNull();

    const adopt = createLocalDb(path.join(dir, 'adopt.db'));
    adopt.insertDecision({ title: 'Lone', summary: 'x', sourceUrl: 'https://github.com/o/r/pull/5', platform: 'github' });
    adopt.foldPendingTwin('https://github.com/o/r/pull/5', 'Lone', 'github', true);
    expect(adopt.rowSetEpoch()).toBe(0);
    adopt.close();
  });

  it('moves when insertDecision folds a twin ITSELF, which the caller never sees', () => {
    seedTwinAndHolder();
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'New title', summary: 'edit', sourceUrl: PR, platform: 'github', keyed: true });
    expect(db.rowSetEpoch()).toBeGreaterThan(0);
  });

  it('moves on dropAll', () => {
    db = createLocalDb(dbPath);
    db.dropAll();
    expect(db.rowSetEpoch()).toBe(1);
  });

  it('moves when the open-time duplicate collapse deletes a row', () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
        platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
        relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    for (const [id, at] of [['first', '10:00:00'], ['second', '10:05:00']] as const) {
      raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, 'Same', 's', 'git://commit/abc', 'git', `2026-08-01 ${at}`);
    }
    raw.close();
    db = createLocalDb(dbPath);
    expect(db.getDecisionById('second')).toBeNull();   // control: the collapse really ran
    expect(db.rowSetEpoch()).toBeGreaterThan(0);
  });

  it('moves when the v7 twin merge absorbs a loser at open', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'v1', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Use Postgres for the queue', summary: 'v2', sourceUrl: PR, platform: 'github' });
    v6.close();
    db = createLocalDb(dbPath);
    expect(db.getDecisionById('old')).toBeNull();      // control: the merge really ran
    expect(db.rowSetEpoch()).toBeGreaterThan(0);
  });
});

describe('dataVersion and countEmbeddings', () => {
  it('dataVersion moves when ANOTHER connection commits and not when this one does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-dv-'));
    const p = path.join(dir, 'g.db');
    const a = createLocalDb(p);
    const b = createLocalDb(p);
    const v0 = a.dataVersion();
    a.insertDecision({ title: 'mine', summary: 's', sourceUrl: 'https://x.test/a', platform: 'github' });
    expect(a.dataVersion()).toBe(v0);
    b.insertDecision({ title: 'theirs', summary: 's', sourceUrl: 'https://x.test/b', platform: 'github' });
    expect(a.dataVersion()).not.toBe(v0);
    const id = b.insertDecision({ title: 'e', summary: 's', sourceUrl: 'https://x.test/c', platform: 'github' });
    b.setEmbedding(id, vec(1), 'm');
    expect(a.countEmbeddings()).toBe(1);
    a.close(); b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
