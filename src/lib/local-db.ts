import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DecisionRow {
  id: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
  platform: string;
  createdAt: string;
}

export interface LinkRow {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  confidence: number;
}

export interface DbStats {
  decisions: number;
  embeddings: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT,
  platform TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_embeddings (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Schema version this build expects. Bump when adding a step to `migrate`.
 *
 * Exported so a test can assert the migration WROTE the version it claims, without hardcoding
 * the number - a test pinning a literal 1 had to be edited by this change rather than passing
 * or failing on its own merits.
 */
export const SCHEMA_VERSION = 2;

/**
 * One-time data migrations, tracked in SQLite's built-in `user_version`.
 *
 * 1. ALI-503: relabel the cosine-similarity links that were written as `conflicts_with`.
 *    Every such row at version 0 is provably an artefact, because `insertLink` had exactly
 *    one caller and it hardcoded that relation for any pair over 0.65 cosine. No classifier
 *    verdict was ever persisted, so there is no earned row to damage.
 *
 * 2. A decision's `source_url` identifies it, and nothing enforced that: `insertDecision` minted
 *    a fresh UUID per call, so re-importing the same commit added a second copy. The documented
 *    first run does exactly that - `setup --local` seeds from git, then its own outro tells you
 *    to run `align import git` - so a graph goes from 2 decisions to 4 by following the tips.
 *    Collapse the existing duplicates, then make them unrepresentable with a unique index.
 *
 * The version guard is load-bearing rather than tidiness. The same UPDATE run on every open
 * is indistinguishable from this one today, and starts silently eating genuine conflicts the
 * moment anything writes one.
 */
function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.exec(`UPDATE decision_links SET relation = 'relates' WHERE relation = 'conflicts_with'`);
  }
  if (version < 2) {
    // One transaction: a half-collapsed graph with the index already in place would refuse
    // every subsequent import, and the failure would surface far from here.
    db.exec('BEGIN');
    try {
      // The survivor per source_url is the EARLIEST. Decision ids are handed to agents and
      // cached by advisory-dedup, so the long-standing id is the one worth keeping. `id` breaks
      // a created_at tie so the choice is deterministic rather than insertion-order luck.
      db.exec(`
        CREATE TEMP TABLE dedup_survivor AS
        SELECT source_url, id FROM (
          SELECT source_url, id,
                 ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY created_at, id) AS rn
          FROM decisions WHERE source_url IS NOT NULL
        ) WHERE rn = 1;
      `);
      // Repoint edges rather than dropping them: an edge to a duplicate is a real edge that
      // happened to name the copy. Dropping it would lose relationships the user earned.
      db.exec(`
        UPDATE decision_links SET source_id = (
          SELECT s.id FROM dedup_survivor s JOIN decisions d ON d.source_url = s.source_url
          WHERE d.id = decision_links.source_id
        ) WHERE source_id IN (
          SELECT d.id FROM decisions d JOIN dedup_survivor s ON d.source_url = s.source_url
          WHERE d.id <> s.id
        );
        UPDATE decision_links SET target_id = (
          SELECT s.id FROM dedup_survivor s JOIN decisions d ON d.source_url = s.source_url
          WHERE d.id = decision_links.target_id
        ) WHERE target_id IN (
          SELECT d.id FROM decisions d JOIN dedup_survivor s ON d.source_url = s.source_url
          WHERE d.id <> s.id
        );
      `);
      // Repointing can collapse an edge onto itself (the two copies were linked to each other)
      // or onto an edge that already exists. Neither is representable as a relationship.
      db.exec(`DELETE FROM decision_links WHERE source_id = target_id`);
      db.exec(`
        DELETE FROM decision_links WHERE id NOT IN (
          SELECT MIN(id) FROM decision_links GROUP BY source_id, target_id, relation
        );
      `);
      // Explicitly, not by CASCADE: SQLite leaves foreign_keys OFF unless asked, so the
      // ON DELETE CASCADE in the schema does not fire and these would be orphaned.
      db.exec(`
        DELETE FROM decision_embeddings WHERE decision_id IN (
          SELECT d.id FROM decisions d JOIN dedup_survivor s ON d.source_url = s.source_url
          WHERE d.id <> s.id
        );
      `);
      db.exec(`
        DELETE FROM decisions WHERE id IN (
          SELECT d.id FROM decisions d JOIN dedup_survivor s ON d.source_url = s.source_url
          WHERE d.id <> s.id
        );
      `);
      db.exec(`DROP TABLE dedup_survivor`);
      // Created here rather than in SCHEMA on purpose: SCHEMA runs before this function, so on
      // any already-duplicated graph the index would fail to build before the collapse could
      // run. A fresh database passes through the same path with nothing to collapse.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decisions_source_url_unique ON decisions(source_url)`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

export function createLocalDb(dbPath: string) {
  // better-sqlite3 creates the DB file but not its parent directory, so on a clean
  // machine (~/.config/align-cli absent) `align setup --local` crashed with "unable
  // to open database file". Create the directory first. ':memory:' has no parent.
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);

  return {
    /**
     * Insert, or refresh the decision that already carries this `source_url`, returning the id
     * that now holds it.
     *
     * Refresh rather than ignore: a rewritten commit message or an edited Jira issue should be
     * current in the graph. Returning the EXISTING id on a conflict is what keeps the caller's
     * `setEmbedding` on the surviving row instead of orphaning a vector.
     *
     * A null `source_url` never conflicts - SQLite treats each NULL in a unique index as
     * distinct - so `align capture` with no URL keeps inserting, by construction rather than by
     * a special case here.
     */
    insertDecision(row: { title: string; summary: string; sourceUrl: string | null; platform: string }): string {
      const inserted = db.prepare(
        `INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_url) DO UPDATE SET title = excluded.title, summary = excluded.summary
         RETURNING id`
      ).get(randomUUID(), row.title, row.summary, row.sourceUrl, row.platform) as { id: string };
      return inserted.id;
    },

    listDecisions(): DecisionRow[] {
      return db.prepare(
        `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt FROM decisions ORDER BY created_at DESC`
      ).all() as DecisionRow[];
    },

    getDecisionById(id: string): DecisionRow | null {
      return (db.prepare(
        `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt FROM decisions WHERE id = ?`
      ).get(id) as DecisionRow | null) ?? null;
    },

    setEmbedding(decisionId: string, embedding: Float32Array): void {
      db.prepare(
        `INSERT OR REPLACE INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)`
      ).run(decisionId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    },

    getEmbedding(decisionId: string): Float32Array | null {
      const row = db.prepare(
        `SELECT embedding FROM decision_embeddings WHERE decision_id = ?`
      ).get(decisionId) as { embedding: Buffer } | null;
      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    },

    getAllEmbeddings(): Array<{ decisionId: string; embedding: Float32Array }> {
      const rows = db.prepare(
        `SELECT decision_id, embedding FROM decision_embeddings`
      ).all() as Array<{ decision_id: string; embedding: Buffer }>;
      return rows.map(r => ({
        decisionId: r.decision_id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      }));
    },

    insertLink(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
      db.prepare(
        `INSERT OR IGNORE INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), link.sourceId, link.targetId, link.relation, link.confidence);
    },

    listLinks(filter?: { relation?: string; decisionId?: string }): LinkRow[] {
      let sql = `SELECT id, source_id as sourceId, target_id as targetId, relation, confidence FROM decision_links WHERE 1=1`;
      const params: unknown[] = [];
      if (filter?.relation) { sql += ` AND relation = ?`; params.push(filter.relation); }
      if (filter?.decisionId) { sql += ` AND (source_id = ? OR target_id = ?)`; params.push(filter.decisionId, filter.decisionId); }
      return db.prepare(sql).all(...params) as LinkRow[];
    },

    getStats(): DbStats {
      const decisions = (db.prepare(`SELECT COUNT(*) as n FROM decisions`).get() as { n: number }).n;
      const embeddings = (db.prepare(`SELECT COUNT(*) as n FROM decision_embeddings`).get() as { n: number }).n;
      // ALI-503 removed a `conflicts` count here: it had no production reader (only a test)
      // and after the relabelling it could only ever report 0, which is a decoy.
      return { decisions, embeddings };
    },

    dropAll(): void {
      db.exec(`DELETE FROM decision_links; DELETE FROM decision_embeddings; DELETE FROM decisions;`);
    },

    close(): void {
      db.close();
    },
  };
}

export type LocalDb = ReturnType<typeof createLocalDb>;
