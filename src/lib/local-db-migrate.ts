/**
 * The local graph's schema and its one-time migrations, moved out of local-db.ts verbatim so
 * that file stays under the 900-line limit. local-db.ts re-exports SCHEMA_VERSION, so every
 * existing `import { SCHEMA_VERSION } from './local-db.js'` still resolves.
 */
import type { DatabaseSync } from 'node:sqlite';
import { repoFromSourceUrl } from './repo-identity.js';
import { migrateV7 } from './local-db-v7.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT,
  platform TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  repo TEXT,
  decided_at TEXT,
  decider_kind TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  ratified_by TEXT,
  ratified_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_audit (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_embeddings (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT
);

CREATE TABLE IF NOT EXISTS decision_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_refs (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  PRIMARY KEY (decision_id, ref)
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
export const SCHEMA_VERSION = 7;

/** The title connector-core 0.5.0 gave every Slack thread whose root was deleted. The 0.6.0
 *  fetcher titles such a thread from its first human message, or drops it; either way this
 *  row is a duplicate-to-be under the (source_url, title) key, or noise. */
export const SLACK_TOMBSTONE_TITLE = 'This message was deleted.';

/** The five ALI-831 columns, named exactly as the shared contract spells them. One list,
 *  read by the migration; SCHEMA above spells them a second time because a fresh CREATE
 *  TABLE cannot read a constant, and the provenance test pins both against each other. */
const PROVENANCE_COLUMNS = ['decider_kind', 'confirmed_by', 'confirmed_at', 'ratified_by', 'ratified_at'] as const;

/**
 * ALI-787: the only embedding model this graph has ever written before the `model` column
 * existed. Verified, not assumed - `git log --all -p` on local-embeddings.ts and
 * local-embeddings-wasm.ts shows exactly one HF model id was ever hardcoded there, across
 * every commit. So backfilling every pre-column row with this is a true historical fact,
 * unlike `decided_at` (step 4 below), which genuinely cannot be derived from an existing row.
 *
 * A deliberate LITERAL, not an import of local-embeddings.ts's EMBEDDING_MODEL_ID: this
 * constant names what was true when the column was added, and must stay that value even
 * after a future model swap changes EMBEDDING_MODEL_ID. Migrations are a historical record.
 */
const LEGACY_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

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
 *    to run `align connect git` - so a graph goes from 2 decisions to 4 by following the tips.
 *    Collapse the existing duplicates, then make them unrepresentable with a unique index.
 *
 * 3. ALI-798: add the `repo` column (missing on any graph that predates it) and backfill it
 *    for every existing row from `source_url`, via the same `repoFromSourceUrl` the importer
 *    now stamps new rows with - one reader of the URL shape, used for both. A row whose
 *    source is not code (Jira, Slack, a bare capture) stays NULL, which is "unattributed",
 *    not "wrong": `--repo` scoping always includes unattributed rows alongside the named
 *    repo (see local-gateway-client.ts), so nothing existing becomes invisible.
 *
 * 4. ALI-829: add `decided_at` - when the decision was MADE, from the source's own
 *    timestamp, as distinct from `created_at`, the minute this CLI imported it. Every one
 *    of the 684 rows in the 2026-09-02 measurement carried the ingest minute and nothing
 *    else, so "what changed since March" was unanswerable offline. No backfill, unlike
 *    `repo`: a repo is derivable from a stored source_url, and a decision date is not
 *    derivable from anything already in the row. A re-import fills it in; inventing one
 *    from created_at would write the exact wrong fact this column exists to correct.
 *
 *    Same bump, second step: drop the Slack rows titled by a deleted root. The 0.6.0
 *    fetcher titles a thread from its first human message, and the dedup key is
 *    (source_url, title), so each of those rows would otherwise be re-inserted BESIDE its
 *    tombstone twin on the next import (35 of 39 on the 2026-09-02 graph). The next import
 *    recreates the real ones with real titles; the ones that were only bot output on a
 *    deleted root do not come back, which is the point. Foreign keys are off in this
 *    database (see step 2), so the dependent rows are deleted explicitly - including any
 *    link a human adjudicated on such a row. That is a real loss, accepted: the row's
 *    identity is changing under it, and the re-import classifies the retitled thread
 *    afresh. Scoped to platform = 'slack': a git commit or a captured note that happens to
 *    carry the same words is not a tombstone and is left alone.
 *
 * 5. ALI-831: add the decider/ratified columns (`decider_kind`, `confirmed_by`,
 *    `confirmed_at`, `ratified_by`, `ratified_at`) so an agent-made decision can enter as a
 *    CLAIM a human later stands behind, and the `decision_audit` table the human act is
 *    recorded in. No backfill, on purpose: a row captured before the column reads as
 *    'unknown', and stamping 'human' on it from its platform would be the retroactive
 *    guess align-stack's migration 113 refuses. The columns are added here rather than only
 *    in SCHEMA because CREATE TABLE IF NOT EXISTS never alters an existing table.
 *
 * 6. ALI-787: tag each embedding with the model that produced it (see LEGACY_EMBEDDING_MODEL).
 *
 * 7. L2: per-source sync state, `source_key` identity with a backed-up twin merge,
 *    `detail_pending`, `enriched_at` (NULL on every existing row) and `local_judgements`.
 *    See local-db-v7.ts.
 *
 * The version guard is load-bearing rather than tidiness. The same UPDATE run on every open
 * is indistinguishable from this one today, and starts silently eating genuine conflicts the
 * moment anything writes one.
 */
/**
 * Remove a decision and everything hanging off it. Foreign keys are off in this database
 * (see migrate, step 2), so the dependents are named explicitly rather than cascaded. One
 * writer for the v4 tombstone sweep and the ingest-time twin removal (ALI-829).
 */
export function deleteDecisionWithDependents(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM decision_links WHERE source_id = ? OR target_id = ?').run(id, id);
  db.prepare('DELETE FROM decision_refs WHERE decision_id = ?').run(id);
  db.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(id);
  db.prepare('DELETE FROM decision_audit WHERE decision_id = ?').run(id);
  db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
}

export function migrate(db: DatabaseSync): void {
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
      //
      // Stamps this step's OWN number (2), not SCHEMA_VERSION: a later step (3, below) runs
      // after this one commits, and if a crash lands between the two, `user_version` must
      // still read 2 so the version-3 step is not skipped on the next open.
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      // Guarded: SQLITE_FULL, IOERR, BUSY, NOMEM and INTERRUPT auto-roll-back, and an
      // unconditional ROLLBACK then throws "no transaction is active" and buries the real
      // cause - so a user whose disk filled mid-migration would be told the wrong thing.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 3) {
    // The column may already exist: a brand-new database's CREATE TABLE (SCHEMA, above)
    // declares `repo` directly, so on a fresh install this ALTER would fail with "duplicate
    // column name" if run unconditionally. A legacy database predates the column entirely.
    const hasRepoColumn = (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'repo');
    if (!hasRepoColumn) {
      db.exec('ALTER TABLE decisions ADD COLUMN repo TEXT');
    }
    // Backfill every row with no repo yet. JS-side because SQLite has no regex function to
    // apply `repoFromSourceUrl`'s pattern in SQL - and it must be the SAME function the
    // importer stamps new rows with, or a backfilled row and a freshly-imported one for the
    // same URL could disagree about which repo they belong to.
    const rows = db.prepare('SELECT id, source_url FROM decisions WHERE repo IS NULL')
      .all() as Array<{ id: string; source_url: string | null }>;
    if (rows.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const update = db.prepare('UPDATE decisions SET repo = ? WHERE id = ?');
        for (const row of rows) {
          const repo = repoFromSourceUrl(row.source_url);
          // Only WRITE when a repo was found: leaving a non-code row NULL is the correct
          // outcome (unattributed, not "wrong"), and writing NULL over NULL is a no-op
          // this loop can just skip.
          if (repo) update.run(repo, row.id);
        }
        db.exec('PRAGMA user_version = 3');
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    } else {
      db.exec('PRAGMA user_version = 3');
    }
  }
  if (version < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Same shape as the `repo` step: a fresh database's CREATE TABLE already declares the
      // column, and a legacy one predates it, so the ALTER is conditional. Checked INSIDE
      // the write lock, unlike step 3: two processes opening a v3 file at once (the
      // advisory hook is the normal concurrent case) could otherwise both read "no column"
      // and the second would die on "duplicate column name". SQLite DDL is transactional.
      const hasDecidedAt = (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>)
        .some((c) => c.name === 'decided_at');
      if (!hasDecidedAt) {
        db.exec('ALTER TABLE decisions ADD COLUMN decided_at TEXT');
      }
      const tombstones = db.prepare(
        `SELECT id FROM decisions WHERE platform = 'slack' AND title = ?`,
      ).all(SLACK_TOMBSTONE_TITLE) as Array<{ id: string }>;
      for (const { id } of tombstones) deleteDecisionWithDependents(db, id);
      // Stamped inside the transaction, for the reason step 2 gives.
      db.exec('PRAGMA user_version = 4');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 5) {
    // Inside the write lock, for the reason step 4 gives: two concurrent opens of a v4
    // file must not both read "no column" and race the ALTER.
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = new Set(
        (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const column of PROVENANCE_COLUMNS) {
        if (!existing.has(column)) db.exec(`ALTER TABLE decisions ADD COLUMN ${column} TEXT`);
      }
      db.exec('PRAGMA user_version = 5');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 6) {
    // Inside the write lock, for the reason step 4/5 give: two concurrent opens of a v5
    // file must not both read "no column" and race the ALTER.
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasModel = (db.prepare('PRAGMA table_info(decision_embeddings)').all() as Array<{ name: string }>)
        .some((c) => c.name === 'model');
      if (!hasModel) {
        db.exec('ALTER TABLE decision_embeddings ADD COLUMN model TEXT');
      }
      // Every row that predates the column was written by LEGACY_EMBEDDING_MODEL - see its
      // doc comment for how that is verified rather than assumed. Only rows with no tag yet
      // are touched, so re-running this on an already-migrated database is a no-op.
      db.prepare('UPDATE decision_embeddings SET model = ? WHERE model IS NULL').run(LEGACY_EMBEDDING_MODEL);
      db.exec('PRAGMA user_version = 6');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 7) {
    // L2: sync state, source_key with the twin merge, enriched_at, local_judgements. One
    // transaction, IMMEDIATE and stamped inside, for the reasons steps 2 and 4 give. The step
    // itself, and why each part is shaped as it is, lives in local-db-v7.ts.
    db.exec('BEGIN IMMEDIATE');
    try {
      migrateV7(db);
      db.exec('PRAGMA user_version = 7');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
