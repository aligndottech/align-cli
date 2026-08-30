import { DatabaseSync } from 'node:sqlite';
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
 * or failing on its own merits. A parity test also derives the highest `version <` branch in
 * `migrate` from the source and compares it here, because forgetting the bump leaves the new
 * branch running destructively on every open with nothing to stop it.
 */
export const SCHEMA_VERSION = 2;

/**
 * A `source_url` is only an identity if it points at ONE thing. Some fetchers substitute a
 * constant when the per-item link is missing, and connector-core ships one:
 *
 *     dist/fetchers/teams.js:60   source_url: msg.webUrl ?? 'https://teams.microsoft.com'
 *
 * Treating that as an identity is destructive once the column is unique - every such message
 * collapses onto one row. So a bare origin, an empty string and whitespace are normalised to
 * null, which means "no identity" and never collides.
 *
 * Normalised away rather than stored beside a separate identity column: a URL that addresses a
 * host and nothing on it is not a link to the decision, so keeping it would render a
 * "source" link in `align search` that takes the reader to a homepage. One column, one meaning.
 *
 * Deliberately narrow: a URL with any path is treated as identifying, because Confluence's
 * `linkBase`
 * fallback (`https://site.atlassian.net/wiki`) cannot be told apart from a genuinely short page
 * URL, and a hardcoded list of known fallbacks would be wrong the day a fetcher invents one
 * more. That case is caught by the other half of the key instead - uniqueness is on
 * (source_url, title).
 */
export function identifyingSourceUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    // No path, no query, no fragment: this addresses a host, not a thing on it.
    if ((parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash) {
      return null;
    }
  } catch {
    // Not a parseable URL. `git://commit/<sha>` parses, but an opaque key may not, and an
    // opaque key is still an identity - discarding it would be the destructive direction.
  }
  return value;
}

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
function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < 1) {
    db.exec(`UPDATE decision_links SET relation = 'relates' WHERE relation = 'conflicts_with'`);
  }
  if (version < 2) {
    // IMMEDIATE, not the default DEFERRED: this transaction reads (the survivor scan) before it
    // writes, and under WAL another writer arriving in between makes the first write fail with
    // SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry. Every local command opens the DB
    // and the advisory hook fires on every agent edit, so a concurrent open is the normal case.
    db.exec('BEGIN IMMEDIATE');
    try {
      // The survivor is the row inserted FIRST. `rowid` rather than `id` breaks a created_at
      // tie: created_at has one-second granularity so rows written in one import tie routinely,
      // and ordering by a random UUID would keep an arbitrary one while this comment claimed to
      // keep the long-standing id. rowid is insertion order (the table is not WITHOUT ROWID).
      //
      // Keyed on (source_url, title), not source_url alone. Some fetchers emit a CONSTANT
      // source_url when the per-item link is missing - connector-core's Teams fallback is
      // literally 'https://teams.microsoft.com' - and collapsing on the URL alone deleted every
      // such message but one. Two rows sharing a URL AND a title are duplicates by any reading;
      // two sharing only the URL are not.
      db.exec(`
        CREATE TEMP TABLE dedup_survivor AS
        SELECT source_url, title, id FROM (
          SELECT source_url, title, id,
                 ROW_NUMBER() OVER (PARTITION BY source_url, title ORDER BY created_at, rowid) AS rn
          FROM decisions WHERE source_url IS NOT NULL
        ) WHERE rn = 1;

        CREATE TEMP TABLE dedup_dropped AS
        SELECT d.id AS id, s.id AS survivor_id
        FROM decisions d JOIN dedup_survivor s
          ON d.source_url = s.source_url AND d.title = s.title
        WHERE d.id <> s.id;
      `);
      // Repoint edges rather than dropping them: an edge naming a duplicate is a real edge that
      // happened to name the copy. Dropping it would lose a relationship the user earned.
      db.exec(`
        UPDATE decision_links SET source_id = (
          SELECT survivor_id FROM dedup_dropped WHERE id = decision_links.source_id
        ) WHERE source_id IN (SELECT id FROM dedup_dropped);
        UPDATE decision_links SET target_id = (
          SELECT survivor_id FROM dedup_dropped WHERE id = decision_links.target_id
        ) WHERE target_id IN (SELECT id FROM dedup_dropped);
      `);
      // Both cleanups are scoped to the pairs repointing actually touched. An earlier version
      // deduplicated decision_links table-wide, which deleted user-earned edges that had nothing
      // to do with duplication - and kept the lowest UUID rather than the highest confidence.
      db.exec(`
        DELETE FROM decision_links
        WHERE source_id = target_id
          AND (source_id IN (SELECT survivor_id FROM dedup_dropped)
            OR target_id IN (SELECT survivor_id FROM dedup_dropped));
      `);
      // Explicitly, not by CASCADE: SQLite leaves foreign_keys OFF unless asked, so the
      // ON DELETE CASCADE in the schema does not fire and these would be orphaned.
      db.exec(`DELETE FROM decision_embeddings WHERE decision_id IN (SELECT id FROM dedup_dropped)`);
      db.exec(`DELETE FROM decisions WHERE id IN (SELECT id FROM dedup_dropped)`);
      db.exec(`DROP TABLE dedup_dropped; DROP TABLE dedup_survivor;`);
      // Created here rather than in SCHEMA on purpose: SCHEMA runs before this function, so on
      // any already-duplicated graph the index would fail to build before the collapse could
      // run. A fresh database passes through the same path with nothing to collapse.
      //
      // A distinct name from any previous attempt, because IF NOT EXISTS matches on the NAME
      // only: an index of the same name with different columns would be silently kept, and
      // every later insert would then fail with "ON CONFLICT clause does not match".
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decisions_source_title_unique ON decisions(source_url, title)`);
      // Same story for edges: insertLink's `OR IGNORE` was decorative without a unique index, so
      // a re-import stacked an identical relates row every time. Collapse, then constrain.
      //
      // This one IS table-wide, unavoidably: the index cannot be created while any duplicate
      // triple remains anywhere. Every row it removes duplicates another by definition - same
      // source, same target, same relation. It keeps the HIGHEST confidence rather than the
      // lowest uuid, so the survivor is the best score rather than an arbitrary one.
      db.exec(`
        DELETE FROM decision_links WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY source_id, target_id, relation ORDER BY confidence DESC, rowid
            ) AS rn FROM decision_links
          ) WHERE rn = 1
        );
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decision_links_triple_unique ON decision_links(source_id, target_id, relation)`);
      // Stamped INSIDE the transaction. Outside it, a process killed between COMMIT and the
      // pragma replays the version-1 relabel on the next open, which turns an adjudicated
      // conflicts_with edge into relates - the exact silent loss the docstring above warns of.
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      // Guarded: SQLITE_FULL, IOERR, BUSY, NOMEM and INTERRUPT auto-roll-back, and an
      // unconditional ROLLBACK then throws "no transaction is active" and buries the real
      // cause - so a user whose disk filled mid-migration would be told the wrong thing.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export function createLocalDb(dbPath: string) {
  // SQLite creates the DB file but not its parent directory, so on a clean machine
  // (~/.config/align-cli absent) `align setup --local` crashed with "unable to open
  // database file". Create the directory first. ':memory:' has no parent.
  //
  // Still true after the move off better-sqlite3: node:sqlite does not mkdir either.
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
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
         ON CONFLICT(source_url, title) DO UPDATE SET summary = excluded.summary, platform = excluded.platform
         RETURNING id`
      ).get(
        randomUUID(),
        row.title,
        row.summary,
        identifyingSourceUrl(row.sourceUrl),
        row.platform,
      ) as { id: string };
      return inserted.id;
    },

    /**
     * The id this graph already holds for `(source_url, title)`, or null.
     *
     * Exists so a caller can tell an insert from a refresh (ALI-770): `insertDecision`
     * upserts and returns the surviving id either way, so an import could not say whether
     * it added anything. It reported every re-import as "Imported N decisions" while the
     * graph did not move, which reads as having imported twice.
     *
     * Normalises through `identifyingSourceUrl` because that is what insertDecision STORES.
     * Skipping it would miss every row whose URL carried a query string or fragment and
     * report each as new - wrong in the one direction nobody questions, because "2 new" on
     * a re-import looks exactly like working software.
     *
     * A null `sourceUrl` is always null here: SQLite treats each NULL in a unique index as
     * distinct, so those rows never conflict and every one of them really is new.
     */
    findIdBySource(sourceUrl: string | null, title: string): string | null {
      const identity = identifyingSourceUrl(sourceUrl);
      if (identity === null) return null;
      const row = db.prepare(
        `SELECT id FROM decisions WHERE source_url = ? AND title = ?`
      ).get(identity, title) as { id: string } | undefined;
      return row?.id ?? null;
    },

    listDecisions(): DecisionRow[] {
      return db.prepare(
        `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt FROM decisions ORDER BY created_at DESC`
      ).all() as unknown as DecisionRow[];
    },

    getDecisionById(id: string): DecisionRow | null {
      return (db.prepare(
        `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt FROM decisions WHERE id = ?`
      ).get(id) as unknown as DecisionRow | null) ?? null;
    },

    setEmbedding(decisionId: string, embedding: Float32Array): void {
      db.prepare(
        `INSERT OR REPLACE INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)`
      ).run(decisionId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    },

    getEmbedding(decisionId: string): Float32Array | null {
      const row = db.prepare(
        `SELECT embedding FROM decision_embeddings WHERE decision_id = ?`
      ).get(decisionId) as { embedding: Uint8Array } | null;
      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    },

    getAllEmbeddings(): Array<{ decisionId: string; embedding: Float32Array }> {
      const rows = db.prepare(
        `SELECT decision_id, embedding FROM decision_embeddings`
      ).all() as Array<{ decision_id: string; embedding: Uint8Array }>;
      return rows.map(r => ({
        decisionId: r.decision_id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      }));
    },

    /**
     * `INSERT OR IGNORE` here was decorative: the id is a fresh UUID, so the only key that
     * could conflict was guaranteed not to, and there was no unique index on the triple. With
     * decisions now deduping, a re-import returns the SAME decision id and this added another
     * identical edge every time - measured 1, 2, 3 over three imports, inflating the
     * "similar decisions found" count `align local status` prints.
     *
     * The unique index (created in migrate) is what makes the OR IGNORE real. Confidence is
     * refreshed rather than ignored so a better score replaces a worse one.
     */
    insertLink(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
      db.prepare(
        `INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id, target_id, relation)
           DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`
      ).run(randomUUID(), link.sourceId, link.targetId, link.relation, link.confidence);
    },

    listLinks(filter?: { relation?: string; decisionId?: string }): LinkRow[] {
      let sql = `SELECT id, source_id as sourceId, target_id as targetId, relation, confidence FROM decision_links WHERE 1=1`;
      const params: string[] = [];
      if (filter?.relation) { sql += ` AND relation = ?`; params.push(filter.relation); }
      if (filter?.decisionId) { sql += ` AND (source_id = ? OR target_id = ?)`; params.push(filter.decisionId, filter.decisionId); }
      return db.prepare(sql).all(...params) as unknown as LinkRow[];
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
