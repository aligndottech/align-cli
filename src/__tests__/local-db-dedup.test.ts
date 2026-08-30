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
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';

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

  it('refreshes the summary when the source body changed since the last import', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Same title', summary: 'Old summary', sourceUrl: COMMIT_URL, platform: 'git' });

    db.insertDecision({ title: 'Same title', summary: 'New summary', sourceUrl: COMMIT_URL, platform: 'git' });

    const rows = db.listDecisions();
    expect(rows).toHaveLength(1);
    // Refresh, not ignore: an edited Jira issue should be current in the graph, and DO NOTHING
    // would pin the first version forever.
    expect(rows[0]).toMatchObject({ summary: 'New summary' });
  });

  /**
   * The accepted cost of keying on (source_url, title) rather than source_url alone. A retitled
   * source inserts a second row instead of updating the first.
   *
   * Taken deliberately, because the alternative is worse in kind rather than degree: keying on
   * the URL alone let a CONSTANT source_url - connector-core's Teams fallback is literally
   * 'https://teams.microsoft.com' - collapse every message onto one row and DELETE the rest on
   * migration. Duplicating on a retitle is a tidiness problem; that was data loss.
   */
  it('inserts a second row when the title changed, which is the cost of the pair key', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Old title', summary: 's', sourceUrl: COMMIT_URL, platform: 'git' });

    db.insertDecision({ title: 'New title', summary: 's', sourceUrl: COMMIT_URL, platform: 'git' });

    expect(db.listDecisions()).toHaveLength(2);
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

describe('SCHEMA_VERSION and migrate() are one fact', () => {
  /**
   * Two writers of the same number: the constant, and the `if (version < N)` branches. Forget
   * the bump and the new branch runs on every open forever, which for a destructive step means
   * re-collapsing a graph indefinitely. Derived from the source rather than asserted as a
   * literal, so the next migration cannot introduce the drift silently.
   */
  it('SCHEMA_VERSION equals the highest migration step in migrate()', () => {
    const source = readFileSync(new URL('../lib/local-db.ts', import.meta.url), 'utf8');
    const steps = [...source.matchAll(/if \(version < (\d+)\)/g)].map(m => Number(m[1]));

    // Positive control: an empty parse would make the comparison below vacuous.
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBe(SCHEMA_VERSION);
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
    const raw = new DatabaseSync(dbPath);
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
    raw.exec('PRAGMA user_version = 1');
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
    const raw = new DatabaseSync(dbPath, { readOnly: true });
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
    const raw = new DatabaseSync(dbPath);
    try {
      expect(() =>
        raw.prepare(`INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?,?,?,?,?)`)
          .run('sneaky-id', 'Postgres', 'again', COMMIT_URL, 'git'),
      ).toThrow(/UNIQUE/i);
    } finally {
      raw.close();
    }
  });

  /**
   * The migration deletes rows from a user's only copy of their personal graph, automatically,
   * on open. These are the states I could think of that might make it delete the wrong thing.
   * Verified by hand first and pinned here, because a destructive path checked once is not
   * guarded - it is anecdote.
   */
  function seedRaw(rows: Array<[string, string | null, string]>, links: Array<[string, string, string]> = []): void {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
        source_url TEXT, platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL);
      CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE, embedding BLOB NOT NULL);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE, relation TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    const blob = Buffer.from(new Float32Array([0.1]).buffer);
    for (const [id, url, created] of rows) {
      raw.prepare(`INSERT INTO decisions (id,title,summary,source_url,platform,created_at) VALUES (?,?,?,?,?,?)`)
        .run(id, 't', 's', url, 'git', created);
      raw.prepare(`INSERT INTO decision_embeddings VALUES (?,?)`).run(id, blob);
    }
    for (const [id, s, t] of links) {
      raw.prepare(`INSERT INTO decision_links (id,source_id,target_id,relation,confidence) VALUES (?,?,?,'relates',1.0)`).run(id, s, t);
    }
    raw.exec('PRAGMA user_version = 1');
    raw.close();
  }

  /** No orphan or null-FK row anywhere, read from a separate connection. */
  function assertReferentialIntegrity(): void {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const orphanE = raw.prepare(`SELECT COUNT(*) n FROM decision_embeddings e LEFT JOIN decisions d ON d.id = e.decision_id WHERE d.id IS NULL`).get() as { n: number };
      const orphanL = raw.prepare(`SELECT COUNT(*) n FROM decision_links l LEFT JOIN decisions s ON s.id = l.source_id LEFT JOIN decisions t ON t.id = l.target_id WHERE s.id IS NULL OR t.id IS NULL`).get() as { n: number };
      const nullFk = raw.prepare(`SELECT COUNT(*) n FROM decision_links WHERE source_id IS NULL OR target_id IS NULL`).get() as { n: number };
      expect(orphanE.n).toBe(0);
      expect(orphanL.n).toBe(0);
      // The repointing UPDATE uses a correlated subquery; if it ever failed to match it would
      // write NULL into a NOT NULL column, which SQLite would reject - but assert it anyway,
      // because the alternative is discovering it on someone's graph.
      expect(nullFk.n).toBe(0);
    } finally {
      raw.close();
    }
  }

  it('collapses THREE copies to the earliest, not just a pair', () => {
    seedRaw([['a', 'u1', '10:00'], ['b', 'u1', '10:01'], ['c', 'u1', '10:02'], ['z', 'u2', '10:03']],
      [['l1', 'c', 'z'], ['l2', 'b', 'z']]);

    db = createLocalDb(dbPath);

    expect(db.listDecisions().map(r => r.id).sort()).toEqual(['a', 'z']);
    // Both edges repointed onto the survivor and then deduped into one.
    expect(db.listLinks()).toHaveLength(1);
    expect(db.listLinks()[0]).toMatchObject({ sourceId: 'a', targetId: 'z' });
    assertReferentialIntegrity();
  });

  it('breaks a created_at tie by INSERTION ORDER, keeping the row that was there first', () => {
    // `c` is inserted first, so `c` is the id an agent has been holding and advisory-dedup has
    // cached. created_at has one-second granularity, so a tie is the norm for rows written in
    // one import rather than a curiosity.
    seedRaw([['c', 'u1', '10:00'], ['a', 'u1', '10:00'], ['b', 'u1', '10:00']]);

    db = createLocalDb(dbPath);

    // Ordering by `id` here would keep 'a' - the lowest UUID, which is a coin flip - while the
    // comment above the query claimed to keep the long-standing row. `rowid` is insertion order
    // and actually delivers that.
    expect(db.listDecisions().map(r => r.id)).toEqual(['c']);
  });

  it('never collapses rows that merely share a NULL source_url', () => {
    seedRaw([['a', null, '10:00'], ['b', null, '10:01'], ['c', 'u1', '10:02'], ['d', 'u1', '10:03']]);

    db = createLocalDb(dbPath);

    // Both NULLs survive - they are different decisions that happen to have no URL - and only
    // the genuine u1 pair collapses.
    expect(db.listDecisions().map(r => r.id).sort()).toEqual(['a', 'b', 'c']);
    assertReferentialIntegrity();
  });

  it('deletes the self-link left behind when the two copies were linked to each other', () => {
    seedRaw([['a', 'u1', '10:00'], ['b', 'u1', '10:01']], [['l1', 'a', 'b']]);

    db = createLocalDb(dbPath);

    expect(db.listDecisions().map(r => r.id)).toEqual(['a']);
    // Repointing turns a->b into a->a, which is not a relationship.
    expect(db.listLinks()).toHaveLength(0);
    assertReferentialIntegrity();
  });

  it('leaves a graph with no duplicates completely untouched', () => {
    seedRaw([['a', 'u1', '10:00'], ['z', 'u2', '10:01']], [['l1', 'a', 'z']]);

    db = createLocalDb(dbPath);

    expect(db.listDecisions().map(r => r.id).sort()).toEqual(['a', 'z']);
    expect(db.listLinks()).toHaveLength(1);
  });

  /**
   * The interrupted state: user_version is stamped AFTER the transaction commits, so a process
   * killed in that window leaves the collapse done and the version still 1. The next open must
   * recover rather than fail permanently.
   */
  it('recovers when killed between the commit and the version stamp', () => {
    seedRaw([['a', 'u1', '10:00'], ['b', 'u1', '10:01']]);
    db = createLocalDb(dbPath);
    db.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 1'); // index present, duplicates gone, version not yet stamped
    raw.close();

    db = createLocalDb(dbPath);

    expect(db.listDecisions().map(r => r.id)).toEqual(['a']);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
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
