/**
 * A decision's `source_url` identifies it. Re-importing the same commit, issue or message must
 * REFRESH that decision, never add a second copy.
 *
 * It added a second copy, on every platform, because `decisions` had `id TEXT PRIMARY KEY` and
 * `source_url TEXT` with no unique constraint, while `insertDecision` minted a fresh
 * `randomUUID()` per call. The documented first run walks straight into it: `setup --local`
 * seeds from git history, then setup's own outro and `import git`'s tip both tell you to run
 * `align import git`. Measured before this fix, macOS and ubuntu and windows alike: 2 decisions
 * after setup, 4 after the import, two rows per `git://commit/<sha>`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLocalDb } from '../lib/local-db.js';

const COMMIT_URL = 'git://commit/d0364cabfef7c371b0773c2d469c3ad1f304a1b2';

describe('local-db source_url dedup', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-dedup-${Date.now()}-${Math.trunc(performance.now())}.db`);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  it('re-inserting the same source_url updates in place rather than duplicating', () => {
    db = createLocalDb(dbPath);
    const first = db.insertDecision({
      title: 'feat: use Postgres over SQLite for the main store',
      summary: 'because we need concurrent writers',
      sourceUrl: COMMIT_URL,
      platform: 'git',
    });

    const second = db.insertDecision({
      title: 'feat: use Postgres over SQLite for the main store',
      summary: 'because we need concurrent writers',
      sourceUrl: COMMIT_URL,
      platform: 'git',
    });

    expect(db.listDecisions()).toHaveLength(1);
    // The SAME id, so the caller's setEmbedding lands on the surviving row rather than
    // orphaning a vector, and any agent holding the id still resolves it.
    expect(second).toBe(first);
  });

  it('refreshes the title and summary when the source has changed since the last import', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Old title', summary: 'Old summary', sourceUrl: COMMIT_URL, platform: 'git' });

    db.insertDecision({ title: 'New title', summary: 'New summary', sourceUrl: COMMIT_URL, platform: 'git' });

    const rows = db.listDecisions();
    expect(rows).toHaveLength(1);
    // Refresh, not ignore: a Jira issue or a rewritten commit message that changed upstream
    // should be current in the graph. DO NOTHING would pin the first version forever.
    expect(rows[0]).toMatchObject({ title: 'New title', summary: 'New summary' });
  });

  // The boundary, and the reason a plain unique index is the right tool: `align capture` with
  // no URL must keep inserting. SQLite treats each NULL as distinct in a unique index, so this
  // works by construction rather than by a special case in the SQL.
  it('still inserts every decision that has no source_url', () => {
    db = createLocalDb(dbPath);
    const a = db.insertDecision({ title: 'Captured one', summary: 'x', sourceUrl: null, platform: 'cli' });
    const b = db.insertDecision({ title: 'Captured two', summary: 'y', sourceUrl: null, platform: 'cli' });

    expect(db.listDecisions()).toHaveLength(2);
    expect(a).not.toBe(b);
  });

  it('keeps distinct source_urls distinct', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'A', summary: 'a', sourceUrl: `${COMMIT_URL}-a`, platform: 'git' });
    db.insertDecision({ title: 'B', summary: 'b', sourceUrl: `${COMMIT_URL}-b`, platform: 'git' });

    expect(db.listDecisions()).toHaveLength(2);
  });
});

describe('local-db migration of a graph that already holds duplicates', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-mig-${Date.now()}-${Math.trunc(performance.now())}.db`);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  /**
   * Build the pre-fix state directly, the way the shipped code produced it, rather than
   * describing it: version-1 schema, two rows sharing a source_url, each with its own
   * embedding and a link between them. Modelling this from my idea of "a duplicated graph"
   * would test my idea rather than the population the old writer left behind.
   */
  function seedDuplicatedV1(): { keptId: string; droppedId: string } {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
        platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE decision_embeddings (
        decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE, embedding BLOB NOT NULL
      );
      CREATE TABLE decision_links (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Distinct created_at so "keep the earliest" is decidable rather than a coin toss.
    raw.prepare(`INSERT INTO decisions (id, title, summary, source_url, platform, created_at) VALUES (?,?,?,?,?,?)`)
      .run('first-id', 'Postgres', 'from setup', COMMIT_URL, 'git', '2026-08-01 10:00:00');
    raw.prepare(`INSERT INTO decisions (id, title, summary, source_url, platform, created_at) VALUES (?,?,?,?,?,?)`)
      .run('second-id', 'Postgres', 'from import', COMMIT_URL, 'git', '2026-08-01 10:05:00');
    raw.prepare(`INSERT INTO decisions (id, title, summary, source_url, platform, created_at) VALUES (?,?,?,?,?,?)`)
      .run('other-id', 'Retries', 'unrelated', `${COMMIT_URL}-other`, 'git', '2026-08-01 10:06:00');
    const blob = Buffer.from(new Float32Array([0.1, 0.2]).buffer);
    for (const id of ['first-id', 'second-id', 'other-id']) {
      raw.prepare(`INSERT INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)`).run(id, blob);
    }
    raw.prepare(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?,?,?,?,?)`)
      .run('link-1', 'second-id', 'other-id', 'relates', 0.7);
    raw.pragma('user_version = 1');
    raw.close();
    return { keptId: 'first-id', droppedId: 'second-id' };
  }

  it('collapses duplicates on open, keeping the earliest row', () => {
    const { keptId, droppedId } = seedDuplicatedV1();

    db = createLocalDb(dbPath);

    const rows = db.listDecisions();
    expect(rows).toHaveLength(2);
    const urls = rows.map(r => r.sourceUrl).sort();
    expect(urls).toEqual([COMMIT_URL, `${COMMIT_URL}-other`]);
    // The earliest id survives: agents and advisory-dedup cache ids, so the long-standing
    // one is the one worth keeping.
    expect(rows.some(r => r.id === keptId)).toBe(true);
    expect(rows.some(r => r.id === droppedId)).toBe(false);
  });

  it('leaves no embedding or link pointing at a row it deleted', () => {
    seedDuplicatedV1();

    db = createLocalDb(dbPath);

    // Read through a separate handle so this asserts what is ON DISK, not what the
    // migration believes it did.
    const raw = new Database(dbPath, { readonly: true });
    try {
      const orphanEmbeddings = raw.prepare(
        `SELECT COUNT(*) n FROM decision_embeddings e LEFT JOIN decisions d ON d.id = e.decision_id WHERE d.id IS NULL`,
      ).get() as { n: number };
      const orphanLinks = raw.prepare(
        `SELECT COUNT(*) n FROM decision_links l
         LEFT JOIN decisions s ON s.id = l.source_id LEFT JOIN decisions t ON t.id = l.target_id
         WHERE s.id IS NULL OR t.id IS NULL`,
      ).get() as { n: number };
      expect(orphanEmbeddings.n).toBe(0);
      expect(orphanLinks.n).toBe(0);
      // Positive control: the surviving rows really are still there, so the two zeros above
      // cannot be passing because the migration emptied the tables.
      const kept = raw.prepare(`SELECT COUNT(*) n FROM decisions`).get() as { n: number };
      expect(kept.n).toBe(2);
    } finally {
      raw.close();
    }
  });

  it('makes a duplicate unrepresentable afterwards, so the guarantee is the schema not the code path', () => {
    seedDuplicatedV1();
    db = createLocalDb(dbPath);

    // Go around insertDecision entirely: a raw INSERT of a colliding source_url must be
    // rejected by the database. If only the upsert prevented duplicates, a future second
    // writer could reintroduce them.
    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw.prepare(`INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?,?,?,?,?)`)
          .run('sneaky-id', 'Postgres', 'again', COMMIT_URL, 'git'),
      ).toThrow(/UNIQUE/i);
    } finally {
      raw.close();
    }
  });

  it('is idempotent: opening an already-migrated graph changes nothing', () => {
    seedDuplicatedV1();
    db = createLocalDb(dbPath);
    const afterFirst = db.listDecisions();
    db.close();

    db = createLocalDb(dbPath);

    expect(db.listDecisions()).toEqual(afterFirst);
  });
});
