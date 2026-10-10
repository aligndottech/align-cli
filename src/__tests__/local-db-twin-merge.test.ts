// L2 (Decisions 2 and 3): an edited PR or issue title made v6 write a SECOND row for the same
// item, because v6's identity was (source_url, title). The migration merges those twins into
// one row keyed by source_key, re-points everything that named the loser, and keeps a copy of
// every deleted row in decisions_merged_backup so the merge can be undone.
//
// The fixture is a v6 file written through v6's own writers (helpers/v6-graph.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { count, createV6Graph } from './helpers/v6-graph.js';

// Real SQLite files; the Windows runner opens one in about a second (see decided-at.test.ts).
vi.setConfig({ testTimeout: 30_000 });

const PR = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
const SESSION = 'file:///home/t/.claude/projects/x/session.jsonl';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-twins-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rows(sql: string, ...params: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all(...params) as Array<Record<string, unknown>>; } finally { db.close(); }
}

describe('twin merge', () => {
  it('two GitHub rows for one PR become one row carrying the newer title; session rows sharing a URL stay', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'v1 body', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Use Postgres for the queue', summary: 'v2 body', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 's1', title: 'Use WAL', summary: 'a', sourceUrl: SESSION, platform: 'agent-session' });
    v6.insertDecision({ id: 's2', title: 'Pin node 22', summary: 'b', sourceUrl: SESSION, platform: 'agent-session' });
    v6.close();
    expect(count(dbPath, 'SELECT count(*) AS n FROM decisions')).toBe(4); // control: the twins exist

    createLocalDb(dbPath).close();

    expect(rows(`SELECT id, title, summary FROM decisions WHERE source_url = ?`, PR)).toEqual([
      { id: 'new', title: 'Use Postgres for the queue', summary: 'v2 body' },
    ]);
    expect(rows(`SELECT id FROM decisions WHERE source_url = ? ORDER BY id`, SESSION)).toEqual([{ id: 's1' }, { id: 's2' }]);
    expect(rows(`SELECT id, title FROM decisions_merged_backup`)).toEqual([{ id: 'old', title: 'Use Postgres' }]);
  });

  it('a ratified OLDER twin survives keeping ITS text and vector; the newer text is kept as an audit note', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'ratified text', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Revert: do not use Postgres', summary: 'opposite text', sourceUrl: PR, platform: 'github' });
    v6.markRatified('old', 'tom@align.tech');
    v6.setEmbedding('old', 0.1);
    v6.setEmbedding('new', 0.2);
    v6.close();

    createLocalDb(dbPath).close();

    // Ratification attests the text Tom read: the survivor must not carry text he never saw.
    expect(rows(`SELECT id, title, summary, ratified_by AS r FROM decisions`)).toEqual([
      { id: 'old', title: 'Use Postgres', summary: 'ratified text', r: 'tom@align.tech' },
    ]);
    expect(rows(`SELECT id FROM decisions_merged_backup`)).toEqual([{ id: 'new' }]);
    const db = createLocalDb(dbPath);
    try { expect(Array.from(db.getEmbedding('old') ?? [])[0]).toBeCloseTo(0.1); } finally { db.close(); }
    const note = rows(`SELECT detail FROM decision_audit WHERE decision_id = 'old' AND action = 'text_revision_pending'`);
    expect(note).toHaveLength(1);
    expect(JSON.parse(note[0]!.detail as string)).toEqual({ title: 'Revert: do not use Postgres', summary: 'opposite text' });
  });

  it('a confirmed (not ratified) older twin also keeps its text', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'confirmed text', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Use SQLite', summary: 'other text', sourceUrl: PR, platform: 'github' });
    v6.raw.prepare(`UPDATE decisions SET confirmed_by = 'tom', confirmed_at = '2026-01-01T00:00:00Z' WHERE id = 'old'`).run();
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows(`SELECT id, summary, confirmed_by AS c FROM decisions`)).toEqual([{ id: 'old', summary: 'confirmed text', c: 'tom' }]);
  });

  it('the survivor carries the union of attestation: ratified_* from a loser when the survivor lacks them, and the earliest created_at', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'a', title: 'T1', summary: '1', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'b', title: 'T2', summary: '2', sourceUrl: PR, platform: 'github' });
    v6.raw.prepare(`UPDATE decisions SET created_at = '2026-01-01 00:00:00' WHERE id = 'a'`).run();
    v6.raw.prepare(`UPDATE decisions SET created_at = '2026-03-01 00:00:00' WHERE id = 'b'`).run();
    // a is confirmed only; b is ratified. Ratified outranks confirmed, so b survives with b's text.
    v6.raw.prepare(`UPDATE decisions SET confirmed_by = 'tom', confirmed_at = '2026-02-01T00:00:00Z' WHERE id = 'a'`).run();
    v6.raw.prepare(`UPDATE decisions SET ratified_by = 'tom', ratified_at = '2026-04-01T00:00:00Z' WHERE id = 'b'`).run();
    v6.close();
    createLocalDb(dbPath).close();
    expect(rows(`SELECT id, title, created_at, confirmed_by AS c, confirmed_at AS ca, ratified_by AS r FROM decisions`)).toEqual([
      { id: 'b', title: 'T2', created_at: '2026-01-01 00:00:00', c: 'tom', ca: '2026-02-01T00:00:00Z', r: 'tom' },
    ]);
  });

  it('three twins (two edits) collapse to the most recent, and both losers are backed up', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'a', title: 'T1', summary: '1', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'b', title: 'T2', summary: '2', sourceUrl: `${PR}/`, platform: 'github' });
    v6.insertDecision({ id: 'c', title: 'T3', summary: '3', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'other', title: 'T1', summary: 'x', sourceUrl: PR2, platform: 'github' });
    v6.close();

    createLocalDb(dbPath).close();

    expect(rows(`SELECT id, title FROM decisions ORDER BY id`)).toEqual([{ id: 'c', title: 'T3' }, { id: 'other', title: 'T1' }]);
    expect(rows(`SELECT id FROM decisions_merged_backup ORDER BY id`)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('re-points audit rows, links, refs, judgements and promotions at the survivor, and drops the twin-to-twin link', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'v1', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Use Postgres for the queue', summary: 'v2', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'x', title: 'Queue retries', summary: 'r', sourceUrl: PR2, platform: 'github' });
    v6.insertAudit('au1', 'old', 'pushed');
    v6.insertLink('l-twins', 'new', 'old', 'relates', 0.9);
    v6.insertLink('l-out', 'old', 'x', 'contradicts', 0.6);
    v6.insertLink('l-dup', 'new', 'x', 'contradicts', 0.8); // same triple once re-pointed: the higher confidence stays
    v6.insertLink('l-in', 'x', 'old', 'relates', 0.7);
    v6.insertRef('old', 'ALI-1', 'linear');
    v6.insertRef('new', 'ALI-1', 'linear'); // same ref on both: one survives
    v6.insertRef('old', 'ALI-2', 'linear');
    v6.setEmbedding('old', 0.1);
    v6.setEmbedding('new', 0.2);
    // Tables a later bump creates (C7's promotions) or that a re-run finds populated: the merge
    // re-points any that exist, so the fixture creates them in the shape their owners define.
    v6.raw.exec(`
      CREATE TABLE promotions (local_id TEXT NOT NULL, env TEXT NOT NULL, tenant_id TEXT NOT NULL, remote_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, shared_at TEXT NOT NULL DEFAULT (datetime('now')), retracted_at TEXT,
        PRIMARY KEY (local_id, env, tenant_id));
      INSERT INTO promotions (local_id, env, tenant_id, remote_id, content_hash) VALUES ('old', 'prod', 't1', 'r1', 'h');
    `);
    v6.close();
    createLocalDb(dbPath).close();

    expect(rows(`SELECT id FROM decisions ORDER BY id`)).toEqual([{ id: 'new' }, { id: 'x' }]);
    expect(rows(`SELECT decision_id AS d, action FROM decision_audit WHERE action = 'pushed'`)).toEqual([{ d: 'new', action: 'pushed' }]);
    expect(rows(`SELECT decision_id AS d, detail FROM decision_audit WHERE action = 'merged'`)).toEqual([{ d: 'new', detail: 'old' }]);
    expect(rows(`SELECT source_id AS s, target_id AS t, relation, confidence FROM decision_links ORDER BY s, t`)).toEqual([
      { s: 'new', t: 'x', relation: 'contradicts', confidence: 0.8 },
      { s: 'x', t: 'new', relation: 'relates', confidence: 0.7 },
    ]);
    expect(rows(`SELECT decision_id AS d, ref FROM decision_refs ORDER BY ref`)).toEqual([
      { d: 'new', ref: 'ALI-1' }, { d: 'new', ref: 'ALI-2' },
    ]);
    expect(rows(`SELECT local_id AS id FROM promotions`)).toEqual([{ id: 'new' }]);
    // The survivor keeps the embedding of its own (newest) text.
    expect(rows(`SELECT decision_id AS d FROM decision_embeddings`)).toEqual([{ d: 'new' }]);
  });

  it('re-points a local judgement on the loser, both as the decision and as the counterpart', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'old', title: 'Use Postgres', summary: 'v1', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'new', title: 'Use Postgres for the queue', summary: 'v2', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'x', title: 'Queue retries', summary: 'r', sourceUrl: PR2, platform: 'github' });
    // As if a previous attempt at this step had created the table and a judgement landed on it
    // (CREATE TABLE IF NOT EXISTS keeps it): the merge must re-point it, not orphan it.
    v6.raw.exec(`
      CREATE TABLE local_judgements (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, counterpart_id TEXT, context_key TEXT,
        kind TEXT NOT NULL, value TEXT, note TEXT, judge_id TEXT NOT NULL, judge_label TEXT, via TEXT NOT NULL, agent_id TEXT, judged_at TEXT NOT NULL);
      INSERT INTO local_judgements (id, decision_id, counterpart_id, kind, value, judge_id, via, judged_at)
        VALUES ('j1', 'old', 'x', 'conflict_verdict', 'false', 'inst-1', 'cli', '2026-10-01T00:00:00Z'),
               ('j2', 'x', 'old', 'conflict_verdict', 'real', 'inst-2', 'cli', '2026-10-01T00:00:00Z');
    `);
    v6.close();

    createLocalDb(dbPath).close();

    expect(rows(`SELECT id, decision_id AS d, counterpart_id AS c FROM local_judgements ORDER BY id`)).toEqual([
      { id: 'j1', d: 'new', c: 'x' },
      { id: 'j2', d: 'x', c: 'new' },
    ]);
  });

  it('with no twins, nothing is backed up and nothing is deleted', () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'a', title: 'A', summary: 'a', sourceUrl: PR, platform: 'github' });
    v6.insertDecision({ id: 'b', title: 'B', summary: 'b', sourceUrl: PR2, platform: 'github' });
    v6.close();

    createLocalDb(dbPath).close();

    expect(count(dbPath, 'SELECT count(*) AS n FROM decisions')).toBe(2);
    expect(count(dbPath, 'SELECT count(*) AS n FROM decisions_merged_backup')).toBe(0);
    expect(count(dbPath, `SELECT count(*) AS n FROM decision_audit WHERE action = 'merged'`)).toBe(0);
  });
});

describe('insertDecision after L2', () => {
  it('a connector upsert with a known source_key and a new title retitles the row; no second row', () => {
    const db = createLocalDb(dbPath);
    try {
      const id = db.insertDecision({ title: 'Use Postgres', summary: 'v1', sourceUrl: PR, platform: 'github', keyed: true });
      const again = db.insertDecision({ title: 'Use Postgres for the queue', summary: 'v2', sourceUrl: `${PR}#top`, platform: 'github', keyed: true });
      expect(again).toBe(id);
      expect(db.listDecisions().map(d => [d.id, d.title, d.summary])).toEqual([[id, 'Use Postgres for the queue', 'v2']]);
    } finally { db.close(); }
  });

  it('a session upsert with a new title is still a second row', () => {
    const db = createLocalDb(dbPath);
    try {
      db.insertDecision({ title: 'Use WAL', summary: 'a', sourceUrl: SESSION, platform: 'agent-session' });
      db.insertDecision({ title: 'Pin node 22', summary: 'b', sourceUrl: SESSION, platform: 'agent-session' });
      expect(db.listDecisions()).toHaveLength(2);
    } finally { db.close(); }
  });

  it('findIdBySource finds the row by its source_key when the title changed', () => {
    const db = createLocalDb(dbPath);
    try {
      const id = db.insertDecision({ title: 'Use Postgres', summary: 'v1', sourceUrl: PR, platform: 'github', keyed: true });
      expect(db.findIdBySource(PR, 'A new title', 'github', true)).toBe(id);
      expect(db.findIdBySource(SESSION, 'A new title', 'agent-session', true)).toBeNull();
      expect(db.findIdBySource(PR, 'A new title', 'github')).toBeNull(); // not a connector call: no key lookup
    } finally { db.close(); }
  });
});
