/**
 * ALI-831: the decider/ratified columns on the local graph's own storage layer.
 *
 * An agent-made decision enters the local graph as a CLAIM - `decider_kind = 'agent'`, no
 * `ratified_at` - and a human later stands behind it by ratifying. These pin the schema half:
 * the five columns, the migration that adds them to a graph that predates them, the
 * write-once origin rule, the first-ratification-stands rule, the queue filter, and the audit
 * table the human act is recorded in.
 *
 * Test List:
 * 1. a fresh database carries the five columns and the audit table
 * 2. a v4 graph (built by hand, no migrate()) gains the columns on open and stamps version 5 -
 *    deleting the migration step reddens this (the ALI-819/824 lesson: an unpinned migration
 *    leaves every test green when deleted)
 * 3. insertDecision stores deciderKind and reads it back; omitted stores NULL
 * 4. a re-import upsert never rewrites decider_kind - origin is immutable (align-stack
 *    snapshots.ts: "a human re-capture must not launder an agent premise into 'human'")
 * 5. markRatified writes both columns and returns the stamp; a second call returns null and
 *    the first stamp stands
 * 6. listDecisions({ unratified: true }) is agent AND unratified: three fixtures, one per
 *    excluded arm, so a filter on either predicate alone fails
 * 7. insertAudit / listAudit round-trip in insertion order
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';

const PROVENANCE_COLUMNS = ['decider_kind', 'confirmed_by', 'confirmed_at', 'ratified_by', 'ratified_at'];

let dir: string;
let dbPath: string;
let db: ReturnType<typeof createLocalDb> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-provenance-'));
  dbPath = path.join(dir, 'local.db');
});

afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  const raw = new DatabaseSync(dbPath);
  const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  raw.close();
  return cols;
}

describe('the provenance columns', () => {
  it('are on a fresh database, with the audit table beside them, and the schema is at least 5', () => {
    db = createLocalDb(dbPath);
    db.close();
    db = undefined;
    const cols = columnsOf('decisions');
    // Positive control: the table exists at all before anything is asserted about its shape.
    expect(cols).toContain('title');
    for (const c of PROVENANCE_COLUMNS) expect(cols).toContain(c);
    expect(columnsOf('decision_audit')).toEqual(expect.arrayContaining(['decision_id', 'action', 'actor', 'created_at']));
    // The exact number is derived, not asserted, in local-db-dedup.test.ts.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });

  it('are added to a v4 graph on open, and the version is stamped so it does not run again', () => {
    // The v4 shape by hand: every column up to decided_at, none of the five, no audit table.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
        platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        repo TEXT, decided_at TEXT
      );
      CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE decision_refs (decision_id TEXT NOT NULL, ref TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
      CREATE UNIQUE INDEX decisions_source_title_unique ON decisions(source_url, title);
      CREATE UNIQUE INDEX decision_links_triple_unique ON decision_links(source_id, target_id, relation);
      PRAGMA user_version = 4;
    `);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)')
      .run('d1', 'Pre-existing row', 's', 'https://github.com/acme/api/commit/abc1234', 'git');
    raw.close();
    // Control on the fixture: it really is a v4 shape, so the columns below are ADDED, not
    // found. Without this the test passes against a migration that does nothing.
    expect(columnsOf('decisions')).not.toContain('decider_kind');

    db = createLocalDb(dbPath);
    const row = db.getDecisionById('d1');
    // No backfill: a row captured before the column reads as unknown, never as a guess
    // (align-stack migration 113 refuses the retroactive classification; so does this).
    expect(row?.deciderKind).toBeNull();
    expect(row?.ratifiedAt).toBeNull();
    db.close();
    db = undefined;

    for (const c of PROVENANCE_COLUMNS) expect(columnsOf('decisions')).toContain(c);
    expect(columnsOf('decision_audit')).toContain('action');
    const check = new DatabaseSync(dbPath);
    const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    expect(version).toBe(SCHEMA_VERSION);
  });
});

describe('decider_kind on insert', () => {
  it('is stored and read back through getDecisionById and listDecisions', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Agent chose sqlite', summary: 's', sourceUrl: 'claude-session://s1/m1', platform: 'agent-session', deciderKind: 'agent' });
    expect(db.getDecisionById(id)?.deciderKind).toBe('agent');
    expect(db.listDecisions()[0]?.deciderKind).toBe('agent');
  });

  it('stores NULL when the caller says nothing, which reads as unknown rather than human', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Legacy caller', summary: 's', sourceUrl: null, platform: 'cli' });
    expect(db.getDecisionById(id)?.deciderKind).toBeNull();
  });

  it('is never rewritten by a re-import of the same (source_url, title): origin is immutable', () => {
    db = createLocalDb(':memory:');
    const first = db.insertDecision({ title: 'Agent chose sqlite', summary: 'v1', sourceUrl: 'claude-session://s1/m1', platform: 'agent-session', deciderKind: 'agent' });
    // A human re-captures the same thing. The summary refreshes (existing upsert contract);
    // the origin does not.
    const second = db.insertDecision({ title: 'Agent chose sqlite', summary: 'v2', sourceUrl: 'claude-session://s1/m1', platform: 'cli', deciderKind: 'human' });
    expect(second).toBe(first);
    const row = db.getDecisionById(first);
    expect(row?.summary).toBe('v2');
    expect(row?.deciderKind).toBe('agent');
  });
});

describe('markRatified', () => {
  it('writes ratified_by and ratified_at and returns the stamp', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Agent chose sqlite', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    const stamp = db.markRatified(id, 'tom@align.tech');
    expect(stamp).not.toBeNull();
    const row = db.getDecisionById(id);
    expect(row?.ratifiedBy).toBe('tom@align.tech');
    expect(row?.ratifiedAt).toBe(stamp!.ratifiedAt);
    expect(row?.ratifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the first ratification stands: a second call returns null and changes nothing', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Agent chose sqlite', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    const first = db.markRatified(id, 'tom@align.tech');
    expect(db.markRatified(id, 'someone-else')).toBeNull();
    const row = db.getDecisionById(id);
    expect(row?.ratifiedBy).toBe('tom@align.tech');
    expect(row?.ratifiedAt).toBe(first!.ratifiedAt);
  });

  it('returns null for an id the graph does not hold', () => {
    db = createLocalDb(':memory:');
    expect(db.markRatified('nope', 'tom@align.tech')).toBeNull();
  });
});

describe('listDecisions({ unratified: true }) is the human queue: agent-decided AND unratified', () => {
  it('excludes a ratified agent row and an unratified human row, keeping the agent claim', () => {
    db = createLocalDb(':memory:');
    const claim = db.insertDecision({ title: 'Agent claim', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    const ratified = db.insertDecision({ title: 'Agent, ratified', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    db.markRatified(ratified, 'tom@align.tech');
    db.insertDecision({ title: 'Human, never needed ratifying', summary: 's', sourceUrl: null, platform: 'cli', deciderKind: 'human' });
    db.insertDecision({ title: 'Legacy, unknown origin', summary: 's', sourceUrl: null, platform: 'cli' });

    const queue = db.listDecisions({ unratified: true });
    expect(queue.map((d) => d.id)).toEqual([claim]);
    // Positive control: the unfiltered listing holds all four, so the filter did the work.
    expect(db.listDecisions()).toHaveLength(4);
  });
});

describe('decision_audit', () => {
  it('records the human act and reads it back in insertion order', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Agent claim', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    db.insertAudit({ decisionId: id, action: 'ratified', actor: 'tom@align.tech' });
    db.insertAudit({ decisionId: id, action: 'pushed', actor: 'tom@align.tech', detail: 'prod:cloud-id' });
    const rows = db.listAudit(id);
    expect(rows.map((r) => r.action)).toEqual(['ratified', 'pushed']);
    expect(rows[1]?.detail).toBe('prod:cloud-id');
    expect(rows[0]?.detail).toBeNull();
    expect(rows[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(db.listAudit('other')).toEqual([]);
  });
});
